import { expect, test } from "bun:test";
import { roundProgress, testCommands, toolObservation, VISIBILITY_DEFAULTS } from "./visibility.ts";
import { parseArgs, parseConfig, summaryJobs, WAKE_EVENTS } from "./cdx.ts";
import { expectMinutes, historyMinutes, markOverrun, overrunNotice } from "./duration.ts";
import { composeGate } from "./gates.ts";

const gemini = (index: number, state: string, parameters = {}, extra = {}) => ({ event: "step_update", step_update: {
  conversation_id: "conversation", step_index: index, step_type: "tool", state, tool_name: "run_command",
  tool_info: { parameters, ...extra },
} });

test("both engine tool phases count once and text never counts", () => {
  const progress = roundProgress("/repo");
  for (const state of ["ACTIVE", "DONE", "DONE"]) expect(progress(toolObservation(gemini(1, state))!).steps).toBe(1);
  for (const method of ["item/started", "item/completed", "item/completed"]) {
    expect(progress(toolObservation({ method, params: { turnId: "turn", item: { id: "a", type: "commandExecution", command: "false", exitCode: 1 } } })!).steps).toBe(2);
  }
  expect(toolObservation({ type: "item.completed", item: { type: "agent_message", text: "hello" } })).toBeUndefined();
  expect(toolObservation({ event: "step_update", step_update: { step_type: "agent_response" } })).toBeUndefined();
  expect(progress(toolObservation({ type: "item.completed", item: { id: "legacy", type: "command_execution", command: "true", exit_code: 0 } })!).steps).toBe(3);
});

test("failed command repetition resets on success or a different command and warns once per round", () => {
  const progress = roundProgress("/repo", { ...VISIBILITY_DEFAULTS, failureRepeats: 3 });
  let index = 0;
  const run = (command: string, exit_code: number) => progress(toolObservation(gemini(++index, "DONE", { CommandLine: command }, { exit_code }))!);
  expect(run("false", 1).thrash).toBeUndefined();
  expect(run("false", 1).thrash).toBeUndefined();
  expect(run("false", 0).thrash).toBeUndefined();
  expect(run("false", 1).thrash).toBeUndefined();
  expect(run("other", 1).thrash).toBeUndefined();
  expect(run("false", 1).thrash).toBeUndefined();
  expect(run("false", 1).thrash).toBeUndefined();
  expect(run("false", 1).thrash).toContain("command failed 3x: false");
  expect(run("false", 1).thrash).toBeUndefined();
  expect(roundProgress("/repo")(toolObservation(gemini(1, "DONE", { CommandLine: "false" }, { exit_code: 1 }))!).thrash).toBeUndefined();
});

test("file edits are observed without a repetition warning", () => {
  const progress = roundProgress("/repo");
  const change = (id: string, path: string) => toolObservation({ method: "item/completed", params: { item: { id, type: "fileChange", changes: [{ path }] } } })!;
  for (let index = 0; index < 30; index++) expect(progress(change(String(index), "file.ts")).thrash).toBeUndefined();
  const event = gemini(4, "DONE", { TargetFile: "/repo/file.ts" });
  event.step_update.tool_name = "replace_file_content";
  expect(toolObservation(event)?.files).toEqual(["/repo/file.ts"]);
});

test("unstructured output does not invent a failed command", () => {
  const event = gemini(1, "DONE", { CommandLine: "echo failed" }, { output: "tests failed in an old report" });
  expect(toolObservation(event)?.failed).toBeUndefined();
  expect(toolObservation(gemini(2, "ERROR", { CommandLine: "false" }))?.failed).toBe(true);
  expect(toolObservation(gemini(3, "DONE", { CommandLine: "false" }, { error: { message: "command failed" } }))?.failed).toBe(true);
});

