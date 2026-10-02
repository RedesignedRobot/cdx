import { expect, test } from "bun:test";
import { dispatch } from "./commands.ts";
import { type Lane, storeLane, recentEvents } from "./ledger.ts";
import { expireRoundQuestions, readQuestions, storeQuestion } from "./questions.ts";

test("lane ask refuses test approval and question raises the head event", async () => {
  const previous = { CDX_LANE: process.env.CDX_LANE, CDX_ROUND: process.env.CDX_ROUND };
  process.env.CDX_LANE = "test-allowance-question";
  process.env.CDX_ROUND = "1";
  try {
    for (const question of [
      "Three test invocations are used. May I run it?",
      "I need one more test-run after correcting the failure.",
      "Please approve another test invocation.",
      "Requesting permission to rerun the gate.",
    ]) {
      await expect(dispatch("ask", [question])).rejects.toThrow('use cdx question "<question>" to ask the head (QUESTION event)');
      await expect(dispatch("ask", ["--cd", "/repo", question])).rejects.toThrow("cdx ask cannot grant permission");
    }
    expect(readQuestions("test-allowance-question")).toHaveLength(0);
    // A code question about permissions still reaches the code lookup's validation.
    await expect(dispatch("ask", ["Where is the permission check implemented?"])).rejects.toThrow("usage: cdx ask --cd");
    await dispatch("question", ["--timeout", "0.0001", "May I run one more test?"]);
    expect(recentEvents(1)[0]).toMatchObject({ kind: "question", lane: "test-allowance-question" });
    expect(readQuestions("test-allowance-question")[0]?.question).toBe("May I run one more test?");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

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
