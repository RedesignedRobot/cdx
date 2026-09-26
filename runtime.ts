import { safeText } from "./safe-text.ts";
// Process paths, child environments, argument parsing, and terminal text helpers.

import { type Engine, type Tokens } from "./ledger.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isatty } from "node:tty";

export const HOME = process.env.HOME ?? "";

export const ROOT = resolve(process.env.CDX_STATE_HOME || process.env.CDX_HOME || `${HOME}/.cdx`);

// bun test sets NODE_ENV=test and its spawned children inherit it; gates and
// fault runs set CDX_TEST. Neither may ever open the owner's live state.
if ((process.env.NODE_ENV === "test" || process.env.CDX_TEST) && sameDirectory(ROOT, `${HOME}/.cdx`)) {
  throw new Error(`cdx: refusing the live state home ${ROOT} under test; set CDX_STATE_HOME to a temp directory`);
}

function sameDirectory(left: string, right: string): boolean {
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return real(left) === real(right);
}

// The 9.x JSON ledger. Only cdx migrate reads it.
export const LEGACY_LEDGER = `${ROOT}/ledger.json`;

export const CONFIG_PATH = `${ROOT}/config.json`;

export const USAGE_PATH = `${ROOT}/usage.json`;

export const GEMINI_USAGE_PATH = `${ROOT}/usage-gemini.json`;

export const GEMINI_QUOTA_PATH = `${ROOT}/gemini-quota.json`;

// Source modules launch cdx.ts. In the single-file bundle, keep the bundle's path.
export const SELF = import.meta.path.replace(/\/runtime\.ts$/, "/cdx.ts");

export const REPO_ROOT = SELF.replace(/\/cdx\.ts$/, "");

export const VERSION = "9.5.0";

const COLOR_ENABLED = process.argv[2] !== "_run" && process.env.NO_COLOR === undefined
  && (process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== "0"
    // tty.isatty, not process.stdout.isTTY: touching process.stdout under Bun
    // 1.4 flips fd 1 non-blocking and console.log then truncates piped output at 64KB.
    : isatty(1) && isatty(2));

const style = (code: number) => (text: string) => COLOR_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text;

export const color = {
  bold: style(1),
  dim: style(2),
  red: style(31),
  green: style(32),
  yellow: style(33),
  magenta: style(35),
  cyan: style(36),
};

export function uncoloredChildEnv(codexHome?: string, stateHome?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  if (stateHome !== undefined) env.CDX_STATE_HOME = stateHome;
  return env;
}

interface LaneEnvironment {
  lane: string;
  round: number;
  owner?: string;
  supervisor?: boolean;
}

// A supervisor lane carries CDX_SUPERVISOR=<its own name>; every other lane,
// a supervisor's children included, has it removed so delegation stays one
// level deep.
export function laneChildEnv(codexHome: string | undefined, context: LaneEnvironment, engine: Engine = "gpt") {
  const env: Record<string, string | undefined> = {
    ...uncoloredChildEnv(codexHome),
    CDX_HOME: ROOT,
    CDX_LANE: context.lane,
    CDX_ROUND: String(context.round),
    CDX_OWNER: context.owner ?? "terminal",
  };
  if (context.supervisor) env.CDX_SUPERVISOR = context.lane;
  else delete env.CDX_SUPERVISOR;
  if (engine === "gemini") delete env.CODEX_HOME;
  return env;
}

// The runner is a harness process, not a worker: it must never inherit a
// lane identity from the shell that launched it.
export function runnerEnv(codexHome: string | undefined) {
  const env: Record<string, string | undefined> = uncoloredChildEnv(codexHome, ROOT);
  delete env.CDX_LANE;
  delete env.CDX_ROUND;
  delete env.CDX_SUPERVISOR;
  return env;
}

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }

export function completionVerdict(state: string, note?: string): string {
  return statusText(note ? `${state}: ${note}` : state, 240);
}

export function coloredState(state: string, text = state): string {
  if (state === "running") return color.yellow(text);
  if (state === "running(dead?)" || state === "failed" || state === "gate-invalid") return color.red(text);
  if (state === "done") return color.green(text);
  if (state === "closed") return color.dim(text);
  return text;
}

export class CmdError extends Error {}

export function fail(message: string): never {
  throw new CmdError(message);
}

export function singleLine(text: string): string {
  return safeText(text).replace(/[\r\n]+/g, " ").trim();
}

export function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

// Flag parsing

const VALUE_FLAGS = new Set(["engine", "effort", "cd", "scope", "schema", "base", "commit", "timeout", "days", "n", "note", "account", "worktree", "gate", "max-runtime", "id", "model", "port", "pre", "interval", "expect", "scope-policy", "rubric"]);

const LIST_FLAGS = new Set(["add-dir", "image"]);

