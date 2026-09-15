import { describe, expect, test } from "bun:test";
import {
  afterPoll,
  afterToolCall,
  clearBuffer,
  initialDeliveryState,
  onPromptSubmit,
  onTurnComplete,
  onTurnStart,
} from "./delivery";

describe("delivery rules", () => {
  test("a wake event submits a prompt only when no turn runs", () => {
    const idleState = initialDeliveryState();
    const event = { text: "[cdx] lane=alpha round=1 started", wake: true };

    const idleOutcome = afterPoll(idleState, [event]);
    expect(idleOutcome.submit).toBeDefined();
    expect(idleOutcome.submit?.text.startsWith("[cdx]")).toBe(true);
    expect(idleOutcome.submit?.text).toContain("lane=alpha round=1 started");
    expect(idleOutcome.state.pending).toHaveLength(0);

    const busyState = { ...initialDeliveryState(), inTurn: true };
    const busyOutcome = afterPoll(busyState, [event]);
    expect(busyOutcome.submit).toBeUndefined();
    expect(busyOutcome.state.pending).toEqual([event]);
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
      pending: [{ text: "[cdx] lane=beta round=1 started", wake: false }],
      inTurn: false,
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
      pending: [
        { text: "event 1", wake: false },
        { text: "event 2", wake: true },
      ],
      inTurn: false,
    };

    const cleared = clearBuffer(state);
    expect(cleared.pending).toHaveLength(0);
  });
});
