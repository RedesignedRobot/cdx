// Session events, progress digests, takeover, and brief commands.

import { config } from "./config.ts";
import { geminiQuotaState } from "./gemini-usage.ts";
import { jobRunning, readJobs, renderJobLine, summaryJobs } from "./jobs.ts";
import {
  activeStateOf, callerSession, delivery, type FeedEvent, laneRunning, owned, readEvents, readLedger,
  readSessions, recipientOf, roundReportOf, scopedEvents, selectEvents, withEvents, withLedger,
} from "./ledger.ts";
import { questionFiles, questionOpen } from "./questions.ts";
import { jobPhase } from "./reports.ts";
import { fail, parseArgs, ROOT, singleLine, statusAge, statusText } from "./runtime.ts";
import { changedFileCount } from "./status.ts";
import { liveView, renderView, tuiEnabled } from "./tui.ts";
import { digestLines, heartbeatDue, type ProgressSample, VISIBILITY_DEFAULTS } from "./visibility.ts";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

export async function eventsCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["json", "peek", "watch"]);
  if (parsed.rest.length) fail("usage: cdx events [--json] [--peek] [--watch]");
  const session = callerSession();
  if (!session || session === "terminal") fail("cdx events needs a Claude session");
  const json = parsed.bools.has("json");
  const peek = parsed.bools.has("peek");

  if (parsed.bools.has("watch")) {
    if (!tuiEnabled() || json) fail("events --watch requires CDX_TUI=1 on a terminal without --json");
    let seen = 0;
    const lines: string[] = [];
    await liveView(() => {
      const state = readSessions();
      const records = readEvents();
      const selected = selectEvents(records, session, state, { peek: true }).events.filter((event) => event.id > seen);
      for (const event of selected) {
        const record = records.find((record) => record.id === event.id)!;
        lines.push(`${record.timestamp}  ${event.kind}  ${event.text}`);
        seen = Math.max(seen, event.id);
      }
      lines.splice(0, Math.max(0, lines.length - 100));
      const cursor = records.at(-1)?.id ?? 0;
      return { title: "events", lines, progress: `${lines.length} recent events`, written: () => {
        if (!peek) withEvents((current) => {
          const target = delivery(current, session);
          target.cursor = Math.max(target.cursor, cursor);
          target.polledAt = new Date().toISOString();
        });
      } };
    });
    return;
  }

  const now = Date.now();
  const visibilityCfg = config.visibility ?? VISIBILITY_DEFAULTS;

  withEvents((state) => {
    const current = delivery(state, session);
    current.polledAt = new Date(now).toISOString();

    if (!peek) {
      if (!current.digestAt) {
        current.digestAt = new Date(now).toISOString();
        current.progress = [];
      } else if (heartbeatDue(now, Date.parse(current.digestAt), visibilityCfg.heartbeatMinutes)) {
        current.digestAt = new Date(now).toISOString();
        const samples = sessionProgress(session, now);
        if (samples.length) {
          const records = readEvents();
          state.sequence = Math.max(state.sequence, records.at(-1)?.id ?? 0);
          const message = `[cdx] progress\n${digestLines(samples, current.progress ?? []).join("\n")}`;
          const progressEvent: FeedEvent = {
            id: ++state.sequence,
            timestamp: new Date().toISOString(),
            kind: "progress",
            owner: session,
            message: message.split("\n").map(singleLine).join("\n"),
          };
          appendFileSync(`${ROOT}/feed.log`, `${JSON.stringify(progressEvent)}\n`);
          current.progress = samples;
        }
      }
    }

    const records = readEvents();
    const { events } = selectEvents(records, session, state, { peek: true });
    if (json) {
      console.log(JSON.stringify({ session, events }));
    } else if (events.length > 0) {
      console.log(tuiEnabled() ? renderView({ title: "events", lines: events.map((e) => e.text), progress: `${events.length} events` }, undefined, 0, Number.MAX_SAFE_INTEGER) : events.map((e) => e.text).join("\n"));
    }
    // Persist only after stdout succeeds. A crash may replay, never acknowledge early.
    if (!peek) current.cursor = Math.max(current.cursor, records.at(-1)?.id ?? 0);
  });
}

