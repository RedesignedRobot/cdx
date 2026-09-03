#!/usr/bin/env bun
// cdx runs tracked Codex and Gemini execution lanes for Claude Code users.
//
//   cdx spawn  <lane> --engine gpt|gemini [--account <name>] [--effort <effort>] [--cd <dir>] [--worktree <path>] [--bg] [--add-dir <d>]... [--schema <file>] [--image <f>]... [--gate <cmd>] [--gate-baseline-check] [--max-runtime <min>] "<brief>"
//   cdx resume <lane> [--effort <effort>] [--gate <cmd>] [--bg] [--max-runtime <min>] "<follow-up>"
//   cdx fork   <newLane> <fromLane|sessionId> [--account <name>] [--effort <effort>] [--bg] "<brief>"
//   cdx review <lane> --engine gpt|gemini [--account <name>] [--effort <effort>] [--cd <dir>] [--bg] [--uncommitted | --base <branch> | --commit <sha>] [--scope "<files>"] ["<intent>"]
//   cdx adopt  <lane> <sessionId> --engine gpt|gemini [--account <name>] [--cd <dir>]
//   cdx send   <lane> "<text>"
//   cdx ask    [--timeout <min>] "<question>"
//   cdx reply  <lane> [--id <seq>] "<answer>"
//   cdx questions [lane]
//   cdx msg    <target> "<text>"
//   cdx inbox  [-n <lines>]
//   cdx status [--all] [--json]
//   cdx usage  [--json]
//   cdx wait   <lane>... [--timeout <sec>] [--json] [--report]
//   cdx tail   <lane> [-n <lines>]
//   cdx feed   [-n <lines>]
//   cdx report <lane> [round]
//   cdx log    <lane> [round]
//   cdx gate   <lane> "<cmd>" | --clear
//   cdx kill   <lane> ["note"]
//   cdx close  <lane> [--remove-worktree] ["note"]
//   cdx clean  [--days <n>]
//   cdx doctor [--fix] [--probe]
//
// A brief of "-" reads the brief from stdin, which sidesteps shell quoting for
// long prompts.
//
// cdx policy comes from $CDX_HOME/config.json. Work lanes cannot commit, push,
// or deploy. Reviews always get a fresh session. Codex uses a read-only
// sandbox, while Gemini fails the round if its before-and-after tree hash moves.
// Worktree creation runs config.worktreeSetup if set, followed by an executable
// .cdx-worktree-setup at the new worktree root if present.
//
// CLI facts this harness absorbs (codex-cli 0.149.1, verified):
// - Work rounds use app-server JSON-RPC over newline-delimited stdio. Reviews
//   stay on `codex exec` and `codex review` as read-only one-shot commands.
// - app-server uses thread/start, thread/resume, thread/fork, turn/start, and
//   turn/steer. turn/steer requires the active expectedTurnId on 0.149.1.
// - `codex review` takes exactly one of --uncommitted/--base/--commit OR a
//   custom prompt, never both; it reviews the process cwd.
// - app-server emits thread/started, turn/started, item/*,
//   thread/tokenUsage/updated, and turn/completed notifications.
// - Gemini rounds use agy stream-json input and output. Each cdx send record
//   becomes a queued follow-up turn because agy has no mid-turn steer.

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  lstatSync, readlinkSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isatty } from "node:tty";
import { join, relative } from "node:path";

const HOME = process.env.HOME ?? "";
const ROOT = (process.argv[2] === "_run" ? process.env.CDX_STATE_HOME : undefined)
  || process.env.CDX_HOME || `${HOME}/.cdx`;
const LEDGER = `${ROOT}/ledger.json`;
const CONFIG_PATH = `${ROOT}/config.json`;
const USAGE_PATH = `${ROOT}/usage.json`;
const GEMINI_USAGE_PATH = `${ROOT}/usage-gemini.json`;
const GEMINI_TRANSPORT_ERRORS = [/stream was interrupted/i, /timeout waiting for response/i];
const SELF = import.meta.path;
const REPO_ROOT = SELF.replace(/\/cdx\.ts$/, "");
const VERSION = "3.1.0";

const COLOR_ENABLED = process.argv[2] !== "_run" && process.env.NO_COLOR === undefined
  && (process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== "0"
    // tty.isatty, not process.stdout.isTTY: touching process.stdout under Bun
    // 1.4 flips fd 1 non-blocking and console.log then truncates piped output at 64KB.
    : isatty(1) && isatty(2));
const style = (code: number) => (text: string) => COLOR_ENABLED ? `\x1b[${code}m${text}\x1b[0m` : text;
const color = {
  bold: style(1),
  dim: style(2),
  red: style(31),
  green: style(32),
  yellow: style(33),
  magenta: style(35),
  cyan: style(36),
};

function uncoloredChildEnv(codexHome?: string, stateHome?: string) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  if (codexHome !== undefined) env.CODEX_HOME = codexHome;
  if (stateHome !== undefined) env.CDX_STATE_HOME = stateHome;
  return env;
}

interface LaneEnvironment {
  lane: string;
  round: number;
  owner?: string;
}

function laneChildEnv(codexHome: string | undefined, context: LaneEnvironment, engine: Engine = "gpt") {
  const env = {
    ...uncoloredChildEnv(codexHome),
    CDX_HOME: ROOT,
    CDX_LANE: context.lane,
    CDX_ROUND: String(context.round),
    CDX_OWNER: context.owner ?? "terminal",
  };
  if (engine === "gemini") delete env.CODEX_HOME;
  return env;
}

type Effort = string;
type Engine = "gpt" | "gemini";
type Mode = "spawn" | "resume" | "fork" | "review-exec" | "review-native";

interface GeminiConfig {
  model: string;
  agent: string;
  reviewAgent: string;
}

interface Config {
  model: string;
  efforts: string[];
  defaultEffort: string;
  rules: string[];
  accounts?: Record<string, string>;
  worktreeSetup?: string;
  gemini?: GeminiConfig;
}

interface Tokens { input: number; cached: number; output: number }

type WorkState = "running" | "done" | "failed" | "gate-invalid" | "adopted" | "closed";
type ReviewState = "running" | "done" | "failed";

interface GateBaseline {
  round: number;
  command: string;
  cwd: string;
  exitCode: number;
  checkedAt: string;
}

interface Lane {
  engine?: Engine;
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
  // cwd and state remain the stable work values for old ledger consumers.
  cwd: string;
  workCwd?: string;
  effort: Effort;
  state: WorkState;
  workState?: WorkState;
  workRound?: number;
  workUpdatedAt?: string;
  workReport?: string;
  kind: "work" | "review";
  rounds: number;
  reports: string[];
  tokens?: Tokens;
  roundTokens?: Tokens;
  steers?: number;
  steerOpen?: boolean;
  continuations?: number;
  // Acceptance gate command; work rounds rerun it at finalize, reviews never.
  gate?: string;
  gateBaseline?: GateBaseline;
  reviewState?: ReviewState;
  reviewCwd?: string;
  reviewRound?: number;
  reviewExitCode?: number;
  reviewNote?: string;
  reviewReport?: string;
  reviewUpdatedAt?: string;
  pid?: number;
  codexPid?: number;
  lastAction?: string;
  lastEventAt?: string;
  exitCode?: number;
  note?: string;
  diffEmpty?: true;
  worktreePath?: string;
  worktreeRepo?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
  roundStartedAt?: string;
}

interface Spec {
  engine?: Engine;
  mode: Mode;
  lane: string;
  round: number;
  cwd: string;
  prompt: string;
  model?: string;
  codexArgs?: string[];
  sourceThreadId?: string;
  additionalDirectories?: string[];
  images?: string[];
  outputSchema?: unknown;
  account?: string;
  codexHome?: string;
  multiAccountUsage?: true;
  ownerSession?: string;
  ownerCwd?: string;
  gate?: string;
  gateBaselineChecked?: true;
  reviewDir?: string;
  maxRuntimeMins?: number;
}

type Ledger = Record<string, Lane>;

function coloredState(state: string, text = state): string {
  if (state === "running") return color.yellow(text);
  if (state === "running(dead?)" || state === "failed" || state === "gate-invalid") return color.red(text);
  if (state === "done") return color.green(text);
  if (state === "closed") return color.dim(text);
  return text;
}

function fail(message: string): never {
  console.error(color.red(`cdx: ${message}`));
  process.exit(1);
}

function configError(message: string): never {
  fail(`${CONFIG_PATH}: ${message}`);
}

function readConfig(skipFile = false): Config {
  const defaults: Config = {
    model: "gpt-5.6-sol",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    rules: [],
  };
  if (skipFile || !existsSync(CONFIG_PATH)) return defaults;

  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    configError(`cannot read config: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text!);
  } catch (error) {
    configError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    configError("config must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set(["model", "efforts", "defaultEffort", "rules", "accounts", "worktreeSetup", "gemini"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) configError(`unknown config key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

  const model = Object.hasOwn(input, "model") ? input.model : defaults.model;
  if (typeof model !== "string" || model.trim().length === 0) configError("model must be a nonempty string");

  const efforts = Object.hasOwn(input, "efforts") ? input.efforts : defaults.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) configError("efforts must be a nonempty array of strings");
  if (efforts.some((effort) => typeof effort !== "string" || effort.trim().length === 0)) {
    configError("efforts must contain only nonempty strings");
  }
  if (new Set(efforts).size !== efforts.length) configError("efforts must not contain duplicates");

  const defaultEffort = Object.hasOwn(input, "defaultEffort") ? input.defaultEffort : defaults.defaultEffort;
  if (typeof defaultEffort !== "string") configError("defaultEffort must be a string");
  if (!efforts.includes(defaultEffort)) configError("defaultEffort must be one of the configured efforts");

  const rules = Object.hasOwn(input, "rules") ? input.rules : defaults.rules;
  if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string")) {
    configError("rules must be an array of strings");
  }

  let accounts: Record<string, string> | undefined;
  if (Object.hasOwn(input, "accounts")) {
    const value = input.accounts;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      configError("accounts must be an object mapping account names to Codex home directories");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) configError("accounts must contain at least one entry");
    const parsedAccounts: [string, string][] = [];
    for (const [name, path] of entries) {
      if (name.trim().length === 0) configError("account names must be nonempty strings");
      if (typeof path !== "string" || path.trim().length === 0) {
        configError(`accounts.${name} must be a nonempty string`);
      }
      const home = path === "~" ? HOME : path.startsWith("~/") ? `${HOME}/${path.slice(2)}` : path;
      parsedAccounts.push([name, home]);
    }
    accounts = Object.fromEntries(parsedAccounts);
  }

  let worktreeSetup: string | undefined;
  if (Object.hasOwn(input, "worktreeSetup")) {
    if (typeof input.worktreeSetup !== "string" || input.worktreeSetup.trim().length === 0) {
      configError("worktreeSetup must be a nonempty string (a shell command run inside each new worktree)");
    }
    worktreeSetup = input.worktreeSetup;
  }

  let gemini: GeminiConfig | undefined;
  if (Object.hasOwn(input, "gemini")) {
    const value = input.gemini;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      configError("gemini must be an object");
    }
    const geminiInput = value as Record<string, unknown>;
    const geminiAllowed = new Set(["model", "agent", "reviewAgent"]);
    const unknownGemini = Object.keys(geminiInput).filter((key) => !geminiAllowed.has(key));
    if (unknownGemini.length > 0) {
      configError(`unknown gemini key${unknownGemini.length === 1 ? "" : "s"}: ${unknownGemini.join(", ")}`);
    }
    const defaults = geminiConfig();
    const values = {
      model: geminiInput.model ?? defaults.model,
      agent: geminiInput.agent ?? defaults.agent,
      reviewAgent: geminiInput.reviewAgent ?? defaults.reviewAgent,
    };
    for (const [key, field] of Object.entries(values)) {
      if (typeof field !== "string" || field.trim().length === 0) configError(`gemini.${key} must be a nonempty string`);
    }
    gemini = values as GeminiConfig;
  }

  return {
    model, efforts: efforts as string[], defaultEffort, rules: rules as string[],
    ...(accounts ? { accounts } : {}), ...(worktreeSetup ? { worktreeSetup } : {}), ...(gemini ? { gemini } : {}),
  };
}

function geminiConfig(): GeminiConfig {
  return {
    model: "gemini-3.8-flash-high",
    agent: "cdx-lane",
    reviewAgent: "cdx-review",
  };
}

const config = readConfig(process.argv[2] === "_run");

for (const dir of ["logs", "reports", "briefs", "specs", "control", "questions"]) mkdirSync(`${ROOT}/${dir}`, { recursive: true });

// Thrown instead of fail() inside withLedger callbacks: process.exit skips
// finally blocks and would strand the ledger lock. The dispatcher converts it.
class CmdError extends Error {}

function singleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function readTailLines(path: string, limit: number, accept: (line: string) => boolean = () => true): string[] {
  if (!existsSync(path) || limit < 1) return [];
  const fd = openSync(path, "r");
  try {
    let position = statSync(path).size;
    let carry = "";
    const newestFirst: string[] = [];
    while (position > 0 && newestFirst.length < limit) {
      const length = Math.min(65_536, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      const parts = `${chunk.toString("utf8")}${carry}`.split("\n");
      carry = parts.shift() ?? "";
      for (let index = parts.length - 1; index >= 0 && newestFirst.length < limit; index -= 1) {
        const line = parts[index]!;
        if (line && accept(line)) newestFirst.push(line);
      }
    }
    if (position === 0 && carry && newestFirst.length < limit && accept(carry)) newestFirst.push(carry);
    return newestFirst.reverse();
  } finally {
    closeSync(fd);
  }
}

// One line per lane completion; the plugin monitor tails this file and
// delivers each line to the Claude session as a notification.
function feed(line: string): boolean {
  try {
    writeFileSync(`${ROOT}/feed.log`, `${singleLine(line)}\n`, { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

function ownerSuffix(ownerSession?: string): string {
  return ` owner=${ownerSession?.slice(0, 8) || "terminal"}`;
}

function feedOwned(line: string, ownerSession?: string): boolean {
  return feed(`${line}${ownerSuffix(ownerSession)}`);
}

function readLedger(): Ledger {
  if (!existsSync(LEDGER)) return {};
  return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
}

function withLedger<T>(mutate: (ledger: Ledger) => T): T {
  const lock = `${ROOT}/.lock`;
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
      if (Date.now() > deadline) fail("ledger lock timeout");
      Bun.sleepSync(50);
    }
  }
  try {
    const ledger = readLedger();
    const result = mutate(ledger);
    const tmp = `${LEDGER}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    renameSync(tmp, LEDGER);
    return result;
  } finally {
    try { rmdirSync(lock); } catch { /* broken by a peer */ }
  }
}

function readLane(lane: string): Lane {
  const entry = readLedger()[lane];
  if (!entry) fail(`unknown lane "${lane}" (cdx status lists lanes)`);
  return entry;
}

function workCwdOf(entry: Lane): string {
  return entry.workCwd ?? entry.worktreePath ?? entry.cwd;
}

function workStateOf(entry: Lane): WorkState {
  if (entry.workState) return entry.workState;
  // Old ledgers used state for the active review. A recorded work session
  // proves that a work round completed before that review started.
  if (entry.kind === "review" && entry.state === "running") return entry.workSessionId ? "done" : "adopted";
  return entry.state;
}

function activeStateOf(entry: Lane): WorkState | ReviewState {
  if (entry.kind === "review") return entry.reviewState ?? entry.state;
  return entry.state;
}

function laneRunning(entry: Lane): boolean {
  return activeStateOf(entry) === "running";
}

function roundStateOf(entry: Lane): WorkState | ReviewState {
  return entry.kind === "review" ? entry.reviewState ?? entry.state : entry.state;
}

function roundExitCodeOf(entry: Lane): number | undefined {
  return entry.kind === "review" ? entry.reviewExitCode : entry.exitCode;
}

function roundNoteOf(entry: Lane): string | undefined {
  return entry.kind === "review" ? entry.reviewNote : entry.note;
}

function roundReportOf(entry: Lane): string | undefined {
  const direct = entry.kind === "review" ? entry.reviewReport : entry.workReport;
  if (direct) return direct;
  const fallback = entry.reports.at(-1);
  return fallback?.endsWith(`-r${entry.rounds}.md`) ? fallback : undefined;
}

function validLane(lane: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(lane)) fail(`lane name "${lane}" must be alphanumeric with . _ - only`);
  return lane;
}

const reportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.md`;
const partialReportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.partial.md`;
const logPathOf = (lane: string, round: number, json: boolean) => `${ROOT}/logs/${lane}-r${round}.${json ? "jsonl" : "log"}`;
const specPathOf = (lane: string, round: number) => `${ROOT}/specs/${lane}-r${round}.json`;
const controlPathOf = (lane: string, round: number) => `${ROOT}/control/${lane}-r${round}.jsonl`;

function geminiTranscriptPath(conversationId: string): string {
  const base = process.env.CDX_AGY_STATE_HOME ?? `${HOME}/.gemini/antigravity-cli`;
  return `${base}/brain/${conversationId}/.system_generated/logs/transcript_full.jsonl`;
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const SESSION_UUID = /^[0-9a-f-]{36}$/i;

interface RolloutSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  source?: unknown;
}

function rolloutDateDirs(sessionsRoot: string, startedAt: Date): string[] {
  const dirs: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(startedAt);
    date.setDate(date.getDate() + offset);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dirs.push(`${sessionsRoot}/${year}/${month}/${day}`);
  }
  return dirs;
}

function readRolloutSessionMeta(path: string): RolloutSessionMeta | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < 1_048_576) {
      const chunk = Buffer.alloc(4096);
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (count === 0) break;
      const newline = chunk.subarray(0, count).indexOf(10);
      chunks.push(chunk.subarray(0, newline >= 0 ? newline : count));
      length += newline >= 0 ? newline : count;
      if (newline >= 0) break;
    }
    const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      type?: string;
      payload?: Partial<RolloutSessionMeta>;
    };
    const meta = event.type === "session_meta" ? event.payload : undefined;
    if (!meta || typeof meta.id !== "string" || !SESSION_UUID.test(meta.id)
      || typeof meta.timestamp !== "string" || typeof meta.cwd !== "string") return undefined;
    return meta as RolloutSessionMeta;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A raw-session fork has no lane to borrow a cwd from; the rollout file named
// by the UUID holds the session's real workdir.
function rolloutCwdForSession(codexHome: string, sessionId: string): string | undefined {
  let files: string[];
  try { files = readdirSync(`${codexHome}/sessions`, { recursive: true }) as string[]; } catch { return undefined; }
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const match = files.find((file) => file.toLowerCase().endsWith(suffix));
  return match ? readRolloutSessionMeta(`${codexHome}/sessions/${match}`)?.cwd : undefined;
}

function resolveSessionIdFromRollouts(spec: Spec, roundStartedAt?: string): string | undefined {
  if (!roundStartedAt) return undefined;
  const startedMs = Date.parse(roundStartedAt);
  if (!Number.isFinite(startedMs)) return undefined;
  const codexHome = spec.codexHome || process.env.CODEX_HOME || `${HOME}/.codex`;
  const candidates: Array<{ id: string; distance: number; topLevel: boolean }> = [];
  for (const dir of rolloutDateDirs(`${codexHome}/sessions`, new Date(startedMs))) {
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!/^rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(file)) continue;
      const meta = readRolloutSessionMeta(`${dir}/${file}`);
      if (!meta) continue;
      let cwdMatches = meta.cwd === spec.cwd;
      try { cwdMatches ||= realpathSync(meta.cwd) === realpathSync(spec.cwd); } catch { /* compare the stored paths only */ }
      if (!cwdMatches) continue;
      const timestampMs = Date.parse(meta.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs < startedMs - 5000 || timestampMs > startedMs + 60_000) continue;
      candidates.push({
        id: meta.id,
        distance: Math.abs(timestampMs - startedMs),
        topLevel: meta.source === "exec",
      });
    }
  }
  const topLevel = candidates.filter((candidate) => candidate.topLevel);
  const matches = topLevel.length > 0 ? topLevel : candidates;
  matches.sort((left, right) => left.distance - right.distance);
  return matches[0]?.id;
}

// ---------------------------------------------------------------------------
// Briefs: standing rules injected once here so per-lane briefs stay short.
// ---------------------------------------------------------------------------

function houseRules(cwd: string, reviewOnly: boolean, engine: Engine = "gpt"): string {
  const builtIns = [
    reviewOnly
      ? "READ-ONLY: change nothing in the tree; write only your report."
      : "Never commit, push, deploy, or start long-running servers beyond what specs start themselves.",
    "Your final response is the lane report. Include what changed or what you reviewed, verification evidence, and any risks or follow-ups.",
  ];
  if (!reviewOnly) {
    builtIns.push("Never run cdx spawn, resume, fork, review, adopt, kill, or close from inside a lane; the harness refuses them. cdx ask is the only harness command you need.");
    if (engine === "gemini") {
      builtIns.push("Execute the task as written. Do not redesign, expand scope, or resolve open design questions yourself. When the brief leaves a gap that changes the outcome, run cdx ask and wait for the answer; ask small, specific questions, one per gap. If the answer times out, take the narrowest reading, state it in the report, and stop there.");
      builtIns.push("If the task splits into independent parts, parallelize with your own subagent threads rather than working them serially.");
      builtIns.push("Before reporting, remove every debug print you added (console.log, print, fmt.Println and the like) and re-run the tests you cite.");
      builtIns.push("The report lists exactly which files changed, the commands you ran with their exit codes, and the Assumptions heading (write 'none' if empty).");
    } else {
      builtIns.push("If the task splits into independent parts, parallelize with your own subagent threads rather than working them serially.");
      builtIns.push('When the brief leaves open something that changes the architecture or the file set, run `cdx ask "<question>"` and wait for the answer instead of guessing. Ask once per open point; never ask what the brief or the code already answers.');
    }
  }
  const sections = [builtIns.map((rule) => `- ${rule}`).join("\n")];
  if (config.rules.length > 0) sections.push(config.rules.map((rule) => `- ${rule}`).join("\n"));
  const projectRules = `${cwd}/.cdx-rules.md`;
  if (existsSync(projectRules)) {
    const text = readFileSync(projectRules, "utf8").trim();
    if (text) sections.push(text);
  }
  return sections.join("\n");
}

const REVIEW_FINDINGS_SCHEMA = {
  type: "object",
  required: ["report", "findings"],
  properties: {
    report: { type: "string", description: "the full markdown review report" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "confidence", "file", "line", "summary"],
        properties: {
          severity: { type: "string", enum: ["P1", "P2", "P3"] },
          confidence: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE"] },
          file: { type: "string" },
          line: { type: "integer" },
          summary: { type: "string" },
        },
      },
    },
  },
};

const REVIEW_FRAME_BASE = "ADVERSARIAL REVIEW. Hunt real defects: correctness bugs, races, authorization holes, contract breaks, test gaps. Severity-rank findings, each with a concrete failure scenario, and mark each CONFIRMED (you traced the code path) or PLAUSIBLE (you could not fully trace it). If clean, say clean and list exactly what you checked.";
const REVIEW_FRAME_GPT = `${REVIEW_FRAME_BASE} End the report with a fenced json code block: {"findings":[{"severity":"P1|P2|P3","confidence":"CONFIRMED|PLAUSIBLE","file":"...","line":0,"summary":"..."}]}. Use an empty findings array when clean.`;
const REVIEW_FRAME_GEMINI = `${REVIEW_FRAME_BASE} Your final answer is captured as structured output: put the complete markdown report in the report field and every finding in the findings array (empty when clean).`;

function reviewFrame(engine: Engine): string {
  return engine === "gemini" ? REVIEW_FRAME_GEMINI : REVIEW_FRAME_GPT;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["engine", "effort", "cd", "scope", "schema", "base", "commit", "timeout", "days", "n", "note", "account", "worktree", "gate", "max-runtime", "id"]);
const LIST_FLAGS = new Set(["add-dir", "image"]);
const BOOL_FLAGS = new Set(["bg", "json", "uncommitted", "fix", "probe", "follow", "all", "report", "remove-worktree", "clear", "gate-baseline-check", "transcript"]);

interface Parsed { flags: Record<string, string>; lists: Record<string, string[]>; bools: Set<string>; rest: string[] }

function parseArgs(argv: string[], allowed: string[]): Parsed {
  const allowedSet = new Set(allowed);
  const parsed: Parsed = { flags: {}, lists: {}, bools: new Set(), rest: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
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

function configuredEffort(effort: string): Effort {
  if (!config.efforts.includes(effort)) {
    fail(`effort must be one of ${config.efforts.join(", ")}, set in ${CONFIG_PATH}; got "${effort}"`);
  }
  return effort;
}

function effortOf(parsed: Parsed): Effort {
  return configuredEffort(parsed.flags.effort ?? config.defaultEffort);
}

const ENGINE_PICKER = `gemini is the default; pass --engine gpt for design-heavy or judgment work
gpt:
+ strongest code and judgment on hard multi-file work, design-heavy lanes
- slow (20-30 min lanes), scarce weekly budget, burns fast
gemini:
+ near-unlimited quota, fast, good on bounded briefs (investigate, read, search, audit, review, test, small scoped builds)
- weaker adversarial self-doubt, needs a precise brief with named files and acceptance checks
gemini is the default engine for execution. Tell it exactly what to do and a lane finishes in about nine minutes, against forty to fifty for gpt. Judgment calls, discovery, design analysis, and open questions stay with gpt or the head.
gemini: one outcome per lane, brief under a page, fan out many lanes in parallel.
gpt: one big brief for sweeping multi-file work.`;

function engineOf(parsed: Parsed, command: "spawn" | "review" | "adopt"): Engine {
  const value = parsed.flags.engine;
  if (value === undefined) {
    console.log("cdx: engine gemini (default)");
    return "gemini";
  }
  if (value === "gpt" || value === "gemini") return value;
  const usage = `usage: cdx ${command} requires --engine gpt|gemini; gemini is the default for fully specified work, gpt for judgment and design-heavy multi-file work`;
  if (command === "spawn") fail(`${usage}\n\n${ENGINE_PICKER}`);
  fail(usage);
}

function laneEngine(lane: Pick<Lane, "engine"> | undefined): Engine {
  return lane?.engine ?? "gpt";
}

// The engine a round actually ran on: reviews record their own beside the
// work engine, so status and wait name the runtime that produced the report.
function roundEngine(lane: Lane): Engine {
  return lane.kind === "review" ? lane.reviewEngine ?? laneEngine(lane) : laneEngine(lane);
}

// A work lane that died before its runtime handed back a session has no
// thread to protect; its engine may follow the next round.
function hasWorkThread(lane: Lane): boolean {
  return Boolean(lane.workSessionId) || (lane.kind === "work" && Boolean(lane.sessionId));
}

function engineEffort(engine: Engine, parsed: Parsed, inherited?: Effort): Effort {
  if (engine === "gemini") {
    if (parsed.flags.effort !== undefined) {
      console.error("cdx: --effort ignored for gemini; gemini lanes always run gemini-3.8-flash-high");
    }
    return "high";
  }
  return parsed.flags.effort ? configuredEffort(parsed.flags.effort) : inherited ?? configuredEffort(config.defaultEffort);
}

function requireEngineBinary(engine: Engine): void {
  if (engine === "gemini" && !Bun.which("agy")) {
    fail("agy is not on PATH; install Google Antigravity CLI and make ~/.local/bin/agy available");
  }
}

function rejectEngineMismatch(laneName: string, lane: Lane, requested: Engine): void {
  const recorded = laneEngine(lane);
  if (recorded !== requested) fail(`lane "${laneName}" uses engine ${recorded}; choose --engine ${recorded}`);
}

function maxRuntimeOf(parsed: Parsed): number | undefined {
  const raw = parsed.flags["max-runtime"];
  if (raw === undefined) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) fail("--max-runtime must be a positive number of minutes");
  return minutes;
}

interface AccountChoice { name: string; home: string }

function configuredAccount(name: string): AccountChoice {
  const accounts = config.accounts;
  if (!accounts || !Object.hasOwn(accounts, name)) {
    const detail = config.accounts ? `unknown account "${name}"; choose one of ${Object.keys(config.accounts).join(", ")}`
      : `--account requires an accounts object in ${CONFIG_PATH}`;
    fail(detail);
  }
  return { name, home: accounts[name]! };
}

function primaryAccount(forced?: string): AccountChoice | undefined {
  if (forced !== undefined) return configuredAccount(forced);
  const first = config.accounts && Object.entries(config.accounts)[0];
  return first ? { name: first[0], home: first[1] } : undefined;
}

function laneAccount(lane: Lane): AccountChoice | undefined {
  if (lane.account === undefined && lane.codexHome === undefined) return undefined;
  if (lane.account === undefined || lane.codexHome === undefined) {
    fail("lane account affinity is incomplete; restore its account and Codex home in the ledger before resuming it");
  }
  return { name: lane.account, home: lane.codexHome };
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME || `${HOME}/.codex`;
}

function accountSpec(account?: AccountChoice, fallbackHome?: string): Pick<Spec, "account" | "codexHome" | "multiAccountUsage"> {
  return {
    ...(account ? { account: account.name, codexHome: account.home } : fallbackHome ? { codexHome: fallbackHome } : {}),
    ...(config.accounts ? { multiAccountUsage: true as const } : {}),
  };
}

function rejectPinnedAccountFlag(laneName: string, lane: Lane, requested?: string): void {
  if (requested === undefined) return;
  const pinned = lane.account ? `account "${lane.account}"` : `the default account at ${displayPath(defaultCodexHome())}`;
  fail(`--account is not valid for lane "${laneName}"; lane "${laneName}" is pinned to ${pinned}`);
}

function legacyAccountFallback(laneName: string, lane: Lane, ownerSession?: string): string | undefined {
  if (lane.account !== undefined || lane.codexHome !== undefined) return undefined;
  const home = defaultCodexHome();
  feedOwned(`[cdx] lane=${laneName} account=default codex-home=${home} note=pre-upgrade lane has no recorded account; using default`, ownerSession);
  return home;
}

interface LaneOwner { ownerSession?: string; ownerCwd: string }

function callerOwnership(): LaneOwner {
  const ownerSession = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  return { ...(ownerSession ? { ownerSession } : {}), ownerCwd: process.cwd() };
}

function ownershipSpec(owner?: LaneOwner): Pick<Spec, "ownerSession" | "ownerCwd"> {
  return owner ? { ...owner } : {};
}

function storedOwnership(lane: Lane): LaneOwner | undefined {
  if (!lane.ownerCwd) return undefined;
  return { ...(lane.ownerSession ? { ownerSession: lane.ownerSession } : {}), ownerCwd: lane.ownerCwd };
}

// A brief of "-" reads stdin, so long prompts with quotes and backticks never
// fight the shell.
async function resolveBrief(text: string | undefined): Promise<string | undefined> {
  if (text !== "-") return text;
  const stdin = (await Bun.stdin.text()).trim();
  if (!stdin) fail("brief was '-' but stdin is empty");
  return stdin;
}

interface WorktreeInfo { path: string; repo: string; branch: string }

function createWorktree(repo: string, target: string, lane: string): WorktreeInfo {
  const top = Bun.spawnSync({ cmd: ["git", "-C", repo, "rev-parse", "--show-toplevel"] });
  if (!top.success) fail(`--worktree needs a git repository at ${repo}`);
  const repoRoot = top.stdout.toString().trim();
  const path = target.startsWith("/") ? target : `${process.cwd()}/${target}`;
  if (existsSync(path)) fail(`worktree target already exists: ${path}`);
  const branch = `lane/${lane}`;
  const add = Bun.spawnSync({ cmd: ["git", "-C", repoRoot, "worktree", "add", path, "-b", branch] });
  if (!add.success) {
    fail(`git worktree add failed: ${(add.stderr.toString() || add.stdout.toString()).trim().split("\n").at(-1)}`);
  }
  console.log(`cdx: worktree ${displayPath(path)} on branch ${branch} (from ${displayPath(repoRoot)})`);
  if (config.worktreeSetup) {
    console.log(`cdx: worktree setup: ${config.worktreeSetup}`);
    const setup = Bun.spawnSync({ cmd: ["/bin/sh", "-lc", config.worktreeSetup], cwd: path, env: uncoloredChildEnv() });
    if (!setup.success) {
      const tail = (setup.stderr.toString() || setup.stdout.toString()).trim().split("\n").at(-1) ?? "";
      // Leave the worktree in place for inspection; the caller decides.
      fail(`worktree setup failed in ${path}${tail ? `: ${tail}` : ""}`);
    }
  }
  const repoSetup = `${path}/.cdx-worktree-setup`;
  let isExecutable = false;
  try {
    const st = statSync(repoSetup);
    if (st.isFile() && (st.mode & 0o111) !== 0) {
      isExecutable = true;
    }
  } catch { /* not present */ }
  if (isExecutable) {
    console.log("cdx: repo worktree setup: .cdx-worktree-setup");
    const setup = Bun.spawnSync({ cmd: ["/bin/sh", "-lc", "./.cdx-worktree-setup"], cwd: path, env: uncoloredChildEnv() });
    if (!setup.success) {
      const tail = (setup.stderr.toString() || setup.stdout.toString()).trim().split("\n").at(-1) ?? "";
      fail(`worktree setup failed in ${path}${tail ? `: ${tail}` : ""}`);
    }
  }
  return { path, repo: repoRoot, branch };
}

function printWorktreeCleanup(entry: Lane) {
  const repo = entry.worktreeRepo ?? entry.worktreePath;
  console.log(`cdx: worktree remains; after merging: git -C ${repo} worktree remove ${entry.worktreePath}${entry.branch ? ` && git -C ${repo} branch -d ${entry.branch}` : ""}`);
}

// Removal only when provably safe: the lane branch is merged into the repo's
// HEAD and the worktree has no uncommitted changes. Anything else refuses
// with the reason and prints the manual commands instead.
function removeWorktree(entry: Lane) {
  const repo = entry.worktreeRepo ?? entry.worktreePath!;
  const refuse = (reason: string) => {
    console.log(color.yellow(`cdx: not removing worktree: ${reason}`));
    printWorktreeCleanup(entry);
  };
  if (!entry.branch) return refuse("the lane has no recorded branch");
  const merged = Bun.spawnSync({ cmd: ["git", "-C", repo, "branch", "--merged", "HEAD"] });
  if (!merged.success) return refuse(`git branch --merged failed in ${repo}`);
  const branches = merged.stdout.toString().split("\n").map((line) => line.replace(/^[*+]\s*/, "").trim());
  if (!branches.includes(entry.branch)) return refuse(`branch ${entry.branch} is not merged into HEAD of ${repo}`);
  const status = Bun.spawnSync({ cmd: ["git", "-C", entry.worktreePath!, "status", "--porcelain"] });
  if (!status.success) return refuse(`git status failed in ${entry.worktreePath}`);
  if (status.stdout.toString().trim() !== "") return refuse(`worktree ${entry.worktreePath} has uncommitted changes`);
  const remove = Bun.spawnSync({ cmd: ["git", "-C", repo, "worktree", "remove", entry.worktreePath!] });
  if (!remove.success) return refuse(`git worktree remove failed: ${(remove.stderr.toString() || remove.stdout.toString()).trim().split("\n").at(-1)}`);
  console.log(`cdx: removed worktree ${displayPath(entry.worktreePath!)}`);
  const del = Bun.spawnSync({ cmd: ["git", "-C", repo, "branch", "-d", entry.branch] });
  if (del.success) console.log(`cdx: deleted branch ${entry.branch}`);
  else console.log(color.yellow(`cdx: branch ${entry.branch} not deleted: ${(del.stderr.toString() || del.stdout.toString()).trim().split("\n").at(-1)}`));
}

// ---------------------------------------------------------------------------
// Round lifecycle: open a round in the ledger, write its spec, run or detach.
// ---------------------------------------------------------------------------

function openRound(lane: string, kind: "work" | "review", cwd: string, effort: Effort, opts?: { engine?: Engine; preserveEngine?: boolean; requireSession?: boolean; sessionOverride?: string; account?: AccountChoice; preserveAccount?: boolean; owner?: LaneOwner; preserveOwner?: boolean; worktree?: WorktreeInfo; gate?: string; preserveGate?: boolean }): { round: number; sessionId?: string } {
  const now = new Date().toISOString();
  return withLedger((ledger) => {
    const existing = ledger[lane];
    if (existing && laneRunning(existing) && pidAlive(existing.pid)) {
      throw new CmdError(`lane "${lane}" is already running (pid ${existing.pid}); pick a new name or wait`);
    }
    if (opts?.requireSession && !opts.sessionOverride && !existing?.sessionId) throw new CmdError(`lane "${lane}" has no session id; use cdx adopt or spawn`);
    const rounds = (existing?.rounds ?? 0) + 1;
    const account = opts?.preserveAccount ? existing?.account : opts?.account?.name;
    const codexHome = opts?.preserveAccount ? existing?.codexHome : opts?.account?.home;
    const ownerSession = opts?.preserveOwner ? existing?.ownerSession : opts?.owner?.ownerSession;
    const ownerCwd = opts?.preserveOwner ? existing?.ownerCwd : opts?.owner?.ownerCwd;
    const workCwd = kind === "work" ? cwd : existing ? workCwdOf(existing) : cwd;
    const workState = kind === "work" ? "running" : existing ? workStateOf(existing) : "adopted";
    ledger[lane] = {
      ...(existing ?? {}),
      // The work engine belongs to the work thread. A review round on an
      // existing lane records its own engine beside it, so a later resume
      // still reattaches to the right runtime.
      engine: opts?.preserveEngine || (kind === "review" && existing && hasWorkThread(existing)) ? laneEngine(existing) : opts?.engine ?? laneEngine(existing),
      reviewEngine: kind === "review" ? opts?.engine ?? laneEngine(existing) : existing?.reviewEngine,
      ...(opts?.worktree ? { worktreePath: opts.worktree.path, worktreeRepo: opts.worktree.repo, branch: opts.worktree.branch } : {}),
      account,
      codexHome,
      ownerSession,
      ownerCwd,
      sessionId: opts?.sessionOverride ?? (opts?.requireSession ? existing?.sessionId : undefined),
      transcriptPath: undefined,
      workSessionId: kind === "review"
        ? existing?.workSessionId ?? (existing?.kind === "work" ? existing.sessionId : undefined)
        : existing?.workSessionId,
      gate: opts?.preserveGate ? existing?.gate : opts?.gate,
      cwd: workCwd,
      workCwd,
      effort,
      state: workState,
      workState,
      workRound: kind === "work" ? rounds : existing?.workRound,
      workUpdatedAt: kind === "work" ? now : existing?.workUpdatedAt,
      reviewState: kind === "review" ? "running" : existing?.reviewState,
      reviewCwd: kind === "review" ? cwd : existing?.reviewCwd,
      reviewRound: kind === "review" ? rounds : existing?.reviewRound,
      reviewExitCode: kind === "review" ? undefined : existing?.reviewExitCode,
      reviewNote: kind === "review" ? undefined : existing?.reviewNote,
      reviewReport: kind === "review" ? undefined : existing?.reviewReport,
      reviewUpdatedAt: kind === "review" ? now : existing?.reviewUpdatedAt,
      roundStartedAt: now,
      // Reserve the lane with the parent's pid so a concurrent launch is
      // rejected before the runner records its own pid.
      pid: process.pid,
      kind,
      rounds,
      reports: existing?.reports ?? [],
      tokens: existing?.tokens ?? { input: 0, cached: 0, output: 0 },
      roundTokens: { input: 0, cached: 0, output: 0 },
      steers: 0,
      steerOpen: kind === "work",
      continuations: 0,
      // A fresh round must never display the previous round's final message
      // or note as its own.
      lastAction: undefined,
      lastEventAt: undefined,
      note: kind === "work" ? undefined : existing?.note,
      exitCode: kind === "work" ? undefined : existing?.exitCode,
      diffEmpty: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { round: rounds, sessionId: opts?.sessionOverride ?? existing?.sessionId };
  });
}

function launch(spec: Spec, brief: string, background: boolean): Promise<never> | never {
  writeFileSync(specPathOf(spec.lane, spec.round), JSON.stringify(spec, null, 2));
  writeFileSync(`${ROOT}/briefs/${spec.lane}-r${spec.round}.md`, brief);
  const jsonMode = (spec.engine ?? "gpt") === "gemini" || spec.reviewDir === undefined || spec.mode === "spawn";
  if (spec.reviewDir) console.log(`cdx: REVIEW DIRECTORY ${spec.reviewDir}`);
  console.log(`cdx: lane=${color.magenta(spec.lane)} engine=${spec.engine ?? "gpt"} mode=${spec.mode} round=${spec.round} cwd=${spec.cwd}${background ? " (background)" : ""}`);
  console.log(`cdx: log=${logPathOf(spec.lane, spec.round, jsonMode)} report=${reportPathOf(spec.lane, spec.round)}`);
  if (background) {
    const crashLog = openSync(`${ROOT}/logs/${spec.lane}-r${spec.round}.runner.log`, "a");
    const child = nodeSpawn(process.execPath, [SELF, "_run", spec.lane, String(spec.round)], {
      detached: true,
      env: uncoloredChildEnv(spec.codexHome, ROOT),
      stdio: ["ignore", crashLog, crashLog],
    });
    child.unref();
    withLedger((ledger) => { ledger[spec.lane]!.pid = child.pid; });
    console.log(`cdx: detached pid=${child.pid}; poll with cdx status / cdx wait ${color.magenta(spec.lane)}`);
    process.exit(0);
  }
  return runRound(spec.lane, spec.round).then((code) => process.exit(code));
}

// ---------------------------------------------------------------------------
// The runner: executes codex for one round, streams events, keeps the ledger
// live, finalizes state. Shared by foreground and detached lanes.
// ---------------------------------------------------------------------------

function excerpt(item: Record<string, unknown>): string {
  const text = (item.command ?? item.text ?? item.message ?? item.summary ?? "") as string;
  const flat = String(text).replace(/\s+/g, " ").trim();
  const label = flat ? `${item.type}: ${flat}` : String(item.type);
  return label.length > 160 ? `${label.slice(0, 157)}...` : label;
}

interface GateResult { exitCode: number; output: string; timedOut: boolean }

function executeGate(command: string, cwd: string, logPath: string): GateResult {
  const started = Date.now();
  const gate = Bun.spawnSync({
    cmd: ["/bin/sh", "-lc", command], cwd, env: uncoloredChildEnv(),
    timeout: 60 * 60 * 1000, killSignal: "SIGKILL",
  });
  const timedOut = gate.signalCode === "SIGKILL" && Date.now() - started >= 60 * 60 * 1000 - 1000;
  const exitCode = gate.exitCode ?? 1;
  const timeoutNote = timedOut ? "\ncdx: gate timed out after 60 minutes\n" : "";
  const output = `${gate.stdout.toString()}${gate.stderr.toString()}${timeoutNote}`;
  writeFileSync(logPath, output);
  return { exitCode, output, timedOut };
}

function gateOutputForReport(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > 4000 ? `...${trimmed.slice(-4000)}` : trimmed;
}

interface ReviewTreeSnapshot {
  kind: "git" | "files";
  fingerprint: string;
  paths: string[];
  pathFingerprints: Record<string, string>;
}

function hashParts(parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function recursiveFileListing(cwd: string): Omit<ReviewTreeSnapshot, "kind"> {
  const rows: string[] = [];
  const paths: string[] = [];
  const pathFingerprints: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = lstatSync(path);
        const name = relative(cwd, path);
        paths.push(name);
        const row = `${name}\0${info.size}\0${info.mtimeMs}\n`;
        rows.push(row);
        pathFingerprints[name] = hashParts([row]);
      }
    }
  };
  walk(cwd);
  rows.sort();
  paths.sort();
  return { fingerprint: hashParts(rows), paths, pathFingerprints };
}

function captureReviewTree(cwd: string): ReviewTreeSnapshot {
  const inside = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"] });
  if (!inside.success) return { kind: "files", ...recursiveFileListing(cwd) };
  const head = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "HEAD"] });
  const status = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--porcelain=v1", "-z"] });
  const diff = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "HEAD", "--binary", "--no-ext-diff"] });
  const names = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "HEAD", "--name-only", "--no-ext-diff"] });
  const untracked = Bun.spawnSync({ cmd: ["git", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"] });
  const statusText = status.stdout.toString();
  const paths = new Set(names.stdout.toString().split("\n").filter(Boolean));
  const statusByPath = new Map<string, string>();
  const statusRecords = statusText.split("\0").filter(Boolean);
  for (let index = 0; index < statusRecords.length; index += 1) {
    const record = statusRecords[index]!;
    const path = record.slice(3).replace(/^"|"$/g, "");
    if (path) {
      paths.add(path);
      statusByPath.set(path, record.slice(0, 2));
    }
    if (/[RC]/.test(record.slice(0, 2)) && statusRecords[index + 1]) {
      const source = statusRecords[++index]!;
      paths.add(source);
      statusByPath.set(source, `source of ${path}`);
    }
  }
  const untrackedParts: Array<string | Uint8Array> = [untracked.stdout, untracked.stderr];
  for (const path of untracked.stdout.toString().split("\0").filter(Boolean).sort()) {
    paths.add(path);
    const fullPath = join(cwd, path);
    try {
      const info = lstatSync(fullPath);
      untrackedParts.push(`${path}\0${info.mode}\0${info.size}\0`);
      untrackedParts.push(info.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath));
    } catch {
      untrackedParts.push(`${path}\0missing`);
    }
  }
  const pathFingerprints: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const fileParts: Array<string | Uint8Array> = [statusByPath.get(path) ?? ""];
    const pathDiff = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "HEAD", "--binary", "--no-ext-diff", "--", path] });
    fileParts.push(pathDiff.stdout, pathDiff.stderr);
    const fullPath = join(cwd, path);
    try {
      const info = lstatSync(fullPath);
      fileParts.push(`${info.mode}\0${info.size}\0`);
      if (info.isSymbolicLink()) fileParts.push(readlinkSync(fullPath));
      else if (info.isFile()) fileParts.push(readFileSync(fullPath));
    } catch {
      fileParts.push("missing");
    }
    pathFingerprints[path] = hashParts(fileParts);
  }
  return {
    kind: "git",
    fingerprint: hashParts([head.stdout, status.stdout, status.stderr, diff.stdout, diff.stderr, ...untrackedParts]),
    paths: [...paths].sort(),
    pathFingerprints,
  };
}

function changedReviewPath(before: ReviewTreeSnapshot, after: ReviewTreeSnapshot): string | undefined {
  if (before.kind === after.kind && before.fingerprint === after.fingerprint) return undefined;
  const paths = [...new Set([...before.paths, ...after.paths])].sort();
  return paths.find((path) => before.pathFingerprints[path] !== after.pathFingerprints[path]) ?? ".";
}

function finishInvalidBaseline(lane: string, round: number, command: string, cwd: string, result: GateResult): void {
  const checkedAt = new Date().toISOString();
  const reportPath = reportPathOf(lane, round);
  const note = result.timedOut
    ? `gate invalid on baseline: timed out after 60 minutes: ${command}`
    : `gate invalid on baseline (exit ${result.exitCode}): ${command}`;
  writeFileSync(reportPath, `# Gate baseline\n\n\`${command}\` exited ${result.exitCode} in ${cwd} before worker startup.\n\n\`\`\`\n${gateOutputForReport(result.output)}\n\`\`\`\n`);
  const entry = withLedger((ledger) => {
    const item = ledger[lane]!;
    item.state = "gate-invalid";
    item.workState = "gate-invalid";
    item.gateBaseline = { round, command, cwd, exitCode: result.exitCode, checkedAt };
    item.exitCode = result.exitCode;
    item.note = note;
    item.workReport = reportPath;
    item.workUpdatedAt = checkedAt;
    item.pid = undefined;
    item.codexPid = undefined;
    item.reports.push(reportPath);
    item.updatedAt = checkedAt;
    return item;
  });
  feedOwned(`[cdx] lane=${lane} round=${round} state=gate-invalid exit=${result.exitCode} note=${note} report=${reportPath}`, entry.ownerSession);
  console.error(`cdx: lane=${color.magenta(lane)} state=${color.red("gate-invalid")} review the gate command before starting work`);
  console.error(`cdx: ${note}`);
  console.error(`cdx: gate log=${ROOT}/logs/${lane}-r${round}.gate-baseline.log`);
}

function failActiveRound(lane: string, item: Lane, note: string): void {
  const now = new Date().toISOString();
  if (item.kind === "review") {
    item.reviewState = "failed";
    item.reviewNote = note;
    item.reviewUpdatedAt = now;
    item.state = workStateOf(item);
    item.workState = item.state;
  } else {
    item.state = "failed";
    item.workState = "failed";
    item.note = note;
    item.workUpdatedAt = now;
  }
  item.pid = undefined;
  item.codexPid = undefined;
  item.updatedAt = now;
  expireRoundQuestions(lane, item.rounds);
}

interface AppInput {
  type: "text" | "localImage";
  text?: string;
  path?: string;
}

interface AppTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: Array<Record<string, unknown>>;
  error?: { message?: string } | null;
}

interface ControlRecord {
  text: string;
  sentAt: string;
  from?: string;
}

function appServerWorkRound(spec: Spec, lane: Lane | undefined): boolean {
  return lane?.kind === "work" && (spec.mode === "spawn" || spec.mode === "resume" || spec.mode === "fork");
}

function inputText(text: string): AppInput {
  return { type: "text", text };
}

function appThreadParams(spec: Spec): Record<string, unknown> {
  const configOverrides: Record<string, unknown> = {};
  if (spec.additionalDirectories?.length) {
    configOverrides.sandbox_workspace_write = { writable_roots: spec.additionalDirectories };
  }
  return {
    ...(spec.mode === "spawn" ? { model: spec.model ?? config.model } : {}),
    cwd: spec.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(Object.keys(configOverrides).length ? { config: configOverrides } : {}),
  };
}

async function runRound(lane: string, round: number): Promise<number> {
  let spec: Spec | undefined;
  try { spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec; } catch { /* handled by runner */ }
  try {
    return await runRoundInner(lane, round);
  } catch (error) {
    withLedger((ledger) => {
      const item = ledger[lane];
      if (item) {
        failActiveRound(lane, item, `runner error: ${String(error).slice(0, 200)}`);
      }
    });
    console.error(`cdx: lane=${color.magenta(lane)} round-state=${color.red("failed")} runner error: ${error}`);
    const ownerSession = spec?.ownerSession ?? readLedger()[lane]?.ownerSession;
    feedOwned(`[cdx] lane=${lane} round=${round} round-state=failed (runner error)`, ownerSession);
    return 1;
  } finally {
    if (process.argv[2] === "_run" && spec && (spec.engine ?? "gpt") === "gpt") {
      const account = spec.account && spec.codexHome ? { name: spec.account, home: spec.codexHome } : undefined;
      // Without a readable spec the account context is unknown; refreshing
      // would misfile per-account usage as a flat usage.json.
      if (!spec.multiAccountUsage || account) {
        try { await refreshUsageSnapshot({ warnFeed: true, account, ownerSession: spec?.ownerSession }); } catch { /* best-effort */ }
      }
    }
  }
}

// The stock message opens with one of these sentences on its own line; a
// real report opens with its own heading, so only the first line decides,
// and it must be the sentence, not a heading that quotes it.
function isAgyCancellationTemplate(text: string): boolean {
  const firstLine = (text.trim().split("\n", 1)[0] ?? "").trim().replace(/\.$/, "");
  return firstLine === "User initiated cancellation"
    || firstLine === "Execution stopped per your cancellation request"
    || firstLine.startsWith("An execution step was interrupted by the user");
}

async function runRoundInner(lane: string, round: number): Promise<number> {
  const spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec;
  const startingLane = readLedger()[lane];
  const engine = spec.engine ?? laneEngine(startingLane);
  const gemini = engine === "gemini";
  const appServer = !gemini && appServerWorkRound(spec, startingLane);
  const jsonMode = gemini || appServer || spec.mode === "spawn";
  const logPath = logPathOf(lane, round, jsonMode);
  const reportPath = reportPathOf(lane, round);
  try { unlinkSync(`${ROOT}/reports/${lane}-r${round}.findings.json`); } catch { /* ignore if missing */ }
  const reviewSnapshot = gemini && startingLane?.kind === "review" ? captureReviewTree(spec.cwd) : undefined;
  const workTreeStartSnapshot = startingLane?.kind === "work" ? captureReviewTree(spec.cwd) : undefined;
  withLedger((ledger) => {
    const item = ledger[lane]!;
    item.pid = process.pid;
    if (item.kind === "review") item.reviewState = "running";
    else { item.state = "running"; item.workState = "running"; }
  });

  let geminiSchemaPath: string | undefined;
  if (gemini && spec.outputSchema !== undefined) {
    geminiSchemaPath = `${ROOT}/specs/${lane}-r${round}.schema.json`;
    writeFileSync(geminiSchemaPath, `${JSON.stringify(spec.outputSchema, null, 2)}\n`);
  }
  const geminiPolicy = config.gemini ?? geminiConfig();
  const geminiArgs = [
    "agy", "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", geminiPolicy.model, "--dangerously-skip-permissions", "--add-dir", spec.cwd,
    ...(spec.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    "--agent", startingLane?.kind === "review" ? geminiPolicy.reviewAgent : geminiPolicy.agent,
    ...(spec.sourceThreadId ? ["--conversation", spec.sourceThreadId] : []),
    ...(geminiSchemaPath ? ["--json-schema", geminiSchemaPath] : []),
    "--print-timeout", spec.maxRuntimeMins ? `${spec.maxRuntimeMins}m` : "12h",
  ];
  const proc = Bun.spawn({
    cmd: gemini ? geminiArgs : appServer ? ["codex", "app-server", "--listen", "stdio://"] : ["codex", ...(spec.codexArgs ?? [])],
    cwd: spec.cwd,
    env: laneChildEnv(spec.codexHome, { lane, round, owner: spec.ownerSession }, engine),
    stdin: appServer || gemini ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  withLedger((ledger) => { const item = ledger[lane]; if (item) item.codexPid = proc.pid; });
  // A killed runner must not orphan its codex child mid-edit.
  let receivedSignal: "SIGTERM" | "SIGINT" | undefined;
  const reap = (signal: "SIGTERM" | "SIGINT") => {
    receivedSignal = signal;
    try { proc.kill(signal); } catch { /* already gone */ }
  };
  process.on("SIGTERM", () => reap("SIGTERM"));
  process.on("SIGINT", () => reap("SIGINT"));
  const log = Bun.file(logPath).writer();
  const errLog = Bun.file(`${ROOT}/logs/${lane}-r${round}.stderr.log`).writer();
  let lastFlush = 0;
  const touchLedger = (patch: (item: Lane) => void, force = false) => {
    if (!force && Date.now() - lastFlush < 3000) return;
    lastFlush = Date.now();
    withLedger((ledger) => {
      const item = ledger[lane];
      if (item) { patch(item); item.updatedAt = new Date().toISOString(); }
    });
  };

  // Stall watchdog: a lane that goes quiet gets flagged on the feed without
  // polling. Workers cannot be stuck on an approval prompt (approvals are
  // never/bypass), so long silence means a slow reasoning stretch, a network
  // stall, or a wedged process.
  let lastEventMs = Date.now();
  let lastStallWarn = 0;
  const noteActivity = () => {
    if (lastStallWarn) feedOwned(`[cdx] lane=${lane} round=${round} active again after quiet stretch`, spec.ownerSession);
    lastStallWarn = 0;
    lastEventMs = Date.now();
  };
  // --max-runtime is a hard cap: past it, kill the codex child and fail the
  // round. The exitCode guard closes the race where the timer fires after a
  // clean exit but before it is cleared.
  let maxRuntimeHit = false;
  let maxRuntimeForceTimer: ReturnType<typeof setTimeout> | undefined;
  const maxRuntimeTimer = spec.maxRuntimeMins
    ? setTimeout(() => {
        if (proc.exitCode !== null) return;
        maxRuntimeHit = true;
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        maxRuntimeForceTimer = setTimeout(() => {
          if (proc.exitCode === null) {
            try { proc.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, 10_000);
      }, spec.maxRuntimeMins * 60_000)
    : undefined;
  const watchdog = setInterval(() => {
    const quiet = Date.now() - lastEventMs;
    if (quiet >= 300_000 && Date.now() - lastStallWarn >= 600_000) {
      lastStallWarn = Date.now();
      feedOwned(`[cdx] lane=${lane} round=${round} running but quiet ${Math.round(quiet / 60_000)}m (codex pid ${proc.pid}); cdx tail ${lane} to inspect`, spec.ownerSession);
    }
  }, 60_000);

  const completedTurns = new Map<string, AppTurn>();
  const turnWaiters = new Map<string, Array<(turn: AppTurn) => void>>();
  let reportOrder = 0;
  let writtenReportOrder = 0;
  let latestReportCandidate: { text: string; turnId: string; order: number } | undefined;
  let turnFailureReason: string | undefined;
  let lastProtocolError: string | undefined;
  let activeTurnId: string | undefined;
  let codexUsageBaseline: Tokens | undefined;
  let codexRoundUsage: Tokens = { input: 0, cached: 0, output: 0 };
  let geminiTurnsSent = 0;
  let geminiTurnsCompleted = 0;
  let geminiTurnWake: (() => void) | undefined;
  let geminiContinuations = 0;
  const turnAgentResponses = new Map<string, { stepIndex: string; num: number; text: string }>();
  const writeUserTurn = (text: string) => {
    turnAgentResponses.clear();
    proc.stdin.write(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
    proc.stdin.flush();
    geminiTurnsSent += 1;
  };

  const persistCapturedReport = () => {
    const candidate = latestReportCandidate;
    if (!candidate || candidate.order <= writtenReportOrder || !completedTurns.has(candidate.turnId)) return;
    writeFileSync(reportPath, `${candidate.text.trim()}\n`);
    writtenReportOrder = candidate.order;
  };
  const rememberAgentMessage = (item: Record<string, unknown>, turnId: string | undefined) => {
    if (!turnId || item.type !== "agentMessage" || typeof item.text !== "string") return;
    const qualifying = item.phase === "final_answer" || item.phase == null;
    if (!qualifying) return;
    latestReportCandidate = { text: item.text, turnId, order: ++reportOrder };
    persistCapturedReport();
  };
  const turnErrorText = (turn: AppTurn): string | undefined => {
    const error = turn.error as { message?: string; additionalDetails?: string | null } | null | undefined;
    const details = [error?.message, error?.additionalDetails].filter((value): value is string => Boolean(value));
    return details.length ? details.join(": ") : lastProtocolError;
  };

  const handleEvent = (line: string) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    noteActivity();
    const now = new Date().toISOString();
    if (event.event === "init" && event.conversation_id) {
      touchLedger((item) => {
        item.sessionId = event.conversation_id;
        item.transcriptPath = geminiTranscriptPath(event.conversation_id);
        item.lastEventAt = now;
      }, true);
    } else if (event.event === "step_update" && event.step_update) {
      const update = event.step_update;
      const stepUsage = update.usage;
      if (stepUsage && typeof stepUsage === "object") {
        const delta: Tokens = {
          input: stepUsage.input_tokens ?? 0,
          cached: stepUsage.cache_read_tokens ?? 0,
          output: stepUsage.output_tokens ?? 0,
        };
        if (delta.input || delta.cached || delta.output) {
          touchLedger((item) => {
            const cumulative = (item.tokens ??= { input: 0, cached: 0, output: 0 });
            const roundTokens = (item.roundTokens ??= { input: 0, cached: 0, output: 0 });
            for (const tokens of [cumulative, roundTokens]) {
              tokens.input += delta.input;
              tokens.cached += delta.cached;
              tokens.output += delta.output;
            }
            item.lastEventAt = now;
          }, true);
        }
      }
      if (update.step_type === "tool") {
        const tool = update.tool_name ?? update.tool_info?.name ?? "tool";
        const params = update.tool_info?.parameters;
        const detail = params === undefined ? "" : ` ${singleLine(typeof params === "string" ? params : JSON.stringify(params)).slice(0, 120)}`;
        touchLedger((item) => { item.lastAction = `${tool}${detail}`; item.lastEventAt = now; });
      } else if (update.step_type === "agent_response") {
        const stepIdx = String(update.step_index ?? "");
        if (stepIdx) {
          const existing = turnAgentResponses.get(stepIdx) ?? {
            stepIndex: stepIdx,
            num: Number(stepIdx),
            text: "",
          };
          if (typeof update.text_delta === "string") {
            existing.text += update.text_delta;
          }
          turnAgentResponses.set(stepIdx, existing);
        }
        if (typeof update.text_delta === "string") {
          touchLedger((item) => { item.lastAction = singleLine(update.text_delta).slice(0, 160); item.lastEventAt = now; });
        }
      }
    } else if (event.event === "result" && event.result) {
      const result = event.result;
      // result.usage is cumulative over the whole conversation (verified live:
      // turn 2 reported turn 1 plus its own steps), so tokens come from step_update.
      if (typeof result.conversation_id === "string") {
        touchLedger((item) => {
          item.sessionId = result.conversation_id;
          item.transcriptPath = geminiTranscriptPath(result.conversation_id);
          item.lastEventAt = now;
        }, true);
      }
      const isReview = startingLane?.kind === "review";
      if (result.status === "SUCCESS") {
        if (isReview) {
          const structured = result.structured_output;
          const hasStructuredReport = Boolean(
            structured && typeof structured === "object" && !Array.isArray(structured) && typeof structured.report === "string"
          );
          if (hasStructuredReport) {
            writeFileSync(reportPath, `${structured.report.trim()}\n`);
            if (Array.isArray(structured.findings)) {
              writeFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, `${JSON.stringify({ findings: structured.findings }, null, 2)}\n`);
            }
            if (isAgyCancellationTemplate(structured.report)) {
              turnFailureReason = "agy returned its cancellation template as the report; no qualifying report";
            }
          } else {
            const rawResponse = typeof result.response === "string" ? result.response.trim() : "";
            const fallbackReport = `${rawResponse}\n\n## Harness note\n\nStructured output was missing.\n`;
            writeFileSync(reportPath, fallbackReport);
            if (isAgyCancellationTemplate(rawResponse)) {
              turnFailureReason = "agy returned its cancellation template as the report; no qualifying report";
            }
          }
        } else if (spec.outputSchema !== undefined) {
          if (typeof result.response === "string" && result.response.trim()) {
            writeFileSync(reportPath, `${result.response.trim()}\n`);
            if (isAgyCancellationTemplate(result.response)) {
              turnFailureReason = "agy returned its cancellation template as the report; no qualifying report";
            }
          }
        } else {
          let chosenReport: string | undefined;
          if (turnAgentResponses.size > 0) {
            const sorted = [...turnAgentResponses.values()].sort((a, b) => {
              return Number.isFinite(a.num) && Number.isFinite(b.num) ? a.num - b.num : 0;
            });
            for (let i = sorted.length - 1; i >= 0; i--) {
              const text = sorted[i].text.trim();
              if (text) {
                chosenReport = text;
                break;
              }
            }
          }
          if (!chosenReport && typeof result.response === "string" && result.response.trim()) {
            chosenReport = result.response.trim();
          }
          if (chosenReport) {
            writeFileSync(reportPath, `${chosenReport}\n`);
            if (isAgyCancellationTemplate(chosenReport)) {
              turnFailureReason = "agy returned its cancellation template as the report; no qualifying report";
            }
          }
        }
      } else {
        if (typeof result.response === "string" && result.response.trim()) {
          writeFileSync(partialReportPathOf(lane, round), `${result.response.trim()}\n`);
        }
      }
      if (result.status !== "SUCCESS") {
        const rawError = result.error?.message ?? result.error;
        const errorText = typeof rawError === "string" ? rawError : typeof rawError === "object" && rawError ? JSON.stringify(rawError) : "";
        const errorCandidates = [
          errorText,
          typeof result.response === "string" ? result.response : "",
        ].filter((s) => s.trim().length > 0);
        const errString = errorCandidates[0] ?? "";
        const isTransportError = GEMINI_TRANSPORT_ERRORS.some((pattern) => errorCandidates.some((c) => pattern.test(c)));

        if (isTransportError && proc.exitCode === null && geminiContinuations < 2) {
          geminiContinuations += 1;
          touchLedger((item) => {
            item.continuations = geminiContinuations;
            item.lastEventAt = now;
          }, true);
          const reason = singleLine(errString).slice(0, 80);
          feedOwned(`[cdx] lane=${lane} round=${round} auto-continue ${geminiContinuations}/2 reason=${reason}`, spec.ownerSession);
          writeUserTurn("The previous turn was cut off by a transport error. Continue the task you were working on from where you left off. When the task is complete, print your final lane report.");
        } else {
          const detail = [result.status, result.error?.message ?? result.error, result.response].filter(Boolean).join(": ");
          turnFailureReason ??= detail || "gemini result status ERROR";
        }
      }
      geminiTurnsCompleted += 1;
      const wake = geminiTurnWake;
      geminiTurnWake = undefined;
      wake?.();
    } else if (event.method === "thread/started" && event.params?.thread?.id) {
      touchLedger((item) => { item.sessionId = event.params.thread.id; item.lastEventAt = now; }, true);
    } else if (event.method === "error" && event.params?.error) {
      const error = event.params.error;
      lastProtocolError = [error.message, error.additionalDetails].filter(Boolean).join(": ") || "app-server turn error";
      touchLedger((item) => { item.lastAction = `error: ${lastProtocolError}`; item.lastEventAt = now; }, true);
    } else if (event.method === "thread/tokenUsage/updated" && event.params?.turnId && event.params?.tokenUsage?.last) {
      const last = event.params.tokenUsage.last;
      const total = event.params.tokenUsage.total ?? last;
      const totalTokens: Tokens = {
        input: total.inputTokens ?? 0,
        cached: total.cachedInputTokens ?? 0,
        output: total.outputTokens ?? 0,
      };
      codexUsageBaseline ??= {
        input: totalTokens.input - (last.inputTokens ?? 0),
        cached: totalTokens.cached - (last.cachedInputTokens ?? 0),
        output: totalTokens.output - (last.outputTokens ?? 0),
      };
      const current: Tokens = {
        input: Math.max(0, totalTokens.input - codexUsageBaseline.input),
        cached: Math.max(0, totalTokens.cached - codexUsageBaseline.cached),
        output: Math.max(0, totalTokens.output - codexUsageBaseline.output),
      };
      const delta: Tokens = {
        input: Math.max(0, current.input - codexRoundUsage.input),
        cached: Math.max(0, current.cached - codexRoundUsage.cached),
        output: Math.max(0, current.output - codexRoundUsage.output),
      };
      codexRoundUsage = current;
      touchLedger((item) => {
        const cumulative = (item.tokens ??= { input: 0, cached: 0, output: 0 });
        const roundTokens = (item.roundTokens ??= { input: 0, cached: 0, output: 0 });
        for (const tokens of [cumulative, roundTokens]) {
          tokens.input += delta.input;
          tokens.cached += delta.cached;
          tokens.output += delta.output;
        }
        item.lastEventAt = now;
      }, true);
    } else if (event.method === "turn/completed" && event.params?.turn?.id) {
      const turn = event.params.turn as AppTurn;
      for (const item of turn.items ?? []) {
        rememberAgentMessage(item, turn.id);
      }
      completedTurns.set(turn.id, turn);
      if (turn.status !== "completed") {
        turnFailureReason = turnErrorText(turn) ?? `turn ended with status ${turn.status}`;
      }
      persistCapturedReport();
      for (const resolve of turnWaiters.get(turn.id) ?? []) resolve(turn);
      turnWaiters.delete(turn.id);
      if (activeTurnId === turn.id) activeTurnId = undefined;
    } else if (event.method === "item/completed" && event.params?.item) {
      const item = event.params.item as Record<string, unknown>;
      rememberAgentMessage(item, event.params.turnId ?? activeTurnId);
      touchLedger((entry) => { entry.lastAction = excerpt(item); entry.lastEventAt = now; });
    } else if (event.type === "thread.started" && event.thread_id) {
      touchLedger((item) => { item.sessionId = event.thread_id; item.lastEventAt = now; }, true);
    } else if (event.type === "turn.completed" && event.usage) {
      touchLedger((item) => {
        const cumulative = (item.tokens ??= { input: 0, cached: 0, output: 0 });
        const round = (item.roundTokens ??= { input: 0, cached: 0, output: 0 });
        for (const tokens of [cumulative, round]) {
          tokens.input += event.usage.input_tokens ?? 0;
          tokens.cached += event.usage.cached_input_tokens ?? 0;
          tokens.output += event.usage.output_tokens ?? 0;
        }
        item.lastEventAt = now;
      }, true);
    } else if (event.type === "item.completed" && event.item) {
      touchLedger((item) => { item.lastAction = excerpt(event.item); item.lastEventAt = now; });
    }
  };

  const pumpJson = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      log.write(chunk);
      log.flush();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) handleEvent(line);
    }
    if (buffer.trim()) handleEvent(buffer);
  };
  const pumpRaw = async (stream: ReadableStream<Uint8Array>, sink: typeof log) => {
    for await (const chunk of stream) {
      sink.write(chunk);
      sink.flush();
      noteActivity();
      touchLedger((item) => { item.lastEventAt = new Date().toISOString(); });
    }
  };

  let exitCode: number;
  let roundCleanupWarning: string | undefined;
  if (gemini) {
    const stdoutPump = pumpJson(proc.stdout);
    const stderrPump = pumpRaw(proc.stderr, errLog);
    let controlIndex = 0;
    let controlChain = Promise.resolve();
    const drainControls = async () => {
      const path = controlPathOf(lane, round);
      if (!existsSync(path)) return;
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
      while (controlIndex < lines.length) {
        const line = lines[controlIndex]!;
        let record: ControlRecord;
        try { record = JSON.parse(line) as ControlRecord; } catch { controlIndex += 1; continue; }
        if (typeof record.text !== "string" || !record.text.trim()) { controlIndex += 1; continue; }
        writeUserTurn(record.text);
        controlIndex += 1;
        const flat = singleLine(record.text);
        withLedger((ledger) => {
          const item = ledger[lane];
          if (item) { item.steers = (item.steers ?? 0) + 1; item.updatedAt = new Date().toISOString(); }
        });
        feedOwned(`[cdx] lane=${lane} round=${round} steer delivered mode=follow-up-turn: ${flat.slice(0, 120)}`, spec.ownerSession);
      }
    };
    const queueControlDrain = () => {
      controlChain = controlChain.then(drainControls, drainControls);
      return controlChain;
    };
    const waitForGeminiResult = () => new Promise<void>((resolve) => { geminiTurnWake = resolve; });
    writeUserTurn(spec.prompt);
    await queueControlDrain();
    const controlWatcher = setInterval(() => { void queueControlDrain(); }, 250);
    const awaitTurns = async () => {
      while (geminiTurnsCompleted < geminiTurnsSent && proc.exitCode === null && !receivedSignal && !maxRuntimeHit) {
        const outcome = await Promise.race([
          waitForGeminiResult().then(() => "result" as const),
          proc.exited.then(() => "exit" as const),
        ]);
        if (outcome === "exit") break;
        // Grace window, same as the Codex path: a send that raced the result still joins this round.
        await queueControlDrain();
        await Bun.sleep(1100);
        await queueControlDrain();
      }
    };
    await awaitTurns();
    clearInterval(controlWatcher);
    await controlChain;
    withLedger((ledger) => { const item = ledger[lane]; if (item) item.steerOpen = false; });
    // A send that landed before steerOpen closed still gets its own turn.
    await queueControlDrain();
    await awaitTurns();
    try { proc.stdin.end(); } catch { /* already closed */ }
    if (proc.exitCode === null) await Promise.race([proc.exited, Bun.sleep(10_000)]);
    if (proc.exitCode === null) {
      roundCleanupWarning = "agy did not exit within 10s after stdin closed";
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      await Promise.race([proc.exited, Bun.sleep(10_000)]);
    }
    if (proc.exitCode === null) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
    exitCode = await proc.exited;
    await Promise.allSettled([stdoutPump, stderrPump]);
    if (geminiTurnsCompleted < geminiTurnsSent && !maxRuntimeHit && !receivedSignal) {
      turnFailureReason ??= `agy exited before result (${geminiTurnsCompleted}/${geminiTurnsSent} turns completed)`;
    }
    if (turnFailureReason) exitCode ||= 1;
  } else if (appServer) {
    let requestId = 0;
    let rpcClosed = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const writeRpc = (message: Record<string, unknown>) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };
    const request = (method: string, params: Record<string, unknown>): Promise<any> => {
      if (rpcClosed) return Promise.reject(new Error(`app-server closed before ${method}`));
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writeRpc({ id, method, params });
      });
    };
    const notify = (method: string) => writeRpc({ method });
    const pumpRpc = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream) {
        log.write(chunk);
        log.flush();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          handleEvent(line);
          let message: any;
          try { message = JSON.parse(line); } catch { continue; }
          if (typeof message.id === "number" && pending.has(message.id)) {
            const waiter = pending.get(message.id)!;
            pending.delete(message.id);
            if (message.error) waiter.reject(new Error(`${message.error.message ?? "app-server request failed"}${message.error.data ? `: ${JSON.stringify(message.error.data)}` : ""}`));
            else waiter.resolve(message.result);
          } else if (message.id !== undefined && message.method) {
            writeRpc({ id: message.id, error: { code: -32601, message: `cdx does not handle server request ${message.method}` } });
          }
        }
      }
      if (buffer.trim()) handleEvent(buffer);
      rpcClosed = true;
      const error = new Error("app-server closed before replying");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      if (activeTurnId && !completedTurns.has(activeTurnId)) {
        const failedTurn: AppTurn = { id: activeTurnId, status: "failed", error: { message: error.message } };
        completedTurns.set(activeTurnId, failedTurn);
        for (const resolve of turnWaiters.get(activeTurnId) ?? []) resolve(failedTurn);
        turnWaiters.delete(activeTurnId);
        activeTurnId = undefined;
      }
    };
    const stdoutPump = pumpRpc(proc.stdout);
    const stderrPump = pumpRaw(proc.stderr, errLog);
    const waitForTurn = (turnId: string): Promise<AppTurn> => {
      const completed = completedTurns.get(turnId);
      if (completed) return Promise.resolve(completed);
      return new Promise((resolve) => {
        const waiters = turnWaiters.get(turnId) ?? [];
        waiters.push(resolve);
        turnWaiters.set(turnId, waiters);
      });
    };
    const startTurn = async (threadId: string, text: string, includeRoundOptions: boolean) => {
      const input: AppInput[] = [inputText(text)];
      if (includeRoundOptions) {
        for (const path of spec.images ?? []) input.push({ type: "localImage", path });
      }
      const result = await request("turn/start", {
        threadId,
        input,
        cwd: spec.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        ...(spec.mode === "spawn" ? { model: spec.model ?? config.model } : {}),
        effort: readLedger()[lane]?.effort ?? config.defaultEffort,
        ...(includeRoundOptions && spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
      });
      const turnId = result?.turn?.id;
      if (typeof turnId !== "string") throw new Error("turn/start returned no turn id");
      activeTurnId = turnId;
      return turnId;
    };
    let controlIndex = 0;
    let controlChain = Promise.resolve();
    let threadId = "";
    const reportedControlFailures = new Set<number>();
    const delivered = (record: ControlRecord, mode: "steered" | "follow-up-turn") => {
      const flat = record.text.replace(/\s+/g, " ").trim();
      const short = flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
      withLedger((ledger) => {
        const item = ledger[lane];
        if (item) { item.steers = (item.steers ?? 0) + 1; item.updatedAt = new Date().toISOString(); }
      });
      feedOwned(`[cdx] lane=${lane} round=${round} steer delivered mode=${mode}: ${short}`, spec.ownerSession);
    };
    const deliverControl = async (record: ControlRecord): Promise<"steered" | "follow-up-turn" | undefined> => {
      const expectedTurnId = activeTurnId;
      try {
        if (expectedTurnId) {
          await request("turn/steer", { threadId, expectedTurnId, input: [inputText(record.text)] });
          return "steered";
        } else {
          await startTurn(threadId, record.text, false);
          return "follow-up-turn";
        }
      } catch (steerError) {
        if (expectedTurnId) {
          try {
            await waitForTurn(expectedTurnId);
            await startTurn(threadId, record.text, false);
            return "follow-up-turn";
          } catch (followUpError) {
            steerError = followUpError;
          }
        }
        const reason = steerError instanceof Error ? steerError.message : String(steerError);
        if (!reportedControlFailures.has(controlIndex)) {
          reportedControlFailures.add(controlIndex);
          feedOwned(`[cdx] lane=${lane} round=${round} steer rejected and retained: ${reason.slice(0, 160)}`, spec.ownerSession);
        }
        return undefined;
      }
    };
    const drainControls = async () => {
      const path = controlPathOf(lane, round);
      if (!existsSync(path)) return;
      const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
      while (controlIndex < lines.length) {
        const line = lines[controlIndex]!;
        let record: ControlRecord;
        try { record = JSON.parse(line) as ControlRecord; } catch { controlIndex += 1; continue; }
        if (typeof record.text !== "string" || !record.text.trim()) { controlIndex += 1; continue; }
        const mode = await deliverControl(record);
        if (!mode) break;
        delivered(record, mode);
        controlIndex += 1;
      }
    };
    const queueControlDrain = () => {
      controlChain = controlChain.then(drainControls, drainControls);
      return controlChain;
    };
    let controlWatcher: ReturnType<typeof setInterval> | undefined;
    let protocolFailed = false;
    try {
      await request("initialize", {
        clientInfo: { name: "cdx", title: "cdx", version: VERSION },
        capabilities: { experimentalApi: true },
      });
      notify("initialized");
      const threadParams = appThreadParams(spec);
      const method = spec.mode === "spawn" ? "thread/start" : spec.mode === "resume" ? "thread/resume" : "thread/fork";
      const sourceThreadId = spec.sourceThreadId;
      if (method !== "thread/start" && !sourceThreadId) throw new Error(`${method} needs a source thread id`);
      const threadResult = await request(method, {
        ...(method === "thread/start" ? {} : { threadId: sourceThreadId }),
        ...threadParams,
      });
      threadId = threadResult?.thread?.id;
      if (typeof threadId !== "string") throw new Error(`${method} returned no thread id`);
      touchLedger((item) => { item.sessionId = threadId; item.lastEventAt = new Date().toISOString(); }, true);
      const firstTurnId = await startTurn(threadId, spec.prompt, true);
      await queueControlDrain();
      controlWatcher = setInterval(() => { void queueControlDrain(); }, 250);
      let nextTurnId: string | undefined = firstTurnId;
      while (nextTurnId) {
        const turn = await waitForTurn(nextTurnId);
        if (turn.status !== "completed") protocolFailed = true;
        if (activeTurnId === nextTurnId) activeTurnId = undefined;
        await queueControlDrain();
        await Bun.sleep(1100);
        await queueControlDrain();
        nextTurnId = activeTurnId;
      }
      clearInterval(controlWatcher);
      controlWatcher = undefined;
      await controlChain;
      withLedger((ledger) => {
        const item = ledger[lane];
        if (item) item.steerOpen = false;
      });
      await queueControlDrain();
      while (activeTurnId) {
        const finalQueuedTurn = activeTurnId;
        const turn = await waitForTurn(finalQueuedTurn);
        if (turn.status !== "completed") protocolFailed = true;
        if (activeTurnId === finalQueuedTurn) activeTurnId = undefined;
        await queueControlDrain();
      }
      exitCode = protocolFailed ? 1 : 0;
      if (proc.exitCode === null && !rpcClosed) {
        try {
          await request("thread/unsubscribe", { threadId });
        } catch (error) {
          roundCleanupWarning = `thread unsubscribe failed after completed turn: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else if (proc.exitCode !== null && proc.exitCode !== 0) {
        roundCleanupWarning = `app-server exited ${proc.exitCode} after completed turn`;
      }
      try { proc.stdin.end(); } catch { /* child already closed */ }
      if (proc.exitCode === null) await Promise.race([proc.exited, Bun.sleep(3000)]);
      if (proc.exitCode !== null && proc.exitCode !== 0 && existsSync(reportPath) && !maxRuntimeHit) {
        roundCleanupWarning ??= `app-server exited ${proc.exitCode} after completed turn`;
      }
      if (proc.exitCode === null) {
        roundCleanupWarning ??= "app-server did not exit after stdin closed";
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        await Promise.race([proc.exited, Bun.sleep(10_000)]);
      }
      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        await proc.exited;
      }
      await Promise.allSettled([stdoutPump, stderrPump]);
      if (roundCleanupWarning) {
        feedOwned(`[cdx] lane=${lane} round=${round} cleanup warning: ${roundCleanupWarning}`, spec.ownerSession);
        console.error(`cdx: lane=${lane} round=${round} cleanup warning: ${roundCleanupWarning}`);
      }
    } catch (error) {
      if (controlWatcher) clearInterval(controlWatcher);
      try { proc.stdin.end(); } catch { /* child already closed */ }
      try { proc.kill(); } catch { /* child already closed */ }
      await Promise.allSettled([stdoutPump, stderrPump, proc.exited]);
      if (receivedSignal) {
        exitCode = receivedSignal === "SIGINT" ? 130 : 143;
        turnFailureReason = undefined;
      } else if (maxRuntimeHit) {
        exitCode = proc.exitCode ?? 143;
      } else {
        clearInterval(watchdog);
        if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
        if (maxRuntimeForceTimer) clearTimeout(maxRuntimeForceTimer);
        log.end();
        errLog.end();
        throw error;
      }
    }
  } else {
    await Promise.all([jsonMode ? pumpJson(proc.stdout) : pumpRaw(proc.stdout, log), pumpRaw(proc.stderr, errLog)]);
    exitCode = await proc.exited;
  }
  if (receivedSignal) {
    exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    turnFailureReason = undefined;
  }
  clearInterval(watchdog);
  if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
  if (maxRuntimeForceTimer) clearTimeout(maxRuntimeForceTimer);
  log.end();
  errLog.end();

  // Text modes (resume/fork/native review) have no -o support: if the worker
  // did not write the report file, salvage the final agent message from the
  // transcript (the block after the last bare "codex" line, before "tokens used").
  if (!jsonMode && !existsSync(reportPath)) {
    const lines = readFileSync(logPath, "utf8").split("\n");
    const start = lines.lastIndexOf("codex");
    // With stderr split into its own file the transcript decorations (the bare
    // "codex" marker, "tokens used") land there, leaving stdout as the final
    // message alone; salvage the whole log when the marker is absent.
    let end = start >= 0 ? lines.indexOf("tokens used", start) : lines.indexOf("tokens used");
    if (end === -1) end = lines.length;
    let message = lines.slice(start + 1, end).join("\n").trim();
    // codex echoes the final message twice in the transcript; collapse exact doubling.
    const doubled = /^([\s\S]+?)\s*\1$/.exec(message);
    if (doubled) message = doubled[1]!;
    if (message) writeFileSync(reportPath, `${message}\n`);
  }
  // Success needs all three gates: exit 0, a nonempty report, and (implicitly)
  // the drained event log. The report is the lane's contract with its caller;
  // a clean exit without one is still a failure.
  const reportOk = existsSync(reportPath) && readFileSync(reportPath, "utf8").trim().length > 0;
  const stderrText = (() => {
    try { return readFileSync(`${ROOT}/logs/${lane}-r${round}.stderr.log`, "utf8"); } catch { return ""; }
  })();
  const beforeFinalize = readLedger()[lane];
  const reviewModifiedPath = reviewSnapshot ? changedReviewPath(reviewSnapshot, captureReviewTree(spec.cwd)) : undefined;
  const workTreeEndSnapshot = workTreeStartSnapshot ? captureReviewTree(spec.cwd) : undefined;
  const workTreeUnchanged = Boolean(workTreeStartSnapshot && workTreeEndSnapshot && workTreeStartSnapshot.fingerprint === workTreeEndSnapshot.fingerprint);
  const unchangedWithGate = Boolean(workTreeUnchanged && spec.gate && beforeFinalize?.kind === "work" && exitCode === 0 && reportOk && !turnFailureReason);
  const unchangedNoGate = Boolean(workTreeUnchanged && !spec.gate && beforeFinalize?.kind === "work" && exitCode === 0 && reportOk && !turnFailureReason);

  const capturedSessionId = beforeFinalize?.sessionId;
  const textSessionId = !jsonMode
    ? /session id: ([0-9a-f-]{36})/i.exec(`${readFileSync(logPath, "utf8")}\n${stderrText}`)?.[1]
    : undefined;
  const resolvedSessionId = capturedSessionId || textSessionId
    || (!gemini ? resolveSessionIdFromRollouts(spec, beforeFinalize?.roundStartedAt) : undefined);
  // The gate is the harness's own verification: a worker's optimistic done
  // claim cannot finalize green unless the gate command also passes. Work
  // rounds only (ledger kind, since intent reviews launch with mode "spawn").
  let gateExit: number | undefined;
  let gateTimedOut = false;
  if (spec.gate && beforeFinalize?.kind === "work" && exitCode === 0 && reportOk && !turnFailureReason && !unchangedWithGate) {
    const gate = executeGate(spec.gate, spec.cwd, `${ROOT}/logs/${lane}-r${round}.gate.log`);
    gateExit = gate.exitCode;
    gateTimedOut = gate.timedOut;
    writeFileSync(reportPath, `${readFileSync(reportPath, "utf8").trimEnd()}\n\n## Gate\n\n\`${spec.gate}\` exited ${gateExit}\n\n\`\`\`\n${gateOutputForReport(gate.output)}\n\`\`\`\n`);
  }
  if (unchangedWithGate) {
    exitCode = 1;
  }
  if (unchangedNoGate && existsSync(reportPath)) {
    appendFileSync(reportPath, "\n\n## Harness note\n\nThis round changed no files.\n");
  }
  const gateFailed = gateExit !== undefined && gateExit !== 0;
  const roundState: ReviewState = exitCode === 0 && reportOk && !gateFailed && !maxRuntimeHit && !reviewModifiedPath && !turnFailureReason && !unchangedWithGate ? "done" : "failed";
  expireRoundQuestions(lane, round);
  const entry = withLedger((ledger) => {
    const item = ledger[lane]!;
    if (!item.sessionId && resolvedSessionId) item.sessionId = resolvedSessionId;
    // Ledger kind, not spec.mode, decides work vs review: intent reviews
    // launch with mode "spawn" but must never become the resume target.
    if (item.kind === "work" && item.sessionId) item.workSessionId = item.sessionId;
    let roundNote: string | undefined;
    if (reviewModifiedPath) roundNote = `review modified the tree: ${reviewModifiedPath}`;
    else if (unchangedWithGate) roundNote = "tree unchanged under a required gate: no work landed, gate not run";
    else if (gateFailed) {
      roundNote = gateTimedOut ? `gate timed out after 60 minutes: ${spec.gate}` : spec.gateBaselineChecked
        ? `gate failed after work; baseline passed (exit ${gateExit}): ${spec.gate}`
        : `gate failed (exit ${gateExit}): ${spec.gate}; baseline was not checked, use --gate-baseline-check on spawn`;
    } else if (maxRuntimeHit) roundNote = `max runtime exceeded (${spec.maxRuntimeMins}m)`;
    else if (receivedSignal) roundNote = `terminated by signal (exit ${exitCode}): cdx kill or a manual stop`;
    else if (turnFailureReason) {
      const continuePrefix = geminiContinuations > 0
        ? `turn failed after ${geminiContinuations} auto-continue${geminiContinuations === 1 ? "" : "s"}`
        : "turn failed";
      roundNote = `${continuePrefix}: ${turnFailureReason.slice(0, 200)}`;
    }
    else if (exitCode === 0 && !reportOk) roundNote = "no final report";
    else if (roundCleanupWarning) roundNote = `cleanup warning: ${roundCleanupWarning.slice(0, 200)}`;
    // Signal exits outrank the auth regex: a SIGTERM'd codex can leave auth
    // words in stderr and a kill must never read as a login failure.
    else if (exitCode === 130 || exitCode === 137 || exitCode === 143) {
      roundNote = `terminated by signal (exit ${exitCode}): cdx kill or a manual stop`;
    } else if (exitCode !== 0 && /login|auth|401|unauthorized|token.*expired/i.test(stderrText)) {
      roundNote = "auth failure: run `codex login`, then `cdx resume` this lane";
    } else if (exitCode !== 0) {
      const errTail = stderrText.trim().split("\n").at(-1);
      if (errTail) roundNote = `stderr: ${errTail.slice(0, 200)}`;
    }
    if (unchangedNoGate) item.diffEmpty = true;
    if (item.kind === "review") {
      item.reviewState = roundState;
      item.reviewExitCode = exitCode;
      item.reviewNote = roundNote;
      item.reviewReport = existsSync(reportPath) ? reportPath : undefined;
      item.reviewUpdatedAt = new Date().toISOString();
      item.state = workStateOf(item);
      item.workState = item.state;
    } else {
      item.state = roundState;
      item.workState = roundState;
      item.exitCode = exitCode;
      item.note = roundNote;
      item.workReport = existsSync(reportPath) ? reportPath : undefined;
      item.workUpdatedAt = new Date().toISOString();
    }
    item.pid = undefined;
    item.codexPid = undefined;
    if (existsSync(reportPath)) item.reports.push(reportPath);
    if (geminiContinuations > 0) item.continuations = geminiContinuations;
    item.updatedAt = new Date().toISOString();
    return item;
  });
  // Structured verdict: reviewers end reports with a fenced json findings
  // block. Persist the last parsable one for machine consumers; a malformed
  // block leaves the markdown report as the only artifact, never a failure.
  if (beforeFinalize?.kind === "review" && reportOk && !existsSync(`${ROOT}/reports/${lane}-r${round}.findings.json`)) {
    const blocks = [...readFileSync(reportPath, "utf8").matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/g)];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      try {
        const verdict = JSON.parse(blocks[index]![1]!) as { findings?: unknown };
        if (Array.isArray(verdict.findings)) {
          writeFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, `${JSON.stringify(verdict, null, 2)}\n`);
          break;
        }
      } catch { /* not the verdict block */ }
    }
  }
  const finalRoundState = roundStateOf(entry);
  const finalRoundNote = entry.kind === "review" ? entry.reviewNote : entry.note;
  const diffToken = entry.diffEmpty ? " diff=empty" : "";
  feedOwned(`[cdx] lane=${lane} round=${round} kind=${entry.kind} state=${finalRoundState} exit=${exitCode}${diffToken}${finalRoundNote ? ` note=${finalRoundNote}` : ""} tokens=${fmtTokens(entry.roundTokens ?? entry.tokens)} report=${reportOk ? reportPath : "-"}`, entry.ownerSession);
  console.log(`lane=${color.magenta(lane)} session=${entry.sessionId ?? "?"} round=${round} kind=${entry.kind} state=${coloredState(finalRoundState)} exit=${exitCode} tokens=${fmtTokens(entry.tokens)} report=${reportPath}`);
  if (finalRoundNote) console.log(`note: ${finalRoundNote}`);
  if (reportOk) {
    console.log("--- report ---");
    console.log(readFileSync(reportPath, "utf8"));
  } else {
    console.log(`--- no report; log tail (${logPath}) ---`);
    console.log(renderTail(logPath, 40));
  }
  return finalRoundState === "done" ? 0 : exitCode || 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface QuestionRecord {
  lane: string;
  round: number;
  seq: number;
  question: string;
  askedAt: string;
  answered: boolean;
  owner?: string;
  answer?: string;
  answeredAt?: string;
  timedOutAt?: string;
  expiredAt?: string;
  status?: "expired: round ended";
}

function readQuestion(path: string): QuestionRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as QuestionRecord;
    return typeof value.question === "string" && typeof value.seq === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function questionFiles(lane?: string): Array<{ path: string; record: QuestionRecord }> {
  const results: Array<{ path: string; record: QuestionRecord }> = [];
  for (const file of readdirSync(`${ROOT}/questions`)) {
    if (!file.endsWith(".json")) continue;
    const path = `${ROOT}/questions/${file}`;
    const record = readQuestion(path);
    if (!record || (lane && record.lane !== lane)) continue;
    results.push({ path, record });
  }
  return results.sort((left, right) => Date.parse(left.record.askedAt) - Date.parse(right.record.askedAt));
}

function writeQuestion(path: string, record: QuestionRecord): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

function questionOpen(record: QuestionRecord): boolean {
  return !record.answered && !record.timedOutAt && !record.expiredAt;
}

function expireRoundQuestions(lane: string, round: number): void {
  const expiredAt = new Date().toISOString();
  for (const { path, record } of questionFiles(lane)) {
    if (record.round !== round || !questionOpen(record)) continue;
    record.expiredAt = expiredAt;
    record.status = "expired: round ended";
    writeQuestion(path, record);
  }
}

function sendCommand(argv: string[]): void {
  const [lane, ...parts] = argv;
  const text = singleLine(parts.join(" "));
  if (!lane || !text) fail('usage: cdx send <lane> "<text>"');
  const record: ControlRecord = {
    text,
    sentAt: new Date().toISOString(),
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { from: process.env.CLAUDE_CODE_SESSION_ID.slice(0, 8) } : {}),
  };
  const entry = withLedger((ledger) => {
    const current = ledger[lane];
    if (!current) throw new CmdError(`unknown lane "${lane}" (cdx status lists lanes)`);
    if (!laneRunning(current) || !pidAlive(current.pid)) throw new CmdError(`lane "${lane}" is not running`);
    if (current.kind === "review") throw new CmdError(`lane "${lane}" is a review lane; review turns do not accept steering`);
    if (current.steerOpen === false) throw new CmdError(`lane "${lane}" is finishing and no longer accepts steering`);
    writeFileSync(controlPathOf(lane, current.rounds), `${JSON.stringify(record)}\n`, { flag: "a" });
    return current;
  });
  console.log(`cdx: lane=${lane} round=${entry.rounds} steer queued`);
}

