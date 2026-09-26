import { expect, test } from "bun:test";
import { afterCompaction, ROLLOVER_REASON, stopOutcome } from "./rollover";

test("the Stop after the second compaction blocks once, and a new session starts over", () => {
  const once = afterCompaction(undefined, "s1");
  expect(stopOutcome(once, "s1")).toBeUndefined();
  const twice = afterCompaction(once, "s1");
  const blocked = stopOutcome(twice, "s1")!;
  expect(blocked.block).toBe(ROLLOVER_REASON);
  expect(stopOutcome(blocked.state, "s1")).toBeUndefined();
  expect(stopOutcome(afterCompaction(blocked.state, "s1"), "s1")).toBeUndefined();
  expect(stopOutcome(twice, "s2")).toBeUndefined();
  expect(afterCompaction(twice, "s2")).toEqual({ session: "s2", compactions: 1, blocked: false });
});