function sessionProgress(session: string, now: number): ProgressSample[] {
  const state = readSessions();
  const samples: ProgressSample[] = [];
  const files = new Map<string, number | undefined>();
  for (const [name, entry] of Object.entries(readLedger())) {
    if (!laneRunning(entry) || !owned(entry.ownerSession, name, session, state)) continue;
    const cwd = entry.kind === "review" ? entry.review?.cwd ?? entry.work.cwd : entry.work.cwd;
    if (!files.has(cwd)) files.set(cwd, changedFileCount(cwd));
    const stage = entry.stage === "gate" ? "gate" : entry.stage ?? "working";
    const gateAge = stage === "gate" ? `gate running ${statusAge(entry.stageStartedAt, now)} ` : "";
    samples.push({ key: `lane=${name}`, round: entry.rounds, steps: entry.roundSteps ?? 0, files: files.get(cwd), stage,
      action: `${gateAge}last ${statusAge(entry.lastActionAt ?? entry.lastEventAt, now)} ${statusText(entry.lastAction ?? "-", 80)}` });
  }
  for (const [name, job] of Object.entries(readJobs())) {
    if (jobRunning(job) && owned(job.ownerSession, undefined, session, state)) {
      samples.push({ key: `job=${name}`, stage: "running", action: jobPhase(job.log) || "-" });
    }
  }
  return samples;
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

function sessionSummary(session: string): string {
  const state = readSessions();
  const ledger = readLedger();
  const open = Object.entries(ledger).filter(([lane, entry]) => owned(entry.ownerSession, lane, session, state)
    && entry.work.state !== "closed").sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
  const finished = open.filter(([, entry]) => !laneRunning(entry));
  const hidden = Math.max(0, finished.length - BRIEF_FINISHED_SHOWN);
  const lines = [...open.filter(([, entry]) => laneRunning(entry)), ...finished.slice(0, BRIEF_FINISHED_SHOWN)]
    .map(([lane, entry]) => `lane=${lane} round=${entry.rounds} kind=${entry.kind} state=${activeStateOf(entry)} report=${roundReportOf(entry) ?? "-"}${laneRunning(entry) ? "" : " awaiting attention; close when handled"}`);
  if (hidden > 0) lines.push(`${hidden} older finished lanes not closed; cdx status --all lists them`);
  for (const { record } of questionFiles()) {
    const entry = ledger[record.lane];
    if (entry && entry.rounds === record.round && questionOpen(record) && owned(entry.ownerSession, record.lane, session, state)) {
      lines.push(`lane=${record.lane} r${record.round} QUESTION #${record.seq}: ${record.question}; cdx reply ${record.lane} --id ${record.seq} "<answer>"`);
    }
  }
  const jobs = Object.fromEntries(Object.entries(readJobs()).filter(([, job]) => owned(job.ownerSession, undefined, session, state)));
  for (const [name, job] of summaryJobs(jobs, BRIEF_FINISHED_SHOWN, BRIEF_FINISHED_JOB_MAX_AGE_MS)) lines.push(renderJobLine(name, job));
  return lines.join("\n");
}

export function takeoverCommand(argv: string[]): void {
  const [target, extra] = argv;
  const session = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!target || extra || !session || session === "terminal") fail("usage: cdx takeover <lane|full-session-id> from a Claude session");
  withLedger((ledger) => withEvents((state) => {
    const entry = ledger[target];
    if (entry) {
      // A lane claim moves that lane and its children only; the previous
      // head keeps everything else it owns.
      const tree = new Set([target]);
      for (const [name, lane] of Object.entries(ledger)) if (lane.parent === target) tree.add(name);
      for (const name of tree) state.lanes[name] = session;
    } else {
      if (target.length <= 8 || target === "terminal") fail("takeover needs a lane name or full session id; terminal work must be claimed by lane");
      const previous = recipientOf(target, undefined, state);
      for (const [owner, recipient] of Object.entries(state.bindings)) if (recipient === previous) state.bindings[owner] = session;
      state.bindings[previous] = session;
    }
    // Nothing is replayed: the summary below carries what needs attention.
    const latest = readEvents().at(-1)?.id ?? 0;
    const cursor = delivery(state, session);
    cursor.cursor = Math.max(cursor.cursor, latest);
  }));
  console.log(`cdx: ownership connected to session=${session}; target=${target}`);
  const summary = sessionSummary(session);
  if (summary) console.log(summary);
}

// A plugin reload registers a fresh hook instance beside the live ones, and
// every instance asks for the brief at its session start; the head then
// reads the same brief once per instance. The same text within this window
// for the same session prints nothing.
const BRIEF_REPEAT_WINDOW_MS = 10 * 60 * 1000;

function briefRepeated(session: string, text: string, now = Date.now()): boolean {
  const hash = createHash("sha256").update(text).digest("hex");
  return withEvents((state) => {
    const record = state.sessions[session] ?? { cursor: 0 };
    const repeated = record.briefHash === hash && record.briefAt !== undefined && now - Date.parse(record.briefAt) < BRIEF_REPEAT_WINDOW_MS;
    if (!repeated) state.sessions[session] = { ...record, briefHash: hash, briefAt: new Date(now).toISOString() };
    return repeated;
  });
}

export function briefCommand() {
  const quotaState = geminiQuotaState();
  if (quotaState.block) console.log(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
  const session = callerSession();
  const summary = sessionSummary(session);
  if (summary && !briefRepeated(session, summary)) console.log(summary);
}

export function feedCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["n"]);
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  console.log(scopedEvents(limit).join("\n"));
}
