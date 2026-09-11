import { expect, test } from "bun:test";
import { digestLines, heartbeatDue, roundProgress, toolObservation, VISIBILITY_DEFAULTS } from "./visibility.ts";
import { parseArgs, parseConfig, parseFeedEvent, summaryJobs, WAKE_EVENTS } from "./cdx.ts";

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

test("file repetition uses normalized paths and only warns above the configured count", () => {
  const progress = roundProgress("/repo", { ...VISIBILITY_DEFAULTS, fileEdits: 2 });
  const change = (id: string, path: string) => toolObservation({ method: "item/completed", params: { item: { id, type: "fileChange", changes: [{ path }, { path }] } } })!;
  expect(progress(change("a", "file.ts")).thrash).toBeUndefined();
  expect(progress(change("b", "./file.ts")).thrash).toBeUndefined();
  expect(progress(change("b", "./file.ts")).thrash).toBeUndefined();
  expect(progress({ ...change("rejected", "file.ts"), failed: true }).thrash).toBeUndefined();
  expect(progress(change("c", "/repo/file.ts")).thrash).toContain("file edited 3x");
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

test("digests combine rows and reset step deltas across rounds", () => {
  const previous = [{ key: "lane=a", round: 1, steps: 50, files: 4, stage: "working", action: "old" }];
  const current = [{ key: "lane=a", round: 1, steps: 55, files: 3, stage: "gate", action: "last 2s check" }, { key: "job=train", stage: "running", action: "land 10/15" }];
  const lines = digestLines(current, previous);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("steps=55(+5) files=3(-1) working>gate");
  expect(lines[1]).toBe("job=train running land 10/15");
  expect(digestLines([{ ...current[0]!, round: 2, steps: 2 }], previous)[0]).toContain("steps=2(+2)");
  expect(digestLines([], previous)).toEqual([]);
  expect(heartbeatDue(599_999, 0, 10)).toBe(false);
  expect(heartbeatDue(600_000, 0, 10)).toBe(true);
});

test("visibility settings reject invalid cadence and thresholds and status flags parse", () => {
  expect(parseConfig("{}").visibility).toEqual(VISIBILITY_DEFAULTS);
  expect(parseConfig('{"visibility":{"heartbeatMinutes":0.5,"failureRepeats":2,"fileEdits":3}}').visibility)
    .toEqual({ heartbeatMinutes: 0.5, failureRepeats: 2, fileEdits: 3 });
  for (const visibility of [null, [], { extra: 1 }, { heartbeatMinutes: 0 }, { failureRepeats: 1.5 }, { fileEdits: -1 }]) {
    expect(() => parseConfig(JSON.stringify({ visibility }))).toThrow();
  }
  const flags = parseArgs(["--brief", "--watch", "--interval", "3"], ["brief", "watch", "interval"]);
  expect(flags.bools.has("watch")).toBe(true);
  expect(flags.bools.has("brief")).toBe(true);
  expect(flags.flags.interval).toBe("3");
});

test("new stages stay quiet while thrash wakes and older events still parse", () => {
  for (const kind of ["gate-started", "gate-finished", "report-written", "progress", "thrash", "started"]) {
    expect(parseFeedEvent(JSON.stringify({ id: 1, timestamp: "now", kind, owner: "head", message: "event" }))?.kind).toBe(kind);
    expect(WAKE_EVENTS.has(kind as any)).toBe(kind === "thrash");
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