async function askCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["timeout"]);
  const question = singleLine(parsed.rest.join(" "));
  if (!question) fail('usage: cdx ask [--timeout <min>] "<question>"');
  const lane = process.env.CDX_LANE?.trim();
  const round = Number(process.env.CDX_ROUND);
  const owner = process.env.CDX_OWNER?.trim();
  if (!lane || !Number.isInteger(round) || round < 1) {
    fail("cdx ask must run inside a cdx work lane with CDX_LANE and CDX_ROUND set");
  }
  const requestedTimeout = Number(parsed.flags.timeout ?? 30);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) fail("--timeout must be a positive number of minutes");
  const timeoutMinutes = Math.min(requestedTimeout, 30);
  if (requestedTimeout > 30) console.error(`cdx: --timeout ${requestedTimeout}m exceeds the 30m limit; using 30m`);
  const created = withLedger(() => {
    const seq = questionFiles(lane).reduce((highest, item) => Math.max(highest, item.record.seq), 0) + 1;
    const record: QuestionRecord = {
      lane,
      round,
      seq,
      question,
      askedAt: new Date().toISOString(),
      answered: false,
      ...(owner ? { owner } : {}),
    };
    const path = `${ROOT}/questions/${lane}-r${round}-${seq}.json`;
    writeQuestion(path, record);
    return { path, record };
  });
  feedOwned(`[cdx] lane=${lane} round=${round} QUESTION #${created.record.seq}: ${question} (answer with: cdx reply ${lane} "<answer>")`, owner);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    const current = readQuestion(created.path);
    if (current?.answered) {
      console.log(current.answer ?? "");
      return;
    }
    if (current?.expiredAt) {
      console.log("cdx ask expired because the round ended. Take the conservative reading, record the deviation in the lane report, and continue.");
      return;
    }
    await Bun.sleep(Math.min(1000, Math.max(10, deadline - Date.now())));
  }
  const outcome = withLedger(() => {
    const current = readQuestion(created.path) ?? created.record;
    if (current.answered) return current;
    current.timedOutAt = new Date().toISOString();
    writeQuestion(created.path, current);
    return current;
  });
  if (outcome.answered) {
    console.log(outcome.answer ?? "");
    return;
  }
  console.log("cdx ask timed out. Take the conservative reading, record the deviation in the lane report, and continue.");
}

function replyCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["id"]);
  const [lane, ...parts] = parsed.rest;
  const answer = singleLine(parts.join(" "));
  if (!lane || !answer) fail('usage: cdx reply <lane> [--id <seq>] "<answer>"');
  const requestedId = parsed.flags.id === undefined ? undefined : Number(parsed.flags.id);
  if (requestedId !== undefined && (!Number.isInteger(requestedId) || requestedId < 1)) fail("--id must be a positive integer");
  const answered = withLedger((ledger) => {
    const currentRound = ledger[lane]?.rounds;
    if (!currentRound) throw new CmdError(`unknown lane "${lane}" (cdx status lists lanes)`);
    const open = questionFiles(lane).filter(({ record }) => record.round === currentRound && questionOpen(record));
    const target = requestedId === undefined ? open[0] : open.find(({ record }) => record.seq === requestedId);
    if (!target) throw new CmdError(requestedId === undefined
      ? `lane "${lane}" has no open questions`
      : `lane "${lane}" has no open question #${requestedId}`);
    const current = readQuestion(target.path) ?? target.record;
    if (!questionOpen(current)) throw new CmdError(`question #${current.seq} is no longer open`);
    current.answered = true;
    current.answer = answer;
    current.answeredAt = new Date().toISOString();
    writeQuestion(target.path, current);
    return current;
  });
  const laneOwner = readLedger()[lane]?.ownerSession;
  feedOwned(`[cdx] lane=${lane} round=${answered.round} ANSWER #${answered.seq}: ${answer}`, answered.owner || laneOwner);
  console.log(`cdx: answered lane=${lane} question #${answered.seq}`);
}

