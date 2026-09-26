import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerPath, citationProblem, memberSpec, readPanel, reapPanels, settledPanel, claudeHeadroom, lineCount, completionLine, groupClaims, type MemberAnswer, panelPrompt, panelRefusal,
  panelReportPath, parseAnswer, PANEL_INPUT_CHARS, renderPanelReport, REPORT_LINES, VERDICT_LINES,
} from "./panel.ts";
import { eventsAfter, latestEventId, type Lane } from "./ledger.ts";
import { laneInstructions } from "./prompts.ts";
import { reportPathOf } from "./reports.ts";
import { db } from "./store.ts";

const cwd = "/repo";
const answer = (member: string, claims: string[], recommendation = `${member} says keep it`) => parseAnswer(member, [
  "## Recommendation", recommendation, "", "## Claims", ...claims, "", "## Dissent", "Someone could split it.", "", "## Confidence", "medium, read two files",
].join("\n"), cwd);

test("answers parse into recommendation, marked claims, dissent and confidence", () => {
  const parsed = answer("sol", [
    "- verified | ledger.ts:12 | lanes live in SQLite",
    "- [inferred] | `/repo/runner.ts:40-44` | the runner finalizes",
    "- verified | 3 | three members",
    "- not a claim line",
  ]);
  expect(parsed.recommendation).toBe("sol says keep it");
  expect(parsed.dissent).toBe("Someone could split it.");
  expect(parsed.confidence).toBe("medium, read two files");
  expect(parsed.claims).toEqual([
    { member: "sol", mark: "verified", evidence: "ledger.ts:12", path: "ledger.ts", line: 12, text: "lanes live in SQLite" },
    { member: "sol", mark: "inferred", evidence: "/repo/runner.ts:40-44", path: "runner.ts", line: 40, endLine: 44, text: "the runner finalizes" },
    { member: "sol", mark: "verified", evidence: "3", text: "three members" },
  ]);
});

test("claims group by cited path into three, two and one member agreement", () => {
  const groups = groupClaims([
    answer("astra", ["- verified | a.ts:1 | x", "- verified | a.ts:2 | y", "- verified | b.ts:1 | z"]),
    answer("sol", ["- inferred | a.ts:3 | x", "- verified | b.ts:1 | z", "- verified | 7 | n"]),
    answer("fable", ["- verified | a.ts:1 | x", "- verified | c.ts:9 | w"]),
  ]);
  expect(groups.map((group) => [group.path, group.agreement])).toEqual([["a.ts", 3], ["b.ts", 2], ["c.ts", 1]]);
  expect(groups[0]!.claims.astra).toHaveLength(2);
});

test("citation checks catch missing files and lines past the end", () => {
  const lines = (path: string) => path === "a.ts" ? 10 : "no such file" as const;
  const [inside, past, missing, range, number] = answer("fable", [
    "- verified | a.ts:10 | ok", "- verified | a.ts:11 | past", "- verified | nope.ts:1 | missing", "- verified | a.ts:9-12 | range", "- verified | 42 | n",
  ]).claims;
  expect(citationProblem(inside!, lines)).toBeUndefined();
  expect(citationProblem(past!, lines)).toBe("fable a.ts:11 (file has 10 lines)");
  expect(citationProblem(missing!, lines)).toBe("fable nope.ts:1 (no such file)");
  expect(citationProblem(range!, lines)).toBe("fable a.ts:9-12 (file has 10 lines)");
  expect(citationProblem(number!, lines)).toBeUndefined();
});

