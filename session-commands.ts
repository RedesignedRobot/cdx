// Session events and brief commands.

import { geminiQuotaState } from "./gemini-usage.ts";
import { markJobOverruns, readJobs, renderJobLine, summaryJobs } from "./jobs.ts";
import { markOverrun, overrunNotice } from "./duration.ts";
import {
  activeStateOf, callerSession, deliverEvents, feedEvent, laneRunning,
  markBrief, readLedger, readSession, recentEvents, renderEvent, roundReportOf, startSession,
  withLedger,
} from "./ledger.ts";
import { questionOpen, readQuestions } from "./questions.ts";
import { fail, parseArgs, ROOT } from "./runtime.ts";
import { liveRows } from "./status.ts";
import { write } from "./store.ts";
import { createHash } from "node:crypto";

export async function eventsCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["json", "peek", "snapshot"]);
  if (parsed.rest.length || (parsed.bools.has("snapshot") && !parsed.bools.has("json"))) fail("usage: cdx events [--json] [--peek] [--snapshot with --json]");
  const session = callerSession();
  if (!session || session === "terminal") fail("cdx events needs a Claude session");
  const json = parsed.bools.has("json");
  const peek = parsed.bools.has("peek");

  const now = Date.now();
  if (!peek) monitorOverruns(now);
  deliverEvents(session, now, peek, (events) => {
    if (json) {
      let rows: ReturnType<typeof liveRows> | undefined;
      if (parsed.bools.has("snapshot")) {
        try { rows = liveRows(now); } catch { /* Events still return when display state is unavailable. */ }
      }
      console.log(JSON.stringify({ session, events, ...(rows ? { rows, now } : {}) }));
    } else if (events.length > 0) {
      console.log(events.map((e) => e.text).join("\n"));
    }
  });
}

// The head calls events throughout a lane's life. This path still runs while
// a synchronous gate blocks the runner's own watchdog.
export function monitorOverruns(now: number): void {
  const due = Object.entries(readLedger()).filter(([, entry]) => laneRunning(entry) && !entry.overrunSent
    && entry.expectMinutes && overrunNotice(entry.roundStartedAt ?? entry.createdAt, entry.expectMinutes, now));
  if (due.length) {
    const notices = withLedger((current) => due.flatMap(([name, original]) => {
      const entry = current[name];
      if (!entry || !laneRunning(entry) || !entry.expectMinutes || entry.rounds !== original.rounds
        || (entry.roundStartedAt ?? entry.createdAt) !== (original.roundStartedAt ?? original.createdAt)) return [];
      const notice = markOverrun(entry, entry.roundStartedAt ?? entry.createdAt, entry.expectMinutes, now, entry.lastAction,
        entry.stage === "gate" ? `${ROOT}/logs/${name}-r${entry.rounds}.gate.log` : `${ROOT}/logs/${name}-r${entry.rounds}.jsonl`,
        entry.lastActionAt ?? entry.roundStartedAt ?? entry.createdAt);
      if (!notice) return [];
      const record = entry.kind === "review" ? entry.review : entry.work;
      if (record) record.overrunSent = true;
      return [{ name, round: entry.rounds, owner: entry.ownerSession, notice }];
    }));
    for (const item of notices) feedEvent("overrun", `[cdx] lane=${item.name} round=${item.round} overrun ${item.notice}`, item.owner, { lane: item.name, round: item.round });
  }
  for (const item of markJobOverruns(now, () => true)) {
    feedEvent("overrun", `[cdx] job=${item.name} overrun ${item.notice}`, item.owner, { job: item.name });
  }
}

// Finished jobs older than this stay out of the brief: a release job that
// failed three days ago is history the head already handled, and cdx job
// still lists it.
const BRIEF_FINISHED_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The brief lands in the head's context on every session start, resume and
// compaction, so it carries the running lanes and only the few most recent
// finished ones; a session that never closed forty old lanes used to reread
// all forty each time.
const BRIEF_FINISHED_SHOWN = 5;

function sessionSummary(): string {
  const ledger = readLedger();
  const open = Object.entries(ledger).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
  const finished = open.filter(([, entry]) => !laneRunning(entry));
  const hidden = Math.max(0, finished.length - BRIEF_FINISHED_SHOWN);
  const lines = [...open.filter(([, entry]) => laneRunning(entry)), ...finished.slice(0, BRIEF_FINISHED_SHOWN)]
    .map(([lane, entry]) => `lane=${lane} round=${entry.rounds} kind=${entry.kind} state=${activeStateOf(entry)} report=${roundReportOf(entry) ?? "-"}${laneRunning(entry) ? "" : " awaiting attention; close when handled"}`);
  if (hidden > 0) lines.push(`${hidden} older finished lanes not closed; cdx status --all lists them`);
  for (const record of readQuestions()) {
    const entry = ledger[record.lane];
    if (entry && entry.rounds === record.round && questionOpen(record)) {
      lines.push(`lane=${record.lane} r${record.round} QUESTION #${record.seq}: ${record.question}; cdx reply ${record.lane} --id ${record.seq} "<answer>"`);
    }
  }
  for (const [name, job] of summaryJobs(readJobs(), BRIEF_FINISHED_SHOWN, BRIEF_FINISHED_JOB_MAX_AGE_MS)) lines.push(renderJobLine(name, job));
  return lines.join("\n");
}

// A plugin reload registers a fresh hook instance beside the live ones, and
// every instance asks for the brief at its session start; the head then
// reads the same brief once per instance. The same text within this window
// for the same session prints nothing.
const BRIEF_REPEAT_WINDOW_MS = 10 * 60 * 1000;

function briefRepeated(session: string, text: string, now = Date.now()): boolean {
  const hash = createHash("sha256").update(text).digest("hex");
  return write(() => {
    const record = readSession(session);
    const repeated = record?.brief_hash === hash && record.brief_at !== null && now - Date.parse(record.brief_at) < BRIEF_REPEAT_WINDOW_MS;
    if (!repeated) markBrief(session, hash, now);
    return repeated;
  });
}

// Session start, resume and compaction run the brief, so the calling session
// becomes the head that receives events from here on.
export function briefCommand() {
  const quotaState = geminiQuotaState();
  if (quotaState.block) console.log(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
  const session = callerSession();
  if (session !== "terminal") startSession(session);
  const summary = sessionSummary();
  if (summary && !briefRepeated(session, summary)) console.log(summary);
}

export function feedCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["n"]);
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  console.log(recentEvents(limit).map(renderEvent).join("\n"));
}
