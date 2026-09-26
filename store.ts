// The SQLite state store every cdx process opens directly: the CLI, detached
// runners and job runners, and the mod's CLI calls. There is no daemon.
// WAL lets readers run beside the one writer. BEGIN IMMEDIATE takes the
// write lock up front, so a transaction never fails halfway on a lock
// upgrade, and busy_timeout queues writers instead of failing them. A
// process killed inside a transaction leaves nothing behind: SQLite rolls
// the open transaction back on the next open.

import { ROOT } from "./runtime.ts";
import { safeJSON } from "./safe-text.ts";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const STATE_DIR = `${ROOT}/state`;

export const DB_PATH = `${STATE_DIR}/cdx.db`;

// Longer than any write transaction cdx holds; a writer that waits this long
// is looking at a wedged process, not contention.
const BUSY_TIMEOUT_MS = 30_000;

// Closed lanes live in archive, never in lanes, so active reads stay small.
// Event ids are the delivery cursors; AUTOINCREMENT never reuses one.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lanes (name TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archive (name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS archive_updated ON archive (updated_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL,
  recipient TEXT, sender TEXT, lane TEXT, round INTEGER, job TEXT, supervisor TEXT, message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_round ON events (lane, round, kind);
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY, cursor INTEGER NOT NULL, started_at TEXT NOT NULL, polled_at TEXT NOT NULL,
  drove_at TEXT, brief_hash TEXT, brief_at TEXT);
CREATE TABLE IF NOT EXISTS jobs (name TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (lane TEXT NOT NULL, seq INTEGER NOT NULL, round INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (lane, seq));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS panels (name TEXT PRIMARY KEY, data TEXT NOT NULL);
`;

let handle: Database | undefined;

export function db(): Database {
  if (handle) return handle;
  mkdirSync(STATE_DIR, { recursive: true });
  const opened = new Database(DB_PATH, { create: true, strict: true });
  // busy_timeout first: switching to WAL needs a lock another process may hold.
  opened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA synchronous = NORMAL");
  opened.exec(SCHEMA);
  handle = opened;
  return opened;
}

// One write transaction. Nested calls become savepoints of the outer one.
export function write<T>(action: () => T): T {
  return db().transaction(action).immediate();
}

// Read-mutate-write a JSON file that stays a file (the usage caches) under
// the store's write lock, through a temp file so a reader never sees a torn
// document.
export function withLockedJson<S, T>(path: string, read: () => S, mutate: (state: S) => T): T {
  return write(() => {
    const state = read();
    const result = mutate(state);
    const serialized = safeJSON(state, 2);
    if (!existsSync(path) || readFileSync(path, "utf8") !== serialized) {
      const tmp = `${path}.tmp.${process.pid}`;
      writeFileSync(tmp, serialized);
      renameSync(tmp, path);
    }
    return result;
  });
}