test("line counts read only regular files inside the checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "panel-lines-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "one\ntwo\n");
  writeFileSync(join(base, "secret.txt"), "outside\n");
  symlinkSync(join(base, "secret.txt"), join(repo, "link.txt"));
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(2_000_001));
  expect(lineCount(repo, "src/a.ts")).toBe(2);
  expect(lineCount(repo, "../secret.txt")).toBe("outside repo");
  expect(lineCount(repo, join(base, "secret.txt"))).toBe("outside repo");
  expect(lineCount(repo, "link.txt")).toBe("outside repo");
  expect(lineCount(repo, "big.bin")).toBe("too large");
  expect(lineCount(repo, "src")).toBe("no such file");
  expect(lineCount(repo, "gone.ts")).toBe("no such file");
  rmSync(base, { recursive: true, force: true });
});

test("the merged report stays under 60 lines with many paths and flags bad citations", () => {
  const many = (member: string) => answer(member, Array.from({ length: 20 }, (_, index) => `- verified | ${member}-${index}.ts:1 | c`));
  const answers: MemberAnswer[] = [many("astra"), many("sol"), answer("fable", ["- verified | astra-0.ts:99 | bad line"])];
  const report = renderPanelReport({
    name: "p1", question: "q?", answers, lines: () => 5,
    outcomes: [
      { member: "astra", state: "done", tokens: { input: 1000, cached: 500, output: 100 } },
      { member: "sol", state: "done" }, { member: "fable", state: "done" },
    ],
  });
  const lines = report.trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(REPORT_LINES);
  expect(REPORT_LINES + 3 + VERDICT_LINES).toBeLessThan(60);
  expect(report).toContain("Coverage: 3/3");
  expect(report).toContain("| 2/3 | astra-0.ts | 1v | - | 99v! |");
  expect(report).toMatch(/\(\d+ more paths in the answers\)/);
  expect(report).toContain("fable astra-0.ts:99 (file has 5 lines)");
});

test("a missing member leaves the report and the completion line incomplete", () => {
  const answers = [answer("astra", []), answer("fable", [])];
  const report = renderPanelReport({
    name: "p2", question: "q", answers, lines: () => "no such file",
    outcomes: [{ member: "astra", state: "done" }, { member: "sol", state: "failed", note: "max runtime" }, { member: "fable", state: "done" }],
  });
  expect(report).toContain("Coverage: 2/3");
  expect(report).toContain("sol failed: max runtime");
  expect(report).toContain("- sol: no answer");
  const line = completionLine({ name: "p2" }, "/r/p2.md", answers);
  expect(line).toBe("[cdx] panel=p2 coverage=incomplete report=/r/p2.md astra: astra says keep it | sol: no answer | fable: fable says keep it");
});

const admitted = { callerIsMember: false, callerIsConsultSupervisor: false, supervisorAskedThisRound: false, inputChars: 100, astraHeadroom: 50, claudeHeadroom: 50 };

test("panel guards refuse recursion, repeats, size and low quota", () => {
  expect(panelRefusal(admitted)).toBeUndefined();
  expect(panelRefusal({ ...admitted, claudeHeadroom: "cca is not on PATH" })).toBe("cca is not on PATH");
  expect(panelRefusal({ ...admitted, callerIsMember: true })).toBe("a panel member cannot start a panel");
  expect(panelRefusal({ ...admitted, supervisorAskedThisRound: true })).toContain("once per round");
  expect(panelRefusal({ ...admitted, callerIsConsultSupervisor: true })).toContain("a consult supervisor cannot start a panel");
  expect(panelRefusal({ ...admitted, openPanel: "p0" })).toContain("panel p0 is still open");
  expect(panelRefusal({ ...admitted, inputChars: PANEL_INPUT_CHARS + 1 })).toContain("the cap is 20000");
  expect(panelRefusal({ ...admitted, inputChars: PANEL_INPUT_CHARS })).toBeUndefined();
  expect(panelRefusal({ ...admitted, astraHeadroom: 9.5 })).toBe("Astra's account has 9% left; a panel needs 10%");
  expect(panelRefusal({ ...admitted, claudeHeadroom: 4 })).toBe("the Claude weekly quota has 4% left; a panel needs 10%");
});

