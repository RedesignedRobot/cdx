import { migrateTokenAccounting, type TokenRoundEvidence } from "./tokens.ts";
import { failureDigest } from "./gates.ts";
import { safeText, safeJSON } from "./safe-text.ts";
// Lane records, ledger migration and locks, ownership, and the event journal.

import { CmdError, fail, LEDGER, ROOT, singleLine } from "./runtime.ts";
import { type ProgressSample, type VisibilityConfig } from "./visibility.ts";
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";

// Inside a supervisor lane both variables name the same lane. Anything else
// (a child, a plain worker, the head's shell) is not a supervisor. The claim
// is then checked against the ledger: the lane must be a running supervisor
// on the round the environment names, so a shell left over from an earlier
// round loses its authority instead of keeping it. This catches mistakes,
// not attackers: both engines hold shell access and could edit the ledger.
export function supervisorLane(): string | undefined {
  const lane = process.env.CDX_LANE?.trim();
  const supervisor = process.env.CDX_SUPERVISOR?.trim();
  if (!lane || supervisor !== lane) return undefined;
  const entry = readLedger()[lane];
  const round = Number(process.env.CDX_ROUND);
  if (!entry?.supervisor || (entry.kind !== "work" && !entry.consult) || !laneRunning(entry) || entry.rounds !== round) {
    fail(`supervisor identity "${lane}" round ${process.env.CDX_ROUND ?? "?"} does not match a running supervisor round in the ledger; this shell belongs to an earlier or unknown round`);
  }
  if (entry.parent) {
    fail(`child lane "${lane}" cannot be a supervisor; delegation is one level deep`);
  }
  return supervisor;
}

// One ownership policy for every mutation a supervisor may issue: it may
// touch only lanes it spawned. Heads must hold the resolved ownership.
export function requireOwnChild(lane: string, entry: Lane | undefined): void {
  const supervisor = supervisorLane();
  if (!entry) return;
  if (!owned(entry.ownerSession, lane)) fail(`lane "${lane}" belongs to another session; use cdx takeover ${lane} first`);
  if (supervisor && entry.parent !== supervisor) fail(`supervisor ${supervisor} may only drive its own children; lane "${lane}" is not one`);
}

export interface Lineage { supervisor: boolean; parent?: string; parentRound?: number }

// Lineage of a lane spawned from the current shell: a supervisor's children
// record the supervisor and its round so cleanup can find them later.
export function callerLineage(supervisor: boolean): Lineage {
  const parent = supervisorLane();
  const parentRound = Number(process.env.CDX_ROUND);
  if (parent && supervisor) {
    fail(`supervisor ${parent} cannot spawn another supervisor; delegation is one level deep`);
  }
  return { supervisor, ...(parent ? { parent, parentRound } : {}) };
}

export type Effort = string;

export type Engine = "gpt" | "gemini";

type Mode = "spawn" | "resume";

export interface GeminiConfig {
  model: string;
  agent: string;
  reviewAgent: string;
  maxRounds: number;
  maxRuntimeMins: number;
  // Model for the one automatic round that continues a conversation after
  // the 503 ladder is exhausted. Stays in the 3.8 family: the medium
  // reasoning tier answers from its own capacity pool. Empty disables.
  outageFallbackModel: string;
}

export interface Config {
  model_auto_compact_token_limit?: number;
  tool_output_token_limit?: number;
  expectMinutes?: number;
  visibility?: VisibilityConfig;
  // Codex model for work lanes (the executor).
  model: string;
  // Codex model for head-launched consults, reviews and supervisors.
  thinkerModel?: string;
  repoRouting?: Record<string, { model: string }>;
  models?: Record<string, string>;
  efforts: string[];
  defaultEffort: string;
  rules: string[];
  accounts?: Record<string, string>;
  // Highest effort a Codex model may run at, by model id.
  effortCaps: Record<string, string>;
  worktreeSetup?: string;
  gemini?: GeminiConfig;
}