test("test runs count at start, completion-only runs count once, and the fourth run warns once", () => {
  const progress = roundProgress("/repo", VISIBILITY_DEFAULTS, "custom-gate");
  const codex = (id: string, method: string, command?: string, exitCode?: number) => toolObservation({ method,
    params: { item: { id, type: "commandExecution", command, exitCode } } })!;
  expect(progress(codex("a", "item/started", "bun test tests/a.test.ts"))).toMatchObject({ testRuns: 1, testSuites: 0, testStatus: "running" });
  expect(progress(codex("a", "item/completed", undefined, 0))).toMatchObject({ testRuns: 1, testStatus: "passed" });
  expect(progress(codex("b", "item/completed", "bun run check", 1))).toMatchObject({ testRuns: 2, testSuites: 1, testStatus: "failed" });
  expect(progress(toolObservation(gemini(3, "DONE", { CommandLine: "custom-gate" }, { exit_code: 0 }))!)).toMatchObject({ testRuns: 3, testSuites: 1 });
  expect(progress(codex("d", "item/started", "bunx vp test run tests/b.test.ts"))).toMatchObject({ testRuns: 4, testSuites: 1, testThrash: "tests run 4x this round" });
  expect(progress(codex("d", "item/completed", undefined, 0)).testThrash).toBeUndefined();
  expect(testCommands("bun test && bunx vp test run x.test.ts && vitest run && wall").map((run) => run.suite)).toEqual([true, false, true, true]);
  expect(testCommands("/bin/zsh -lc 'cd /repo && bun test a.test.ts'")).toHaveLength(1);
  expect(testCommands("/bin/zsh -lc 'echo \"bun test\"'")).toHaveLength(0);
  expect(testCommands("/bin/zsh -lc 'echo \"a;b\"; bun test a.test.ts'")).toHaveLength(1);
  expect(testCommands("/bin/zsh -lc 'echo one && echo two'", "echo one && echo two")).toHaveLength(1);
  expect(testCommands("/bin/zsh -lc 'bun run wall'")[0]?.suite).toBe(true);
  const composed = composeGate('echo "bun test && vitest run"; bun run check', "bunx vp test run tests/gate.test.ts")!;
  expect(testCommands(composed).map((run) => run.suite)).toEqual([true, false]);
  expect(testCommands('echo "bun test && vitest run"')).toHaveLength(0);
});

test("visibility settings reject invalid cadence and thresholds and status flags parse", () => {
  expect(parseConfig("{}").visibility).toEqual(VISIBILITY_DEFAULTS);
  expect(parseConfig('{"visibility":{"failureRepeats":2}}').visibility).toEqual({ failureRepeats: 2, testRuns: 3 });
  for (const visibility of [null, [], { extra: 1 }, { heartbeatMinutes: 10 }, { fileEdits: 20 }, { failureRepeats: 1.5 }, { testRuns: 0 }]) {
    expect(() => parseConfig(JSON.stringify({ visibility }))).toThrow();
  }
  const flags = parseArgs(["--brief", "--watch", "--interval", "3"], ["brief", "watch", "interval"]);
  expect(flags.bools.has("watch")).toBe(true);
  expect(flags.bools.has("brief")).toBe(true);
  expect(flags.flags.interval).toBe("3");
});

test("only actionable kinds wake the head", () => {
  for (const kind of ["gate-finished", "partial", "account", "thrash", "terminal", "question"]) {
    expect(WAKE_EVENTS.has(kind)).toBe(!["gate-finished", "partial", "account"].includes(kind));
  }
});

test("session summaries keep every running job and only the ten newest finished jobs", () => {
  const jobs: any = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [String(index), { state: "done", startedAt: String(index).padStart(3, "0") }]));
  jobs.running = { state: "running", startedAt: "000" };
  const selected = summaryJobs(jobs).map(([name]) => name);
  expect(selected).toHaveLength(11);
  expect(selected[0]).toBe("running");
  expect(selected.slice(1)).toEqual(["149", "148", "147", "146", "145", "144", "143", "142", "141", "140"]);
});

test("duration estimates use recent completed history and explicit expectations reject invalid values", () => {
  const start = "2026-09-11T12:00:00Z";
  expect(historyMinutes([{ startedAt: start, finishedAt: "2026-09-11T12:12:00Z" },
    { startedAt: start, finishedAt: "2026-09-11T12:20:00Z" }, { startedAt: start }], 15)).toBe(20);
  expect(historyMinutes([], 15)).toBe(15);
  expect(historyMinutes([{ startedAt: start, finishedAt: "2026-09-11T12:03:00Z" }, { startedAt: start, finishedAt: "2026-09-11T12:04:00Z" }], 15)).toBe(15);
  expect(overrunNotice(start, 3.6920166, Date.parse(start) + 240_000)).toStartWith("expected 3.7m,");
  expect(expectMinutes("7.5", 15)).toBe(7.5);
  expect(() => expectMinutes("0", 15)).toThrow("--expect");
  expect(overrunNotice(start, 15, Date.parse(start) + 899_999)).toBeUndefined();
  expect(overrunNotice(start, 15, Date.parse(start) + 900_000, "read file", "/tmp/log", "2026-09-11T12:12:00Z"))
    .toBe("expected 15m, elapsed 15m; lastActivity=read file lastActivityAt=2026-09-11T12:12:00Z age=3m log=/tmp/log");
  const round = { overrunSent: false };
  expect(markOverrun(round, start, 15, Date.parse(start) + 900_000)).toContain("elapsed 15m");
  expect(markOverrun(round, start, 15, Date.parse(start) + 900_000)).toBeUndefined();
  expect(markOverrun({ overrunSent: false }, start, 15, Date.parse(start) + 900_000)).toContain("elapsed 15m");
});