function questionsCommand(argv: string[]): void {
  const [lane, extra] = argv;
  if (extra) fail("usage: cdx questions [lane]");
  const ledger = readLedger();
  if (lane && !ledger[lane]) fail(`unknown lane "${lane}" (cdx status lists lanes)`);
  const open = questionFiles(lane).filter(({ record }) => questionOpen(record) && ledger[record.lane]?.rounds === record.round);
  if (open.length === 0) {
    console.log(lane ? `cdx: lane=${lane} has no open questions` : "cdx: no open questions");
    return;
  }
  for (const { record } of open) {
    console.log(`${record.lane} r${record.round} QUESTION #${record.seq} asked ${fmtAge(record.askedAt)} ago: ${record.question}`);
  }
}

function msgCommand(argv: string[]): void {
  const [target, ...parts] = argv;
  const message = singleLine(parts.join(" "));
  if (!target || !message) fail('usage: cdx msg <target> "<text>"');
  const caller = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!caller) fail("cdx msg needs CLAUDE_CODE_SESSION_ID from the calling Claude Code session");
  const lane = readLedger()[target];
  const resolved = lane ? lane.ownerSession : target;
  if (!resolved) fail(`lane "${target}" has no Claude session owner`);
  if (resolved.length < 8) fail("message target must be a lane name or an 8-character session prefix");
  const target8 = resolved.slice(0, 8);
  const from8 = caller.slice(0, 8);
  feed(`[cdx] msg to=${target8} from=${from8}: ${message}`);
  console.log(`cdx: message sent to=${target8} from=${from8}`);
}

function inboxCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["n"]);
  if (parsed.rest.length) fail("usage: cdx inbox [-n <lines>]");
  const caller = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!caller) fail("cdx inbox needs CLAUDE_CODE_SESSION_ID from the calling Claude Code session");
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  const path = `${ROOT}/feed.log`;
  if (!existsSync(path)) { console.log("cdx: inbox empty"); return; }
  const prefix = `[cdx] msg to=${caller.slice(0, 8)} `;
  const messages = readTailLines(path, limit, (line) => line.startsWith(prefix));
  console.log(messages.length ? messages.join("\n") : "cdx: inbox empty");
}

function gateLabel(command?: string): string {
  return command ?? "<none>";
}

function printGateChange(lane: string, oldGate: string | undefined, newGate: string | undefined): void {
  console.log(`cdx: lane=${color.magenta(lane)} gate old=${gateLabel(oldGate)}`);
  console.log(`cdx: lane=${color.magenta(lane)} gate new=${gateLabel(newGate)}`);
}

function gateCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["clear"]);
  const [lane, command, extra] = parsed.rest;
  if (!lane || extra || (parsed.bools.has("clear") ? command !== undefined : command === undefined)) {
    fail('usage: cdx gate <lane> "<cmd>" | cdx gate <lane> --clear');
  }
  if (!parsed.bools.has("clear") && command!.trim() === "") fail("gate command cannot be empty; use --clear");
  const before = readLane(lane);
  if (laneRunning(before) && pidAlive(before.pid)) fail(`lane "${lane}" is running; stop it before changing the gate`);
  const next = parsed.bools.has("clear") ? undefined : command;
  withLedger((ledger) => {
    const item = ledger[lane]!;
    item.gate = next;
    item.updatedAt = new Date().toISOString();
  });
  printGateChange(lane, before.gate, next);
}

async function spawnCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "worktree", "bg", "add-dir", "image", "schema", "account", "gate", "gate-baseline-check", "max-runtime"]);
  const engine = engineOf(parsed, "spawn");
  const [lane, briefArg] = parsed.rest;
  const brief = await resolveBrief(briefArg);
  if (!lane || !brief) fail(`usage: cdx spawn <lane> [--engine gpt|gemini] [options] "<brief>"\n\n${ENGINE_PICKER}`);
  validLane(lane);
  requireEngineBinary(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gemini" && (parsed.lists.image?.length ?? 0) > 0) fail("--image is not supported for gemini");
  let cwd = parsed.flags.cd ?? process.cwd();
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = engineEffort(engine, parsed);
  const maxRuntime = maxRuntimeOf(parsed);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  if (parsed.bools.has("gate-baseline-check") && parsed.flags.gate === undefined) fail("--gate-baseline-check requires --gate");
  // Cheap pre-check so a doomed launch is rejected before paying for usage
  // probes; openRound re-checks under the ledger lock.
  const existingLane = readLedger()[lane];
  if (existingLane && laneRunning(existingLane) && pidAlive(existingLane.pid)) {
    fail(`lane "${lane}" is already running (pid ${existingLane.pid}); pick a new name or wait`);
  }
  if (existingLane) {
    rejectEngineMismatch(lane, existingLane, engine);
    if (engine === "gpt") rejectPinnedAccountFlag(lane, existingLane, parsed.flags.account);
  }
  let worktree: WorktreeInfo | undefined;
  if (parsed.flags.worktree) {
    worktree = createWorktree(cwd, parsed.flags.worktree, lane);
    cwd = worktree.path;
  }
  const selection = engine === "gpt" ? existingLane ? undefined : await selectAccount(parsed.flags.account) : undefined;
  const account = engine === "gpt" ? existingLane ? laneAccount(existingLane) : selection!.choice : undefined;
  const fallbackHome = engine === "gpt" && existingLane ? legacyAccountFallback(lane, existingLane, existingLane.ownerSession) : undefined;
  if (engine === "gpt" && (existingLane || !config.accounts || parsed.flags.account)) warnCachedUsageBeforeLaunch(account);
  const owner = callerOwnership();
  if (engine === "gemini") {
    const words = brief.trim().split(/\s+/).filter(Boolean).length;
    if (words > 1500) {
      const warning = `cdx: gemini brief is ${words} words; gemini works best on one outcome per lane, consider splitting into parallel lanes`;
      console.error(warning);
      feed(warning);
    }
  }
  const additionalDirectories = (parsed.lists["add-dir"] ?? []).map((dir) => {
    if (!existsSync(dir)) fail(`--add-dir does not exist: ${dir}`);
    return realpathSync(dir);
  });
  const images = (parsed.lists.image ?? []).map((image) => {
    if (!existsSync(image)) fail(`--image does not exist: ${image}`);
    return realpathSync(image);
  });
  let outputSchema: unknown;
  if (parsed.flags.schema) {
    try { outputSchema = JSON.parse(readFileSync(parsed.flags.schema, "utf8")); }
    catch (error) { fail(`--schema must name valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const { round } = openRound(lane, "work", cwd, effort, {
    engine, ...(existingLane && engine === "gpt" ? { preserveAccount: true as const } : engine === "gpt" ? { account } : {}), owner, worktree, gate: parsed.flags.gate,
  });
  if (selection) announceAccountSelection(lane, selection, owner.ownerSession);
  const fullBrief = `Ground rules:\n${houseRules(cwd, false, engine)}\n\nTask:\n${brief}`;
  const gateBaselineChecked = Boolean(parsed.flags.gate && (worktree || parsed.bools.has("gate-baseline-check")));
  if (gateBaselineChecked) {
    const baselineLog = `${ROOT}/logs/${lane}-r${round}.gate-baseline.log`;
    console.log(`cdx: gate baseline check cwd=${cwd} cmd=${parsed.flags.gate}`);
    const result = executeGate(parsed.flags.gate!, cwd, baselineLog);
    const checkedAt = new Date().toISOString();
    withLedger((ledger) => {
      ledger[lane]!.gateBaseline = { round, command: parsed.flags.gate!, cwd, exitCode: result.exitCode, checkedAt };
    });
    if (result.exitCode !== 0) {
      writeFileSync(`${ROOT}/briefs/${lane}-r${round}.md`, fullBrief);
      finishInvalidBaseline(lane, round, parsed.flags.gate!, cwd, result);
      process.exitCode = 1;
      return;
    }
    console.log(`cdx: gate baseline passed cwd=${cwd}`);
  }
  return launch({
    engine, mode: "spawn", lane, round, cwd, prompt: fullBrief, model: engine === "gemini" ? (config.gemini ?? geminiConfig()).model : config.model,
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    ...(images.length ? { images } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(parsed.flags.gate ? { gate: parsed.flags.gate } : {}),
    ...(gateBaselineChecked ? { gateBaselineChecked: true as const } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...accountSpec(account, fallbackHome), ...ownershipSpec(owner),
  }, fullBrief, parsed.bools.has("bg"));
}

async function resumeCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "gate", "bg", "max-runtime", "account"]);
  const [lane, followUpArg] = parsed.rest;
  const followUp = await resolveBrief(followUpArg);
  if (!lane || !followUp) fail('usage: cdx resume <lane> [--effort <effort>] [--bg] [--max-runtime <min>] "<follow-up>"');
  const maxRuntime = maxRuntimeOf(parsed);
  const before = readLane(lane);
  const engine = laneEngine(before);
  requireEngineBinary(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gpt") rejectPinnedAccountFlag(lane, before, parsed.flags.account);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  const account = engine === "gpt" ? laneAccount(before) : undefined;
  const fallbackHome = engine === "gpt" ? legacyAccountFallback(lane, before, before.ownerSession) : undefined;
  if (engine === "gpt") warnCachedUsageBeforeLaunch(account);
  const owner = storedOwnership(before);
  const effort = engineEffort(engine, parsed, before.effort);
  // Resume targets the lane's work thread even when the latest round was a
  // review; only a lane that never had a work session continues read-only.
  const workThread = before.workSessionId ?? (before.kind === "work" ? before.sessionId : undefined);
  const reviewResume = workThread === undefined;
  const cwd = workCwdOf(before);
  const { round, sessionId } = openRound(lane, reviewResume ? "review" : "work", cwd, effort, {
    engine, preserveEngine: true, requireSession: true, preserveAccount: engine === "gpt", preserveOwner: true,
    preserveGate: parsed.flags.gate === undefined,
    ...(parsed.flags.gate !== undefined ? { gate: parsed.flags.gate } : {}),
    ...(workThread ? { sessionOverride: workThread } : {}),
  });
  if (parsed.flags.gate !== undefined) printGateChange(lane, before.gate, parsed.flags.gate);
  const reportInstruction = reviewResume
    ? (engine === "gemini"
        ? "Your final answer is captured as structured output: put the complete markdown report in the report field and every finding in the findings array (empty when clean)."
        : "Print your final report. cdx captures it from the transcript.")
    : "Print your final report. cdx captures the last final agent message.";
  const prompt = `Ground rules:\n${houseRules(cwd, reviewResume, engine)}\n\nTask:\n${followUp}\n\n${reportInstruction}`;
  // The session keeps its own settings; only an explicit --effort overrides.
  const effortArgs = parsed.flags.effort ? ["-c", `model_reasoning_effort=${effort}`] : [];
  const codexArgs = reviewResume && engine === "gpt"
    ? ["exec", "resume", ...effortArgs, "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "--skip-git-repo-check", sessionId!, prompt]
    : undefined;
  const gate = parsed.flags.gate ?? before.gate;
  return launch({
    engine, mode: "resume", lane, round, cwd, prompt,
    ...(codexArgs ? { codexArgs, reviewDir: cwd } : { sourceThreadId: sessionId }),
    ...(reviewResume && engine === "gemini" ? { reviewDir: cwd, outputSchema: REVIEW_FINDINGS_SCHEMA } : {}),
    ...(!reviewResume && gate ? { gate } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...accountSpec(account, fallbackHome), ...ownershipSpec(owner),
  }, prompt, parsed.bools.has("bg"));
}

async function forkCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "bg", "account"]);
  const [newLane, source, briefArg] = parsed.rest;
  const brief = await resolveBrief(briefArg);
  if (!newLane || !source || !brief) fail('usage: cdx fork <newLane> <fromLane|sessionId> [--bg] "<brief>"');
  validLane(newLane);
  const ledger = readLedger();
  const sourceLane = ledger[source];
  if (sourceLane && laneEngine(sourceLane) === "gemini") fail("gemini has no headless fork; use cdx resume");
  const sessionId = sourceLane
    ? sourceLane.workSessionId ?? sourceLane.sessionId ?? source
    : source;
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) fail(`"${source}" is neither a lane with a session nor a session UUID`);
  const effort = parsed.flags.effort
    ? effortOf(parsed)
    : configuredEffort(sourceLane?.effort ?? config.defaultEffort);
  let account: AccountChoice | undefined;
  let fallbackHome: string | undefined;
  if (sourceLane) {
    rejectPinnedAccountFlag(source, sourceLane, parsed.flags.account);
    account = laneAccount(sourceLane);
    fallbackHome = legacyAccountFallback(source, sourceLane, sourceLane.ownerSession);
  } else {
    account = primaryAccount(parsed.flags.account);
  }
  warnCachedUsageBeforeLaunch(account);
  // exec fork keeps the source session's workdir; --cd would be a lie. For a
  // raw session id the truth lives in the rollout's session_meta.
  let cwd: string;
  if (sourceLane) {
    cwd = workCwdOf(sourceLane);
  } else {
    const codexHome = account?.home ?? process.env.CODEX_HOME ?? `${HOME}/.codex`;
    const sessionCwd = rolloutCwdForSession(codexHome, sessionId);
    if (!sessionCwd) {
      console.error(color.yellow(`cdx: warning: could not resolve the session's workdir under ${displayPath(codexHome)}/sessions; recording ${process.cwd()}`));
    }
    cwd = sessionCwd ?? process.cwd();
  }
  const owner = callerOwnership();
  const { round } = openRound(newLane, "work", cwd, effort, { engine: "gpt", account, owner });
  const prompt = `Ground rules:\n${houseRules(cwd, false)}\n\nTask:\n${brief}\n\nPrint your final report. cdx captures the last final agent message.`;
  return launch({ engine: "gpt", mode: "fork", lane: newLane, round, cwd, prompt, sourceThreadId: sessionId, ...accountSpec(account, fallbackHome), ...ownershipSpec(owner) }, prompt, parsed.bools.has("bg"));
}

async function reviewCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "bg", "uncommitted", "base", "commit", "scope", "account"]);
  const engine = engineOf(parsed, "review");
  const [lane, intentArg] = parsed.rest;
  const intent = await resolveBrief(intentArg);
  if (!lane) fail('usage: cdx review <lane> [--uncommitted | --base <branch> | --commit <sha>] [--scope "<files>"] ["<intent>"]');
  validLane(lane);
  requireEngineBinary(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  const existing = readLedger()[lane];
  if (existing && laneEngine(existing) === "gemini" && engine === "gemini") {
    console.log(color.yellow("cdx: gemini reviewing a gemini lane; give the intent explicit attack items"));
  }
  const cwd = parsed.flags.cd ?? (existing ? workCwdOf(existing) : process.cwd());
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = engineEffort(engine, parsed);
  const targets = [parsed.bools.has("uncommitted") ? "--uncommitted" : "", parsed.flags.base ? "base" : "", parsed.flags.commit ? "commit" : ""].filter(Boolean);
  if (targets.length > 1) fail("pick exactly one of --uncommitted, --base, --commit");
  if (targets.length === 1 && intent) fail("native review targets (--uncommitted/--base/--commit) cannot carry a custom intent; drop it or drop the target flag");
  if (targets.length === 1 && parsed.flags.scope) fail("--scope only applies to exec review (native review always covers the whole target diff)");
  if (targets.length === 0 && !intent) fail("exec review needs an intent (or pass a native target flag)");
  if (existing && engine === "gpt") rejectPinnedAccountFlag(lane, existing, parsed.flags.account);

  const selection = engine === "gpt" ? existing ? undefined : await selectAccount(parsed.flags.account) : undefined;
  const account = engine === "gpt" ? existing ? laneAccount(existing) : selection!.choice : undefined;
  const fallbackHome = engine === "gpt" && existing ? legacyAccountFallback(lane, existing, existing.ownerSession) : undefined;
  if (engine === "gpt" && (existing || !config.accounts || parsed.flags.account)) warnCachedUsageBeforeLaunch(account);
  const roundAccount = engine === "gpt" ? existing ? { preserveAccount: true as const } : { account } : {};

  if (targets.length === 1) {
    const owner = callerOwnership();
    if (engine === "gemini") {
      const target = parsed.bools.has("uncommitted") ? "HEAD"
        : parsed.flags.base ? `${parsed.flags.base}...HEAD`
        : undefined;
      // git show covers a root commit; <sha>^ has no parent there.
      const task = target
        ? `Review the diff shown by \`git diff ${target}\` in this repository.`
        : `Review the diff shown by \`git show ${parsed.flags.commit}\` in this repository.`;
      const fullBrief = [reviewFrame(engine), `Ground rules:\n${houseRules(cwd, true, engine)}`, `Task:\n${task}`].join("\n\n");
      const { round } = openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true });
      return launch({ engine, mode: "review-native", lane, round, cwd, reviewDir: cwd, prompt: fullBrief, outputSchema: REVIEW_FINDINGS_SCHEMA, ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
    }
    // Native `codex review`: purpose-built diff review. It rejects a custom
    // prompt alongside a target, so the adversarial frame stays home.
    const { round } = openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true });
    if (selection) announceAccountSelection(lane, selection, owner.ownerSession);
    const codexArgs = [
      "review", "-c", `review_model=${JSON.stringify(config.model)}`, "-c", `model_reasoning_effort=${effort}`,
      "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
    ];
    if (parsed.bools.has("uncommitted")) codexArgs.push("--uncommitted");
    if (parsed.flags.base) codexArgs.push("--base", parsed.flags.base);
    if (parsed.flags.commit) codexArgs.push("--commit", parsed.flags.commit);
    const label = parsed.bools.has("uncommitted") ? "uncommitted changes" : parsed.flags.base ? `diff vs ${parsed.flags.base}` : `commit ${parsed.flags.commit}`;
    return launch({ engine, mode: "review-native", lane, round, cwd, reviewDir: cwd, prompt: `native review of ${label}`, codexArgs, ...accountSpec(account, fallbackHome), ...ownershipSpec(owner) }, `native review of ${label}`, parsed.bools.has("bg"));
  }

  const owner = callerOwnership();
  const { round } = openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true });
  if (selection) announceAccountSelection(lane, selection, owner.ownerSession);
  const scope = parsed.flags.scope
    ? `\nScope: review EXACTLY these files, ignore all other dirty files (other lanes own them): ${parsed.flags.scope}`
    : "";
  const fullBrief = [reviewFrame(engine) + scope, `Ground rules:\n${houseRules(cwd, true, engine)}`, `Task:\n${intent}`].join("\n\n");
  // Reviews are read-only: enforce it with the sandbox, not just the prompt.
  const codexArgs = engine === "gpt" ? [
    "exec", "--json", "-m", config.model, "-c", `model_reasoning_effort=${effort}`,
    "-s", "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check", "--cd", cwd,
    "--output-last-message", reportPathOf(lane, round), fullBrief,
  ] : undefined;
  return launch({ engine, mode: "spawn", lane, round, cwd, reviewDir: cwd, prompt: fullBrief, ...(engine === "gemini" ? { outputSchema: REVIEW_FINDINGS_SCHEMA } : {}), ...(codexArgs ? { codexArgs } : {}), ...(engine === "gpt" ? accountSpec(account, fallbackHome) : {}), ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
}

function fmtTokens(tokens?: Tokens): string {
  if (!tokens || (tokens.input === 0 && tokens.output === 0)) return "-";
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  return `${k(tokens.input)}in/${k(tokens.output)}out`;
}

function fmtAge(iso?: string): string {
  if (!iso) return "-";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function displayPath(path: string): string {
  if (path === HOME) return "~";
  return path.startsWith(`${HOME}/`) ? `~/${path.slice(HOME.length + 1)}` : path;
}

function fmtCreated(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "-";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getDate()} ${months[date.getMonth()]} ${hour}:${minute}`;
}

function renderLaneBlock(lane: string, entry: Lane): string {
  const active = laneRunning(entry);
  const stale = active && !pidAlive(entry.pid);
  const workState = workStateOf(entry);
  const state = entry.kind === "work" && stale ? "running(dead?)" : workState;
  const workRound = entry.workRound ?? (entry.kind === "work" ? entry.rounds : undefined);
  const steerDetail = entry.kind === "work" && active ? `  steers=${entry.steers ?? 0}` : "";
  const continueDetail = (entry.continuations ?? 0) > 0 ? `  auto-continued ${entry.continuations}x` : "";
  const engine = laneEngine(entry);
  const first = `${color.magenta(lane)}  ${coloredState(state)}  work${workRound ? ` r${workRound}` : ""}  engine=${engine}  ${entry.effort}${entry.account ? `  account=${entry.account}` : ""}${steerDetail}${continueDetail}`;
  const line = (label: string, value: string) => `${color.dim(`  ${label.padEnd(12)}`)}${value}`;
  let owner = "-";
  if (entry.ownerCwd) {
    const currentSession = process.env.CLAUDE_CODE_SESSION_ID?.trim();
    const ownerId = entry.ownerSession?.slice(0, 8) || "terminal";
    const relation = !entry.ownerSession || !currentSession ? "(terminal)"
      : entry.ownerSession === currentSession ? "(this session)" : "(other session)";
    owner = `${ownerId} ${relation}  from ${displayPath(entry.ownerCwd)}`;
  }
  const timing = workState === "running"
    ? `running ${fmtAge(entry.roundStartedAt ?? entry.createdAt)} · idle ${fmtAge(entry.lastEventAt ?? entry.roundStartedAt ?? entry.createdAt)}`
    : `finished ${fmtAge(entry.workUpdatedAt ?? entry.updatedAt)} ago`;
  const laneDetail = `cwd ${displayPath(workCwdOf(entry))}${entry.branch ? ` · worktree ${entry.branch}` : ""} · created ${fmtCreated(entry.createdAt)} · ${timing}`;
  const tokenLabel = active && entry.roundTokens
    ? `${fmtTokens(entry.roundTokens)} round / ${fmtTokens(entry.tokens)} total`
    : fmtTokens(entry.tokens);
  const tokenDetail = `${tokenLabel} · ${engine === "gemini" ? "gemini conversation" : "codex session"} ${(entry.workSessionId ?? entry.sessionId)?.slice(0, 8) ?? "-"}`;
  const report = entry.workReport ?? (entry.kind === "work" ? entry.reports.at(-1) : undefined);
  const lastParts = [entry.diffEmpty ? "no tree change" : undefined, entry.note, report ? `report ${displayPath(report)}` : undefined].filter(Boolean);
  const last = entry.kind === "work" && active ? entry.lastAction ?? "-"
    : lastParts.join(" · ") || "-";
  const lines = [first, line("owner", owner), line("lane", laneDetail), line("tokens", tokenDetail), line("last", last)];
  const waiting = questionFiles(lane).find(({ record }) => record.round === entry.rounds && questionOpen(record));
  if (active && waiting) lines.push(line("question", `waiting on question #${waiting.record.seq}: ${waiting.record.question}`));
  if (entry.reviewState) {
    const reviewState = entry.kind === "review" && stale ? "running(dead?)" : entry.reviewState;
    const reviewTiming = entry.reviewState === "running"
      ? `running ${fmtAge(entry.roundStartedAt)} · idle ${fmtAge(entry.lastEventAt ?? entry.roundStartedAt)}`
      : `finished ${fmtAge(entry.reviewUpdatedAt)} ago`;
    const reviewLast = entry.reviewState === "running" ? entry.lastAction ?? "-"
      : [entry.reviewNote, entry.reviewReport ? `report ${displayPath(entry.reviewReport)}` : undefined].filter(Boolean).join(" · ") || "-";
    lines.push(line("review", `${coloredState(reviewState)}${entry.reviewRound ? ` r${entry.reviewRound}` : ""} · cwd ${displayPath(entry.reviewCwd ?? workCwdOf(entry))} · ${reviewTiming}`));
    lines.push(line("review last", reviewLast));
  }
  return lines.join("\n");
}

const FINISHED_SHOWN = 10;

function statusCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["json", "all"]);
  const ledger = readLedger();
  const all = Object.entries(ledger);
  if (parsed.bools.has("json")) {
    const enriched = Object.fromEntries(all.map(([lane, entry]) => [lane, { ...entry, engine: laneEngine(entry), alive: laneRunning(entry) ? pidAlive(entry.pid) : undefined }]));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  if (all.length === 0) { console.log("cdx: no lanes"); return; }
  // Running lanes first (most recent activity on top), then finished ones
  // newest first, capped unless --all.
  const byRecency = (a: [string, Lane], b: [string, Lane]) =>
    Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt);
  const running = all.filter(([, entry]) => laneRunning(entry)).sort(byRecency);
  const finished = all.filter(([, entry]) => !laneRunning(entry)).sort(byRecency);
  const hidden = parsed.bools.has("all") ? 0 : Math.max(0, finished.length - FINISHED_SHOWN);
  const lanes = [...running, ...finished.slice(0, finished.length - hidden)];
  console.log(lanes.map(([lane, entry]) => renderLaneBlock(lane, entry)).join("\n\n"));
  if (hidden > 0) console.log(`\n${color.dim(`… ${hidden} older finished lane${hidden === 1 ? "" : "s"} hidden (cdx status --all)`)}`);
}