export interface Tokens { input: number; cached: number; output: number }

type WorkState = "running" | "done" | "failed" | "gate-invalid" | "adopted" | "closed";

export type ReviewState = "running" | "done" | "failed";

interface GateBaseline {
  round: number;
  command: string;
  cwd: string;
  exitCode: number;
  checkedAt: string;
}

export interface GateTree { head: string; tree: string }

export interface GateReceipt {
  paths?: string[];
  sharedTreeLanes?: string[];
  version: 1;
  round: number;
  cwd: string;
  command: string;
  exitCode: number;
  finishedAt: string;
  head?: string;
  tree?: string;
  valid: boolean;
  reason?: string;
}

export interface RoundRecord<S extends WorkState = WorkState> {
  codegraphCalls?: number;
  codeSearchesBeforeGraph?: number;
  testRuns?: number;
  testSuites?: number;
  testStatus?: "passed" | "failed" | "running";
  expectMinutes?: number;
  overrunSent?: boolean;
  exitCode?: number;
  note?: string;
  state: S;
  round?: number;
  cwd: string;
  report?: string;
  updatedAt?: string;
  startedAt?: string;
  tokensIncomplete?: boolean;
}

export interface LaneOutage {
  // Which retry layer is waiting: agy's in-process loop or cdx's ladder.
  layer: "agy" | "cdx";
  since: string;
  attempt: number;
  limit?: number;
  reason: string;
  nextRetryAt?: string;
}

export interface Lane {
  queuedUntil?: string;
  modelCalls?: number;
  callLimitHit?: boolean;
  quotaWrapSent?: boolean;
  touchedPaths?: string[];
  landedCommit?: string;
  landingCommit?: string;
  baseBranch?: string;
  reviewTree?: GateTree;
  reviewClosed?: boolean;
  accountPercentStart?: Record<string, number>;
  accountPercentEnd?: Record<string, number>;
  agentLoaded?: boolean;
  work: RoundRecord;
  review?: RoundRecord<ReviewState>;
  engine: Engine;
  // Codex model id of the work thread; absent on gemini lanes.
  model?: string;
  // A supervisor lane owns its child lanes through cdx.
  supervisor?: true;
  // Name and round of the supervisor lane that spawned this one.
  parent?: string;
  parentRound?: number;
  // A read-only advisory lane; resume continues the conversation read-only.
  consult?: true;
  account?: string;
  codexHome?: string;
  ownerSession?: string;
  ownerCwd?: string;
  sessionId?: string;
  // Review rounds overwrite sessionId with the read-only review session; the
  // work thread survives here so resume always reattaches to it.
  workSessionId?: string;
  transcriptPath?: string;
  reviewEngine?: Engine;
  // Codex model of the latest review or consult round. It never replaces
  // model, so a Sol work thread keeps Sol when it resumes after an Astra review.
  reviewModel?: string;
  effort: Effort;
  roundAccount?: AccountChoice & { demand: Demand };
  quotaFailure?: string;
  switchingAccount?: true;
  // Set when finalize decided the next round continues on the outage
  // fallback model; the runner opens that round itself.
  outageFallbackPending?: true;
  // Model of the current round when it is the outage fallback round.
  fallbackModel?: string;
  // Live 503 state for status and the digest; cleared when Gemini answers.
  outage?: LaneOutage;
  // agy in-process retries seen this round (from the per-round agy log).
  agyRetries?: number;
  kind: "work" | "review";
  rounds: number;
  workRounds?: number;
  reports: string[];
  tokenAccounting?: 1;
  tokens?: Tokens;
  roundTokens?: Tokens;
  tokensIncomplete?: boolean;
  roundTestRuns?: number;
  roundCodegraphCalls?: number;
  roundCodeSearchesBeforeGraph?: number;
  roundTestSuites?: number;
  roundTestStatus?: "passed" | "failed" | "running";
  expectMinutes?: number;
  overrunSent?: boolean;
  roundSteps?: number;
  stage?: "working" | "gate" | "reporting";
  stageStartedAt?: string;
  lastActionAt?: string;
  steers?: number;
  steerOpen?: boolean;
  continuations?: number;
  hooksActive?: boolean;
  // Acceptance gate command; work rounds rerun it at finalize, reviews never.
  gate?: string;
  gateBaseline?: GateBaseline;
  gateReceipt?: GateReceipt;
  additionalDirectories?: string[];
  // Pre-check command; runs in cwd before opening the round.
  pre?: string;
  pid?: number;
  codexPid?: number;
  lastAction?: string;
  lastEventAt?: string;
  lastResultError?: string;
  diffEmpty?: true;
  worktreePath?: string;
  worktreeRepo?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
  roundStartedAt?: string;
}

