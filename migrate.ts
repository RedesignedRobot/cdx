// cdx migrate: the one-shot import of the 9.x JSON state (ledger.json,
// feed.log, jobs.json, questions/) into the SQLite store. Nothing else reads
// those files; no command migrates on read. The import commits in one
// transaction, then the old files move to state/legacy as the backup copy.

import { acknowledgeOwnerEvents, type FeedEvent, type Lane, latestEventId, storeLane } from "./ledger.ts";
import { type Job, storeJob } from "./jobs.ts";
import { type QuestionRecord, storeQuestion } from "./questions.ts";
import { fail, LEGACY_LEDGER, parseArgs, ROOT } from "./runtime.ts";
import { db, STATE_DIR, write } from "./store.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";

export const LEGACY_DIR = `${STATE_DIR}/legacy`;

// Everything the 9.x state kept at the top of ROOT, including its lock files.
const LEGACY_PATHS = ["ledger.json", ".ledger-version", "feed.log", "jobs.json", "sessions.json", "questions", ".lock", ".events.lock", ".jobs.lock"];

// Lifecycle kinds 10.0 no longer records: progress lives in the round notes,
// the rest were never acted on.
const DROPPED_KINDS = new Set(["started", "active", "progress", "gate-started", "report-written"]);

const KEPT_KINDS = new Set(["question", "stalled", "partial", "account", "terminal", "job-exit", "message", "thrash", "overrun", "outage", "gate-finished"]);

const IMPORTED_EVENT_LINES = 5;

export function legacyStatePending(): boolean {
  return existsSync(LEGACY_LEDGER);
}

// The same shape checks the 9.x reader enforced on a version 5 ledger. A lane
// that fails them stops the import: guessing at a broken record is worse than
// asking the owner to repair it.
function validLane(entry: any): entry is Lane {
  return Boolean(entry && typeof entry === "object" && !Array.isArray(entry)
    && ["gpt", "gemini"].includes(entry.engine) && ["work", "review"].includes(entry.kind)
    && entry.work && typeof entry.work.cwd === "string"
    && ["running", "done", "failed", "gate-invalid", "adopted", "closed"].includes(entry.work.state)
    && (entry.kind !== "review" || (entry.review && typeof entry.review.cwd === "string" && ["running", "done", "failed"].includes(entry.review.state)))
    && typeof entry.updatedAt === "string");
}

function readLegacyLanes(): Record<string, Lane> {
  const document = JSON.parse(readFileSync(LEGACY_LEDGER, "utf8"));
  if (document?.version !== 5 || !document.lanes || typeof document.lanes !== "object") {
    fail(`${LEGACY_LEDGER} is not a version 5 ledger; run cdx 9.5 once to upgrade it, then migrate`);
  }
  const lanes = document.lanes as Record<string, unknown>;
  const pending = document.tokenAccounting !== 1 || Object.values(lanes).some((lane: any) => lane?.tokenAccounting !== 1);
  if (pending) fail("the ledger has lanes without token accounting 1; run cdx 9.5 status once to finish it, then migrate");
  const invalid = Object.entries(lanes).filter(([, entry]) => !validLane(entry)).map(([name]) => name);
  if (invalid.length) fail(`invalid ledger lanes: ${invalid.slice(0, 10).join(", ")}${invalid.length > 10 ? ` and ${invalid.length - 10} more` : ""}`);
  return lanes as Record<string, Lane>;
}

function readLegacyEvents(): { kept: FeedEvent[]; dropped: number } {
  const path = `${ROOT}/feed.log`;
  const kept: FeedEvent[] = [];
  let dropped = 0;
  if (!existsSync(path)) return { kept, dropped };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event?.timestamp !== "string" || typeof event.owner !== "string" || typeof event.message !== "string") continue;
    if (DROPPED_KINDS.has(event.kind)) dropped += 1;
    else if (KEPT_KINDS.has(event.kind)) kept.push(event);
  }
  return { kept, dropped };
}

