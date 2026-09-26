import { expect, test } from "bun:test";
import { drainGeminiControls } from "./gemini-controls.ts";

test("a quiet Gemini turn avoids ledger transactions until an undelivered control arrives", () => {
  const path = "/control/lane-r1.jsonl";
  const lane = { steers: 0, updatedAt: "" };
  let fileExists = false;
  let lines: string[] = [];
  let deliveredCount = 0;
  let transactions = 0;
  const received: string[] = [];
  const io = {
    exists: () => fileExists,
    lines: () => lines,
    deliveredCount: () => deliveredCount,
    markDelivered: (count: number) => { deliveredCount = count; },
    withLane: (action: (value: typeof lane) => void) => {
      transactions++;
      if (transactions > 3) throw new Error("ledger transaction budget exceeded within one second of quiet polling");
      action(lane);
    },
    deliver: (record: { text: string }) => { received.push(record.text); },
    now: () => "2026-09-26T10:57:09Z",
  };
  // The last recorded Gemini event is a completed tool step. No result follows.
  for (let tick = 0; tick < 4; tick++) drainGeminiControls(path, true, false, io);
  expect(transactions).toBe(0);

  fileExists = true;
  lines = [JSON.stringify({ text: "continue", sentAt: "2026-09-26T10:57:10Z" })];
  drainGeminiControls(path, true, false, io);
  expect(received).toEqual(["continue"]);
  expect(lane.steers).toBe(1);
  expect(transactions).toBe(1);
  for (let tick = 0; tick < 100; tick++) drainGeminiControls(path, true, false, io);
  expect(transactions).toBe(1);
});

test("a steer queued during an active hooked turn waits without ledger transactions", () => {
  let transactions = 0;
  const received: string[] = [];
  let deliveredCount = 0;
  const io = {
    exists: () => true,
    lines: () => [JSON.stringify({ text: "addendum", sentAt: "2026-09-26T10:59:00Z" })],
    deliveredCount: () => deliveredCount,
    markDelivered: (count: number) => { deliveredCount = count; },
    withLane: (action: (value: { steers?: number }) => void) => { transactions++; action({}); },
    deliver: (record: { text: string }) => { received.push(record.text); },
    now: () => "2026-09-26T11:00:00Z",
  };
  for (let tick = 0; tick < 100; tick++) drainGeminiControls("/control/lane-r1.jsonl", true, true, io);
  expect(transactions).toBe(0);
  drainGeminiControls("/control/lane-r1.jsonl", false, true, io);
  expect(received).toEqual(["addendum"]);
  expect(transactions).toBe(1);
});