export interface Spec {
  expectMinutes?: number;
  promptBytes?: Record<string, number>;
  model_auto_compact_token_limit?: number;
  tool_output_token_limit?: number;
  queuedUntil?: string;
  reviewTree?: GateTree;
  injectedRules?: string;
  visibility?: VisibilityConfig;
  effort: Effort;
  engine: Engine;
  mode: Mode;
  lane: string;
  round: number;
  cwd: string;
  prompt: string;
  model?: string;
  sourceThreadId?: string;
  additionalDirectories?: string[];
  images?: string[];
  outputSchema?: unknown;
  account?: string;
  codexHome?: string;
  accountHomes?: Record<string, string>;
  taskPrompt?: string;
  ownerSession?: string;
  ownerCwd?: string;
  sessionId?: string;
  gate?: string;
  gateBaselineChecked?: true;
  reviewDir?: string;
  maxRuntimeMins?: number;
  supervisor?: true;
  // agy agent name, pinned at launch so the detached runner cannot drift.
  agent?: string;
  startedAt?: string;
}

export type Ledger = Record<string, Lane>;

type EventKind = "started" | "question" | "stalled" | "active" | "partial" | "account" | "progress" | "terminal" | "job-exit" | "message" | "thrash" | "overrun" | "outage" | "gate-started" | "gate-finished" | "report-written";

export interface FeedEvent {
  id: number;
  timestamp: string;
  kind: EventKind | string;
  owner: string;
  recipient?: string;
  from?: string;
  lane?: string;
  round?: number;
  job?: string;
  message: string;
  supervisor?: string;
}

interface SessionDelivery {
  cursor: number;
  polledAt?: string;
  digestAt?: string;
  progress?: ProgressSample[];
  briefHash?: string;
  briefAt?: string;
}

interface SessionState {
  sequence: number;
  bindings: Record<string, string>;
  lanes: Record<string, string>;
  sessions: Record<string, SessionDelivery>;
}

const SESSION_STATE = `${ROOT}/sessions.json`;

export const WAKE_EVENTS = new Set<string>(["question", "stalled", "terminal", "job-exit", "message", "thrash", "overrun", "outage"]);

export function readSessions(): SessionState {
  return { sequence: 0, bindings: {}, lanes: {}, sessions: {}, ...(existsSync(SESSION_STATE) ? JSON.parse(readFileSync(SESSION_STATE, "utf8")) : {}) };
}

export function withEvents<T>(action: (state: SessionState) => T, persist = true): T {
  if (!persist && !existsSync(ROOT)) return action(readSessions());
  mkdirSync(ROOT, { recursive: true });
  return withLockedJson(SESSION_STATE, `${ROOT}/.events.lock`, readSessions, action, persist);
}

export function recipientOf(owner: string | undefined, lane?: string, state = readSessions()): string {
  const token = state.lanes[lane ?? ""] ?? owner ?? "terminal";
  return state.bindings[token] ?? token;
}

