import { expect, test } from "bun:test";
import { capNotice, CAP_BYTES, cappedCommand, codexPreTool, geminiOverwrite, invokesCdx, utf8Boundary } from "./cap.ts";
import { codexSandbox, geminiProfile, laneCodegraphRoot, resolvedPath, spillDirOf } from "./sandbox.ts";
import { houseRules } from "./prompts.ts";
import { ROOT } from "./runtime.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { CDX_LANE: "w", CDX_ROUND: "2", CDX_HOME: "/state" };

test("codex lanes get read-only or workspace-write with only their roots", () => {
  expect(codexSandbox({ cwd: "/repo", reviewDir: "/repo", lane: "r", round: 1 })).toEqual({ mode: "read-only", policy: { type: "readOnly", networkAccess: true } });
  const work = codexSandbox({ cwd: "/repo", additionalDirectories: ["/extra"], lane: "w", round: 2 });
  expect(work.mode).toBe("workspace-write");
  expect(work.policy).toMatchObject({ type: "workspaceWrite", networkAccess: true, excludeSlashTmp: false, excludeTmpdirEnvVar: false });
  const roots = (work.policy as { writableRoots: string[] }).writableRoots;
  expect(roots).toEqual(["/extra", `${ROOT}/state`, `${ROOT}/control`, spillDirOf("w", 2)].map(resolvedPath));
  expect(roots.some((root) => root === resolvedPath(ROOT) || root.endsWith("config.json"))).toBe(false);
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

test("a worktree lane queries its primary checkout's index, which it may write", () => {
  const base = mkdtempSync(join(tmpdir(), "cdx-index-"));
  try {
    const primary = join(base, "repo"), lane = join(base, "wt", "lane");
    mkdirSync(join(primary, ".git"), { recursive: true });
    mkdirSync(join(primary, ".codegraph"));
    writeFileSync(join(primary, ".codegraph", "codegraph.db"), "");
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, ".git"), `gitdir: ${primary}/.git/worktrees/lane\n`);
    const index = resolvedPath(join(primary, ".codegraph"));
    expect((codexSandbox({ cwd: lane, lane: "w", round: 1 }).policy as { writableRoots: string[] }).writableRoots).toContain(index);
    expect(geminiProfile({ cwd: lane, reviewDir: lane })).toContain(`(subpath ${JSON.stringify(index)})`);
    expect(houseRules(lane, false, "gpt")).toContain(`codegraph explore -p ${primary} "<question>"`);
    expect(houseRules(lane, true, "gpt")).not.toContain("codegraph");
    expect(laneCodegraphRoot({ cwd: lane, reviewDir: lane, engine: "gpt" })(lane)).toBeUndefined();
    expect(laneCodegraphRoot({ cwd: lane, reviewDir: lane, engine: "gemini" })(lane)).toBe(primary);
  } finally { rmSync(base, { recursive: true, force: true }); }
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
