import { expect, test } from "bun:test";
import { capNotice, CAP_BYTES, cappedCommand, codexPreTool, geminiOverwrite, invokesCdx, utf8Boundary } from "./cap.ts";
import { codexSandbox, geminiProfile, resolvedPath, REVIEW_PROFILE, spillDirOf } from "./sandbox.ts";
import { houseRules, laneInstructions } from "./prompts.ts";
import { ROOT } from "./runtime.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { CDX_LANE: "w", CDX_ROUND: "2", CDX_HOME: "/state" };

test("codex reviews write only TMPDIR and the index; work lanes write only their roots", () => {
  expect(codexSandbox({ cwd: "/repo", reviewDir: "/repo", lane: "r", round: 1 })).toEqual({ thread: {}, turn: {}, config: { default_permissions: REVIEW_PROFILE,
    permissions: { [REVIEW_PROFILE]: { filesystem: { ":root": "read", ":tmpdir": "write" }, network: { enabled: true } } } } });
  const work = codexSandbox({ cwd: "/repo", additionalDirectories: ["/extra"], lane: "w", round: 2 });
  expect(work.thread).toEqual({ sandbox: "workspace-write" });
  const policy = (work.turn as { sandboxPolicy: { writableRoots: string[] } }).sandboxPolicy;
  expect(policy).toMatchObject({ type: "workspaceWrite", networkAccess: true, excludeSlashTmp: false, excludeTmpdirEnvVar: false });
  const roots = policy.writableRoots;
  expect(roots).toEqual(["/extra", `${ROOT}/state`, `${ROOT}/control`, spillDirOf("w", 2)].map(resolvedPath));
  expect(roots.some((root) => root === resolvedPath(ROOT) || root.endsWith("config.json"))).toBe(false);
});