export function callerSession(): string {
  // A worker's inherited owner wins even when it is explicitly terminal.
  const owner = (process.env.CDX_LANE ? process.env.CDX_OWNER?.trim() : undefined)
    || process.env.CLAUDE_CODE_SESSION_ID?.trim() || "terminal";
  return process.env.CDX_LANE ? recipientOf(owner, process.env.CDX_LANE) : owner;
}

export function owned(owner?: string, lane?: string, session = callerSession(), state = readSessions()): boolean {
  return recipientOf(owner, lane, state) === session;
}

export function parseFeedEvent(line: string): FeedEvent | undefined {
  try {
    const event = JSON.parse(line);
    if (Number.isSafeInteger(event.id) && event.id > 0 && typeof event.timestamp === "string"
      && typeof event.owner === "string" && typeof event.message === "string"
      && ["started", "question", "stalled", "active", "partial", "account", "progress", "terminal", "job-exit", "message", "thrash", "overrun", "outage", "gate-started", "gate-finished", "report-written"].includes(event.kind)) return event;
  } catch { /* Version 5 free-text records are deliberately ignored. */ }
}

export function readEvents(): FeedEvent[] {
  if (!existsSync(`${ROOT}/feed.log`)) return [];
  return readFileSync(`${ROOT}/feed.log`, "utf8").split("\n").flatMap((line) => {
    const event = parseFeedEvent(line);
    return event ? [event] : [];
  });
}

export function renderEvent(event: FeedEvent): string {
  if (event.kind === "message") return safeText(`[cdx] msg to=${event.recipient} from=${event.from}: ${event.message}`);
  return safeText(event.message);
}

export function eventOwned(event: FeedEvent, session: string, state: SessionState): boolean {
  if (event.supervisor) return false;
  return recipientOf(event.recipient ?? event.owner, event.lane, state) === session;
}

export function terminalText(message: string, report: string | undefined, failure: string | undefined): string {
  const body = report && Buffer.byteLength(report) < 10_000 ? `\n\n${report.trim()}` : "";
  const digest = failure ? `\n\nFailure evidence:\n${failureDigest(failure)}` : "";
  return safeText(message + body + digest);
}

export function feedEvent(kind: EventKind, message: string, owner?: string, identity: { lane?: string; round?: number; job?: string; recipient?: string; from?: string } = {}): void {
  return withEvents((state) => {
    // Recover sequence after a crash between append and state rename.
    const records = readEvents();
    state.sequence = Math.max(state.sequence, records.at(-1)?.id ?? 0);
    if (kind === "terminal" && records.some((event) => event.kind === kind && event.lane === identity.lane && event.round === identity.round)) return;
    if (kind === "partial" && records.some((event) => event.kind === kind && event.lane === identity.lane && event.round === identity.round)) return;
    const lane = identity.lane ? readLedger()[identity.lane] : undefined;
    const terminal = kind === "terminal" || kind === "job-exit";
    if (kind === "terminal" && lane) message += ` tests=${lane.roundTestRuns ?? 0} suites=${lane.roundTestSuites ?? 0}${lane.roundTestStatus ? ` testStatus=${lane.roundTestStatus}` : ""} codegraph=${lane.roundCodegraphCalls ?? 0} code-before-graph=${lane.roundCodeSearchesBeforeGraph ?? 0}`;
    const read = (path?: string) => { try { return path && path !== "-" ? readFileSync(path, "utf8") : undefined; } catch { return undefined; } };
    if (terminal) {
      const report = read(/(?:^|\s)report=(\S+)/.exec(message)?.[1]);
      const failed = /state=(failed|gate-invalid)/.test(message);
      const gateLog = /(?:^|\s)gateLog=(\S+)/.exec(message)?.[1];
      const log = /(?:^|\s)log=(\S+)/.exec(message)?.[1];
      message = terminalText(message, report, failed ? read(gateLog !== "-" && gateLog ? gateLog : log) : undefined);
    }
    const supervisor = terminal ? lane?.parent : undefined;
    const event: FeedEvent = { id: ++state.sequence, timestamp: new Date().toISOString(), kind, owner: owner || "terminal", ...identity,
      ...(supervisor ? { supervisor } : {}), message: terminal || kind === "progress" ? safeText(message) : singleLine(message) };
    if (supervisor && lane?.parentRound) {
      const parent = readLedger()[supervisor];
      if (parent && laneRunning(parent) && parent.rounds === lane.parentRound && parent.steerOpen !== false) {
        mkdirSync(`${ROOT}/control`, { recursive: true });
        appendFileSync(`${ROOT}/control/${supervisor}-r${lane.parentRound}.jsonl`, `${safeJSON({ text: event.message, sentAt: event.timestamp, from: "cdx" })}\n`);
      }
    }
    appendFileSync(`${ROOT}/feed.log`, `${safeJSON(event)}\n`);
  });
}

