import { expect, test } from "bun:test";
import type { Lane, Ledger } from "./ledger.ts";
import { laneOutcomes } from "./outcomes.ts";

const lane = (overrides: Partial<Lane>): Lane => ({
  engine: "gpt", model: "gpt-6-sol", kind: "work", rounds: 1, workRounds: 1, reports: [], effort: "medium",
  work: { state: "closed", cwd: "/repo", exitCode: 0 }, worktreeRepo: "/repo", createdAt: "", updatedAt: "", ...overrides,
});

test("first-round green and landed counts per engine role and per repo", () => {
  const ledger: Ledger = {
    first: lane({ landedCommit: "a" }),
    second: lane({ landedCommit: "b", workRounds: 3, rounds: 4 }),
    red: lane({ work: { state: "failed", cwd: "/repo", exitCode: 1 } }),
    running: lane({ work: { state: "running", cwd: "/repo" } }),
    consult: lane({ consult: true }),
    child: lane({ engine: "gemini", model: undefined, parent: "boss", landedCommit: "c", worktreeRepo: "/other" }),
    boss: lane({ model: "gpt-6-astra", supervisor: true, workRounds: 2 }),
    review: lane({ kind: "review", workRounds: 0 }),
  };
  const outcomes = laneOutcomes(ledger);
  expect(outcomes.byEngine["sol direct"]).toEqual({
    lanes: 3, green: 2, landed: 2, firstRoundGreenLanded: 1, firstRoundGreenLandedShare: 0.333, meanRoundsToGreen: 2,
  });
  expect(outcomes.byEngine["gemini child"]?.firstRoundGreenLandedShare).toBe(1);
  expect(outcomes.byEngine["astra supervisor"]).toMatchObject({ lanes: 1, green: 1, landed: 0, meanRoundsToGreen: 2 });
  expect(outcomes.byRepo["/repo"]?.lanes).toBe(4);
  expect(outcomes.byRepo["/other"]?.lanes).toBe(1);
});
