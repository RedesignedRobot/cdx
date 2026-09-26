import { expect, test } from "bun:test";
import { afterCompaction, ROLLOVER_REASON, stopOutcome } from "./rollover";

test("the Stop after the third compaction blocks once, and a new session starts over", () => {
  const once = afterCompaction(undefined, "s1");
  expect(stopOutcome(once, "s1")).toBeUndefined();
  const twice = afterCompaction(once, "s1");
  expect(stopOutcome(twice, "s1")).toBeUndefined();
  const thrice = afterCompaction(twice, "s1");
  const blocked = stopOutcome(thrice, "s1")!;
  expect(blocked.block).toBe(ROLLOVER_REASON);
  expect(stopOutcome(blocked.state, "s1")).toBeUndefined();
  expect(stopOutcome(afterCompaction(blocked.state, "s1"), "s1")).toBeUndefined();
  expect(stopOutcome(thrice, "s2")).toBeUndefined();
  expect(afterCompaction(thrice, "s2")).toEqual({ session: "s2", compactions: 1, blocked: false });
});