const BOOL_FLAGS = new Set(["bg", "json", "uncommitted", "fix", "probe", "follow", "all", "report", "remove-worktree", "keep-worktree", "clear", "transcript", "tools", "supervisor", "brief", "watch", "line", "peek", "snapshot", "totals", "downscale"]);

// A flag missing from these sets fails as "unknown flag" even when the
// command allows it; cdx.test.ts checks every parseArgs allow-list.
export function registeredFlag(name: string): boolean {
  return BOOL_FLAGS.has(name) || VALUE_FLAGS.has(name) || LIST_FLAGS.has(name);
}

export interface Parsed { flags: Record<string, string>; lists: Record<string, string[]>; bools: Set<string>; rest: string[] }

export function parseArgs(argv: string[], allowed: string[]): Parsed {
  const allowedSet = new Set(allowed);
  const parsed: Parsed = { flags: {}, lists: {}, bools: new Set(), rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    // "--" ends the flags; free text that starts with dashes follows it.
    if (arg === "--") { parsed.rest.push(...argv.slice(index + 1)); break; }
    const name = arg.startsWith("--") ? arg.slice(2) : arg === "-n" ? "n" : arg === "-f" ? "follow" : undefined;
    if (name && (BOOL_FLAGS.has(name) || VALUE_FLAGS.has(name) || LIST_FLAGS.has(name)) && !allowedSet.has(name)) {
      fail(`${arg} is not valid for this command`);
    }
    if (name && BOOL_FLAGS.has(name)) { parsed.bools.add(name); continue; }
    if (name && (VALUE_FLAGS.has(name) || LIST_FLAGS.has(name))) {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      if (LIST_FLAGS.has(name)) (parsed.lists[name] ??= []).push(value);
      else parsed.flags[name] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) fail(`unknown flag ${arg}`);
    parsed.rest.push(arg);
  }
  return parsed;
}

export function resolveStdinText(text: string | undefined, stdinContent: string, usage: string): string | undefined {
  if (text !== "-") return text;
  const trimmed = stdinContent.trim();
  if (!trimmed) fail(usage);
  return trimmed;
}

// An argument of "-" reads stdin, so long prompts with quotes and backticks never
// fight the shell. An empty stdin fails with the command's usage line.
export async function resolveBrief(text: string | undefined, usage: string): Promise<string | undefined> {
  if (text !== "-") return text;
  return resolveStdinText(text, await Bun.stdin.text(), usage);
}

export function fmtTokens(tokens?: Tokens, incomplete?: boolean): string {
  if (!tokens || (!tokens.input && !tokens.output && !tokens.cached)) return incomplete ? "(incomplete)" : "-";
  const k = (n?: number) => { const v = n ?? 0; return v >= 1000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : String(v); };
  const base = `${k(tokens.input)}in/${k(tokens.output)}out`;
  return incomplete ? `${base} (incomplete)` : base;
}

// What to do until a detached lane or job settles. A lane has only the CLI,
// so it waits; the head is woken by the mod and must not.
export function settleHint(target: string): string {
  return process.env.CDX_LANE
    ? `cdx wait ${color.magenta(target)} blocks until it settles`
    : `end your turn; a [cdx] event wakes you when ${color.magenta(target)} settles (mcp__cdx__status checks in)`;
}

export function fmtAge(iso?: string): string {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function displayPath(path: string): string {
  if (path === HOME) return "~";
  return path.startsWith(`${HOME}/`) ? `~/${path.slice(HOME.length + 1)}` : path;
}

export function fmtCreated(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "-";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getDate()} ${months[date.getMonth()]} ${hour}:${minute}`;
}

export function statusText(text: string, limit: number): string {
  const clean = safeText(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

export function statusAge(iso: string | undefined, now: number): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "-";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
}

export const FINISHED_SHOWN = 10;

export function fmtUntil(unixSeconds: number, now = Date.now()): string {
  const ms = unixSeconds * 1000 - now;
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${(minutes / 1440).toFixed(1)}d`;
}

export function rateLimitWindowName(minutes: number): string {
  if (minutes === 10_080) return "weekly";
  if (minutes === 300) return "5h";
  return `${minutes / 60}h`;
}

// Local wall-clock instant, "Sun 20 Sep 23:33": the head plans lanes against
// the exact reset, so a day-only date sent it to the raw usage file.
export function fmtLocalInstant(ms: number): string {
  const date = new Date(ms);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${clock}`;
}

export function rateLimitResetDate(unixSeconds: number): string {
  return fmtLocalInstant(unixSeconds * 1000);
}

export function fmtTokensFull(tokens: Tokens, incomplete?: boolean): string {
  const k = (n?: number) => { const v = n ?? 0; return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : String(v); };
  const base = `${k(tokens.input)} in (${k(tokens.cached)} cached) / ${k(tokens.output)} out`;
  return incomplete ? `${base} (incomplete)` : base;
}