async function waitCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["timeout", "json", "report"]);
  const json = parsed.bools.has("json");
  const showReport = parsed.bools.has("report");
  const lanes = parsed.rest;
  if (lanes.length === 0) fail("usage: cdx wait <lane>... [--timeout <sec>] [--json] [--report]");
  for (const lane of lanes) readLane(lane);
  const timeoutMs = Number(parsed.flags.timeout ?? 7200) * 1000;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(lanes);
  const reportTextOf = (entry: Lane): string | undefined => {
    const path = roundReportOf(entry);
    try { return path ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
  };
  // --json prints one JSON object per finished lane, in completion order.
  const emitJson = (lane: string, entry: Lane, error?: string) => console.log(JSON.stringify({
    lane, engine: roundEngine(entry), state: entry.state, roundState: roundStateOf(entry), kind: entry.kind,
    exitCode: roundExitCodeOf(entry) ?? null, tokens: entry.tokens ?? null,
    report: roundReportOf(entry) ?? null, note: roundNoteOf(entry) ?? null, sessionId: entry.sessionId ?? null,
    rounds: entry.rounds, ...(showReport ? { reportText: reportTextOf(entry) ?? null } : {}),
    ...(error ? { error } : {}),
  }));
  let failed = false;
  while (pending.size > 0) {
    const ledger = readLedger();
    for (const lane of [...pending]) {
      const entry = ledger[lane]!;
      if (laneRunning(entry) && pidAlive(entry.pid)) continue;
      if (laneRunning(entry)) {
        if (json) emitJson(lane, entry, "runner died without finalizing");
        else console.log(`cdx: lane=${color.magenta(lane)} ${color.red("runner died without finalizing")} (see cdx doctor)`);
        failed = true;
      } else {
        if (json) emitJson(lane, entry);
        else {
          console.log(`cdx: lane=${color.magenta(lane)} engine=${roundEngine(entry)} kind=${entry.kind} state=${coloredState(roundStateOf(entry))} exit=${roundExitCodeOf(entry) ?? "?"} tokens=${fmtTokens(entry.tokens)} report=${roundReportOf(entry) ?? "-"}`);
          if (showReport) {
            const text = reportTextOf(entry);
            if (text) {
              console.log(`--- report ${color.magenta(lane)} ---`);
              console.log(text.trimEnd());
              console.log(`--- end ${color.magenta(lane)} ---`);
            }
          }
        }
        if (roundStateOf(entry) === "failed" || roundStateOf(entry) === "gate-invalid") failed = true;
      }
      pending.delete(lane);
    }
    if (pending.size === 0) break;
    if (Date.now() > deadline) fail(`timeout waiting for: ${[...pending].join(", ")}`);
    await Bun.sleep(5000);
  }
  process.exit(failed ? 1 : 0);
}

function renderEventLine(line: string): string | undefined {
  try {
    const event = JSON.parse(line);
    if (event.event === "init") return `[gemini conversation ${event.conversation_id ?? "?"}]`;
    if (event.event === "step_update" && event.step_update) {
      const update = event.step_update;
      if (update.step_type === "tool") return `gemini: ${update.tool_name ?? update.tool_info?.name ?? "tool"}`;
      if (update.step_type === "agent_response" && update.text_delta) return `gemini: ${singleLine(update.text_delta)}`;
      return undefined;
    }
    if (event.event === "result" && event.result) {
      const usage = event.result.usage;
      return `[gemini turn ${String(event.result.status ?? "?").toLowerCase()}: conversation total ${usage?.input_tokens ?? "?"} in / ${usage?.output_tokens ?? "?"} out]`;
    }
    if (event.method === "thread/started") return `[session ${event.params?.thread?.id ?? "?"}]`;
    if (event.method === "turn/completed") return `[turn ${event.params?.turn?.status ?? "done"}]`;
    if (event.method === "item/completed" && event.params?.item) {
      return event.params.item.type === "agentMessage" ? `codex: ${event.params.item.text}` : excerpt(event.params.item);
    }
    if (event.type === "thread.started") return `[session ${event.thread_id}]`;
    if (event.type === "turn.completed") return `[turn done: ${event.usage?.input_tokens ?? "?"} in / ${event.usage?.output_tokens ?? "?"} out]`;
    if (event.type === "item.completed" && event.item) {
      return event.item.type === "agent_message" ? `codex: ${event.item.text}` : excerpt(event.item);
    }
    return undefined;
  } catch { return line; }
}

function renderTail(logPath: string, lines: number): string {
  const raw = readFileSync(logPath, "utf8");
  if (!logPath.endsWith(".jsonl")) return raw.split("\n").slice(-lines).join("\n");
  const rendered: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const out = renderEventLine(line);
    if (out !== undefined) rendered.push(out);
  }
  return rendered.slice(-lines).join("\n");
}

interface Cursor { round: number; path: string; offset: number; buffer: string; json: boolean; decoder: TextDecoder }

function openCursor(lane: string, entry: Lane, fromEnd: boolean): Cursor | undefined {
  for (let round = entry.rounds; round >= 1; round -= 1) {
    for (const json of [true, false]) {
      const path = logPathOf(lane, round, json);
      if (existsSync(path)) return { round, path, offset: fromEnd ? statSync(path).size : 0, buffer: "", json, decoder: new TextDecoder() };
    }
  }
  return undefined;
}

function drainCursor(cursor: Cursor, prefix: string, emit = console.log) {
  let size: number;
  try { size = statSync(cursor.path).size; } catch { return; }
  if (size > cursor.offset) {
    const chunk = Buffer.alloc(size - cursor.offset);
    const fd = openSync(cursor.path, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < chunk.length) {
        const count = readSync(fd, chunk, bytesRead, chunk.length - bytesRead, cursor.offset + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
    } finally {
      closeSync(fd);
    }
    cursor.offset += bytesRead;
    cursor.buffer += cursor.decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
  }
  const lines = cursor.buffer.split("\n");
  cursor.buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const out = cursor.json ? renderEventLine(line) : line;
    if (out !== undefined) emit(prefix + out);
  }
}

async function followLane(lane: string) {
  let entry = readLane(lane);
  let cursor = openCursor(lane, entry, false);
  if (cursor) {
    const history: string[] = [];
    drainCursor(cursor, "", (line) => history.push(line));
    console.log(history.slice(-15).join("\n"));
  }
  console.log(`--- following ${color.magenta(lane)} live (Ctrl-C to stop) ---`);
  while (true) {
    entry = readLedger()[lane] ?? fail(`lane "${lane}" disappeared from the ledger`);
    if (cursor && entry.rounds > cursor.round) cursor = openCursor(lane, entry, false) ?? cursor;
    if (!cursor) cursor = openCursor(lane, entry, false);
    if (cursor) drainCursor(cursor, "");
    if (!laneRunning(entry)) {
      const state = roundStateOf(entry);
      const exitCode = roundExitCodeOf(entry);
      const note = roundNoteOf(entry);
      console.log(`--- lane ${color.magenta(lane)} ${entry.kind} ${coloredState(state)}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}${note ? `: ${note}` : ""} report=${roundReportOf(entry) ?? "-"} ---`);
      process.exit(state === "failed" || state === "gate-invalid" ? 1 : 0);
    }
    if (!pidAlive(entry.pid)) {
      console.log(`--- lane ${color.magenta(lane)} ${color.red("marked running but its runner is dead")} (cdx doctor --fix) ---`);
      process.exit(1);
    }
    await Bun.sleep(1000);
  }
}

async function followAll() {
  const cursors = new Map<string, Cursor>();
  console.log("--- following all running lanes (Ctrl-C to stop) ---");
  while (true) {
    const ledger = readLedger();
    for (const [lane, entry] of Object.entries(ledger)) {
      if (!laneRunning(entry) || cursors.has(lane)) continue;
      const cursor = openCursor(lane, entry, true);
      if (cursor) {
        cursors.set(lane, cursor);
        console.log(`${color.magenta(`[${lane}]`)} --- attached (round ${cursor.round}, ${entry.effort}, ${entry.kind === "review" ? entry.reviewCwd ?? workCwdOf(entry) : workCwdOf(entry)}) ---`);
      }
    }
    for (const [lane, cursor] of cursors) {
      const entry = ledger[lane];
      if (entry && laneRunning(entry) && entry.rounds > cursor.round) {
        cursors.set(lane, openCursor(lane, entry, false) ?? cursor);
        continue;
      }
      drainCursor(cursor, `${color.magenta(`[${lane}]`)} `);
      if (!entry || !laneRunning(entry)) {
        console.log(`${color.magenta(`[${lane}]`)} --- ${entry ? coloredState(roundStateOf(entry)) : "gone"}${entry && roundNoteOf(entry) ? `: ${roundNoteOf(entry)}` : ""} ---`);
        cursors.delete(lane);
      }
    }
    if (cursors.size === 0) {
      const running = Object.values(readLedger()).some((entry) => laneRunning(entry));
      if (!running) await Bun.sleep(2000);
    }
    await Bun.sleep(1000);
  }
}

function latestRoundLog(lane: string): string {
  const entry = readLane(lane);
  for (let round = entry.rounds; round >= 1; round -= 1) {
    for (const json of [true, false]) {
      const path = logPathOf(lane, round, json);
      if (existsSync(path)) return path;
    }
  }
  fail(`no logs for lane "${lane}"`);
}

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

interface AccountUsage {
  planType: string;
  primary: RateLimitWindow;
  secondary?: RateLimitWindow;
  resetCredits: number;
  rateLimitReachedType: unknown;
  spendControlReached: boolean;
}

interface UsageSnapshot {
  checkedAt: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  planType: string;
  resetCreditsAvailable: number;
  reached: boolean;
  warnedAt?: string;
  probeFailedAt?: string;
}

interface RefreshedUsage {
  usage: AccountUsage;
  snapshot: UsageSnapshot;
}

function isRateLimitWindow(value: unknown): value is RateLimitWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return typeof window.usedPercent === "number"
    && typeof window.windowDurationMins === "number"
    && typeof window.resetsAt === "number";
}

function parseAccountUsage(response: unknown): AccountUsage | undefined {
  if (!response || typeof response !== "object") return undefined;
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const limits = (result as { rateLimits?: unknown }).rateLimits;
  const credits = (result as { rateLimitResetCredits?: unknown }).rateLimitResetCredits;
  if (!limits || typeof limits !== "object" || !credits || typeof credits !== "object") return undefined;
  const value = limits as Record<string, unknown>;
  const availableCount = (credits as Record<string, unknown>).availableCount;
  if (typeof value.planType !== "string" || !isRateLimitWindow(value.primary)
    || (value.secondary != null && !isRateLimitWindow(value.secondary))
    || typeof availableCount !== "number") return undefined;
  return {
    planType: value.planType,
    primary: value.primary,
    secondary: value.secondary == null ? undefined : value.secondary as RateLimitWindow,
    resetCredits: availableCount,
    rateLimitReachedType: value.rateLimitReachedType,
    spendControlReached: value.spendControlReached === true,
  };
}

async function readAccountUsage(codexHome?: string): Promise<AccountUsage | undefined> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stderrDrain: Promise<string> | undefined;
  const deadline = Date.now() + 10_000;
  try {
    proc = Bun.spawn(["codex", "app-server"], {
      env: uncoloredChildEnv(codexHome), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    stderrDrain = new Response(proc.stderr).text().catch(() => "");
    const messages = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "cdx", title: "cdx", version: VERSION } } },
      { method: "initialized", params: {} },
      { id: 2, method: "account/rateLimits/read", params: {} },
    ];
    proc.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
    proc.stdin.flush();

    const response = await Promise.race([
      (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of proc!.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              const message = JSON.parse(line) as { id?: number };
              if (message.id === 2) return message;
            }
            newline = buffer.indexOf("\n");
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
          const message = JSON.parse(buffer) as { id?: number };
          if (message.id === 2) return message;
        }
        throw new Error("app server exited before the usage response");
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try { proc?.kill("SIGKILL"); } catch { /* already exited */ }
          reject(new Error("usage request timed out"));
        }, Math.max(0, deadline - Date.now()));
      }),
    ]);
    return parseAccountUsage(response);
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    try { proc?.stdin.end(); } catch { /* already closed */ }
    try { proc?.kill("SIGKILL"); } catch { /* already exited */ }
    const cleanupMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (proc && cleanupMs > 0) {
      await Promise.race([
        Promise.allSettled([proc.exited, stderrDrain]),
        Bun.sleep(cleanupMs),
      ]);
    }
  }
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.checkedAt === "string"
    && typeof snapshot.usedPercent === "number"
    && typeof snapshot.windowDurationMins === "number"
    && typeof snapshot.resetsAt === "number"
    && typeof snapshot.planType === "string"
    && typeof snapshot.resetCreditsAvailable === "number"
    && typeof snapshot.reached === "boolean"
    && (snapshot.warnedAt === undefined || typeof snapshot.warnedAt === "string")
    && (snapshot.probeFailedAt === undefined || typeof snapshot.probeFailedAt === "string");
}

function readUsageSnapshot(account?: AccountChoice): UsageSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(USAGE_PATH, "utf8")) as unknown;
    if (!account) return isUsageSnapshot(value) ? value : undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const accounts = (value as { accounts?: unknown }).accounts;
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return undefined;
    const snapshot = (accounts as Record<string, unknown>)[account.name];
    return isUsageSnapshot(snapshot) ? snapshot : undefined;
  } catch {
    return undefined;
  }
}

function writeUsageSnapshot(snapshot: UsageSnapshot, account?: AccountChoice) {
  const tmp = `${USAGE_PATH}.tmp.${process.pid}`;
  try {
    let value: UsageSnapshot | { accounts: Record<string, UsageSnapshot> } = snapshot;
    if (account) {
      let accounts: Record<string, UsageSnapshot> = {};
      try {
        const current = JSON.parse(readFileSync(USAGE_PATH, "utf8")) as { accounts?: unknown };
        if (current?.accounts && typeof current.accounts === "object" && !Array.isArray(current.accounts)) {
          accounts = Object.fromEntries(Object.entries(current.accounts as Record<string, unknown>)
            .filter((entry): entry is [string, UsageSnapshot] => isUsageSnapshot(entry[1])));
        }
      } catch { /* missing, flat, or malformed means an empty account cache */ }
      value = { accounts: { ...accounts, [account.name]: snapshot } };
    }
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, USAGE_PATH);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw error;
  }
}

function withUsageLock<T>(action: () => T): T | undefined {
  const lock = `${ROOT}/.usage.lock`;
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; }
      } catch { /* raced */ }
      if (Date.now() > deadline) return undefined;
      Bun.sleepSync(25);
    }
  }
  try {
    return action();
  } finally {
    try { rmdirSync(lock); } catch { /* raced */ }
  }
}

function snapshotFromAccountUsage(usage: AccountUsage): UsageSnapshot {
  const windows = [usage.primary, ...(usage.secondary ? [usage.secondary] : [])];
  const window = windows.reduce((selected, candidate) => {
    if (candidate.usedPercent > selected.usedPercent) return candidate;
    if (candidate.usedPercent === selected.usedPercent && candidate.resetsAt > selected.resetsAt) return candidate;
    return selected;
  });
  return {
    checkedAt: new Date().toISOString(),
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
    planType: usage.planType,
    resetCreditsAvailable: usage.resetCredits,
    reached: window.usedPercent >= 99 || usage.rateLimitReachedType != null || usage.spendControlReached,
  };
}