test("panel files never share a path with a lane report or another panel's files", () => {
  expect(panelReportPath("foo-r2")).not.toBe(reportPathOf("foo", 2));
  expect(panelReportPath("foo-astra")).not.toBe(answerPath("foo", "astra"));
  expect(answerPath("foo", "astra")).not.toBe(reportPathOf("foo-astra", 1));
});

test("a supervisor-started panel's Codex members carry review lane instructions; the Claude member needs none", () => {
  const panel = { name: "p", cwd, question: "q", caller: "sup", callerRound: 2, owner: { ownerCwd: cwd }, state: "running" as const, startedAt: "2026-09-26T12:00:00Z" };
  const round = { lane: "p-astra", round: 1, engine: "gpt" as const, model: "gpt-6-astra", effort: "medium", prompt: "q", maxRuntimeMins: 15 };
  const entry = { roundStartedAt: "2026-09-26T12:00:00Z" } as Lane;
  expect(memberSpec(panel, entry, round).laneInstructions).toBe(laneInstructions({ review: true }));
  expect(memberSpec({ ...panel, caller: undefined, callerRound: undefined }, entry, round).laneInstructions).toBe(laneInstructions({ review: true }));
  expect(memberSpec(panel, entry, { ...round, lane: "p-fable", engine: "claude" }).laneInstructions).toBeUndefined();
});

test("claude headroom reads the active account's tightest weekly window", () => {
  const status = { active: "xa", accounts: [
    { name: "dev", limits: [{ label: "week", percent: 99 }] },
    { name: "xa", limits: [{ label: "5h", percent: 95 }, { label: "week", percent: 35 }, { label: "Fable wk", percent: 80 }] },
  ] };
  expect(claudeHeadroom(status)).toBe(20);
  expect(claudeHeadroom({ active: "xa", accounts: [{ name: "xa", limits: [{ label: "5h", percent: 10 }] }] })).toBeUndefined();
  expect(claudeHeadroom({})).toBeUndefined();
});

test("every member gets the same frozen prompt with the answer shape", () => {
  const prompt = panelPrompt("Why SQLite?", cwd, "/state/briefs/p-pack.md");
  expect(prompt).toContain("Why SQLite?");
  expect(prompt).toContain("Context pack: /state/briefs/p-pack.md");
  for (const heading of ["## Recommendation", "## Claims", "## Dissent", "## Confidence"]) expect(prompt).toContain(heading);
  expect(prompt).toContain(`codegraph explore -p ${cwd}`);
});

test("cdx wait on a panel returns its record once it finishes, or a failure once its runner died", () => {
  const record = { name: "wait-p", cwd, question: "q", owner: { ownerCwd: cwd }, state: "running", pid: 4242, startedAt: "2026-09-26T12:00:00Z" };
  const store = (data: object) => db().query("INSERT OR REPLACE INTO panels (name, data) VALUES (?, ?)").run("wait-p", JSON.stringify(data));
  store(record);
  expect(settledPanel("wait-p", () => true)).toBeUndefined();
  const since = latestEventId();
  expect(settledPanel("wait-p", () => false)?.state).toBe("failed");
  expect(readPanel("wait-p")?.state).toBe("failed");
  // The next poll finds nothing left to fail: one panel event per death.
  reapPanels(() => false);
  expect(eventsAfter(since).map((event) => event.kind)).toEqual(["panel"]);
  db().query("INSERT OR REPLACE INTO panels (name, data) VALUES (?, ?)").run("reap-p", JSON.stringify({ ...record, name: "reap-p" }));
  reapPanels(() => false);
  expect(readPanel("reap-p")?.summary).toContain("panel=reap-p state=failed runner died");
  store({ ...record, state: "done", summary: "[cdx] panel=wait-p coverage=3/3" });
  expect(settledPanel("wait-p", () => true)?.summary).toBe("[cdx] panel=wait-p coverage=3/3");
  expect(settledPanel("missing", () => true)).toBeUndefined();
});