export function scopedEvents(limit: number, session = callerSession(), messagesOnly = false): string[] {
  return withEvents((state) => readEvents().filter((event) => eventOwned(event, session, state)
    && (!messagesOnly || event.kind === "message")).slice(-limit).map(renderEvent), false);
}

// A 6.x record carried two cursors (wake, quiet) and a hook receipt. The
// higher cursor becomes the single cursor so an upgraded session never
// replays its history; the receipt fields are dropped.
export function delivery(state: SessionState, session: string): SessionDelivery {
  const entry = state.sessions[session] ??= { cursor: 0 };
  const legacy = entry as SessionDelivery & { wake?: number; quiet?: number; lease?: unknown; plugin?: unknown };
  if (typeof entry.cursor !== "number") entry.cursor = Math.max(legacy.wake ?? 0, legacy.quiet ?? 0);
  delete legacy.wake; delete legacy.quiet; delete legacy.lease; delete legacy.plugin;
  return entry;
}

interface EventsRecord {
  id: number;
  kind: string;
  wake: boolean;
  text: string;
  lane?: string;
  round?: number;
  job?: string;
  from?: string;
  recipient?: string;
}

interface SelectEventsOptions {
  peek?: boolean;
}

export function selectEvents(
  records: FeedEvent[],
  session: string,
  state: SessionState,
  options: SelectEventsOptions = {}
): {
  events: EventsRecord[];
  cursor: number;
} {
  const current = delivery(state, session);
  const currentCursor = current.cursor ?? 0;
  const matching = records.filter((event) => event.id > currentCursor && eventOwned(event, session, state));
  const lastRecordId = records.length > 0 ? records[records.length - 1]!.id : currentCursor;
  const newCursor = options.peek ? currentCursor : Math.max(currentCursor, lastRecordId);
  if (!options.peek) {
    current.cursor = newCursor;
  }
  const events: EventsRecord[] = matching.map((event) => {
    const e: EventsRecord = {
      id: event.id,
      kind: event.kind,
      wake: WAKE_EVENTS.has(event.kind),
      text: renderEvent(event),
    };
    if (event.lane !== undefined) e.lane = event.lane;
    if (event.round !== undefined) e.round = event.round;
    if (event.job !== undefined) e.job = event.job;
    if (event.from !== undefined) e.from = event.from;
    if (event.recipient !== undefined) e.recipient = event.recipient;
    return e;
  });
  return { events, cursor: current.cursor };
}

