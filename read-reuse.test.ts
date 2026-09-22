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