function usageFeedWarning(snapshot: UsageSnapshot, account?: AccountChoice, ownerSession?: string): string {
  const credit = snapshot.resetCreditsAvailable > 0 ? ", reset credit available" : "";
  const owner = account ? `usage for account ${account.name}` : "usage";
  return `[cdx] WARNING: OpenAI Codex ${owner} ${snapshot.usedPercent}% consumed (${rateLimitWindowName(snapshot.windowDurationMins)} window, resets ${rateLimitResetDate(snapshot.resetsAt)})${credit}${ownerSuffix(ownerSession)}`;
}

async function refreshUsageSnapshot(options: { warnFeed?: boolean; account?: AccountChoice; ownerSession?: string } = {}): Promise<RefreshedUsage | undefined> {
  const usage = await readAccountUsage(options.account?.home);
  if (!usage) {
    // Negative-cache the failure so a hung app-server does not cost every
    // subsequent launch a fresh probe timeout (selectAccount honors this
    // marker for 5 minutes).
    withUsageLock(() => {
      const previous = readUsageSnapshot(options.account);
      writeUsageSnapshot({
        checkedAt: new Date(0).toISOString(),
        usedPercent: 0,
        windowDurationMins: 0,
        resetsAt: 0,
        planType: "unknown",
        resetCreditsAvailable: 0,
        reached: false,
        ...previous,
        probeFailedAt: new Date().toISOString(),
      }, options.account);
    });
    return undefined;
  }
  const fresh = snapshotFromAccountUsage(usage);
  const stored = withUsageLock(() => {
    const previous = readUsageSnapshot(options.account);
    const previousIsNewer = previous && Date.parse(previous.checkedAt) > Date.parse(fresh.checkedAt);
    let snapshot = previousIsNewer ? previous : {
      ...fresh,
      ...(previous?.warnedAt ? { warnedAt: previous.warnedAt } : {}),
    };
    if (options.warnFeed && snapshotReached(snapshot)) {
      const warnedAt = snapshot.warnedAt ? Date.parse(snapshot.warnedAt) : Number.NaN;
      if (!Number.isFinite(warnedAt) || Date.now() - warnedAt >= 3_600_000) {
        const beforeWarning = snapshot;
        const warned = { ...snapshot, warnedAt: new Date().toISOString() };
        writeUsageSnapshot(warned, options.account);
        if (feed(usageFeedWarning(warned, options.account, options.ownerSession))) return warned;
        writeUsageSnapshot(beforeWarning, options.account);
        return beforeWarning;
      }
    }
    writeUsageSnapshot(snapshot, options.account);
    return snapshot;
  });
  return { usage, snapshot: stored ?? fresh };
}

function warnCachedUsageBeforeLaunch(account?: AccountChoice) {
  const snapshot = readUsageSnapshot(account);
  if (!snapshot || !snapshotReached(snapshot)) return;
  const checkedAt = Date.parse(snapshot.checkedAt);
  const age = Date.now() - checkedAt;
  if (!Number.isFinite(checkedAt) || age < 0 || age >= 6 * 60 * 60 * 1000) return;
  const owner = account ? `account ${account.name} usage` : "usage";
  console.error(color.red(`cdx: WARNING: OpenAI Codex ${owner} ${snapshot.usedPercent}% consumed; resets ${rateLimitResetDate(snapshot.resetsAt)}`));
}

interface ReachedAccount { choice: AccountChoice; snapshot: UsageSnapshot }
interface AccountSelection { choice?: AccountChoice; skipped: ReachedAccount[]; allReached: boolean }

function snapshotFresh(snapshot: UsageSnapshot | undefined, maxAgeMs: number): snapshot is UsageSnapshot {
  if (!snapshot) return false;
  const checkedAt = Date.parse(snapshot.checkedAt);
  const age = Date.now() - checkedAt;
  return Number.isFinite(checkedAt) && age >= 0 && age < maxAgeMs;
}

// A cached reached=true snapshot stops being true the moment its window
// resets; without this check a post-reset account is skipped for up to the
// full cache TTL.
function snapshotReached(snapshot: UsageSnapshot): boolean {
  return snapshot.reached && snapshot.resetsAt * 1000 > Date.now();
}

function probeFailedRecently(snapshot: UsageSnapshot | undefined): boolean {
  if (!snapshot?.probeFailedAt) return false;
  const failedAt = Date.parse(snapshot.probeFailedAt);
  return Number.isFinite(failedAt) && Date.now() - failedAt < 5 * 60 * 1000;
}

async function selectAccount(forced?: string): Promise<AccountSelection> {
  if (!config.accounts) {
    if (forced !== undefined) configuredAccount(forced);
    return { skipped: [], allReached: false };
  }
  if (forced !== undefined) return { choice: configuredAccount(forced), skipped: [], allReached: false };

  const reached: ReachedAccount[] = [];
  for (const [name, home] of Object.entries(config.accounts)) {
    const choice = { name, home };
    const cached = readUsageSnapshot(choice);
    const fresh = snapshotFresh(cached, 30 * 60 * 1000);
    const refreshed = fresh || probeFailedRecently(cached) ? undefined : await refreshUsageSnapshot({ account: choice });
    const snapshot = refreshed?.snapshot ?? (fresh ? cached : undefined);
    if (!snapshot || !snapshotReached(snapshot)) return { choice, skipped: reached, allReached: false };
    reached.push({ choice, snapshot });
  }

  const selected = reached.reduce((best, candidate) =>
    candidate.snapshot.resetsAt < best.snapshot.resetsAt ? candidate : best);
  return { choice: selected.choice, skipped: reached, allReached: true };
}

// Feed lines are broadcast to every open Claude session, so exhaustion
// notices share the hourly warnedAt dedupe; the per-spawn console line stays.
function feedExhaustionOnce(accounts: AccountChoice[], message: string, ownerSession?: string) {
  withUsageLock(() => {
    const due = accounts.some((choice) => {
      const warnedAt = readUsageSnapshot(choice)?.warnedAt;
      const parsed = warnedAt ? Date.parse(warnedAt) : Number.NaN;
      return !Number.isFinite(parsed) || Date.now() - parsed >= 3_600_000;
    });
    if (!due || !feedOwned(message, ownerSession)) return;
    for (const choice of accounts) {
      const current = readUsageSnapshot(choice);
      if (current) writeUsageSnapshot({ ...current, warnedAt: new Date().toISOString() }, choice);
    }
  });
}

function announceAccountSelection(lane: string, selection: AccountSelection, ownerSession?: string) {
  if (!selection.choice || selection.skipped.length === 0) return;
  if (selection.allReached) {
    const accounts = selection.skipped.map(({ choice, snapshot }) => {
      const credit = snapshot.resetCreditsAvailable > 0 ? ", reset credit available" : "";
      return `${choice.name} ${snapshot.usedPercent}% consumed (${rateLimitWindowName(snapshot.windowDurationMins)} window, resets ${rateLimitResetDate(snapshot.resetsAt)})${credit}`;
    }).join(", ");
    const message = `[cdx] WARNING: OpenAI Codex usage consumed for all accounts: ${accounts}; ${lane} using ${selection.choice.name}`;
    console.error(color.red(message.replace(/^\[cdx\]/, "cdx:")));
    feedExhaustionOnce(selection.skipped.map(({ choice }) => choice), message, ownerSession);
    return;
  }
  for (const { choice, snapshot } of selection.skipped) {
    const message = `[cdx] account ${choice.name} consumed (resets ${rateLimitResetDate(snapshot.resetsAt)}); ${lane} using ${selection.choice.name}`;
    console.error(color.yellow(message.replace(/^\[cdx\]/, "cdx:")));
    feedExhaustionOnce([choice], message, ownerSession);
  }
}

function rateLimitWindowName(minutes: number): string {
  if (minutes === 10_080) return "weekly";
  if (minutes === 300) return "5h";
  return `${minutes / 60}h`;
}

function rateLimitResetDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
}

function formatAccountUsage(usage: AccountUsage): { detail: string; usedPercent: number } {
  const windows = [usage.primary, ...(usage.secondary ? [usage.secondary] : [])];
  const detail = windows.map((window) =>
    `${rateLimitWindowName(window.windowDurationMins)} window ${window.usedPercent}% used, resets ${rateLimitResetDate(window.resetsAt)}`
  ).join(", ");
  const creditLabel = usage.resetCredits === 1 ? "reset credit" : "reset credits";
  return {
    detail: `${usage.planType.toLowerCase()} plan, ${detail} (${usage.resetCredits} ${creditLabel} available)`,
    usedPercent: Math.max(...windows.map((window) => window.usedPercent)),
  };
}

function fmtTokensFull(tokens: Tokens): string {
  const k = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
  return `${k(tokens.input)} in (${k(tokens.cached)} cached) / ${k(tokens.output)} out`;
}

interface GeminiUsageWindow {
  remainingPercent: number;
  resetsAt: string;
}

interface GeminiUsageSnapshot {
  checkedAt: string;
  weekly: GeminiUsageWindow;
  fiveHour: GeminiUsageWindow;
}

function parseGeminiUsage(text: string): GeminiUsageSnapshot | undefined {
  const rows = text.trim().split("\n").map((line) => line.split("\t"));
  const parse = (label: string): GeminiUsageWindow | undefined => {
    const row = rows.find(([model, window]) => model === "Gemini Models" && window === label);
    if (!row) return undefined;
    const remainingPercent = Number(row[2]?.replace(/%$/, ""));
    const resetsAt = row[3] ?? "";
    if (!Number.isFinite(remainingPercent) || !resetsAt || !Number.isFinite(Date.parse(resetsAt))) return undefined;
    return { remainingPercent, resetsAt };
  };
  const weekly = parse("Weekly Limit Remaining");
  const fiveHour = parse("Five Hour Limit Remaining");
  return weekly && fiveHour ? { checkedAt: new Date().toISOString(), weekly, fiveHour } : undefined;
}

function readGeminiUsageSnapshot(): GeminiUsageSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(GEMINI_USAGE_PATH, "utf8")) as GeminiUsageSnapshot;
    return value && typeof value.checkedAt === "string" && typeof value.weekly?.remainingPercent === "number"
      && typeof value.fiveHour?.remainingPercent === "number" ? value : undefined;
  } catch { return undefined; }
}

function writeGeminiUsageSnapshot(snapshot: GeminiUsageSnapshot): void {
  const tmp = `${GEMINI_USAGE_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, GEMINI_USAGE_PATH);
}

async function refreshGeminiUsage(): Promise<GeminiUsageSnapshot | undefined> {
  const agy = Bun.which("agy");
  if (!agy) return undefined;
  const proc = Bun.spawn([agy, "--print=/usage", "--output-format", "text"], {
    env: uncoloredChildEnv(), stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const timeout = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, 10_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, stdout]);
    await stderr;
    if (exitCode !== 0) return undefined;
    const snapshot = parseGeminiUsage(text);
    if (snapshot) writeGeminiUsageSnapshot(snapshot);
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}

function formatGeminiReset(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString() : iso;
}

async function usageCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["json"]);
  const json = parsed.bools.has("json");
  const accounts: (AccountChoice | undefined)[] = config.accounts
    ? Object.entries(config.accounts).map(([name, home]) => ({ name, home }))
    : [undefined];

  // All-time lane and token totals from the ledger, grouped by account.
  // Tokens only accrue on JSONL rounds (spawn, exec review); text rounds
  // (resume, fork, native review) report none.
  const totals = new Map<string, { lanes: number; tokens: Tokens }>();
  const geminiTotals = { lanes: 0, tokens: { input: 0, cached: 0, output: 0 } as Tokens };
  for (const entry of Object.values(readLedger())) {
    if (laneEngine(entry) === "gemini") {
      geminiTotals.lanes += 1;
      if (entry.tokens) {
        geminiTotals.tokens.input += entry.tokens.input;
        geminiTotals.tokens.cached += entry.tokens.cached;
        geminiTotals.tokens.output += entry.tokens.output;
      }
      continue;
    }
    const key = entry.account ?? "default";
    const bucket = totals.get(key) ?? { lanes: 0, tokens: { input: 0, cached: 0, output: 0 } };
    bucket.lanes += 1;
    if (entry.tokens) {
      bucket.tokens.input += entry.tokens.input;
      bucket.tokens.cached += entry.tokens.cached;
      bucket.tokens.output += entry.tokens.output;
    }
    totals.set(key, bucket);
  }

  const [refreshed, geminiUsage] = await Promise.all([
    Promise.all(accounts.map((account) => refreshUsageSnapshot({ account }))),
    refreshGeminiUsage(),
  ]);
  if (json) {
    const rows = accounts.map((account, index) => {
      const key = account?.name ?? "default";
      const ledgerTotals = totals.get(key);
      return {
        account: key,
        home: account?.home ?? process.env.CODEX_HOME ?? `${HOME}/.codex`,
        usage: refreshed[index]?.usage ?? null,
        checkedAt: refreshed[index]?.snapshot.checkedAt ?? null,
        lanes: ledgerTotals?.lanes ?? 0,
        ledgerTokens: ledgerTotals?.tokens ?? null,
      };
    });
    console.log(JSON.stringify({ codex: rows, gemini: geminiUsage ?? readGeminiUsageSnapshot() ?? null, geminiLedger: geminiTotals }, null, 2));
    return;
  }
  for (const [index, account] of accounts.entries()) {
    const key = account?.name ?? "default";
    const label = account ? `${color.bold(account.name)} ${color.dim(`(${displayPath(account.home)})`)}` : color.bold("codex");
    const result = refreshed[index];
    if (!result) {
      const cached = readUsageSnapshot(account);
      const detail = cached && cached.planType !== "unknown"
        ? ` · cached ${fmtAge(cached.checkedAt)} ago: ${cached.planType.toLowerCase()} plan, ${cached.usedPercent}% used, resets ${rateLimitResetDate(cached.resetsAt)}`
        : "";
      console.log(`${label}: ${color.yellow("probe failed (codex login?)")}${color.dim(detail)}`);
    } else {
      const formatted = formatAccountUsage(result.usage);
      const paint = formatted.usedPercent >= 95 ? color.red : formatted.usedPercent >= 75 ? color.yellow : color.green;
      console.log(`${label}: ${paint(formatted.detail)}`);
    }
    const ledgerTotals = totals.get(key);
    if (ledgerTotals) console.log(color.dim(`  lanes ${ledgerTotals.lanes} · ledger tokens ${fmtTokensFull(ledgerTotals.tokens)}`));
  }
  const gemini = geminiUsage ?? readGeminiUsageSnapshot();
  if (!gemini) {
    console.log(`${color.bold("gemini")}: ${color.yellow("usage probe failed (agy installed and signed in?)")}`);
  } else {
    const paint = (remaining: number) => remaining <= 5 ? color.red : remaining <= 25 ? color.yellow : color.green;
    const weekly = `${gemini.weekly.remainingPercent}% weekly remaining, resets ${formatGeminiReset(gemini.weekly.resetsAt)}`;
    const fiveHour = `${gemini.fiveHour.remainingPercent}% five-hour remaining, resets ${formatGeminiReset(gemini.fiveHour.resetsAt)}`;
    console.log(`${color.bold("gemini")}: ${paint(gemini.weekly.remainingPercent)(weekly)}, ${paint(gemini.fiveHour.remainingPercent)(fiveHour)}`);
  }
  if (geminiTotals.lanes > 0) console.log(color.dim(`  lanes ${geminiTotals.lanes} · ledger tokens ${fmtTokensFull(geminiTotals.tokens)}`));
}

async function probeAppServer(account?: AccountChoice): Promise<{ reply: string; usage: string }> {
  const proc = Bun.spawn({
    cmd: ["codex", "app-server", "--listen", "stdio://"],
    cwd: "/tmp",
    ...(account ? { env: uncoloredChildEnv(account.home) } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let reply = "";
  let usage = "? in / ? out";
  let turnResolve: ((turn: AppTurn) => void) | undefined;
  let turnReject: ((error: Error) => void) | undefined;
  const write = (message: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  };
  const reader = (async () => {
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (typeof event.id === "number" && pending.has(event.id)) {
            const waiter = pending.get(event.id)!;
            pending.delete(event.id);
            if (event.error) waiter.reject(new Error(event.error.message ?? "app-server probe request failed"));
            else waiter.resolve(event.result);
          } else if (event.method === "item/completed" && event.params?.item?.type === "agentMessage") {
            reply = event.params.item.text ?? reply;
          } else if (event.method === "thread/tokenUsage/updated" && event.params?.tokenUsage?.last) {
            const last = event.params.tokenUsage.last;
            usage = `${last.inputTokens ?? "?"} in / ${last.outputTokens ?? "?"} out`;
          } else if (event.method === "turn/completed") {
            const resolve = turnResolve;
            turnResolve = undefined;
            turnReject = undefined;
            resolve?.(event.params.turn as AppTurn);
          }
        }
      }
    } finally {
      const suffix = proc.exitCode === null ? "stdout stream ended" : `child exited ${proc.exitCode}`;
      const closed = new Error(`app-server closed before turn/completed: ${suffix}`);
      for (const waiter of pending.values()) waiter.reject(closed);
      pending.clear();
      const reject = turnReject;
      turnResolve = undefined;
      turnReject = undefined;
      reject?.(closed);
    }
  })();
  const stderr = new Response(proc.stderr).text();
  const killer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 180_000);
  try {
    await request("initialize", {
      clientInfo: { name: "cdx", title: "cdx doctor", version: VERSION },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized" });
    const started = await request("thread/start", {
      model: config.model,
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread id");
    const completion = new Promise<AppTurn>((resolve, reject) => { turnResolve = resolve; turnReject = reject; });
    await request("turn/start", {
      threadId,
      input: [inputText("Reply with the single word OK and nothing else.")],
      cwd: "/tmp",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: config.model,
      effort: config.defaultEffort,
    });
    const turn = await completion;
    if (turn.status !== "completed") throw new Error(`turn ended with status ${turn.status}${turn.error?.message ? `: ${turn.error.message}` : ""}`);
    await request("thread/unsubscribe", { threadId });
    proc.stdin.end();
    await Promise.race([proc.exited, Bun.sleep(3000).then(() => { try { proc.kill(); } catch { /* already gone */ } })]);
    await Promise.all([reader, stderr]);
    if (!reply.trim()) throw new Error("turn completed without an agent message");
    return { reply, usage };
  } catch (error) {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill(); } catch { /* already closed */ }
    await Promise.allSettled([reader, stderr, proc.exited]);
    throw error;
  } finally {
    clearTimeout(killer);
  }
}

async function probeGemini(): Promise<string> {
  const agy = Bun.which("agy");
  if (!agy) throw new Error("agy is not on PATH");
  const proc = Bun.spawn([
    agy, "--print=Reply with the single word OK and nothing else.",
    "--model", (config.gemini ?? geminiConfig()).model,
    "--output-format", "json", "--dangerously-skip-permissions",
    "--print-timeout", "2m", "--add-dir", "/tmp",
  ], { cwd: "/tmp", env: uncoloredChildEnv(), stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, 150_000);
  try {
    const [exitCode, text, err] = await Promise.all([proc.exited, stdout, stderr]);
    if (exitCode !== 0) throw new Error(err.trim() || `agy exited ${exitCode}`);
    let value: any;
    try { value = JSON.parse(text); } catch { throw new Error(`agy returned invalid JSON: ${singleLine(text).slice(0, 160)}`); }
    const reply = value.response ?? value.result?.response ?? value.result ?? value.output;
    if (typeof reply !== "string" || !reply.trim()) throw new Error("agy JSON contained no response");
    return reply.trim();
  } finally {
    clearTimeout(killer);
  }
}

function agentLinkState(name: string, sourceName: "cdx-lane" | "cdx-review"): { source: string; target: string; current: boolean; detail: string } {
  const source = `${REPO_ROOT}/agents/${sourceName}/agent.md`;
  const target = `${HOME}/.gemini/config/agents/${name}/agent.md`;
  if (!existsSync(source)) return { source, target, current: false, detail: `source missing: ${source}` };
  try {
    if (!lstatSync(target).isSymbolicLink()) return { source, target, current: false, detail: `stale copy at ${target}` };
    const linked = readlinkSync(target);
    const resolved = realpathSync(linked.startsWith("/") ? linked : join(target, "..", linked));
    return resolved === realpathSync(source)
      ? { source, target, current: true, detail: target }
      : { source, target, current: false, detail: `stale link at ${target}` };
  } catch {
    return { source, target, current: false, detail: `missing: ${target}` };
  }
}

function installAgentLink(name: string, sourceName: "cdx-lane" | "cdx-review"): void {
  const state = agentLinkState(name, sourceName);
  if (!existsSync(state.source)) return;
  mkdirSync(join(state.target, ".."), { recursive: true });
  try { unlinkSync(state.target); } catch { /* missing */ }
  symlinkSync(state.source, state.target);
}

function parseAgyModels(stdout: string): string[] | undefined {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    const models = parsed?.command?.data?.models;
    if (Array.isArray(models)) {
      return models.map((m: any) => typeof m?.id === "string" ? m.id : "").filter(Boolean);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function checkDoctorGeminiModel(
  good: (message: string) => void,
  warn: (message: string) => void,
  bad: (label: string, detail: string, remedy: string) => void,
): Promise<void> {
  const agy = Bun.which("agy");
  if (!agy) return;
  const configuredModel = (config.gemini ?? geminiConfig()).model;
  const proc = Bun.spawn([agy, "--output-format", "json", "models"], {
    env: uncoloredChildEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch { /* exited */ }
  }, 10_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, stdout]);
    await stderr;
    if (timedOut || proc.signalCode === "SIGKILL") {
      warn("agy models: probe timed out after 10s");
      return;
    }
    if (exitCode !== 0) {
      warn(`agy models: probe exited ${exitCode}`);
      return;
    }
    const slugs = parseAgyModels(text);
    if (!slugs) {
      warn("agy models: probe returned invalid JSON");
      return;
    }
    if (slugs.includes(configuredModel)) {
      good(`agy model: ${configuredModel} available`);
    } else {
      bad("agy model", `configured model "${configuredModel}" not found in agy models`, `check \`agy models\` or update gemini.model in ${CONFIG_PATH}`);
    }
  } catch (error) {
    warn(`agy models: probe failed (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    clearTimeout(timer);
  }
}

async function doctorCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["fix", "probe"]);
  let failures = 0;
  const good = (message: string) => console.log(color.green(message));
  const warn = (message: string) => console.log(color.yellow(message));
  const bad = (label: string, detail: string, remedy: string) => {
    failures += 1;
    console.log(color.red(`FAIL ${label}: ${detail}`));
    console.log(color.yellow(`     remedy: ${remedy}`));
  };

  const codexPath = Bun.which("codex");
  const doctorAccount = primaryAccount();
  const version = codexPath ? Bun.spawnSync({
    cmd: [codexPath, "--version"],
    ...(doctorAccount ? { env: uncoloredChildEnv(doctorAccount.home) } : {}),
  }) : undefined;
  if (version?.success) good(`codex: ${version.stdout.toString().trim()} (${codexPath})`);
  else bad("codex", "CLI not found or not runnable", "reinstall the Codex CLI (`npm i -g @openai/codex` or your install method), then log in with `codex login`");

  const agyPath = Bun.which("agy");
  const agyVersion = agyPath ? Bun.spawnSync({ cmd: [agyPath, "--version"], env: uncoloredChildEnv() }) : undefined;
  if (agyVersion?.success) good(`agy: ${agyVersion.stdout.toString().trim()} (${agyPath})`);
  else if (config.gemini) bad("agy", "CLI not found or not runnable", "install Google Antigravity CLI and make ~/.local/bin/agy available");
  else warn("agy: CLI not found; Gemini lanes are unavailable until it is installed");

  if (agyVersion?.success) {
    const geminiUsage = await refreshGeminiUsage();
    if (geminiUsage) {
      good(`agy usage: weekly ${geminiUsage.weekly.remainingPercent}% remaining, five-hour ${geminiUsage.fiveHour.remainingPercent}% remaining`);
    } else warn("agy usage: unavailable");
    await checkDoctorGeminiModel(good, warn, bad);
  } else {
    warn("agy usage: unavailable");
  }

  const geminiPolicy = config.gemini ?? geminiConfig();
  for (const [name, sourceName] of [[geminiPolicy.agent, "cdx-lane"], [geminiPolicy.reviewAgent, "cdx-review"]] as const) {
    let state = agentLinkState(name, sourceName);
    let installed = false;
    if (!state.current && parsed.bools.has("fix")) {
      installAgentLink(name, sourceName);
      state = agentLinkState(name, sourceName);
      if (state.current) { good(`agy agent ${name}: installed ${state.target}`); installed = true; }
    }
    if (state.current) {
      if (!installed) good(`agy agent ${name}: current (${state.target})`);
    } else if (config.gemini) {
      bad(`agy agent ${name}`, state.detail, `run \`cdx doctor --fix\` to install ${sourceName}`);
    } else {
      warn(`agy agent ${name}: ${state.detail}; run cdx doctor --fix to install`);
    }
  }

  let loggedIn = false;
  if (config.accounts) {
    const entries = Object.entries(config.accounts);
    for (const [index, [name, home]] of entries.entries()) {
      const account = { name, home };
      console.log(color.cyan(`account ${name} (${home.replace(HOME, "~")}):`));
      if (!version?.success) {
        warn("  auth: unavailable");
        warn("  usage: unavailable");
        continue;
      }
      const login = Bun.spawnSync({ cmd: ["codex", "login", "status"], env: uncoloredChildEnv(home) });
      const loginMsg = (login.stdout.toString() + login.stderr.toString()).trim();
      if (index === 0) loggedIn = login.success;
      if (login.success) good(`  auth: ${loginMsg || "ok"}`);
      else {
        bad(`${name} auth`, loginMsg || "not logged in", `run \`CODEX_HOME=${home} codex login\`, then re-run \`cdx doctor\``);
        warn("  usage: unavailable");
        continue;
      }
      const refreshed = await refreshUsageSnapshot({ account });
      if (!refreshed) {
        warn("  usage: unavailable");
        continue;
      }
      const formatted = formatAccountUsage(refreshed.usage);
      if (refreshed.snapshot.reached || formatted.usedPercent >= 95) {
        failures += 1;
        console.log(color.red(`  usage: ${formatted.detail}`));
        console.log(color.yellow("       remedy: limits nearly exhausted; wait for reset or redeem a reset credit in the codex TUI /usage"));
      } else if (formatted.usedPercent >= 75) {
        warn(`  usage: ${formatted.detail}; caution: 25% or less remains`);
      } else {
        good(`  usage: ${formatted.detail}`);
      }
    }
  } else if (version?.success) {
    const login = Bun.spawnSync({ cmd: ["codex", "login", "status"] });
    const loginMsg = (login.stdout.toString() + login.stderr.toString()).trim();
    loggedIn = login.success;
    if (loggedIn) good(`auth: ${loginMsg || "ok"}`);
    else bad("auth", loginMsg || "not logged in", "run `codex login` in a terminal (opens a browser), then re-run `cdx doctor`");
  }

  if (!config.accounts) {
    const refreshed = version?.success && loggedIn ? await refreshUsageSnapshot() : undefined;
    if (!refreshed) {
      warn("usage: unavailable");
    } else {
      const formatted = formatAccountUsage(refreshed.usage);
      if (refreshed.snapshot.reached || formatted.usedPercent >= 95) {
        failures += 1;
        console.log(color.red(`usage: ${formatted.detail}`));
        console.log(color.yellow("     remedy: limits nearly exhausted; wait for reset or redeem a reset credit in the codex TUI /usage"));
      } else if (formatted.usedPercent >= 75) {
        warn(`usage: ${formatted.detail}; caution: 25% or less remains`);
      } else {
        good(`usage: ${formatted.detail}`);
      }
    }
  }

  const primaryHome = (config.accounts && Object.values(config.accounts)[0]) ?? `${HOME}/.codex`;
  const configPath = `${primaryHome}/config.toml`;
  if (existsSync(configPath)) {
    const configModel = readFileSync(configPath, "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    if (configModel === config.model) good(`config: model ${configModel}`);
    else warn(`config: warning: Codex CLI default model is ${configModel ?? "unset"}, but cdx uses ${config.model} from ${CONFIG_PATH}`);
  } else {
    warn(`config: warning: ${configPath} missing; cdx uses model ${config.model} and effort ${config.defaultEffort} from cdx policy`);
  }

  if (!Bun.which("cdx")) bad("path", "cdx not on PATH", `ln -s ${SELF} ~/.local/bin/cdx`);

  const guard = `${SELF.replace(/\/cdx\.ts$/, "")}/hooks/guard-raw-codex.ts`;
  if (!existsSync(guard)) bad("plugin", "guard-raw-codex.ts missing", "restore the hooks/ folder of the cdx plugin");
  else if (!(statSync(guard).mode & 0o111)) bad("plugin", "guard-raw-codex.ts not executable", `chmod +x ${guard}`);
  else good("plugin: guard hook present and executable");
  const monitor = Bun.spawnSync({ cmd: ["pgrep", "-f", `tail -n 0 -F ${ROOT}/feed.log`] });
  if (monitor.success) good("plugin: lane monitor running");
  else warn("plugin: lane monitor not running (it starts with a Claude Code session)");

  good(`ledger: ${LEDGER} (${Object.keys(readLedger()).length} lanes)`);
  if (existsSync(`${ROOT}/.lock`)) warn("warning: ledger lock present (breaks automatically after 30s if stale)");
  const stale = Object.entries(readLedger()).filter(([, entry]) => laneRunning(entry) && !pidAlive(entry.pid));
  for (const [lane, entry] of stale) {
    const orphan = pidAlive(entry.codexPid) ? ` and its codex child (pid ${entry.codexPid}) is STILL RUNNING` : "";
    console.log(color.red(`stale: lane "${lane}" has a running ${entry.kind} round but its runner is dead${orphan}`));
  }
  if (stale.length > 0 && parsed.bools.has("fix")) {
    for (const [lane, entry] of stale) {
      if (pidAlive(entry.codexPid)) {
        try { process.kill(entry.codexPid!, "SIGTERM"); good(`fixed: sent SIGTERM to orphaned codex pid ${entry.codexPid} (lane "${lane}")`); } catch { /* raced */ }
      }
    }
    withLedger((ledger) => {
      for (const [lane] of stale) {
        failActiveRound(lane, ledger[lane]!, "runner died without finalizing; repaired by cdx doctor --fix");
      }
    });
    good(`fixed: marked ${stale.length} stale round(s) failed`);
  } else if (stale.length > 0) {
    warn("run `cdx doctor --fix` to mark them failed (kills orphaned codex children)");
  }

  if (parsed.bools.has("probe")) {
    if (!version?.success || !loggedIn) {
      warn("probe: skipped, fix the failures above first");
    } else {
      console.log(color.cyan("probe: live app-server round-trip, may take about 30s..."));
      const started = Date.now();
      try {
        const result = await probeAppServer(doctorAccount);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        good(`probe: OK in ${secs}s (reply "${result.reply.trim()}", ${result.usage}, thread unsubscribed)`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const remedy = /auth|login|401|unauthorized/i.test(detail) ? "run `codex login`"
          : /model/i.test(detail) ? `model ${config.model} rejected; check \`codex features\` and account access`
          : "check the 0.149.1 app-server schema, network, and `codex login status`";
        bad("probe", detail.slice(0, 240), remedy);
      }
    }
    if (!agyVersion?.success) {
      warn("gemini probe: skipped, agy is unavailable");
    } else {
      console.log(color.cyan("gemini probe: live one-word round-trip..."));
      const started = Date.now();
      try {
        const reply = await probeGemini();
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (reply !== "OK") throw new Error(`expected OK, got ${JSON.stringify(reply)}`);
        good(`gemini probe: OK in ${secs}s (reply "${reply}")`);
      } catch (error) {
        bad("gemini probe", error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240), "run `agy` once to finish sign-in, then re-run `cdx doctor --probe`");
      }
    }
  }

  if (failures > 0) process.exitCode = 1;
}