function normalizeLane(entry: any): void {
  entry.engine ??= "gpt";
  entry.work ??= {
    state: entry.workState ?? (entry.kind === "review" ? entry.workSessionId ? "done" : "adopted" : entry.state),
    round: entry.workRound ?? (entry.kind === "work" ? entry.rounds : undefined),
    cwd: entry.workCwd ?? entry.worktreePath ?? entry.cwd,
    exitCode: entry.kind === "review" && !entry.workState ? undefined : entry.exitCode,
    note: entry.kind === "review" && !entry.workState ? undefined : entry.note,
    report: entry.workReport,
    updatedAt: entry.workUpdatedAt,
  };
  if (!entry.review && (entry.reviewState || entry.kind === "review")) {
    entry.review = {
      state: entry.reviewState ?? entry.state,
      round: entry.reviewRound ?? (entry.kind === "review" ? entry.rounds : undefined),
      cwd: entry.reviewCwd ?? entry.work.cwd,
      exitCode: entry.reviewExitCode ?? (entry.kind === "review" && !entry.workState ? entry.exitCode : undefined),
      note: entry.reviewNote ?? (entry.kind === "review" && !entry.workState ? entry.note : undefined),
      report: entry.reviewReport,
      updatedAt: entry.reviewUpdatedAt,
    };
  }
  const active = entry.kind === "review" ? entry.review : entry.work;
  const lastReport = entry.reports?.at(-1);
  if (active && !active.report && lastReport?.endsWith(`-r${entry.rounds}.md`)) active.report = lastReport;
  if (entry.account && entry.codexHome && (entry.kind === "review" ? entry.reviewEngine ?? entry.engine ?? "gpt" : entry.engine ?? "gpt") === "gpt") {
    entry.roundAccount ??= { name: entry.account, home: entry.codexHome, demand: entry.kind === "review" ? "light" : entry.supervisor ? "supervisor" : "work" };
  }
  for (const key of ["workState", "workRound", "workCwd", "workReport", "workUpdatedAt", "exitCode", "note", "reviewState", "reviewRound", "reviewCwd", "reviewExitCode", "reviewNote", "reviewReport", "reviewUpdatedAt"]) delete entry[key];
  delete entry.state;
  delete entry.cwd;
}

const LEDGER_VERSION_PATH = `${ROOT}/.ledger-version`;

const LEGACY_LANE_KEYS = ["state", "cwd", "workState", "workRound", "workCwd", "workReport", "workUpdatedAt", "exitCode", "note", "reviewState", "reviewRound", "reviewCwd", "reviewExitCode", "reviewNote", "reviewReport", "reviewUpdatedAt"];

function readLedgerDocument(document: any = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : {}) {
  if (document && typeof document === "object" && Object.keys(document).length === 0) return { version: 5, tokenAccounting: 1, lanes: {} as Ledger };
  const current = document?.version === 5;
  if (!current && (existsSync(LEDGER_VERSION_PATH) || typeof document?.version === "number")) {
    throw new CmdError("unsupported ledger shape; stop older cdx writers and restore a version 5 ledger");
  }
  const ledger = current ? document.lanes : document;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) throw new CmdError("invalid ledger: expected lane records");
  for (const [name, entry] of Object.entries(ledger) as [string, any][]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new CmdError(`invalid ledger lane "${name}"`);
    if (!current) normalizeLane(entry);
    if (LEGACY_LANE_KEYS.some((key) => Object.hasOwn(entry, key))
      || !["gpt", "gemini"].includes(entry.engine)
      || !entry.work || typeof entry.work.cwd !== "string"
      || !["running", "done", "failed", "gate-invalid", "adopted", "closed"].includes(entry.work.state)
      || !["work", "review"].includes(entry.kind)
      || (entry.kind === "review" && (!entry.review || typeof entry.review.cwd !== "string" || !["running", "done", "failed"].includes(entry.review.state)))) {
      throw new CmdError(`invalid ledger lane "${name}": version 5 requires an engine and work/review records, without flat aliases`);
    }
  }
  const result = { version: 5, tokenAccounting: document.tokenAccounting as number | undefined, lanes: ledger as Ledger };
  migrateTokenAccounting(result, (name, entry) => {
      const evidence: (TokenRoundEvidence & { round: number })[] = [];
      for (let round = 1; round <= entry.rounds; round++) {
        try {
          const spec = JSON.parse(readFileSync(`${ROOT}/specs/${name}-r${round}.json`, "utf8"));
          if (["gpt", "gemini"].includes(spec.engine)) evidence.push({ engine: spec.engine, round });
        } catch { /* cleaned specs leave engine attribution incomplete */ }
      }
      const mixed = new Set([entry.engine, entry.reviewEngine ?? entry.engine, ...evidence.map((round) => round.engine)]).size > 1;
      if (mixed) {
        for (const record of evidence) {
          if (record.engine !== "gemini") continue;
          try {
            const round = record.round;
            const lines = readFileSync(`${ROOT}/logs/${name}-r${round}.jsonl`, "utf8").split("\n");
            let cached = 0;
            for (const line of lines) {
              let event: any;
              try { event = JSON.parse(line); } catch { continue; }
              const usage = event.event === "step_update" ? event.step_update?.usage : undefined;
              if (usage && [usage.input_tokens, usage.cache_read_tokens, usage.output_tokens]
                .every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) cached += usage.cache_read_tokens;
            }
            record.cached = cached;
          } catch { /* preserve the incomplete evidence */ }
        }
      }
      return evidence;
  });
  return result;
}

