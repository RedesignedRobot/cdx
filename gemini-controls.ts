import type { ControlRecord } from "./questions.ts";

export interface GeminiControlLane { callLimitHit?: boolean; steers?: number; updatedAt?: string }

export function drainGeminiControls(path: string, turnActive: boolean, hooksInstalled: boolean, io: {
  exists: (path: string) => boolean;
  lines: (path: string) => string[];
  deliveredCount: () => number;
  markDelivered: (count: number) => void;
  callLimitHit: () => boolean;
  withLane: (action: (lane: GeminiControlLane | undefined) => void) => void;
  deliver: (record: ControlRecord) => void;
  now: () => string;
}): void {
  // A quiet Gemini turn polls this path every 250 ms. Do not take the ledger
  // lock unless a control record can be delivered now: a steer queued during
  // an active hooked turn waits for the turn to end without touching the lock.
  if (turnActive && hooksInstalled) return;
  if (!io.exists(path) || io.deliveredCount() >= io.lines(path).length) return;
  // A lane past its call limit never delivers again, so its queued steers
  // stay undelivered; check with a plain read before taking the write lock.
  if (io.callLimitHit()) return;
  const toDeliver: ControlRecord[] = [];
  io.withLane((lane) => {
    if (lane?.callLimitHit || !io.exists(path)) return;
    const lines = io.lines(path);
    const delivered = io.deliveredCount();
    if (delivered >= lines.length) return;
    for (let i = delivered; i < lines.length; i++) {
      let record: ControlRecord;
      try { record = JSON.parse(lines[i]!) as ControlRecord; } catch { continue; }
      if (typeof record.text !== "string" || !record.text.trim()) continue;
      toDeliver.push(record);
    }
    io.markDelivered(lines.length);
    if (lane && toDeliver.length) {
      lane.steers = (lane.steers ?? 0) + toDeliver.length;
      lane.updatedAt = io.now();
    }
  });
  for (const record of toDeliver) io.deliver(record);
}
