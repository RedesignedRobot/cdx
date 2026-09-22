import { expect, test } from "bun:test";
import { roundTools } from "./engines.ts";
import { writeProtocolEvent } from "./reports.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";

test("identical Gemini reads collapse in stored transcripts without a head wake", () => {
  let hash: string | null = "first";
  const track = roundTools("/repo", VISIBILITY_DEFAULTS, () => hash);
  const event = (step: number, end = 5, state = "DONE") => ({ event: "step_update", step_update: {
    step_index: step, step_type: "tool", state, tool_name: "view_file",
    tool_info: { parameters: { AbsolutePath: "/repo/file.ts", EndLine: end }, output: "original body" },
  } });
  const first = event(1);
  track(first, "now");
  const repeated = event(2);
  const result = track(repeated, "now")!;
  let stored = "";
  writeProtocolEvent({ write(text) { stored += text; }, flush() {} }, repeated);
  expect(first.step_update.tool_info.output).toBe("original body");
  expect(JSON.parse(stored).step_update.tool_info.output).toBe("unchanged since step 1");
  expect(result.record).toMatchObject({ reusedFromStep: 1, outputBytes: 13 });
  expect(result.thrash).toBeUndefined();
  const changedRange = event(3, 8);
  track(changedRange, "now");
  expect(changedRange.step_update.tool_info.output).toBe("original body");
  hash = "changed";
  const changedFile = event(4);
  track(changedFile, "now");
  expect(changedFile.step_update.tool_info.output).toBe("original body");
  hash = null;
  const missing = event(5);
  track(missing, "now");
  expect(missing.step_update.tool_info.output).toBe("original body");
  hash = "first";
  const failed = event(6, 5, "ERROR");
  track(failed, "now");
  expect(failed.step_update.tool_info.output).toBe("original body");
  const nextRound = event(7);
  roundTools("/repo", VISIBILITY_DEFAULTS, () => hash)(nextRound, "now");
  expect(nextRound.step_update.tool_info.output).toBe("original body");
});

import { unchangedRead, invocationPolicy } from "./questions.ts";

test("a pre-tool read is denied only for covered content from a successful unchanged read", () => {
  const record = { type: "cdx_tool", toolKind: "read", step: 7, readFiles: { "/repo/a.ts": "hash" }, readRange: { start: 1, end: 30 } };
  expect(unchangedRead([record], "/repo/a.ts", "hash", 10, 20)).toContain("unchanged since step 7");
  expect(unchangedRead([record], "/repo/a.ts", "edited", 10, 20)).toBeUndefined();
  expect(unchangedRead([record], "/repo/a.ts", "hash", 10, 31)).toBeUndefined();
  expect(unchangedRead([{ ...record, failed: true }], "/repo/a.ts", "hash", 10, 20)).toBeUndefined();
  expect(unchangedRead([{ ...record, readFilesAfter: { "/repo/a.ts": "changed" } }], "/repo/a.ts", "hash", 10, 20)).toBeUndefined();
});

test("Gemini requests a handoff before terminating at 250 calls", () => {
  expect(invocationPolicy(239)).toEqual({});
  expect(invocationPolicy(240).injectSteps?.[0]?.userMessage).toContain("handoff report");
  expect(invocationPolicy(249).terminationBehavior).toBeUndefined();
  expect(invocationPolicy(250).terminationBehavior).toBe("terminate");
});