export function readLedger(): Ledger {
  if (!existsSync(LEDGER)) return {};
  const document = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (document.version === 5 && document.tokenAccounting === 1 && Object.values(document.lanes ?? {}).every((lane: any) => lane.tokenAccounting === 1)) return readLedgerDocument(document).lanes;
  // Persist the migration under the normal writer lock, including read-only
  // usage requests. A second reader rechecks the marker after taking the lock.
  return withLockedJson(LEDGER, `${ROOT}/.lock`, readLedgerDocument, (document) => document.lanes);
}

export function withLedger<T>(mutate: (ledger: Ledger) => T): T {
  // Finish any legacy migration before callbacks can read under this lock.
  readLedger();
  return withLockedJson(LEDGER, `${ROOT}/.lock`,
    readLedgerDocument,
    (document) => {
      if (!existsSync(LEDGER_VERSION_PATH) || readFileSync(LEDGER_VERSION_PATH, "utf8").trim() !== "5") writeFileSync(LEDGER_VERSION_PATH, "5\n");
      return mutate(document.lanes);
    });
}

// Read-mutate-write one JSON state file under a mkdir lock, written through a
// temp file so a reader never sees a torn document.
export function withLockedJson<S, T>(path: string, lock: string, read: () => S, mutate: (state: S) => T, persist = true): T {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A lock older than 30s belongs to a dead process; break it.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; }
      } catch { /* raced */ }
      if (Date.now() > deadline) throw new CmdError(`${relative(ROOT, path)} lock timeout`);
      Bun.sleepSync(50);
    }
  }
  try {
    const state = read();
    const result = mutate(state);
    if (persist) {
      const serialized = safeJSON(state, 2);
      if (!existsSync(path) || readFileSync(path, "utf8") !== serialized) {
        const tmp = `${path}.tmp.${process.pid}`;
        writeFileSync(tmp, serialized);
        renameSync(tmp, path);
      }
    }
    return result;
  } finally {
    try { rmdirSync(lock); } catch { /* broken by a peer */ }
  }
}

export function readLane(lane: string): Lane {
  const entry = readLedger()[lane];
  if (!entry) fail(`unknown lane "${lane}" (cdx status lists lanes)`);
  return entry;
}

export function workCwdOf(entry: Lane): string {
  return entry.work.cwd;
}

