import { failureDigest } from "./gates.ts";
import { safeText, safeJSON } from "./safe-text.ts";
// Lane records, ownership, and the event journal, stored in the SQLite state store.

import { fail, ROOT, singleLine } from "./runtime.ts";
import { db, write } from "./store.ts";
import type { ScopePolicy } from "./brief-contract.ts";
import { type VisibilityConfig } from "./visibility.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// A supervisor may drive only lanes it spawned. The head is the one owner
// and may drive any lane.
export function requireOwnChild(lane: string, entry: Lane | undefined): void {
  const supervisor = supervisorLane();
  if (entry && supervisor && entry.parent !== supervisor) fail(`supervisor ${supervisor} may only drive its own children; lane "${lane}" is not one`);
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

// claude runs read-only consult lanes only (panel members); openRound refuses the rest.
export type Engine = "gpt" | "gemini" | "claude";

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

export interface GateTree {
  head: string;
  tree: string;
  // A --base or --commit review's resolved commit, part of its dedup key.
  target?: string;
}

export interface ReviewAttestation { tree: string; head: string; reviewer: string; closed: boolean; report?: string; at: string }

export interface GateReceipt {
  paths?: string[];
  // Files the lane edited outside its brief's Files section, from its report.
  scopeExtensions?: string[];
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
  // The lander that owns the lane while its merge gates; inert once pid dies.
  landing?: { pid: number; job: string };
  baseBranch?: string;
  reviewTree?: GateTree;
  reviewClosed?: boolean;
  // Reviews of this lane's tree by any review lane, oldest first. Land and
  // fix resumes read these, never the reviewer's name.
  reviewAttestations?: ReviewAttestation[];
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
  // Panel this consult answers for; its events go to the panel, not the head.
  panel?: string;
  // The cdx command (shots grade, context) that ran this consult and reports
  // for it; its terminal event goes to the batch, not the head.
  batch?: string;
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
  scopePolicy?: ScopePolicy;
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
  // The Codex lane home AGENTS.md, rendered where config is loaded; the runner reads defaults.
  laneInstructions?: string;
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
  reviewDir?: string;
  maxRuntimeMins?: number;
  supervisor?: true;
  // agy agent name, pinned at launch so the detached runner cannot drift.
  agent?: string;
  // The round whose runner sets up the new worktree before the engine starts.
  // A number, not a flag: fallback and failover rounds copy the spec.
  worktreeSetupRound?: number;
  startedAt?: string;
}

export type Ledger = Record<string, Lane>;

// runConsult names its batch to the consult it starts through this variable.
export const BATCH_ENV = "CDX_BATCH";

type EventKind = "question" | "stalled" | "partial" | "account" | "terminal" | "job-exit" | "message" | "thrash" | "overrun" | "outage" | "gate-finished" | "panel";

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

// The kinds a head acts on. The other kinds stay in the table for cdx feed
// and never reach a session.
export const WAKE_EVENTS = new Set<string>(["question", "stalled", "terminal", "job-exit", "message", "thrash", "overrun", "outage", "panel"]);

export function callerSession(): string {
  return process.env.CLAUDE_CODE_SESSION_ID?.trim() || "terminal";
}

interface EventRow {
  id: number; at: string; kind: string; owner: string; recipient: string | null; sender: string | null;
  lane: string | null; round: number | null; job: string | null; supervisor: string | null; message: string;
}

function feedEventOf(row: EventRow): FeedEvent {
  const event: FeedEvent = { id: row.id, timestamp: row.at, kind: row.kind, owner: row.owner, message: row.message };
  if (row.recipient !== null) event.recipient = row.recipient;
  if (row.sender !== null) event.from = row.sender;
  if (row.lane !== null) event.lane = row.lane;
  if (row.round !== null) event.round = row.round;
  if (row.job !== null) event.job = row.job;
  if (row.supervisor !== null) event.supervisor = row.supervisor;
  return event;
}

export function eventsAfter(cursor: number): FeedEvent[] {
  return db().query<EventRow, [number]>("SELECT * FROM events WHERE id > ? ORDER BY id").all(cursor).map(feedEventOf);
}

// The newest events, oldest first.
export function recentEvents(limit: number): FeedEvent[] {
  return db().query<EventRow, [number]>("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit).reverse().map(feedEventOf);
}

// Messages addressed to the session or to the head, oldest first.
export function inboxEvents(session: string, limit: number): FeedEvent[] {
  return db().query<EventRow, [string, number]>("SELECT * FROM events WHERE kind = 'message' AND (recipient IS NULL OR recipient = ?) ORDER BY id DESC LIMIT ?")
    .all(session, limit).reverse().map(feedEventOf);
}

export function latestEventId(): number {
  return db().query<{ id: number | null }, []>("SELECT MAX(id) AS id FROM events").get()?.id ?? 0;
}

export function renderEvent(event: FeedEvent): string {
  if (event.kind === "message") return safeText(`[cdx] msg to=${event.recipient ?? "head"} from=${event.from}: ${event.message}`);
  return safeText(event.message);
}

// A terminal event is at most TERMINAL_LINES lines: the verdict line, which
// names the report path, then the head of the failure evidence or of the
// report. The body stays on disk for the head or supervisor to open.
const TERMINAL_LINES = 5;

const DIGEST_LINE_CHARS = 200;

export function terminalText(message: string, report: string | undefined, failure: string | undefined): string {
  const source = failure ? failureDigest(failure).split("\n") : (report ?? "").split("\n").filter((line) => !/^\s*#/.test(line));
  const digest = source.map(singleLine).filter(Boolean).slice(0, TERMINAL_LINES - 1)
    .map((line) => Array.from(line).slice(0, DIGEST_LINE_CHARS).join(""));
  return safeText([singleLine(message), ...digest].join("\n"));
}

export function feedEvent(kind: EventKind, message: string, owner?: string, identity: { lane?: string; round?: number; job?: string; recipient?: string; from?: string } = {}): void {
  write(() => {
    if ((kind === "terminal" || kind === "partial") && db().query("SELECT 1 FROM events WHERE lane IS ? AND round IS ? AND kind = ?")
      .get(identity.lane ?? null, identity.round ?? null, kind)) return;
    const lane = identity.lane ? findLane(identity.lane) : undefined;
    const terminal = kind === "terminal" || kind === "job-exit";
    if (kind === "terminal" && lane) message += ` tests=${lane.roundTestRuns ?? 0} suites=${lane.roundTestSuites ?? 0}${lane.roundTestStatus ? ` testStatus=${lane.roundTestStatus}` : ""} codegraph=${lane.roundCodegraphCalls ?? 0} code-before-graph=${lane.roundCodeSearchesBeforeGraph ?? 0}`;
    const read = (path?: string) => { try { return path && path !== "-" ? readFileSync(path, "utf8") : undefined; } catch { return undefined; } };
    if (terminal) {
      const report = read(/(?:^|\s)report=(\S+)/.exec(message)?.[1]);
      const failed = /state=(failed|gate-invalid)/.test(message);
      const gateLog = /(?:^|\s)gateLog=(\S+)/.exec(message)?.[1];
      const log = /(?:^|\s)log=(\S+)/.exec(message)?.[1];
      message = terminalText(message, report, failed ? read(gateLog !== "-" && gateLog ? gateLog : log) : undefined);
    } else message = singleLine(message);
    const at = new Date().toISOString();
    const supervisor = lane?.panel ? `panel:${lane.panel}` : terminal && lane?.batch ? `batch:${lane.batch}` : terminal ? lane?.parent : undefined;
    if (supervisor && lane?.parentRound) {
      const parent = findLane(supervisor);
      if (parent && laneRunning(parent) && parent.rounds === lane.parentRound && parent.steerOpen !== false) {
        mkdirSync(`${ROOT}/control`, { recursive: true });
        appendFileSync(`${ROOT}/control/${supervisor}-r${lane.parentRound}.jsonl`, `${safeJSON({ text: message, sentAt: at, from: "cdx" })}\n`);
      }
    }
    db().query("INSERT INTO events (at, kind, owner, recipient, sender, lane, round, job, supervisor, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(at, kind, owner || "terminal", identity.recipient ?? null, identity.from ?? null, identity.lane ?? null,
        identity.round ?? null, identity.job ?? null, supervisor ?? null, message);
  });
}

// A Claude session is a delivery cursor, not an owner: every lane belongs to
// the one owner. The head is the active session (polled within
// ACTIVE_SESSION_MS) that most recently drove cdx: spawned, resumed, sent,
// reviewed, consulted, replied, landed, or ran cdx brief --head. The mod
// runs brief --head when a session starts with a person at the prompt, so a
// fresh interactive session beside an older idle one takes the wakes at
// once. A session that starts without a person (a headless claude -p, the
// SDK) never drives by starting, and with no active driver there is no head:
// events wait for one rather than wake a session nobody reads. Agent-tool
// subagents and in-process teammates share their parent's process and
// session id and fire no session.start of their own. Owner events have one
// cursor in meta, advanced only after a head received them, so a change of
// head never skips an event; each session's own cursor covers messages
// addressed to it.
const ACTIVE_SESSION_MS = 30_000;

// An idle poll with nothing new skips the write until its liveness mark is
// this old; the mod polls every two seconds.
const POLL_MARK_MS = 10_000;

export interface SessionRow { session: string; cursor: number; started_at: string; polled_at: string; drove_at: string | null; brief_hash: string | null; brief_at: string | null }

export function readSession(session: string): SessionRow | undefined {
  return db().query<SessionRow, [string]>("SELECT * FROM sessions WHERE session = ?").get(session) ?? undefined;
}

// A new session's own cursor starts at the newest event: what happened
// before it is the brief's job, not a replay. started_at marks the start of
// the current live stretch: a row not polled within ACTIVE_SESSION_MS
// belongs to no running process, so the next start or poll restarts it.
function touchSession(session: string, now: number): SessionRow {
  const at = new Date(now).toISOString();
  const row = readSession(session);
  if (!row) db().query("INSERT INTO sessions (session, cursor, started_at, polled_at) VALUES (?, ?, ?, ?)").run(session, latestEventId(), at, at);
  else db().query("UPDATE sessions SET polled_at = ?, started_at = ? WHERE session = ?")
    .run(at, Date.parse(row.polled_at) >= now - ACTIVE_SESSION_MS ? row.started_at : at, session);
  return readSession(session)!;
}

// brief --head claims the wakes only early in a live stretch: a new session,
// /clear, /resume, or a restart of an idle one. A reload, plugin enable or
// worker respawn re-fires session.start inside a session that kept polling,
// and must not take the head from the session the person is using.
export function mayClaimHead(row: SessionRow, now: number): boolean {
  return Date.parse(row.started_at) >= now - ACTIVE_SESSION_MS;
}

// Session start, /clear, /resume and compaction call this through cdx brief.
export function startSession(session: string, now = Date.now(), claim = false): void {
  write(() => {
    const row = touchSession(session, now);
    if (claim && mayClaimHead(row, now)) markDriver(session, now);
  });
}

// Only a session that already has a row records its brief or its drive; the
// terminal never becomes a delivery target.
export function markBrief(session: string, hash: string, now: number): void {
  write(() => db().query("UPDATE sessions SET brief_hash = ?, brief_at = ? WHERE session = ?").run(hash, new Date(now).toISOString(), session));
}

export function markDriver(session: string, now = Date.now()): void {
  write(() => db().query("UPDATE sessions SET drove_at = ? WHERE session = ?").run(new Date(now).toISOString(), session));
}

export function acknowledgeEvents(session: string, id: number): void {
  write(() => db().query("UPDATE sessions SET cursor = MAX(cursor, ?) WHERE session = ?").run(id, session));
}

// Migrate sets it past imported history; a fresh store starts at zero.
export function ownerCursor(): number {
  return Number(db().query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'owner_cursor'").get()?.value ?? 0);
}

export function acknowledgeOwnerEvents(id: number): void {
  write(() => db().query(`INSERT INTO meta (key, value) VALUES ('owner_cursor', ?)
    ON CONFLICT (key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`).run(String(id)));
}

export function electHead(sessions: readonly SessionRow[], now: number): string | undefined {
  return sessions.filter((row) => row.drove_at && Date.parse(row.polled_at) >= now - ACTIVE_SESSION_MS)
    .sort((a, b) => b.drove_at!.localeCompare(a.drove_at!))[0]?.session;
}

export function deliveryHead(now = Date.now()): string | undefined {
  return electHead(db().query<SessionRow, []>("SELECT * FROM sessions").all(), now);
}

export interface EventsRecord {
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

// Which events reach a session: actionable kinds only, never a child's
// terminal routed to its supervisor. An addressed message goes to its
// session past that session's cursor; everything else goes to the head past
// the owner cursor. A session that is not the head passes no owner cursor.
export function selectEvents(records: readonly FeedEvent[], session: string, cursor: number, owner?: number): EventsRecord[] {
  return records.filter((event) => WAKE_EVENTS.has(event.kind) && !event.supervisor
    && (event.recipient ? event.recipient === session && event.id > cursor : owner !== undefined && event.id > owner)).map((event) => {
    const record: EventsRecord = { id: event.id, kind: event.kind, wake: true, text: renderEvent(event) };
    if (event.lane !== undefined) record.lane = event.lane;
    if (event.round !== undefined) record.round = event.round;
    if (event.job !== undefined) record.job = event.job;
    if (event.from !== undefined) record.from = event.from;
    if (event.recipient !== undefined) record.recipient = event.recipient;
    return record;
  });
}

// Hands the session its events and advances the cursors only after emit
// returns: a crash in between replays events, never drops them. Only the
// head moves the owner cursor.
export function deliverEvents(session: string, now: number, peek: boolean, emit: (events: EventsRecord[]) => void): void {
  const current = readSession(session);
  if (current && latestEventId() <= Math.min(current.cursor, ownerCursor()) && now - Date.parse(current.polled_at) < POLL_MARK_MS) { emit([]); return; }
  write(() => {
    const cursor = touchSession(session, now).cursor;
    const owner = deliveryHead(now) === session ? ownerCursor() : undefined;
    const records = eventsAfter(Math.min(cursor, owner ?? cursor));
    emit(selectEvents(records, session, cursor, owner));
    if (peek || !records.length) return;
    acknowledgeEvents(session, records.at(-1)!.id);
    if (owner !== undefined) acknowledgeOwnerEvents(records.at(-1)!.id);
  });
}

interface LaneRow { name: string; data: string }

const LANE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

// A closed lane with no round running lives in the archive table.
function archivable(entry: Lane): boolean {
  return entry.work.state === "closed" && !laneRunning(entry);
}

function archivedRow(name: string): LaneRow | undefined {
  return db().query<LaneRow, [string]>("SELECT name, data FROM archive WHERE name = ?").get(name) ?? undefined;
}

function laneRows(table: "lanes" | "archive"): Ledger {
  const lanes: Ledger = {};
  for (const row of db().query<LaneRow, []>(`SELECT name, data FROM ${table}`).all()) lanes[row.name] = JSON.parse(row.data);
  return lanes;
}

// Active lanes by name. Iteration sees only active lanes. Looking up a name
// that is not active falls through to the archive by primary key, so
// resume, review, report, wait and close still reach a closed lane; the
// lane found that way joins the object and withLedger writes it back if it
// changed.
function laneTable(lanes: Ledger, loaded?: Map<string, string>): Ledger {
  return new Proxy(lanes, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in target || !LANE_NAME.test(key)) return Reflect.get(target, key, receiver);
      const row = archivedRow(key);
      if (!row) return undefined;
      target[key] = JSON.parse(row.data);
      loaded?.set(key, row.data);
      return target[key];
    },
  });
}

export function storeLane(name: string, entry: Lane, data = safeJSON(entry)): void {
  if (archivable(entry)) {
    db().query("DELETE FROM lanes WHERE name = ?").run(name);
    db().query("INSERT OR REPLACE INTO archive (name, data, updated_at) VALUES (?, ?, ?)").run(name, data, entry.updatedAt);
  } else {
    db().query("DELETE FROM archive WHERE name = ?").run(name);
    db().query("INSERT OR REPLACE INTO lanes (name, data) VALUES (?, ?)").run(name, data);
  }
}

export function dropLane(name: string): void {
  db().query("DELETE FROM lanes WHERE name = ?").run(name);
  db().query("DELETE FROM archive WHERE name = ?").run(name);
}

export function readLedger(): Ledger {
  return laneTable(laneRows("lanes"));
}

export function findLane(name: string): Lane | undefined {
  const row = db().query<LaneRow, [string]>("SELECT name, data FROM lanes WHERE name = ?").get(name) ?? archivedRow(name);
  return row ? JSON.parse(row.data) : undefined;
}

// Active and archived lanes. Only history views and totals read this.
export function readAllLanes(): Ledger {
  return { ...laneRows("archive"), ...laneRows("lanes") };
}

// Active lanes plus archived lanes updated at or after the instant.
export function lanesUpdatedSince(iso: string): Ledger {
  const archived: Ledger = {};
  for (const row of db().query<LaneRow, [string]>("SELECT name, data FROM archive WHERE updated_at >= ?").all(iso)) archived[row.name] = JSON.parse(row.data);
  return { ...archived, ...laneRows("lanes") };
}

// The newest archived lanes, for statistics that need finished history.
export function recentArchivedLanes(limit: number): Ledger {
  const lanes: Ledger = {};
  for (const row of db().query<LaneRow, [number]>("SELECT name, data FROM archive ORDER BY updated_at DESC LIMIT ?").all(limit)) lanes[row.name] = JSON.parse(row.data);
  return lanes;
}

// Worktree repositories of closed lanes, without loading their records.
export function archivedWorktreeRepos(): string[] {
  return db().query<{ repo: string }, []>("SELECT DISTINCT json_extract(data, '$.worktreeRepo') AS repo FROM archive WHERE repo IS NOT NULL")
    .all().map((row) => row.repo);
}

// One write transaction over the active lanes. Only rows whose JSON changed
// are written back; a lane that turned closed moves to the archive.
export function withLedger<T>(mutate: (ledger: Ledger) => T): T {
  return write(() => {
    const lanes: Ledger = {};
    const loaded = new Map<string, string>();
    for (const row of db().query<LaneRow, []>("SELECT name, data FROM lanes").all()) {
      lanes[row.name] = JSON.parse(row.data);
      loaded.set(row.name, row.data);
    }
    const result = mutate(laneTable(lanes, loaded));
    for (const [name, entry] of Object.entries(lanes)) {
      const data = safeJSON(entry);
      if (loaded.get(name) !== data) storeLane(name, entry, data);
    }
    for (const name of loaded.keys()) if (!Object.hasOwn(lanes, name)) dropLane(name);
    return result;
  });
}

// One lane's row in one write transaction, for patches that touch nothing
// else: the runner's step counter must not rewrite its siblings.
export function withLane<T>(name: string, mutate: (entry: Lane | undefined) => T): T {
  return write(() => {
    const row = db().query<LaneRow, [string]>("SELECT name, data FROM lanes WHERE name = ?").get(name);
    const entry: Lane | undefined = row ? JSON.parse(row.data) : undefined;
    const result = mutate(entry);
    if (entry) {
      const data = safeJSON(entry);
      if (data !== row!.data) storeLane(name, entry, data);
    }
    return result;
  });
}

export function readLane(lane: string): Lane {
  const entry = findLane(lane);
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
  if (!lane || !["gpt", "gemini", "claude"].includes(lane.engine)) fail("lane has no valid engine; restore its engine in the ledger");
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

// The session that started a lane, kept as provenance. It routes nothing.
export function callerOwnership(): LaneOwner {
  const parent = supervisorLane();
  const ownerSession = parent ? findLane(parent)?.ownerSession : process.env.CLAUDE_CODE_SESSION_ID?.trim();
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
