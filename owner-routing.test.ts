import { afterEach, expect, test } from "bun:test";
import { dispatch } from "./commands.ts";
import { TOOLS_BY_NAME } from "./hooks/tools.ts";
import {
  acknowledgeOwnerEvents, allowTakeover, deliverEvents, eventsAfter, feedEvent, findLane, type Lane, latestEventId,
  requireOwnChild, startSession, storeLane,
} from "./ledger.ts";
import { db } from "./store.ts";

// Every test starts with no sessions and the owner cursor at the newest
// event, so rows and events from other tests in this process never route.
function fresh(): number {
  db().query("DELETE FROM sessions").run();
  acknowledgeOwnerEvents(latestEventId());
  return latestEventId();
}

function poll(session: string, now: number): string[] {
  let texts: string[] = [];
  deliverEvents(session, now, false, (events) => { texts = events.map((event) => event.text); });
  return texts;
}

const question = (lane: string, owner: string) => feedEvent("question", `[cdx] lane=${lane} QUESTION #1`, owner, { lane, round: 1 });

const callerBefore = process.env.CLAUDE_CODE_SESSION_ID;
function callAs(session: string | undefined): void {
  if (session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = session;
}

afterEach(() => {
  callAs(callerBefore);
  allowTakeover(false);
});

test("two live heads each receive only the question from their own lane", () => {
  fresh();
  const t0 = Date.parse("2026-09-26T12:00:00Z");
  startSession("two-a", t0, true);
  startSession("two-b", t0 + 1_000, true);
  question("lane-a", "two-a");
  question("lane-b", "two-b");
  // two-b is the elected head; it still takes only its own lane's question.
  expect(poll("two-b", t0 + 2_000)).toEqual(["[cdx] lane=lane-b QUESTION #1"]);
  expect(poll("two-a", t0 + 2_000)).toEqual(["[cdx] lane=lane-a QUESTION #1"]);
  expect(poll("two-b", t0 + 4_000)).toEqual([]);
  expect(poll("two-a", t0 + 4_000)).toEqual([]);
});

test("the head takes a gone owner's event, and the owner's /resume never receives it again", () => {
  const since = fresh();
  const t0 = Date.parse("2026-09-26T13:00:00Z");
  startSession("gone-owner", t0, true);
  startSession("gone-head", t0 + 50_000, true);
  question("lane-g", "gone-owner");
  expect(poll("gone-head", t0 + 60_000)).toEqual(["[cdx] lane=lane-g QUESTION #1"]);
  expect(eventsAfter(since).map((event) => event.owner)).toEqual(["gone-head"]);
  // /resume keeps the session id; the event is the head's now.
  startSession("gone-owner", t0 + 61_000, true);
  expect(poll("gone-owner", t0 + 62_000)).toEqual([]);
  expect(poll("gone-head", t0 + 63_000)).toEqual([]);
});

test("an owner that dies before its next poll loses nothing: the head's cursor waits for it", () => {
  fresh();
  const t0 = Date.parse("2026-09-26T14:00:00Z");
  startSession("dies-owner", t0, true);
  startSession("dies-head", t0 + 1_000, true);
  question("lane-d", "dies-owner");
  // The owner is live, so the head skips the question and holds its cursor.
  expect(poll("dies-head", t0 + 2_000)).toEqual([]);
  // The owner never polls again; once it is gone the head takes the question.
  expect(poll("dies-head", t0 + 40_000)).toEqual(["[cdx] lane=lane-d QUESTION #1"]);
  expect(poll("dies-head", t0 + 42_000)).toEqual([]);
});

test("an owner that comes back before the head takes its event receives it once", () => {
  fresh();
  const t0 = Date.parse("2026-09-26T15:00:00Z");
  startSession("back-owner", t0, true);
  startSession("back-head", t0 + 1_000, true);
  question("lane-r", "back-owner");
  expect(poll("back-head", t0 + 2_000)).toEqual([]);
  expect(poll("back-owner", t0 + 50_000)).toEqual(["[cdx] lane=lane-r QUESTION #1"]);
  expect(poll("back-head", t0 + 51_000)).toEqual([]);
  expect(poll("back-owner", t0 + 52_000)).toEqual([]);
});

test("an unowned event goes to the head only, and a lane spawned before the owner's first poll reaches its owner", () => {
  fresh();
  const t0 = Date.parse("2026-09-26T16:00:00Z");
  startSession("un-head", t0, true);
  startSession("un-other", t0 + 1_000, false);
  question("lane-t", "terminal");
  expect(poll("un-other", t0 + 2_000)).toEqual([]);
  expect(poll("un-head", t0 + 2_000)).toEqual(["[cdx] lane=lane-t QUESTION #1"]);
  question("lane-l", "un-late");
  startSession("un-late", t0 + 3_000, false);
  expect(poll("un-head", t0 + 4_000)).toEqual([]);
  expect(poll("un-late", t0 + 4_000)).toEqual(["[cdx] lane=lane-l QUESTION #1"]);
  expect(poll("un-head", t0 + 5_000)).toEqual([]);
});

test("a live session cannot drive another live session's lane without --force", () => {
  fresh();
  startSession("guard-owner", Date.now());
  const lane = { ownerSession: "guard-owner" } as Lane;
  callAs("guard-other");
  expect(() => requireOwnChild("guarded", lane)).toThrow('lane "guarded" belongs to live Claude session guard-owner');
  callAs("guard-owner");
  requireOwnChild("guarded", lane);
  callAs(undefined);
  requireOwnChild("guarded", lane);
  callAs("guard-other");
  allowTakeover();
  requireOwnChild("guarded", lane);
  allowTakeover(false);
  // After a restart the old id is gone, so the new session needs no force.
  startSession("guard-gone", Date.now() - 60_000);
  requireOwnChild("guarded", { ownerSession: "guard-gone" } as Lane);
});

test("close refuses a foreign live lane, closes it with --force, and msg to a lane goes to its owner", async () => {
  const since = fresh();
  const at = new Date().toISOString();
  startSession("cmd-owner", Date.now());
  storeLane("owned-lane", { engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [], tokenAccounting: 1, ownerSession: "cmd-owner",
    ownerCwd: "/repo", work: { state: "done", cwd: "/repo", updatedAt: at }, createdAt: at, updatedAt: at } as unknown as Lane);
  callAs("cmd-other");
  await dispatch("msg", ["owned-lane", "hello"]);
  expect(eventsAfter(since).map((event) => [event.kind, event.owner])).toEqual([["message", "cmd-owner"]]);
  await expect(dispatch("close", ["owned-lane"])).rejects.toThrow("belongs to live Claude session cmd-owner");
  await dispatch("close", ["owned-lane", "--force"]);
  expect(findLane("owned-lane")?.work.state).toBe("closed");
});

test("the lane tools pass force through; other tools do not take it", () => {
  expect(TOOLS_BY_NAME.get("reply")!.run({ lane: "l1", answer: "yes", force: true }).argv).toEqual(["reply", "l1", "-", "--force"]);
  expect(TOOLS_BY_NAME.get("land")!.run({ lane: "l1" }).argv).toEqual(["land", "l1"]);
  expect((TOOLS_BY_NAME.get("kill")!.inputSchema.properties as Record<string, unknown>).force).toBeDefined();
  expect((TOOLS_BY_NAME.get("status")!.inputSchema.properties as Record<string, unknown>).force).toBeUndefined();
});