// Prints nothing when all lanes are settled, so the SessionStart hook costs
// zero context in the common case.
function briefCommand() {
  const byRecency = (a: [string, Lane], b: [string, Lane]) =>
    Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt);
  const entries = Object.entries(readLedger());
  const running = entries.filter(([, entry]) => laneRunning(entry)).sort(byRecency);
  const failed = entries.filter(([, entry]) => !laneRunning(entry) && (entry.state === "failed" || entry.state === "gate-invalid" || entry.reviewState === "failed")).sort(byRecency);
  const lanes = [...running, ...failed];
  if (lanes.length > 0) console.log(lanes.map(([lane, entry]) => renderLaneBlock(lane, entry)).join("\n\n"));
}

// Replay recent feed lines: what completed, stalled, or warned while the
// caller was away (the live monitor only delivers lines to open sessions).
function feedCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["n"]);
  const path = `${ROOT}/feed.log`;
  if (!existsSync(path)) { console.log("cdx: no feed yet"); return; }
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  console.log(readTailLines(path, limit, (line) => line.trim().length > 0).join("\n"));
}

function cleanCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["days"]);
  const days = Number(parsed.flags.days ?? 14);
  const cutoff = Date.now() - days * 86_400_000;
  const removed: string[] = [];
  withLedger((ledger) => {
    for (const [lane, entry] of Object.entries(ledger)) {
      if (entry.state !== "closed" || Date.parse(entry.updatedAt) > cutoff) continue;
      // Anchor on "-r<digits>" plus a separator so lane "foo" never matches
      // "foo-review-r1".
      const escaped = lane.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escaped}-r\\d+(?:\\.|-)`);
      for (const dir of ["logs", "reports", "briefs", "specs", "control", "questions"]) {
        for (const file of readdirSync(`${ROOT}/${dir}`)) {
          if (pattern.test(file)) rmSync(`${ROOT}/${dir}/${file}`, { force: true });
        }
      }
      delete ledger[lane];
      removed.push(lane);
    }
  });
  const feedPath = `${ROOT}/feed.log`;
  if (existsSync(feedPath)) {
    const tail = readTailLines(feedPath, 2000, (line) => line.trim().length > 0);
    writeFileSync(feedPath, tail.length ? `${tail.join("\n")}\n` : "");
  }
  console.log(removed.length > 0 ? `cdx: pruned closed lanes older than ${days}d: ${removed.join(", ")}` : `cdx: nothing to prune (closed lanes older than ${days}d)`);
}

// SIGTERM first: the runner's reap handler kills its codex child and finalizes
// the round itself (signal note, feed line). Only a runner that fails to
// finalize within 10s, or a dead runner with a live codex orphan, gets the
// force path: SIGKILL what remains and finalize the ledger here.
async function killCommand(argv: string[]) {
  const [lane, note] = argv;
  if (!lane) fail('usage: cdx kill <lane> ["note"]');
  const entry = readLane(lane);
  if (!laneRunning(entry)) fail(`lane "${lane}" is not running (latest ${entry.kind} state ${roundStateOf(entry)})`);
  const runnerAlive = pidAlive(entry.pid);
  if (!runnerAlive && !pidAlive(entry.codexPid)) {
    fail(`lane "${lane}" is marked running but its runner and codex child are both dead; run cdx doctor --fix`);
  }
  if (runnerAlive) {
    try { process.kill(entry.pid!, "SIGTERM"); } catch { /* exited between check and kill */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = readLedger()[lane];
      if (current && !laneRunning(current)) {
        if (note) {
          withLedger((ledger) => {
            const item = ledger[lane];
            if (item) {
              if (item.kind === "review") item.reviewNote = item.reviewNote ? `${item.reviewNote}; ${note}` : note;
              else item.note = item.note ? `${item.note}; ${note}` : note;
              item.updatedAt = new Date().toISOString();
            }
          });
        }
        console.log(`cdx: lane=${color.magenta(lane)} stopped; runner finalized ${current.kind} state=${coloredState(roundStateOf(current))}${roundNoteOf(current) ? ` note=${roundNoteOf(current)}` : ""}`);
        return;
      }
      await Bun.sleep(250);
    }
  }
  const current = readLedger()[lane] ?? entry;
  for (const pid of [current.codexPid, current.pid]) {
    if (pidAlive(pid)) { try { process.kill(pid!, "SIGKILL"); } catch { /* exited between check and kill */ } }
  }
  const finalized = withLedger((ledger) => {
    const item = ledger[lane]!;
    failActiveRound(lane, item, note ? `killed: ${note}` : "killed");
    if (item.kind === "review") item.reviewExitCode = undefined;
    else item.exitCode = undefined;
    return item;
  });
  feedOwned(`[cdx] lane=${lane} round=${finalized.rounds} kind=${finalized.kind} state=failed note=${roundNoteOf(finalized)}`, finalized.ownerSession);
  console.log(`cdx: lane=${color.magenta(lane)} killed; ${finalized.kind} state=${coloredState("failed")} note=${roundNoteOf(finalized)}`);
}

const USAGE = `cdx tracks Codex and Gemini execution lanes
cdx policy: model ${config.model}; efforts ${config.efforts.join(", ")}; default effort ${config.defaultEffort}; set in ${CONFIG_PATH}

Engines:
${ENGINE_PICKER}

  spawn  <lane> [--engine gpt|gemini] [--account NAME] [--effort E] [--cd D] [--worktree P] [--bg] [--add-dir D]... [--schema F] [--image F]... [--gate CMD] [--gate-baseline-check] [--max-runtime MIN] "<brief>"
  resume <lane> [--effort E] [--gate CMD] [--bg] [--max-runtime MIN] "<follow-up>"
  fork   <newLane> <fromLane|sessionId> [--account NAME] [--effort E] [--bg] "<brief>"
  review <lane> [--engine gpt|gemini] [--account NAME] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "files"] ["<intent>"]
  adopt  <lane> <sessionId> [--engine gpt|gemini] [--account NAME] [--cd D]
  send   <lane> "<text>"  # steer the active work turn, or start an idle follow-up turn
  ask    [--timeout MIN] "<question>"  # work-lane command; default 30 minutes
  reply  <lane> [--id SEQ] "<answer>"  questions [lane]
  msg    <lane|session-prefix> "<text>"  inbox [-n N]
  status [--json]         wait <lane>... [--timeout S] [--json] [--report]
  usage  [--json]         # per-account plan, rate-limit windows, ledger totals
  tail   <lane> [-n N]    tail -f [lane]           # -f: live transcript; no lane = all running lanes
  feed   [-n N]           # replay recent completion/stall lines
  report <lane> [round]    log <lane> [round]
  gate   <lane> "<cmd>" | gate <lane> --clear
  kill   <lane> ["note"]  # SIGTERM the runner; force-finalize if it hangs
  close  <lane> [--remove-worktree] ["note"]       clean [--days N]
  doctor [--fix] [--probe]
  brief                   # running/failed lanes only; silent when all settled

--bg detaches the lane (survives the parent shell); combine with "cdx wait" for
one blocking call over many lanes. Foreground lanes print the report on exit.
--worktree P creates a git worktree at P on branch lane/<lane> from the repo at
--cd (or the current directory) and runs the lane there. A "-" brief reads stdin.
--gate CMD runs after a green work round (sh -lc, lane cwd); a nonzero exit
fails the round. Work resumes rerun the lane's stored gate; reviews never do.
Worktree spawns check the gate before worker startup. Use --gate-baseline-check
to do the same in a non-worktree spawn. A baseline failure is gate-invalid.
--max-runtime MIN kills the round past the cap and marks it failed.`;

const REFUSED_INSIDE_LANE = new Set([
  "spawn", "resume", "fork", "review", "adopt",
  "kill", "close", "clean", "gate", "reply",
]);

const [command, ...argv] = process.argv.slice(2);
try {
  await dispatch(command, argv);
} catch (err) {
  // CmdError is a user-facing refusal thrown from inside withLedger callbacks,
  // where process.exit would strand the lock. Convert it here, after unlock.
  if (err instanceof CmdError) fail(err.message);
  throw err;
}

export { isAgyCancellationTemplate, houseRules, REVIEW_FINDINGS_SCHEMA };

async function dispatch(command: string | undefined, argv: string[]) {
  if (process.env.CDX_LANE && command && REFUSED_INSIDE_LANE.has(command)) {
    fail(`lane workers cannot drive the harness (command "${command}" refused inside lane ${process.env.CDX_LANE}); use cdx ask for anything you need from the head`);
  }
switch (command) {
  case "spawn": await spawnCommand(argv); break;
  case "review": await reviewCommand(argv); break;
  case "resume": await resumeCommand(argv); break;
  case "fork": await forkCommand(argv); break;
  case "send": sendCommand(argv); break;
  case "ask": await askCommand(argv); break;
  case "reply": replyCommand(argv); break;
  case "questions": questionsCommand(argv); break;
  case "msg": msgCommand(argv); break;
  case "inbox": inboxCommand(argv); break;
  case "_run": {
    const [lane, round] = argv;
    if (!lane || !round) fail("internal: _run <lane> <round>");
    process.exit(await runRound(lane, Number(round)));
  }
  case "adopt": {
    const parsed = parseArgs(argv, ["engine", "cd", "account"]);
    const engine = engineOf(parsed, "adopt");
    const [lane, sessionId] = parsed.rest;
    if (!lane || !sessionId) fail("usage: cdx adopt <lane> <sessionId> [--engine gpt|gemini] [--cd <dir>]");
    validLane(lane);
    requireEngineBinary(engine);
    if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
    const account = engine === "gpt" ? primaryAccount(parsed.flags.account) : undefined;
    const owner = callerOwnership();
    const now = new Date().toISOString();
    withLedger((ledger) => {
      ledger[lane] = {
        engine,
        ...(account ? { account: account.name, codexHome: account.home } : {}),
        ...owner,
        sessionId, workSessionId: sessionId, cwd: parsed.flags.cd ?? process.cwd(), workCwd: parsed.flags.cd ?? process.cwd(), effort: engine === "gemini" ? "high" : config.defaultEffort,
        state: "adopted", workState: "adopted", kind: "work", rounds: ledger[lane]?.rounds ?? 0,
        reports: ledger[lane]?.reports ?? [], createdAt: ledger[lane]?.createdAt ?? now, updatedAt: now, workUpdatedAt: now,
      };
    });
    console.log(`cdx: adopted lane=${lane} session=${sessionId}`);
    break;
  }
  case "status": statusCommand(argv); break;
  case "gate": gateCommand(argv); break;
  case "usage": await usageCommand(argv); break;
  case "wait": await waitCommand(argv); break;
  case "feed": feedCommand(argv); break;
  case "tail": {
    const parsed = parseArgs(argv, ["n", "follow"]);
    const [lane] = parsed.rest;
    if (parsed.bools.has("follow")) {
      await (lane ? followLane(lane) : followAll());
      break;
    }
    if (!lane) fail("usage: cdx tail <lane> [-n <lines>] | cdx tail -f [lane]");
    console.log(renderTail(latestRoundLog(lane), Number(parsed.flags.n ?? 30)));
    break;
  }
  case "report": {
    const [lane, roundArg] = argv;
    if (!lane) fail("usage: cdx report <lane> [round]");
    const entry = readLane(lane);
    const path = roundArg ? reportPathOf(lane, Number(roundArg)) : entry.reports.at(-1);
    if (!path || !existsSync(path)) fail(`no report for lane "${lane}"`);
    console.log(readFileSync(path, "utf8"));
    break;
  }
  case "log": {
    const parsed = parseArgs(argv, ["transcript"]);
    const [lane, roundArg] = parsed.rest;
    if (!lane) fail("usage: cdx log <lane> [round] [--transcript]");
    const entry = readLane(lane);
    if (parsed.bools.has("transcript")) {
      let transcriptPath = entry.transcriptPath;
      if (roundArg) {
        const roundNum = Number(roundArg);
        const roundLog = logPathOf(lane, roundNum, true);
        if (existsSync(roundLog)) {
          const rawLog = readFileSync(roundLog, "utf8");
          for (const line of rawLog.split("\n")) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (typeof event.conversation_id === "string" && event.conversation_id) {
                transcriptPath = geminiTranscriptPath(event.conversation_id);
                break;
              }
            } catch { /* continue scanning */ }
          }
        }
      }
      if (!transcriptPath || !existsSync(transcriptPath)) {
        fail(`no transcript for lane "${lane}"`);
      }
      const raw = readFileSync(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const content = typeof record.content === "string"
            ? record.content
            : record.content != null
            ? JSON.stringify(record.content)
            : "";
          const preview = singleLine(content).slice(0, 200);
          console.log(`#${record.step_index} ${record.type} ${record.status}${preview ? ` ${preview}` : ""}`);
        } catch { /* skip invalid lines */ }
      }
      break;
    }
    if (roundArg) {
      for (const json of [true, false]) {
        const path = logPathOf(lane, Number(roundArg), json);
        if (existsSync(path)) { console.log(path); process.exit(0); }
      }
      fail(`no log for lane "${lane}" round ${roundArg}`);
    }
    console.log(latestRoundLog(lane));
    break;
  }
  case "close": {
    const parsed = parseArgs(argv, ["remove-worktree"]);
    const [lane, note] = parsed.rest;
    if (!lane) fail('usage: cdx close <lane> [--remove-worktree] ["note"]');
    const entry = readLane(lane);
    if (laneRunning(entry) && (pidAlive(entry.pid) || pidAlive(entry.codexPid))) fail(`lane "${lane}" is running; kill it first`);
    withLedger((ledger) => {
      const item = ledger[lane]!;
      item.state = "closed";
      item.workState = "closed";
      if (note) item.note = note;
      item.updatedAt = new Date().toISOString();
    });
    console.log(`cdx: closed lane=${lane}`);
    // Default: never auto-remove, the branch may be unmerged. --remove-worktree
    // deletes only a merged branch with a clean worktree; otherwise it refuses.
    if (entry.worktreePath && existsSync(entry.worktreePath)) {
      if (parsed.bools.has("remove-worktree")) removeWorktree(entry);
      else printWorktreeCleanup(entry);
    }
    break;
  }
  case "kill": await killCommand(argv); break;
  case "clean": cleanCommand(argv); break;
  case "doctor": await doctorCommand(argv); break;
  case "brief": briefCommand(); break;
  case "help": case "--help": case "-h": case undefined: console.log(USAGE); break;
  default:
    fail(`unknown command "${command}"\n${USAGE}`);
}
}
