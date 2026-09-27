import { expect, test } from "bun:test";
import { dispatch } from "./commands.ts";
import { type Lane, storeLane } from "./ledger.ts";
import { expireRoundQuestions, readQuestions, storeQuestion } from "./questions.ts";

// A lane whose engine finished its last turn and is waiting on its gate: the
// runner is alive, steering is closed.
function gatingLane(lane: string): void {
  const at = new Date().toISOString();
  storeLane(lane, { engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [], tokenAccounting: 1, pid: process.pid,
    stage: "gate", steerOpen: false, work: { state: "running", cwd: "/repo", updatedAt: at }, createdAt: at, updatedAt: at } as unknown as Lane);
}

test("a question left open when the engine's turns end expires, and a reply to it says the answer cannot land", async () => {
  gatingLane("gating-lane");
  storeQuestion({ lane: "gating-lane", round: 1, seq: 4, question: "build part 2?", askedAt: new Date().toISOString(), answered: false });
  expireRoundQuestions("gating-lane", 1);
  await expect(dispatch("reply", ["gating-lane", "--id", "4", "build it"])).rejects.toThrow('lane "gating-lane" question #4 expired: its engine finished its turns');
  await expect(dispatch("reply", ["gating-lane", "build it"])).rejects.toThrow("question #4 expired");
  expect(readQuestions("gating-lane")[0]!.answered).toBe(false);
});

test("a send to a lane past its last turn names the stage and the way to stop it", async () => {
  gatingLane("finishing-lane");
  await expect(dispatch("send", ["finishing-lane", "stop the build"])).rejects.toThrow(
    'lane "finishing-lane" is finishing (stage gate): its engine has no turn left to read steering. Act on its report when it settles, or cdx kill finishing-lane to stop it now');
});
