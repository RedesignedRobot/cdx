import { expect, test } from "bun:test";
import { eventOwned, owned, parseFeedEvent, recipientOf } from "./cdx.ts";

// Keep only ownership and feed rules. Pass state explicitly so these tests
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
