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
  bandTable,
  bandText,
  orderedRows,
  pinnedLine,
  stageColor,
  type LiveRow,
} from "./delivery";

describe("delivery rules", () => {
  test("every polled event reaches head context and wake events toast", () => {
    const events = ["question", "terminal", "stalled", "thrash", "outage", "message", "job-exit"].map((kind) =>
      ({ kind, text: `[cdx] ${kind}`, wake: true }));
    const outcome = afterPoll(initialDeliveryState(), events, 1000);
    expect(outcome.state.pending).toEqual(events);
    expect(outcome.toasts).toHaveLength(7);
    expect(afterToolCall(outcome.state).context).toContain("[cdx] job-exit");
  });

  test("band rows keep hierarchy, elapsed round time and questions", () => {
    const now = Date.parse("2026-09-24T12:02:03Z");
    const startedAt = "2026-09-24T12:00:00Z";
    const parent = { name: "parent", kind: "lane" as const, engine: "gpt", model: "sol", effort: "high", stage: "gate", startedAt,
      steps: 12, files: 3, action: "bun test hooks/delivery.test.ts" };
    const child = { ...parent, name: "child", parent: "parent", stage: "question", question: "Which branch?" };
    expect(orderedRows([child, parent]).map((row) => row.name)).toEqual(["parent", "child"]);
    const [, parentLine, childLine] = bandTable(orderedRows([child, parent]), now, 120).map(bandText);
    expect(parentLine).toMatch(/^◆ parent +lane +sol +high +gate +2m3s +12 +3 +running bun test/);
    expect(childLine).toMatch(/^\?   child +lane +sol +high +question +2m3s +12 +3 +question: Which branch\?$/);
    expect(pinnedLine([parent, child], now)).toContain("2m3s");
  });

  const bandNow = Date.parse("2026-09-26T16:00:00Z");
  const bandRows: LiveRow[] = [
    { name: "m29-mixed", kind: "lane", engine: "gpt", model: "gpt-6-sol", effort: "high", stage: "working", startedAt: "2026-09-26T12:14:00Z",
      steps: 374, files: 8, action: "commandExecution: bun test src/nonbonded/mixed-precision.test.ts --timeout 600000" },
    { name: "m29-unified", kind: "lane", engine: "gpt", model: "gpt-6-astra", effort: "medium", stage: "gate", startedAt: "2026-09-26T12:13:00Z",
      steps: 331, files: 0, action: "agentMessage: Dead: the migration left two readers behind" },
    { name: "m29-resident", kind: "lane", engine: "gpt", model: "gpt-6-astra", effort: "medium", stage: "question", startedAt: "2026-09-26T12:13:00Z",
      steps: 235, files: 10, action: "", question: "merge candidate A or keep both kernels?" },
    { name: "ship-r123", kind: "job", engine: "job", stage: "working", startedAt: "2026-09-26T15:04:00Z",
      steps: 0, action: "publish-npm: + hsx@1.0.123" },
  ];
  const columnStart = (line: string, title: string) => line.indexOf(title);

  test("band columns fit the widest value, align under the header and right-align counts", () => {
    const lines = bandTable(bandRows, bandNow, 120).map(bandText);
    expect(lines[0]).toStartWith("  NAME          KIND  ENGINE       EFFORT  STAGE     AGE    STEPS  FILES  NOW");
    expect(lines[1]).toStartWith("● m29-mixed     lane  gpt-6-sol    high    working   3h46m    374      8  running bun test");
    expect(lines[2]).toStartWith("◆ m29-unified   lane  gpt-6-astra  medium  gate      3h47m    331      0  agentMessage: Dead");
    expect(lines[4]).toStartWith("● ship-r123     job   -            -       working   56m0s      -      -  publish-npm: + hsx@1.0.123");
    for (const line of lines.slice(1)) expect(line.charAt(columnStart(lines[0]!, "STAGE") - 1)).toBe(" ");
    expect(lines.every((line) => Array.from(line).length <= 120)).toBe(true);
  });

  test("NOW takes the rest of the width and truncates; NAME and ENGINE are capped", () => {
    const long = { ...bandRows[0]!, name: "a-very-long-lane-name-that-goes-on-and-on", model: "gpt-6-astra-extended-context" };
    const lines = bandTable([long], bandNow, 120).map(bandText);
    expect(lines[1]).toStartWith("● a-very-long-lane-name-that-…  lane  gpt-6-astra-exten…  high    working");
    expect(Array.from(lines[1]!)).toHaveLength(120);
    expect(lines[1]).toEndWith("…");
  });

  test("a narrow band drops EFFORT, then ENGINE, then KIND, and never exceeds the width", () => {
    const at = (columns: number) => bandTable(bandRows, bandNow, columns).map(bandText);
    expect(at(94)[0]).toContain("EFFORT");
    expect(at(90)[0]).not.toContain("EFFORT");
    expect(at(90)[0]).toContain("ENGINE");
    expect(at(75)[0]).not.toContain("EFFORT");
    expect(at(75)[0]).not.toContain("ENGINE");
    expect(at(75)[0]).toContain("KIND");
    expect(at(70)[0]).not.toContain("EFFORT");
    expect(at(70)[0]).not.toContain("ENGINE");
    expect(at(70)[0]).not.toContain("KIND");
    expect(at(70)[0]).toContain("NOW");
    for (const columns of [120, 75, 70, 40, 10]) expect(at(columns).every((line) => Array.from(line).length <= columns)).toBe(true);
  });

  test("band colours: NAME bold, STAGE by state, EFFORT, AGE and NOW dim, header dim", () => {
    expect(["working", "gate", "review", "question", "stalled", "outage", "queued", "reporting"].map(stageColor))
      .toEqual(["green", "cyan", "cyan", "yellow", "yellow", "red", undefined, undefined]);
    const [header, row] = bandTable([bandRows[2]!], bandNow, 140);
    expect(header!.every((cell) => cell.dim)).toBe(true);
    const cell = (prefix: string) => row!.find((item) => item.text.startsWith(prefix))!;
    expect(cell("?")).toMatchObject({ color: "yellow" });
    expect(cell("m29-resident")).toMatchObject({ bold: true });
    expect(cell("question ")).toMatchObject({ color: "yellow" });
    expect(cell("3h47m")).toMatchObject({ dim: true });
    expect(cell("medium")).toMatchObject({ dim: true });
    expect(row!.at(-1)).toMatchObject({ text: "question: merge candidate A or keep both kernels?", dim: true });
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