function readLegacyJobs(): Record<string, Job> {
  const path = `${ROOT}/jobs.json`;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function readLegacyQuestions(): QuestionRecord[] {
  const dir = `${ROOT}/questions`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json")).flatMap((file) => {
    try {
      const record = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
      return typeof record.lane === "string" && typeof record.question === "string" && Number.isInteger(record.seq) && Number.isInteger(record.round) ? [record as QuestionRecord] : [];
    } catch { return []; }
  });
}

export interface MigrationResult { active: number; archived: number; skipped: string[]; events: number; dropped: number; jobs: number; questions: number }

// Lanes, jobs and questions already in the store win over the JSON copy: a
// lane spawned by 10.0 before the migration is the newer record. Events get
// new ids after any already stored, so no delivery cursor sees them twice.
export function migrateLegacyState(): MigrationResult {
  if (db().query("SELECT 1 FROM meta WHERE key = 'migrated'").get()) fail(`state already migrated; the old files are in ${LEGACY_DIR}`);
  if (!legacyStatePending()) fail(`no ${LEGACY_LEDGER}; nothing to migrate`);
  const lanes = readLegacyLanes();
  const { kept, dropped } = readLegacyEvents();
  const jobs = readLegacyJobs();
  const questions = readLegacyQuestions();
  const result: MigrationResult = { active: 0, archived: 0, skipped: [], events: kept.length, dropped, jobs: 0, questions: 0 };
  write(() => {
    const exists = (table: string, key: string) => Boolean(db().query(`SELECT 1 FROM ${table} WHERE name = ?`).get(key));
    for (const [name, entry] of Object.entries(lanes)) {
      if (exists("lanes", name) || exists("archive", name)) { result.skipped.push(name); continue; }
      storeLane(name, entry);
      if (exists("archive", name)) result.archived += 1;
      else result.active += 1;
    }
    const insert = db().query("INSERT INTO events (at, kind, owner, recipient, sender, lane, round, job, supervisor, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // 9.x terminals carried whole report bodies; imported ones keep the
    // five-line cap new terminals get.
    for (const event of kept) {
      insert.run(event.timestamp, event.kind, event.owner, event.recipient ?? null, event.from ?? null, event.lane ?? null,
        event.round ?? null, event.job ?? null, event.supervisor ?? null, event.message.split("\n").slice(0, IMPORTED_EVENT_LINES).join("\n"));
    }
    for (const [name, job] of Object.entries(jobs)) {
      if (exists("jobs", name)) continue;
      storeJob(name, job);
      result.jobs += 1;
    }
    for (const record of questions) {
      if (db().query("SELECT 1 FROM questions WHERE lane = ? AND seq = ?").get(record.lane, record.seq)) continue;
      storeQuestion(record);
      result.questions += 1;
    }
    // 9.x already delivered the imported history; no head replays it.
    acknowledgeOwnerEvents(latestEventId());
    db().query("INSERT INTO meta (key, value) VALUES ('migrated', ?)").run(new Date().toISOString());
  });
  mkdirSync(LEGACY_DIR, { recursive: true });
  for (const name of LEGACY_PATHS) if (existsSync(`${ROOT}/${name}`)) renameSync(`${ROOT}/${name}`, `${LEGACY_DIR}/${name}`);
  return result;
}

export function migrateCommand(argv: string[]): void {
  if (parseArgs(argv, []).rest.length) fail("usage: cdx migrate");
  const result = migrateLegacyState();
  console.log(`cdx: migrated ${result.active + result.archived} lanes (${result.active} active, ${result.archived} archived), ${result.events} events (${result.dropped} lifecycle events dropped), ${result.jobs} jobs, ${result.questions} questions`);
  if (result.skipped.length) console.log(`cdx: kept the stored copy of ${result.skipped.length} lanes: ${result.skipped.join(", ")}`);
  console.log(`cdx: old files moved to ${LEGACY_DIR}`);
}