test("a review snapshot may write the linked index and the directory SQLite resolves it to", () => {
  const base = mkdtempSync(join(tmpdir(), "cdx-index-"));
  try {
    const source = join(base, "repo"), snapshot = join(base, "snap");
    mkdirSync(join(source, ".codegraph"), { recursive: true });
    writeFileSync(join(source, ".codegraph", "codegraph.db"), "");
    mkdirSync(join(snapshot, ".codegraph"), { recursive: true });
    writeFileSync(join(snapshot, ".git"), "gitdir: /elsewhere/git\n");
    symlinkSync(join(source, ".codegraph", "codegraph.db"), join(snapshot, ".codegraph", "codegraph.db"));
    const filesystem = { ":root": "read", ":tmpdir": "write", [resolvedPath(join(snapshot, ".codegraph"))]: "write", [resolvedPath(join(source, ".codegraph"))]: "write" };
    expect(codexSandbox({ cwd: snapshot, reviewDir: snapshot }).config).toMatchObject({ permissions: { [REVIEW_PROFILE]: { filesystem } } });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the agy profile denies writes except the engine, lane state, and a work checkout", () => {
  const review = geminiProfile({ cwd: "/repo", reviewDir: "/repo", lane: "r", round: 1 }, ["/logs/r-r1.agy.log"]);
  expect(review.startsWith("(version 1)(allow default)(deny file-write*)(allow file-write* ")).toBe(true);
  expect(review).not.toContain('(subpath "/repo")');
  expect(review).not.toContain('(subpath "/private/tmp")');
  expect(review).toContain('(literal "/logs/r-r1.agy.log")');
  expect(review).toContain(`(subpath ${JSON.stringify(resolvedPath(`${ROOT}/state`))})`);
  const work = geminiProfile({ cwd: "/repo", lane: "w", round: 1 });
  expect(work).toContain('(subpath "/repo")');
  expect(work).toContain('(subpath "/private/tmp")');
  const ask = geminiProfile({ cwd: "/repo", reviewDir: "/repo" });
  expect(ask).not.toContain(resolvedPath(`${ROOT}/state`));
});

test("a worktree lane or review queries its primary checkout's index, which it may write", () => {
  const base = mkdtempSync(join(tmpdir(), "cdx-index-"));
  try {
    const primary = join(base, "repo"), lane = join(base, "wt", "lane");
    mkdirSync(join(primary, ".git"), { recursive: true });
    mkdirSync(join(primary, ".codegraph"));
    writeFileSync(join(primary, ".codegraph", "codegraph.db"), "");
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, ".git"), `gitdir: ${primary}/.git/worktrees/lane\n`);
    const index = resolvedPath(join(primary, ".codegraph"));
    expect((codexSandbox({ cwd: lane, lane: "w", round: 1 }).turn as { sandboxPolicy: { writableRoots: string[] } }).sandboxPolicy.writableRoots).toContain(index);
    expect(codexSandbox({ cwd: lane, reviewDir: lane }).config).toMatchObject({ permissions: { [REVIEW_PROFILE]: { filesystem: { [index]: "write" } } } });
    expect(geminiProfile({ cwd: lane, reviewDir: lane })).toContain(`(subpath ${JSON.stringify(index)})`);
    expect(houseRules(lane, false, "gpt")).toContain(`codegraph explore -p ${primary} "<question>"`);
    expect(houseRules(lane, true, "gpt")).toContain(`codegraph explore -p ${primary} "<question>"`);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("supervisor cdx calls are single-quoted so the exec-policy rule matches", () => {
  expect(laneInstructions({ supervisor: true })).toContain("cdx spawn <child> --bg --gate '<cmd>' '<brief with the four headings>'");
});

test("supervisors review child trees without codegraph and sync their own index after landing", () => {
  const rules = laneInstructions({ supervisor: true });
  expect(rules).toContain("Codegraph cannot open a child worktree's index");
  expect(rules).toContain("`codegraph sync .`");
  expect(laneInstructions({})).not.toContain("child worktree's index");
});

test("the cap wraps lane shell commands except cdx calls", () => {
  expect(invokesCdx("cdx spawn a 'brief'")).toBe(true);
  expect(invokesCdx("cd x && cdx status")).toBe(true);
  expect(invokesCdx("rg cdx src")).toBe(false);
  const hook = codexPreTool({ tool_name: "Bash", tool_input: { command: "bun test" } }, env) as any;
  const command: string = hook.hookSpecificOutput.updatedInput.command;
  expect(hook.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "allow" });
  expect(command).toContain(" run '/state/logs/w-r2.out/");
  expect(command.endsWith(" 'bun test'")).toBe(true);
  expect(codexPreTool({ tool_name: "Bash", tool_input: { command } }, env)).toBeUndefined();
  expect(codexPreTool({ tool_name: "Bash", tool_input: { command: "cdx ask 'q'" } }, env)).toBeUndefined();
  expect(codexPreTool({ tool_name: "Bash", tool_input: { command: "ls" } }, {})).toBeUndefined();
  expect(cappedCommand("echo 'a'", "/s", "/bun", "/cap.ts")).toBe(`'/bun' '/cap.ts' run '/s' 'echo '"'"'a'"'"''`);
  const args = { CommandLine: "ls", Cwd: "/repo", WaitMsBeforeAsync: 2000 };
  expect(geminiOverwrite({ name: "run_command", args }, env)).toMatchObject({ Cwd: "/repo", WaitMsBeforeAsync: 2000 });
  expect(geminiOverwrite({ name: "view_file", args }, env)).toBeUndefined();
});

test("the cap notice stays inside the cap and cuts on character boundaries", () => {
  const bytes = new TextEncoder().encode("abé");
  expect(utf8Boundary(bytes, 3)).toBe(2);
  expect(utf8Boundary(bytes, 9)).toBe(4);
  const notice = capNotice(90_000, 2048, 1536, "/state/logs/w-r2.out/1-abc.log");
  expect(2048 + 1536 + Buffer.byteLength(notice)).toBeLessThan(CAP_BYTES);
  expect(capNotice(90_000, 2048, 1536, undefined)).toContain("narrow the command");
});