// Where a spawn runs and which repository a --worktree is cut from. An
// explicit --cd wins outright. A reused lane name keeps its old directory and
// repository only while that directory still exists; a closed lane whose
// worktree was removed used to pin every respawn to the stale repository
// (two lanes cut from ~/code/cdx instead of Arc on 2026-09-17).
export function spawnRoots(
  explicitCd: string | undefined,
  existing: Pick<Lane, "work" | "worktreeRepo" | "worktreePath"> | undefined,
  callerCwd: string,
  exists: (path: string) => boolean,
): { cwd: string; worktreeRepo: string } {
  if (explicitCd !== undefined) {
    const cwd = resolve(callerCwd, explicitCd);
    return { cwd, worktreeRepo: cwd };
  }
  const previous = existing ? workCwdOf(existing as Lane) : undefined;
  if (existing && previous && exists(previous)) {
    return { cwd: previous, worktreeRepo: existing.worktreeRepo ?? previous };
  }
  return { cwd: callerCwd, worktreeRepo: callerCwd };
}

export function workStateOf(entry: Lane): WorkState {
  return entry.work.state;
}

export function activeStateOf(entry: Lane): WorkState | ReviewState {
  if (entry.switchingAccount || entry.outageFallbackPending) return "running";
  return entry.kind === "review" ? entry.review!.state : entry.work.state;
}

export function laneRunning(entry: Lane): boolean {
  return activeStateOf(entry) === "running";
}

export function roundExitCodeOf(entry: Lane): number | undefined {
  return entry.kind === "review" ? entry.review?.exitCode : entry.work.exitCode;
}

export function roundNoteOf(entry: Lane): string | undefined {
  return entry.kind === "review" ? entry.review?.note : entry.work.note;
}

export function roundReportOf(entry: Lane): string | undefined {
  return entry.kind === "review" ? entry.review?.report : entry.work.report;
}

// "undefined" and "null" are what a dropped tool field stringifies to; a lane
// by that name cannot be addressed through the native tools afterwards.
export function validLane(lane: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(lane)) fail(`lane name "${lane}" must be alphanumeric with . _ - only`);
  if (lane === "undefined" || lane === "null") fail(`lane name "${lane}" is reserved; name the lane after its work`);
  return lane;
}

export function laneEngine(lane: Pick<Lane, "engine"> | undefined): Engine {
  if (!lane || !["gpt", "gemini"].includes(lane.engine)) throw new CmdError("lane has no valid engine; restore its engine in the ledger");
  return lane.engine;
}

// The engine a round actually ran on: reviews record their own beside the
// work engine, so status and wait name the runtime that produced the report.
export function roundEngine(lane: Lane): Engine {
  return lane.kind === "review" ? lane.reviewEngine ?? laneEngine(lane) : laneEngine(lane);
}

// A work lane that died before its runtime handed back a session has no
// thread to protect; its engine may follow the next round.
export function hasWorkThread(lane: Lane): boolean {
  return Boolean(lane.workSessionId) || (lane.kind === "work" && Boolean(lane.sessionId));
}

export interface AccountChoice { name: string; home: string }

export interface LaneOwner { ownerSession?: string; ownerCwd: string }

export function callerOwnership(): LaneOwner {
  const parent = supervisorLane();
  const inherited = parent ? readSessions().lanes[parent] ?? readLedger()[parent]?.ownerSession ?? "terminal" : undefined;
  const ownerSession = inherited === "terminal" ? undefined : inherited ?? process.env.CLAUDE_CODE_SESSION_ID?.trim();
  return { ...(ownerSession ? { ownerSession } : {}), ownerCwd: process.cwd() };
}

export function ownershipSpec(owner?: LaneOwner): Pick<Spec, "ownerSession" | "ownerCwd"> {
  return owner ? { ...owner } : {};
}

export function storedOwnership(lane: Lane): LaneOwner | undefined {
  if (!lane.ownerCwd) return undefined;
  return { ...(lane.ownerSession ? { ownerSession: lane.ownerSession } : {}), ownerCwd: lane.ownerCwd };
}

// Demand costs guide placement; they are not completion budgets.
export type Demand = "light" | "work" | "supervisor";
