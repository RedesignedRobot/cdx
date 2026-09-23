import { describe, expect, test } from "bun:test";
import {
  afterPoll,
  afterToolCall,
  clearBuffer,
  initialDeliveryState,
  onPromptSubmit,
  onSubmitRefused,
  onTurnComplete,
  onTurnStart,
  WAKE_COALESCE_MS,
  bandRow,
  headEvents,
  orderedRows,
  pinnedLine,
} from "./delivery";

describe("delivery rules", () => {
  test("progress stays available on demand but cannot wake or enter head context", () => {
    const events = [
      { kind: "progress", text: "[cdx] progress", wake: true },
      ...["question", "terminal", "stalled", "thrash", "outage", "message", "job-exit"].map((kind) =>
        ({ kind, text: `[cdx] ${kind}`, wake: true })),
    ];
    expect(headEvents(events).map((event) => event.kind)).toEqual(events.slice(1).map((event) => event.kind));
    const outcome = afterPoll(initialDeliveryState(), events, 1000);
    expect(outcome.state.pending).toEqual(events.slice(1));
    expect(outcome.state.progress).toEqual(events.slice(0, 1));
    expect(outcome.toasts).toHaveLength(7);
    expect(afterToolCall(outcome.state).context).not.toContain("progress");
  });

  test("an answered question notice reaches the head", () => {
    const event = { kind: "progress", text: "[cdx] answered question=alpha:r1:q2 answer=yes", wake: false };
    expect(headEvents([event])).toEqual([event]);
    const outcome = afterPoll(initialDeliveryState(), [event]);
    expect(afterToolCall(outcome.state).context).toContain(event.text);
  });

  test("a rejected steer notice reaches the head", () => {
    const event = { kind: "progress", text: "[cdx] lane=alpha round=1 steer rejected and retained: turn closed", wake: false };
    expect(headEvents([event])).toEqual([event]);
    const outcome = afterPoll(initialDeliveryState(), [event]);
    expect(afterToolCall(outcome.state).context).toContain(event.text);
  });

  test("band rows show hierarchy, elapsed round time, and questions within width", () => {
    const now = Date.parse("2026-09-24T12:02:03Z");
    const startedAt = "2026-09-24T12:00:00Z";
    const parent = { name: "parent", kind: "lane" as const, engine: "gpt", model: "sol", stage: "gate", startedAt,
      steps: 12, files: 3, action: "bun test hooks/delivery.test.ts" };
    const child = { ...parent, name: "child", parent: "parent", stage: "question", question: "Which branch?" };
    expect(orderedRows([child, parent]).map((row) => row.name)).toEqual(["parent", "child"]);
    expect(bandRow(parent, now, 120)).toContain("gate 2m3s 12 steps 3 files running bun test");
    expect(bandRow(child, now, 120)).toContain("  ? child");
    expect(bandRow(child, now, 50)).toHaveLength(50);
    expect(pinnedLine([parent, child], now)).toContain("2m3s");
  });
  test("a wake event submits a prompt only when no turn runs, after the coalesce window", () => {
    const idleState = initialDeliveryState();
    const event = { text: "[cdx] lane=alpha round=1 started", wake: true };
    const t0 = 1_000_000;

    const held = afterPoll(idleState, [event], t0);
    expect(held.submit).toBeUndefined();
    expect(held.state.wakeSince).toBe(t0);
    expect(held.state.pending).toEqual([event]);

    const idleOutcome = afterPoll(held.state, [], t0 + WAKE_COALESCE_MS);
    expect(idleOutcome.submit).toBeDefined();
    expect(idleOutcome.submit?.text.startsWith("[cdx]")).toBe(true);
    expect(idleOutcome.submit?.text).toContain("lane=alpha round=1 started");
    expect(idleOutcome.state.pending).toHaveLength(0);
    expect(idleOutcome.state.wakeSince).toBeUndefined();
    expect(idleOutcome.state.submits).toBe(1);

    const busyState = { ...initialDeliveryState(), inTurn: true };
    const busyOutcome = afterPoll(busyState, [event], t0);
    expect(busyOutcome.submit).toBeUndefined();
    expect(busyOutcome.state.pending).toEqual([event]);
  });

  test("a burst of wake events costs one prompt", () => {
    const t0 = 1_000_000;
    let state = initialDeliveryState();
    const lanes = ["a", "b", "c"].map((lane) => ({ text: `[cdx] lane=${lane} finished`, wake: true }));
    let submits = 0;
    for (const [index, event] of lanes.entries()) {
      const outcome = afterPoll(state, [event], t0 + index * 4_000);
      state = outcome.state;
      if (outcome.submit) submits += 1;
    }
    const flush = afterPoll(state, [], t0 + WAKE_COALESCE_MS);
    if (flush.submit) submits += 1;
    expect(submits).toBe(1);
    expect(flush.submit?.text).toBe("[cdx] lane=a finished\n[cdx] lane=b finished\n[cdx] lane=c finished");
    expect(flush.state.submits).toBe(1);
  });

  test("a turn start drops the held wake so the tool result carries it", () => {
    const t0 = 1_000_000;
    const held = afterPoll(initialDeliveryState(), [{ text: "[cdx] lane=a finished", wake: true }], t0);
    const running = onTurnStart(held.state);
    expect(running.wakeSince).toBeUndefined();
    expect(afterToolCall(running).context).toContain("lane=a finished");
  });

  test("a budget refusal ends submitting and suggests fresh wakes instead", () => {
    const t0 = 1_000_000;
    const event = { text: "[cdx] lane=a finished", wake: true };
    const held = afterPoll(initialDeliveryState(), [event], t0);
    const sent = afterPoll(held.state, [], t0 + WAKE_COALESCE_MS);
    expect(sent.submit).toBeDefined();

    const refused = onSubmitRefused(sent.state, [event], "cdx: $.prompt.submit refused: 50 prompts this session is the budget");
    expect(refused.budgetSpent).toBe(true);
    expect(refused.pending).toEqual([event]);
    expect(refused.submits).toBe(0);

    // No retry on the next polls, however long the session idles.
    const quiet = afterPoll(refused, [], t0 + 10 * WAKE_COALESCE_MS);
    expect(quiet.submit).toBeUndefined();
    expect(quiet.suggest).toBeUndefined();
    expect(quiet.state.pending).toEqual([event]);

    // A fresh wake goes to the prompt box; the buffer still drains on a tool result.
    const later = { text: "[cdx] lane=b asks a question", wake: true };
    const nudged = afterPoll(quiet.state, [later], t0 + 11 * WAKE_COALESCE_MS);
    expect(nudged.submit).toBeUndefined();
    expect(nudged.suggest?.text).toBe("[cdx] lane=a finished\n[cdx] lane=b asks a question");
    expect(afterToolCall(nudged.state).context).toContain("lane=b asks a question");
  });

  test("a transient refusal is retried after the coalesce window", () => {
    const t0 = 1_000_000;
    const event = { text: "[cdx] lane=a finished", wake: true };
    const sent = afterPoll({ ...initialDeliveryState(), pending: [event], wakeSince: t0 - WAKE_COALESCE_MS }, [], t0);
    expect(sent.submit).toBeDefined();
    const refused = onSubmitRefused(sent.state, [event], "a dialog holds the keys");
    expect(refused.budgetSpent).toBe(false);
    const retry = afterPoll(refused, [], t0 + WAKE_COALESCE_MS + 1);
    expect(retry.submit).toBeUndefined();
    expect(afterPoll(retry.state, [], t0 + 2 * WAKE_COALESCE_MS + 1).submit).toBeDefined();
  });

  test("a quiet event waits for the next tool result", () => {
    const idleState = initialDeliveryState();
    const quietEvent = { text: "gemini quota: exhausted until 14:00", wake: false };

    const pollOutcome = afterPoll(idleState, [quietEvent]);
    expect(pollOutcome.submit).toBeUndefined();
    expect(pollOutcome.state.pending).toEqual([quietEvent]);

    const toolOutcome = afterToolCall(pollOutcome.state);
    expect(toolOutcome.context).toBeDefined();
    expect(toolOutcome.context?.startsWith("[cdx] events\n")).toBe(true);
    expect(toolOutcome.context).toContain("gemini quota: exhausted until 14:00");
    expect(toolOutcome.state.pending).toHaveLength(0);
  });

  test("a subagent tool call never drains", () => {
    const state = {
      ...initialDeliveryState(),
      pending: [{ text: "[cdx] lane=child round=1 finished", wake: true }],
      inTurn: true,
    };

    const outcome = afterToolCall(state, { isSubagent: true });
    expect(outcome.context).toBeUndefined();
    expect(outcome.state.pending).toHaveLength(1);
    expect(outcome.state.pending[0]?.text).toBe("[cdx] lane=child round=1 finished");
  });

  test("prompt submission drains pending events into context", () => {
    const state = {
      ...initialDeliveryState(),
      pending: [{ text: "[cdx] lane=beta round=1 started", wake: false }],
    };

    const outcome = onPromptSubmit(state);
    expect(outcome.context).toBe("[cdx] events\n[cdx] lane=beta round=1 started");
    expect(outcome.state.pending).toHaveLength(0);

    const emptyOutcome = onPromptSubmit(outcome.state);
    expect(emptyOutcome.context).toBeUndefined();
  });

  test("turn transitions track running turn state", () => {
    const state = initialDeliveryState();
    expect(state.inTurn).toBe(false);

    const running = onTurnStart(state);
    expect(running.inTurn).toBe(true);

    const completed = onTurnComplete(running);
    expect(completed.inTurn).toBe(false);
  });

  test("wake events yield toasts during poll", () => {
    const state = initialDeliveryState();
    const events = [
      { text: "[cdx] wake notification", wake: true },
      { text: "quiet progress sample", wake: false },
    ];

    const outcome = afterPoll(state, events);
    expect(outcome.toasts).toEqual(["[cdx] wake notification"]);
  });

  test("clearBuffer removes all pending events", () => {
    const state = {
      ...initialDeliveryState(),
      pending: [
        { text: "event 1", wake: false },
        { text: "event 2", wake: true },
      ],
    };

    const cleared = clearBuffer(state);
    expect(cleared.pending).toHaveLength(0);
  });
});
