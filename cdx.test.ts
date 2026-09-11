import "./visibility.test.ts";
import "./status-progress.test.ts";
import { expect, test } from "bun:test";
import { checkRoundCap, eventOwned, owned, parseArgs, parseConfig, parseFeedEvent, recipientOf, roundCapRefusal } from "./cdx.ts";

// Keep tests pure. Pass state explicitly so these tests
// never read user files, spawn engines, or wait on timers.
const state = {
  sequence: 0,
  bindings: { "former-head": "current-head" },
  lanes: { claimed: "lane-head", unclaimed: "former-head", detached: "terminal" },
  sessions: {},
  heads: {},
};

test("feed parsing requires a valid envelope before accepting a record", () => {
  const event = { id: 1, timestamp: "2026-09-07T00:00:00Z", kind: "question", owner: "head", message: "Which file?" };
  expect(parseFeedEvent(JSON.stringify(event))).toEqual(event);
  for (const line of ["", "[cdx] old free-text record", "{", "null", "[]", "42"]) {
    expect(parseFeedEvent(line)).toBeUndefined();
  }
  for (const patch of [
    { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: "1" },
    { timestamp: null }, { owner: null }, { message: null }, { kind: "unknown" },
  ]) {
    expect(parseFeedEvent(JSON.stringify({ ...event, ...patch }))).toBeUndefined();
  }
});

test("a lane claim overrides its recorded owner and that owner's takeover", () => {
  expect(recipientOf("former-head", "claimed", state)).toBe("lane-head");
  expect(owned("former-head", "claimed", "lane-head", state)).toBe(true);
  expect(owned("former-head", "claimed", "current-head", state)).toBe(false);
});

test("a session takeover redirects both lane owners and owner-only records", () => {
  expect(recipientOf("former-head", undefined, state)).toBe("current-head");
  expect(owned("former-head", "unclaimed", "current-head", state)).toBe(true);
  expect(owned("former-head", "unclaimed", "former-head", state)).toBe(false);
});

test("terminal ownership survives an absent owner or an explicit lane claim", () => {
  expect(recipientOf(undefined, undefined, state)).toBe("terminal");
  expect(owned("former-head", "detached", "terminal", state)).toBe(true);
  expect(owned("former-head", "detached", "current-head", state)).toBe(false);
});

test("ownership compares full session ids even when prefixes collide", () => {
  const owner = "12345678-1111-4111-8111-111111111111";
  const other = "12345678-2222-4222-8222-222222222222";
  expect(owned(owner, undefined, owner, state)).toBe(true);
  expect(owned(owner, undefined, other, state)).toBe(false);
  expect(owned(owner, undefined, "12345678", state)).toBe(false);
});

test("a peer message reaches its recipient rather than its sender or message text", () => {
  const event = parseFeedEvent(JSON.stringify({
    id: 2, timestamp: "2026-09-07T00:00:00Z", kind: "message",
    owner: "sender", recipient: "former-head", from: "sender", message: "owner=sender recipient=someone-else",
  }))!;
  expect(eventOwned(event, "current-head", state)).toBe(true);
  expect(eventOwned(event, "sender", state)).toBe(false);
  expect(eventOwned(event, "someone-else", state)).toBe(false);
});

test("config parsing reads gemini.maxRounds and defaults to 2", () => {
  const empty = parseConfig("{}");
  expect(empty.gemini?.maxRounds).toBe(2);

  const custom = parseConfig(JSON.stringify({ gemini: { maxRounds: 4 } }));
  expect(custom.gemini?.maxRounds).toBe(4);

  const partial = parseConfig(JSON.stringify({ gemini: { model: "custom-gemini" } }));
  expect(partial.gemini?.maxRounds).toBe(2);
  expect(partial.gemini?.model).toBe("custom-gemini");
});

test("config parsing reads gemini.maxRuntimeMins and defaults to 90", () => {
  const empty = parseConfig("{}");
  expect(empty.gemini?.maxRuntimeMins).toBe(90);
  const custom = parseConfig(JSON.stringify({ gemini: { maxRuntimeMins: 30 } }));
  expect(custom.gemini?.maxRuntimeMins).toBe(30);
  for (const bad of [0, -5, "90", null]) {
    expect(() => parseConfig(JSON.stringify({ gemini: { maxRuntimeMins: bad } }))).toThrow("gemini.maxRuntimeMins must be a positive number of minutes");
  }
});

test("config parsing rejects invalid gemini.maxRounds values", () => {
  for (const bad of [0, -1, 1.5, "2", null, []]) {
    expect(() => parseConfig(JSON.stringify({ gemini: { maxRounds: bad } }))).toThrow("gemini.maxRounds must be a positive integer");
  }
});

test("round cap refusal formats exact refusal message", () => {
  expect(roundCapRefusal("worker-lane", 2)).toBe(
    "round cap 2 reached for worker-lane: close it and spawn a new lane with the failure attached"
  );
  expect(roundCapRefusal("hs-cell-9", 5)).toBe(
    "round cap 5 reached for hs-cell-9: close it and spawn a new lane with the failure attached"
  );
});

test("checkRoundCap refuses gemini lanes at or above the round cap", () => {
  expect(() => checkRoundCap("gemini-lane", "gemini", 2, 2)).toThrow(
    "round cap 2 reached for gemini-lane: close it and spawn a new lane with the failure attached"
  );
  expect(() => checkRoundCap("gemini-lane", "gemini", 3, 2)).toThrow(
    "round cap 2 reached for gemini-lane: close it and spawn a new lane with the failure attached"
  );
  // Work rounds only: a lane at rounds 2 with one review round has workRounds 1.
  expect(() => checkRoundCap("gemini-lane", "gemini", 1, 2)).not.toThrow();
});

test("checkRoundCap does not cap Astra or GPT lanes", () => {
  expect(() => checkRoundCap("gpt-lane", "gpt", 2, 2)).not.toThrow();
  expect(() => checkRoundCap("gpt-lane", "gpt", 5, 2)).not.toThrow();
  expect(() => checkRoundCap("gpt-lane", "gpt", 100, 2)).not.toThrow();
});

test("parseArgs parses --pre flag for spawn and resume", () => {
  const spawnArgs = parseArgs(
    ["lane-1", "--pre", "bun qa.ts readiness-check --release abc", "task brief"],
    ["pre"]
  );
  expect(spawnArgs.flags.pre).toBe("bun qa.ts readiness-check --release abc");
  expect(spawnArgs.rest).toEqual(["lane-1", "task brief"]);

  const resumeArgs = parseArgs(
    ["lane-1", "--pre", "make test", "follow up"],
    ["pre"]
  );
  expect(resumeArgs.flags.pre).toBe("make test");
  expect(resumeArgs.rest).toEqual(["lane-1", "follow up"]);
});

test("parseArgs rejects --pre without a value or when disallowed", () => {
  expect(() => parseArgs(["lane-1", "--pre"], ["pre"])).toThrow("--pre needs a value");
  expect(() => parseArgs(["lane-1", "--pre", "cmd"], [])).toThrow("--pre is not valid for this command");
});
