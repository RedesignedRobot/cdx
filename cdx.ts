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
//   cdx status [--all] [--json] [--brief] [--watch [--interval S]]
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
import { VISIBILITY_DEFAULTS, roundProgress, toolObservation, digestLines, heartbeatDue, type VisibilityConfig, type ProgressSample } from "./visibility.ts";
import { syncAccountHomes } from "./account-sync.ts";
import { isatty } from "node:tty";
import { isAbsolute, join, relative, resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const ROOT = (process.argv[2] === "_run" || process.argv[2] === "_job" ? process.env.CDX_STATE_HOME : undefined)
  || process.env.CDX_HOME || `${HOME}/.cdx`;
const LEDGER = `${ROOT}/ledger.json`;
const CONFIG_PATH = `${ROOT}/config.json`;
const USAGE_PATH = `${ROOT}/usage.json`;
const GEMINI_USAGE_PATH = `${ROOT}/usage-gemini.json`;
const GEMINI_QUOTA_PATH = `${ROOT}/gemini-quota.json`;
const GEMINI_TRANSPORT_RETRIES = 5;
const GEMINI_TRANSPORT_ERRORS = [/stream was interrupted/i, /timeout waiting for response/i];
const SELF = import.meta.path;
const REPO_ROOT = SELF.replace(/\/cdx\.ts$/, "");
const VERSION = "6.4.0";

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
  supervisor?: boolean;
}

// A supervisor lane carries CDX_SUPERVISOR=<its own name>; every other lane,
// a supervisor's children included, has it removed so delegation stays one
// level deep.
function laneChildEnv(codexHome: string | undefined, context: LaneEnvironment, engine: Engine = "gpt") {
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
function runnerEnv(codexHome: string | undefined) {
  const env: Record<string, string | undefined> = uncoloredChildEnv(codexHome, ROOT);
  delete env.CDX_LANE;
  delete env.CDX_ROUND;
  delete env.CDX_SUPERVISOR;
  return env;
}

// Inside a supervisor lane both variables name the same lane. Anything else
// (a child, a plain worker, the head's shell) is not a supervisor. The claim
// is then checked against the ledger: the lane must be a running supervisor
// on the round the environment names, so a shell left over from an earlier
// round loses its authority instead of keeping it. This catches mistakes,
// not attackers: both engines hold shell access and could edit the ledger.
function supervisorLane(): string | undefined {
  const lane = process.env.CDX_LANE?.trim();
  const supervisor = process.env.CDX_SUPERVISOR?.trim();
  if (!lane || supervisor !== lane) return undefined;
  const entry = readLedger()[lane];
  const round = Number(process.env.CDX_ROUND);
  if (!entry?.supervisor || entry.kind !== "work" || !laneRunning(entry) || entry.rounds !== round) {
    fail(`supervisor identity "${lane}" round ${process.env.CDX_ROUND ?? "?"} does not match a running supervisor round in the ledger; this shell belongs to an earlier or unknown round`);
  }
  return supervisor;
}

// One ownership policy for every mutation a supervisor may issue: it may
// touch only lanes it spawned. Heads must hold the resolved ownership.
function requireOwnChild(lane: string, entry: Lane | undefined): void {
  const supervisor = supervisorLane();
  if (!entry) return;
  if (!owned(entry.ownerSession, lane)) fail(`lane "${lane}" belongs to another session; use cdx takeover ${lane} first`);
  if (supervisor && entry.parent !== supervisor) fail(`supervisor ${supervisor} may only drive its own children; lane "${lane}" is not one`);
}

interface Lineage { supervisor: boolean; parent?: string; parentRound?: number }

// Lineage of a lane spawned from the current shell: a supervisor's children
// record the supervisor and its round so cleanup can find them later.
function callerLineage(supervisor: boolean): Lineage {
  const parent = supervisorLane();
  const parentRound = Number(process.env.CDX_ROUND);
  return { supervisor, ...(parent ? { parent, parentRound } : {}) };
}

type Effort = string;
type Engine = "gpt" | "gemini";
type Mode = "spawn" | "resume" | "fork" | "review-exec" | "review-native";

interface GeminiConfig {
  model: string;
  agent: string;
  reviewAgent: string;
  maxRounds: number;
  maxRuntimeMins: number;
}

interface Config {
  visibility?: VisibilityConfig;
  model: string;
  models?: Record<string, string>;
  efforts: string[];
  defaultEffort: string;
  rules: string[];
  accounts?: Record<string, string>;
  // Highest effort a Codex model may run at, by model id. Astra is capped at
  // medium by default because high and above burn the weekly window on churn.
  effortCaps: Record<string, string>;
  worktreeSetup?: string;
  gemini?: GeminiConfig;
}

// Codex reasoning efforts from cheapest to most expensive; effortCaps compare
// against this order.
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_EFFORT_CAPS: Record<string, string> = { "gpt-6-astra": "medium" };

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

interface RoundRecord<S extends WorkState = WorkState> {
  exitCode?: number;
  note?: string;
  state: S;
  round?: number;
  cwd: string;
  report?: string;
  updatedAt?: string;
}

interface Lane {
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
  effort: Effort;
  roundAccount?: AccountChoice & { demand: Demand };
  quotaFailure?: string;
  switchingAccount?: true;
  kind: "work" | "review";
  rounds: number;
  workRounds?: number;
  reports: string[];
  tokens?: Tokens;
  roundTokens?: Tokens;
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

interface Spec {
  visibility?: VisibilityConfig;
  effort: Effort;
  engine: Engine;
  mode: Mode;
  lane: string;
  round: number;
  cwd: string;
  prompt: string;
  model?: string;
  codexArgs?: string[];
  sourceThreadId?: string;
  sourceLane?: string;
  additionalDirectories?: string[];
  images?: string[];
  outputSchema?: unknown;
  account?: string;
  codexHome?: string;
  accountHomes?: Record<string, string>;
  taskPrompt?: string;
  ownerSession?: string;
  ownerCwd?: string;
  gate?: string;
  gateBaselineChecked?: true;
  reviewDir?: string;
  maxRuntimeMins?: number;
  supervisor?: true;
  // agy agent name, pinned at launch so the detached runner cannot drift.
  agent?: string;
}

type Ledger = Record<string, Lane>;

function coloredState(state: string, text = state): string {
  if (state === "running") return color.yellow(text);
  if (state === "running(dead?)" || state === "failed" || state === "gate-invalid") return color.red(text);
  if (state === "done") return color.green(text);
  if (state === "closed") return color.dim(text);
  return text;
}

class CmdError extends Error {}

function fail(message: string): never {
  throw new CmdError(message);
}

function configError(message: string): never {
  fail(`${CONFIG_PATH}: ${message}`);
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

function parseConfig(text: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    configError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    configError("config must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set(["model", "models", "efforts", "defaultEffort", "rules", "accounts", "effortCaps", "worktreeSetup", "gemini", "visibility"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) configError(`unknown config key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

  const defaults: Config = {
    model: "gpt-6-astra",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    rules: [],
    effortCaps: DEFAULT_EFFORT_CAPS,
    gemini: geminiConfig(),
  };

  const model = Object.hasOwn(input, "model") ? input.model : defaults.model;
  if (typeof model !== "string" || model.trim().length === 0) configError("model must be a nonempty string");

  let models: Record<string, string> | undefined;
  if (Object.hasOwn(input, "models")) {
    const value = input.models;
    if (value === null || typeof value !== "object" || Array.isArray(value)) configError("models must be an object mapping aliases to Codex model ids");
    for (const [alias, id] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) configError(`models: alias "${alias}" must be lowercase letters, digits, and dashes`);
      if (typeof id !== "string" || !MODEL_ID.test(id)) configError(`models.${alias} must be a Codex model id`);
    }
    models = { ...(value as Record<string, string>) };
  }

  const efforts = Object.hasOwn(input, "efforts") ? input.efforts : defaults.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) configError("efforts must be a nonempty array of strings");
  if (efforts.some((effort) => typeof effort !== "string" || effort.trim().length === 0)) {
    configError("efforts must contain only nonempty strings");
  }
  if (new Set(efforts).size !== efforts.length) configError("efforts must not contain duplicates");
  if (efforts.some((effort) => !EFFORT_ORDER.includes(effort))) configError(`efforts must be among ${EFFORT_ORDER.join(", ")}`);

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
      if (!isAbsolute(home)) configError(`accounts.${name} must be an absolute path or start with ~/`);
      const canonicalHome = resolve(home);
      if (parsedAccounts.some(([, configuredHome]) => configuredHome === canonicalHome)) configError(`accounts.${name} repeats a configured Codex home; each home is one account`);
      parsedAccounts.push([name, canonicalHome]);
    }
    accounts = Object.fromEntries(parsedAccounts);
  }

  let effortCaps: Record<string, string> = defaults.effortCaps;
  if (Object.hasOwn(input, "effortCaps")) {
    const value = input.effortCaps;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      configError("effortCaps must be an object mapping Codex model ids to the highest allowed effort");
    }
    effortCaps = { ...DEFAULT_EFFORT_CAPS };
    for (const [modelId, cap] of Object.entries(value as Record<string, unknown>)) {
      if (!MODEL_ID.test(modelId)) configError(`effortCaps key "${modelId}" is not a Codex model id`);
      if (typeof cap !== "string" || !EFFORT_ORDER.includes(cap)) {
        configError(`effortCaps.${modelId} must be one of ${EFFORT_ORDER.join(", ")}`);
      }
      // A built-in cap is an owner ruling; config may lower it, never raise it.
      const builtIn = DEFAULT_EFFORT_CAPS[modelId];
      if (builtIn && EFFORT_ORDER.indexOf(cap) > EFFORT_ORDER.indexOf(builtIn)) {
        configError(`effortCaps.${modelId} cannot exceed the built-in cap ${builtIn}`);
      }
      effortCaps[modelId] = cap;
    }
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
    const geminiAllowed = new Set(["model", "agent", "reviewAgent", "maxRounds", "maxRuntimeMins"]);
    const unknownGemini = Object.keys(geminiInput).filter((key) => !geminiAllowed.has(key));
    if (unknownGemini.length > 0) {
      configError(`unknown gemini key${unknownGemini.length === 1 ? "" : "s"}: ${unknownGemini.join(", ")}`);
    }
    const defaults = geminiConfig();
    const values = {
      model: Object.hasOwn(geminiInput, "model") ? geminiInput.model : defaults.model,
      agent: Object.hasOwn(geminiInput, "agent") ? geminiInput.agent : defaults.agent,
      reviewAgent: Object.hasOwn(geminiInput, "reviewAgent") ? geminiInput.reviewAgent : defaults.reviewAgent,
      maxRounds: Object.hasOwn(geminiInput, "maxRounds") ? geminiInput.maxRounds : defaults.maxRounds,
      maxRuntimeMins: Object.hasOwn(geminiInput, "maxRuntimeMins") ? geminiInput.maxRuntimeMins : defaults.maxRuntimeMins,
    };
    for (const key of ["model", "agent", "reviewAgent"] as const) {
      const field = values[key];
      if (typeof field !== "string" || field.trim().length === 0) configError(`gemini.${key} must be a nonempty string`);
    }
    if (!Number.isInteger(values.maxRounds) || (values.maxRounds as number) < 1) {
      configError("gemini.maxRounds must be a positive integer");
    }
    if (typeof values.maxRuntimeMins !== "number" || !Number.isFinite(values.maxRuntimeMins) || values.maxRuntimeMins <= 0) {
      configError("gemini.maxRuntimeMins must be a positive number of minutes");
    }
    gemini = values as GeminiConfig;
  }

  const visibility = { ...VISIBILITY_DEFAULTS };
  if (Object.hasOwn(input, "visibility")) {
    const values = input.visibility;
    if (!values || typeof values !== "object" || Array.isArray(values)) configError("visibility must be an object");
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(visibility, key)) configError(`unknown visibility key: ${key}`);
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0
        || (key !== "heartbeatMinutes" && !Number.isSafeInteger(value))) configError(`visibility.${key} must be a positive ${key === "heartbeatMinutes" ? "number" : "integer"}`);
      visibility[key as keyof VisibilityConfig] = value as number;
    }
  }

  return {
    visibility,
    model, ...(models ? { models } : {}), efforts: efforts as string[], defaultEffort, rules: rules as string[],
    ...(accounts ? { accounts } : {}), effortCaps, ...(worktreeSetup ? { worktreeSetup } : {}), gemini: gemini ?? defaults.gemini,
  };
}

function readConfig(skipFile = false): Config {
  const defaults: Config = {
    model: "gpt-6-astra",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    rules: [],
    effortCaps: DEFAULT_EFFORT_CAPS,
    gemini: geminiConfig(),
  };
  if (skipFile || !existsSync(CONFIG_PATH)) return defaults;

  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    configError(`cannot read config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(text!);
}

function geminiConfig(): GeminiConfig {
  return {
    model: "gemini-3.8-flash-high",
    agent: "cdx-lane",
    reviewAgent: "cdx-review",
    maxRounds: 2,
    maxRuntimeMins: 90,
  };
}

// Pure tests import defaults without reading or writing user state. The
// CLI reads the config file except on the paths that pin what they need.
const config: Config = import.meta.main
  ? readConfigForCommand(process.argv[2])
  : readConfig(true);

// The plugin monitor must keep delivering wake events when config.json is
// broken, so `watch` falls back to the defaults and says so once on stderr.
function readConfigForCommand(command: string | undefined): Config {
  const pinned = command === "_run" || command === "view" || command === "hook" || command === "_session";
  if (command !== "watch") return readConfig(pinned);
  try { return readConfig(false); }
  catch (error) {
    process.stderr.write(`cdx watch: ${error instanceof Error ? error.message : String(error)}; using default visibility settings\n`);
    return readConfig(true);
  }
}

if (import.meta.main) {
  const isHookInvocation = process.argv[2] === "hook";
  if (!isHookInvocation && process.argv[2] !== "view" && process.argv[2] !== "status") {
    for (const dir of ["logs", "reports", "briefs", "specs", "control", "questions"]) {
      try {
        mkdirSync(`${ROOT}/${dir}`, { recursive: true });
      } catch { /* ignore if read-only or raced */ }
    }
  }
}


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

type EventKind = "started" | "question" | "stalled" | "active" | "partial" | "account" | "progress" | "terminal" | "job-exit" | "message" | "thrash" | "gate-started" | "gate-finished" | "report-written";
interface FeedEvent {
  id: number;
  timestamp: string;
  kind: EventKind;
  owner: string;
  recipient?: string;
  from?: string;
  lane?: string;
  round?: number;
  job?: string;
  message: string;
}
interface SessionDelivery {
  wake: number;
  quiet: number;
  lease?: { pid: number; claudePid: number };
  plugin?: { root: string; version: string; hooks: string; observed: string[] };
}
interface SessionState {
  sequence: number;
  bindings: Record<string, string>;
  lanes: Record<string, string>;
  sessions: Record<string, SessionDelivery>;
  heads: Record<string, string>;
}
const SESSION_STATE = `${ROOT}/sessions.json`;
const WAKE_EVENTS = new Set<EventKind>(["question", "stalled", "terminal", "job-exit", "message", "thrash"]);
function readSessions(): SessionState {
  return { sequence: 0, bindings: {}, lanes: {}, sessions: {}, heads: {}, ...(existsSync(SESSION_STATE) ? JSON.parse(readFileSync(SESSION_STATE, "utf8")) : {}) };
}
function withEvents<T>(action: (state: SessionState) => T, persist = true): T {
  if (!persist && !existsSync(ROOT)) return action(readSessions());
  mkdirSync(ROOT, { recursive: true });
  return withLockedJson(SESSION_STATE, `${ROOT}/.events.lock`, readSessions, action, persist);
}
function recipientOf(owner: string | undefined, lane?: string, state = readSessions()): string {
  const token = state.lanes[lane ?? ""] ?? owner ?? "terminal";
  return state.bindings[token] ?? token;
}
function callerSession(): string {
  // A worker's inherited owner wins even when it is explicitly terminal.
  const owner = (process.env.CDX_LANE ? process.env.CDX_OWNER?.trim() : undefined)
    || process.env.CLAUDE_CODE_SESSION_ID?.trim() || "terminal";
  return process.env.CDX_LANE ? recipientOf(owner, process.env.CDX_LANE) : owner;
}
function owned(owner?: string, lane?: string, session = callerSession(), state = readSessions()): boolean {
  return recipientOf(owner, lane, state) === session;
}
function parseFeedEvent(line: string): FeedEvent | undefined {
  try {
    const event = JSON.parse(line);
    if (Number.isSafeInteger(event.id) && event.id > 0 && typeof event.timestamp === "string"
      && typeof event.owner === "string" && typeof event.message === "string"
      && ["started", "question", "stalled", "active", "partial", "account", "progress", "terminal", "job-exit", "message", "thrash", "gate-started", "gate-finished", "report-written"].includes(event.kind)) return event;
  } catch { /* Version 5 free-text records are deliberately ignored. */ }
}
function readEvents(): FeedEvent[] {
  if (!existsSync(`${ROOT}/feed.log`)) return [];
  return readFileSync(`${ROOT}/feed.log`, "utf8").split("\n").flatMap((line) => {
    const event = parseFeedEvent(line);
    return event ? [event] : [];
  });
}
function renderEvent(event: FeedEvent): string {
  if (event.kind === "message") return `[cdx] msg to=${event.recipient} from=${event.from}: ${event.message}`;
  return `${event.message} owner=${event.owner}`;
}
function eventOwned(event: FeedEvent, session: string, state: SessionState): boolean {
  return recipientOf(event.recipient ?? event.owner, event.lane, state) === session;
}
function feedEvent(kind: EventKind, message: string, owner?: string, identity: { lane?: string; round?: number; job?: string; recipient?: string; from?: string } = {}): void {
  return withEvents((state) => {
    // Recover sequence after a crash between append and state rename.
    const records = readEvents();
    state.sequence = Math.max(state.sequence, records.at(-1)?.id ?? 0);
    if (kind === "terminal" && records.some((event) => event.kind === kind && event.lane === identity.lane && event.round === identity.round)) return;
    if (kind === "partial" && records.some((event) => event.kind === kind && event.lane === identity.lane && event.round === identity.round)) return;
    const event: FeedEvent = { id: ++state.sequence, timestamp: new Date().toISOString(), kind, owner: owner || "terminal", ...identity, message: kind === "progress" ? message.split("\n").map(singleLine).join("\n") : singleLine(message) };
    appendFileSync(`${ROOT}/feed.log`, `${JSON.stringify(event)}\n`);
  });
}
function scopedEvents(limit: number, session = callerSession(), messagesOnly = false): string[] {
  return withEvents((state) => readEvents().filter((event) => eventOwned(event, session, state)
    && (!messagesOnly || event.kind === "message")).slice(-limit).map(renderEvent), false);
}
function delivery(state: SessionState, session: string): SessionDelivery {
  return state.sessions[session] ??= { wake: 0, quiet: 0 };
}
function deliverEvents(session: string, channel: "wake" | "quiet", emit: (text: string) => void, leasePid?: number): void {
  withEvents((state) => {
    const cursor = delivery(state, session);
    if (leasePid !== undefined && cursor.lease?.pid !== leasePid) fail("watcher lease was replaced");
    const records = readEvents();
    const events = records.filter((event) => event.id > cursor[channel] && eventOwned(event, session, state)
      && WAKE_EVENTS.has(event.kind) === (channel === "wake"));
    if (events.length) emit(events.map(renderEvent).join("\n"));
    // Persist only after stdout succeeds. A crash may replay, never acknowledge early.
    cursor[channel] = Math.max(cursor[channel], records.at(-1)?.id ?? 0);
  });
}
async function watchCommand(argv: string[]): Promise<void> {
  const claudePid = Number(process.env.CLAUDE_PID);
  if (argv.length || !Number.isInteger(claudePid) || claudePid < 1) fail("cdx watch needs CLAUDE_PID from the plugin monitor, with no arguments");
  // The monitor's own CLAUDE_CODE_SESSION_ID is a child id. The head's id is
  // the session hook receipt keyed by the Claude process; /clear changes it.
  const headSession = () => readSessions().heads[String(claudePid)];
  let held: string | undefined;
  let digestSession: string | undefined;
  let lastDigest = Date.now();
  let previousProgress: ProgressSample[] = [];
  const release = () => withEvents((state) => {
    if (held && state.sessions[held]?.lease?.pid === process.pid) delete state.sessions[held]!.lease;
    held = undefined;
  });
  // A live holder keeps the lease; this watcher stands by and takes over
  // when the holder exits (a plugin reload starts the new monitor first).
  const acquire = (session: string) => withEvents((state) => {
    const current = delivery(state, session);
    if (current.lease?.pid === process.pid) return true;
    if (current.lease && pidAlive(current.lease.pid) && pidAlive(current.lease.claudePid)) return false;
    current.lease = { pid: process.pid, claudePid };
    return true;
  });
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    while (!stopped && pidAlive(claudePid)) {
      const session = headSession();
      if (held && session !== held) release();
      if (session && acquire(session)) {
        held = session;
        const now = Date.now();
        if (digestSession !== session) {
          digestSession = session;
          lastDigest = now;
          previousProgress = [];
        }
        if (heartbeatDue(now, lastDigest, (config.visibility ?? VISIBILITY_DEFAULTS).heartbeatMinutes)) {
          const samples = sessionProgress(session, now);
          if (samples.length) feedEvent("progress", `[cdx] progress\n${digestLines(samples, previousProgress).join("\n")}`, session);
          previousProgress = samples;
          lastDigest = now;
        }
        deliverEvents(session, "wake", (text) => writeFileSync(1, `${text}\n`), process.pid);
      }
      await Bun.sleep(500);
    }
  } finally {
    release();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
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

function summaryJobs(jobs: Jobs): [string, Job][] {
  const entries = Object.entries(jobs).sort((a, b) => b[1].startedAt.localeCompare(a[1].startedAt));
  return [...entries.filter(([, job]) => jobRunning(job)), ...entries.filter(([, job]) => !jobRunning(job)).slice(0, FINISHED_SHOWN)];
}

function sessionSummary(session: string): string {
  const state = readSessions();
  const ledger = readLedger();
  const lines = Object.entries(ledger).filter(([lane, entry]) => owned(entry.ownerSession, lane, session, state)
    && entry.work.state !== "closed").sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
    .map(([lane, entry]) => `lane=${lane} round=${entry.rounds} kind=${entry.kind} state=${roundStateOf(entry)} report=${roundReportOf(entry) ?? "-"}${laneRunning(entry) ? "" : " awaiting attention; close when handled"}`);
  for (const { record } of questionFiles()) {
    const entry = ledger[record.lane];
    if (entry && entry.rounds === record.round && questionOpen(record) && owned(entry.ownerSession, record.lane, session, state)) {
      lines.push(`lane=${record.lane} r${record.round} QUESTION #${record.seq}: ${record.question}; cdx reply ${record.lane} --id ${record.seq} "<answer>"`);
    }
  }
  const jobs = Object.fromEntries(Object.entries(readJobs()).filter(([, job]) => owned(job.ownerSession, undefined, session, state)));
  for (const [name, job] of summaryJobs(jobs)) lines.push(renderJobLine(name, job));
  return lines.join("\n");
}
async function sessionCommand(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text());
  if (typeof input.session_id !== "string" || !input.session_id.trim() || input.session_id === "terminal") fail("session hook needs session_id");
  if (input.agent_id) return;
  const event = input.hook_event_name;
  if (!["SessionStart", "PostToolBatch", "UserPromptSubmit"].includes(event)) fail("unsupported session hook event");
  const session = input.session_id.trim();
  withEvents((state) => {
    if (process.env.CLAUDE_PID) state.heads[process.env.CLAUDE_PID] = session;
    const current = delivery(state, session);
    const hooks = createHash("sha256").update(readFileSync(`${REPO_ROOT}/hooks/hooks.json`)).digest("hex");
    const observed = current.plugin?.version === VERSION && current.plugin.hooks === hooks ? current.plugin.observed : [];
    current.plugin = { root: realpathSync(REPO_ROOT), version: VERSION, hooks, observed: [...new Set([...observed, event])] };
  });
  const summary = event === "SessionStart" ? sessionSummary(session) : "";
  let emitted = false;
  deliverEvents(session, "quiet", (delta) => {
    emitted = true;
    const additionalContext = [summary, delta].filter(Boolean).join("\n");
    writeFileSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }) + "\n");
  });
  if (summary && !emitted) {
    writeFileSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: summary } }) + "\n");
  }
}
function takeoverCommand(argv: string[]): void {
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
    cursor.wake = Math.max(cursor.wake, latest);
    cursor.quiet = Math.max(cursor.quiet, latest);
  }));
  console.log(`cdx: ownership connected to session=${session}; target=${target}`);
  const summary = sessionSummary(session);
  if (summary) console.log(summary);
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

function readLedger(): Ledger {
  if (!existsSync(LEDGER)) return {};
  const document = JSON.parse(readFileSync(LEDGER, "utf8"));
  if (document && typeof document === "object" && Object.keys(document).length === 0) return {};
  const current = document?.version === 5;
  if (!current && (existsSync(LEDGER_VERSION_PATH) || typeof document?.version === "number")) {
    throw new CmdError("unsupported ledger shape after migration to 5.0; stop older cdx writers and restore the version 5 ledger");
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
  return ledger;
}

function withLedger<T>(mutate: (ledger: Ledger) => T): T {
  return withLockedJson(LEDGER, `${ROOT}/.lock`,
    () => ({ version: 5, lanes: readLedger() }),
    (document) => {
      if (!existsSync(LEDGER_VERSION_PATH)) writeFileSync(LEDGER_VERSION_PATH, "5\n");
      return mutate(document.lanes);
    });
}

// Read-mutate-write one JSON state file under a mkdir lock, written through a
// temp file so a reader never sees a torn document.
function withLockedJson<S, T>(path: string, lock: string, read: () => S, mutate: (state: S) => T, persist = true): T {
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
      const serialized = JSON.stringify(state, null, 2);
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

function readLane(lane: string): Lane {
  const entry = readLedger()[lane];
  if (!entry) fail(`unknown lane "${lane}" (cdx status lists lanes)`);
  return entry;
}

function workCwdOf(entry: Lane): string {
  return entry.work.cwd;
}

function workStateOf(entry: Lane): WorkState {
  return entry.work.state;
}

function activeStateOf(entry: Lane): WorkState | ReviewState {
  if (entry.switchingAccount) return "running";
  return entry.kind === "review" ? entry.review!.state : entry.work.state;
}

function laneRunning(entry: Lane): boolean {
  return activeStateOf(entry) === "running";
}

function roundStateOf(entry: Lane): WorkState | ReviewState {
  return activeStateOf(entry);
}

function roundExitCodeOf(entry: Lane): number | undefined {
  return entry.kind === "review" ? entry.review?.exitCode : entry.work.exitCode;
}

function roundNoteOf(entry: Lane): string | undefined {
  return entry.kind === "review" ? entry.review?.note : entry.work.note;
}

function roundReportOf(entry: Lane): string | undefined {
  return entry.kind === "review" ? entry.review?.report : entry.work.report;
}

function validLane(lane: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(lane)) fail(`lane name "${lane}" must be alphanumeric with . _ - only`);
  return lane;
}

const reportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.md`;
const partialReportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.partial.md`;

function availableReportPath(lane: string, round: number): string | undefined {
  return [reportPathOf(lane, round), partialReportPathOf(lane, round)]
    .find((path) => existsSync(path) && readFileSync(path, "utf8").trim().length > 0);
}
const logPathOf = (lane: string, round: number, json: boolean) => `${ROOT}/logs/${lane}-r${round}.${json ? "jsonl" : "log"}`;
const specPathOf = (lane: string, round: number) => `${ROOT}/specs/${lane}-r${round}.json`;
const controlPathOf = (lane: string, round: number) => `${ROOT}/control/${lane}-r${round}.jsonl`;
const deliveredPathOf = (lane: string, round: number) => `${ROOT}/control/${lane}-r${round}.delivered`;

function readDeliveredCount(lane: string, round: number): number {
  const path = deliveredPathOf(lane, round);
  try {
    const text = readFileSync(path, "utf8").trim();
    const count = Number(text);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

function writeDeliveredCount(lane: string, round: number, count: number): void {
  const path = deliveredPathOf(lane, round);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${count}\n`);
}

function geminiTranscriptPath(conversationId: string): string {
  return `${HOME}/.gemini/antigravity-cli/brain/${conversationId}/.system_generated/logs/transcript_full.jsonl`;
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
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
// Every rule names the mechanism behind it. A model that knows why a rule
// exists keeps it in the cases the rule did not foresee; a bare prohibition
// gets rationalized away the first time it is inconvenient.
// ---------------------------------------------------------------------------

const LANE_ROLE = "The Claude session is the owner's liaison. It briefs outcomes, answers questions, reviews, and merges. Your final report is its handoff.";
const WORK_LIMITS = "Never commit, push, deploy, or start long-running servers beyond what tests start. The liaison integrates after independent review.";
const READ_ONLY = "READ-ONLY: change nothing in the tree; write only your report. The runtime sandbox or before-and-after tree check enforces this.";
const WORK_REPORT = "A final report is required. Lead with the outcome, then changed files and remaining risks. Include child outcomes and report paths. Use plain prose and short lists. No em dashes, filler, or praise.";
const REVIEW_REPORT = "A final report is required. State the conclusion and evidence in plain prose and short lists. No em dashes or filler.";
const ASK_RULE = 'Use `cdx ask "<question>"` only for a missing answer that changes the outcome or authorization. Read available evidence first. A timeout is not approval: continue independent authorized work, stop dependent work, and report the unanswered question.';
const WORKER_BAN = "This worker cannot drive other cdx lanes or jobs. Use cdx ask for dependencies that need the supervisor or liaison.";
const STANDARD_RULE = "Read the source, fix causes, and choose the simplest design that meets the outcome. Delete unnecessary code and tests.";
const CHALLENGE_RULE = "You own technical judgment. If the brief solves the wrong problem, explain the evidence through cdx ask before changing scope. Report unresolved disagreement.";

const TOKEN_ECONOMY = "Reuse verified evidence within the workstream; prefer targeted reads and compact output; skip polling, timers, and status checks that change nothing. Send children one-sentence progress messages, keep the final report short, and end supervisor reports with any duplicated investigation or rework observed.";

const ASTRA_RULES = [
  TOKEN_ECONOMY,
  CHALLENGE_RULE,
  STANDARD_RULE,
  "Finish the authorized outcome. Resolve routine choices and make reasonable assumptions for reversible work. Prepare a concrete result before asking for a decision. Incorporate steering and answer side questions without dropping the task.",
  "The brief and liaison replies outrank project and skill guidance within runtime constraints. If an instruction file blocks work, name its path, quote the instruction, and explain the conflict. Do not invent approval requirements.",
  "Delegate bounded work or exploration when it saves time or improves quality. Give writers exclusive files and join subagents before reporting. Native subagents and cdx child lanes must not delegate further.",
  "Do not run the test suite or the wall; the lane gate runs it once after your report and the liaison merges on that result. Keep one test per real rule; remove fixture restatements and implementation mirrors.",
  ASK_RULE,
];
const GPT_WORKER_RULES = [WORKER_BAN, ...ASTRA_RULES];
const GEMINI_WORKER_RULES = [
  WORKER_BAN,
  "Execute the assigned outcome within your files. The parent owns design and scope. Do not spawn subagents.",
  ASK_RULE,
  "Remove temporary diagnostics before reporting. Do not run the test suite; the gate runs it once after your report. End with Assumptions, or 'none'.",
];
const SUPERVISOR_RULES = [
  "You are the owner's driver. Own design and cross-cutting decisions; delegate bounded execution to Gemini children. Use GPT children, consults, or native subagents when useful. Keep delegation one level deep.",
  ...ASTRA_RULES,
  'Start children with `cdx spawn <child> --bg --gate "<cmd>" "<brief>"`; Gemini is default, `--engine gpt` selects GPT. `cdx consult <child> --bg "<question>"` starts a read-only advisor. `cdx wait <child>... --report` returns exit 2 for questions; answer with `cdx reply`.',
  "Each child needs an outcome, exclusive files, gate, and relevant facts. Start independent children together. Separate worktrees start from committed HEAD; use disjoint files in one tree when children need your edits.",
  "Drive only your own children. Answer questions promptly. Never change a child's gate; ask the liaison if it is wrong. Jobs, fork, adopt, and clean belong to the liaison because they can outlive this lane or affect unrelated history.",
  "Read child reports and their gate results; do not rerun their gates or the suite. Join native subagents before reporting. Ending this round stops running cdx children; reporting with a running child fails the round.",
];

function houseRules(cwd: string, reviewOnly: boolean, engine: Engine = "gpt", opts: { supervisor?: boolean } = {}): string {
  const builtIns = reviewOnly ? [LANE_ROLE, READ_ONLY, REVIEW_REPORT] : [LANE_ROLE, WORK_LIMITS, WORK_REPORT];
  if (!reviewOnly) {
    if (opts.supervisor && engine === "gpt") builtIns.push(...SUPERVISOR_RULES);
    else builtIns.push(...(engine === "gemini" ? GEMINI_WORKER_RULES : GPT_WORKER_RULES));
  }
  builtIns.push("Write tool payloads larger than one screen to a file outside the repository and print only the path and a one-line digest.");
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

const REVIEW_FRAME_BASE = "ADVERSARIAL REVIEW. Find defects in behavior, contracts, data handling, or verification. For each finding give severity, file and line, and the input or state that produces the wrong result. P1 breaks users or data; P2 fails under realistic conditions; P3 is a smaller defect. Mark traced paths CONFIRMED and unverified paths PLAUSIBLE. Rank findings by severity. If clean, say so in one line. Omit praise and style remarks. Do not run the test suite; the lane gate already ran it and its result is in the report.";
const REVIEW_FRAME_GPT = `${REVIEW_FRAME_BASE} End with fenced JSON: {"findings":[{"severity":"P1|P2|P3","confidence":"CONFIRMED|PLAUSIBLE","file":"...","line":0,"summary":"..."}]}. Use an empty findings array when clean.`;
const REVIEW_FRAME_GEMINI = `${REVIEW_FRAME_BASE} Your final answer is captured as structured output: put the complete markdown report in the report field and every finding in the findings array (empty when clean).`;

function reviewFrame(engine: Engine): string {
  return engine === "gemini" ? REVIEW_FRAME_GEMINI : REVIEW_FRAME_GPT;
}

const CONSULT_FRAME = `CONSULT. Advise the Astra driver or the owner's liaison. Challenge the premise when evidence supports a better approach. ${STANDARD_RULE} Ground recommendations in the tree; separate verified facts from inference. Recommend one approach and explain rejected alternatives. Read-only: change nothing. End with Decisions for the caller, limited to choices that need the caller or owner.`;

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["engine", "effort", "cd", "scope", "schema", "base", "commit", "timeout", "days", "n", "note", "account", "worktree", "gate", "max-runtime", "id", "model", "port", "pre", "interval"]);
const LIST_FLAGS = new Set(["add-dir", "image"]);
const BOOL_FLAGS = new Set(["bg", "json", "uncommitted", "fix", "probe", "follow", "all", "report", "remove-worktree", "clear", "gate-baseline-check", "transcript", "supervisor", "open", "brief", "watch"]);

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

const ENGINE_PICKER = `gemini is the default; pass --engine gpt for design and judgment work.
For a whole change, use --engine gpt --model gpt-6-astra --supervisor.
The Astra supervisor owns the design, delegates bounded work, verifies, and reports.
Gemini children need one outcome, named files, and an acceptance gate.
Supervisors may also use GPT children and read-only consults, one level deep.
--model picks a Codex model alias or id; Astra effort stays at medium or below.`;

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
  if (!lane || !["gpt", "gemini"].includes(lane.engine)) throw new CmdError("lane has no valid engine; restore its engine in the ledger");
  return lane.engine;
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

function modelAliases(): string {
  const entries = Object.entries(config.models ?? {});
  return entries.map(([alias, id]) => `${alias}=${id}`).join(", ");
}

// --model takes an alias from config.models or a raw Codex model id. Gemini
// lanes have one model and refuse the flag.
function modelOf(parsed: Parsed, engine: Engine): string | undefined {
  const value = parsed.flags.model;
  if (engine === "gemini") {
    if (value !== undefined) fail("--model applies to gpt lanes only; gemini always runs the configured gemini model");
    return undefined;
  }
  if (value === undefined) return config.model;
  const resolved = config.models?.[value];
  if (resolved) return resolved;
  if (!MODEL_ID.test(value)) {
    const aliases = modelAliases();
    fail(`--model must be a Codex model id${aliases ? ` or one of ${aliases}` : ""}, set in ${CONFIG_PATH}; got "${value}"`);
  }
  return value;
}

function laneModel(lane: Pick<Lane, "model"> | undefined): string {
  return lane?.model ?? config.model;
}

function resolveEffort(engine: Engine, model: string | undefined, explicit?: string, inherited?: string): Effort {
  if (engine === "gemini") return "high";
  return configuredEffort(cappedEffort(model, explicit ?? inherited ?? config.defaultEffort, explicit !== undefined));
}

// Caps are keyed by model id, so an alias resolves before the check. An
// explicit --effort above the cap is refused. Any other source above it (the
// config default, a lane recorded before the cap, a gemini review round that
// stored "high" on a gpt lane) clamps to the cap with a note, so nothing runs
// Astra above medium by accident and nothing blocks a resume over bookkeeping.
// Every caller must send the returned effort to Codex; a session's stored
// effort is never trusted.
function cappedEffort(model: string | undefined, effort: Effort, explicit = true): Effort {
  const cap = model ? config.effortCaps[model] : undefined;
  if (!cap) return effort;
  const capIndex = EFFORT_ORDER.indexOf(cap);
  const effortIndex = EFFORT_ORDER.indexOf(effort);
  if (effortIndex >= 0 && effortIndex <= capIndex) return effort;
  if (!explicit) {
    return cap;
  }
  const allowed = EFFORT_ORDER.slice(0, capIndex + 1).filter((candidate) => config.efforts.includes(candidate));
  const remedy = allowed.length > 0 ? `allowed: ${allowed.join(", ")}` : `no configured effort is at or below ${cap}; edit efforts in ${CONFIG_PATH}`;
  fail(`effort ${effort} exceeds the cap for ${model} (max ${cap}); ${remedy}`);
}

function requireEngineBinary(engine: Engine): void {
  if (engine === "gemini" && !Bun.which("agy")) {
    fail("agy is not on PATH; install Google Antigravity CLI and make ~/.local/bin/agy available");
  }
}

interface GeminiQuotaRecord {
  blockedUntil: string;
  observedAt: string;
  lane: string;
  round: number;
}

function writeGeminiQuota(record: GeminiQuotaRecord): void {
  mkdirSync(ROOT, { recursive: true });
  const tmp = `${GEMINI_QUOTA_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, GEMINI_QUOTA_PATH);
}

function readGeminiQuota(): GeminiQuotaRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(GEMINI_QUOTA_PATH, "utf8")) as GeminiQuotaRecord;
    return value && typeof value.blockedUntil === "string" && Number.isFinite(Date.parse(value.blockedUntil))
      ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseQuotaResetDelayMs(text: string): number | undefined {
  const match = /Resets in (?:(?:(\d+)\s*h\s*)?(?:(\d+)\s*m\s*)?(?:(\d+)\s*s)?)/i.exec(text);
  if (!match) return undefined;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  if (!match[1] && !match[2] && !match[3]) return undefined;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

function parseQuotaResetIso(text: string, baseTime = Date.now()): string {
  const delayMs = parseQuotaResetDelayMs(text) ?? (30 * 60 * 1000);
  return new Date(baseTime + delayMs).toISOString();
}

function resetMinutesRemaining(iso: string, now = Date.now()): number {
  const diffMs = Date.parse(iso) - now;
  if (diffMs <= 0) return 0;
  return Math.max(1, Math.round(diffMs / 60_000));
}

interface GeminiQuotaState {
  block?: { resetsAt: string; minutesRemaining: number };
  warnPercent?: number;
  resetsAt?: string;
}

function geminiQuotaState(now = Date.now()): GeminiQuotaState {
  const quota = readGeminiQuota();
  if (quota && Date.parse(quota.blockedUntil) > now) {
    return {
      block: {
        resetsAt: quota.blockedUntil,
        minutesRemaining: resetMinutesRemaining(quota.blockedUntil, now),
      },
    };
  }

  const snapshot = readGeminiUsageSnapshot();
  if (snapshot) {
    const ageMs = now - Date.parse(snapshot.checkedAt);
    const resetTime = Date.parse(snapshot.fiveHour.resetsAt);
    if (ageMs >= 0 && ageMs < 15 * 60 * 1000 && resetTime > now) {
      if (snapshot.fiveHour.remainingPercent < 5) {
        return {
          block: {
            resetsAt: snapshot.fiveHour.resetsAt,
            minutesRemaining: resetMinutesRemaining(snapshot.fiveHour.resetsAt, now),
          },
        };
      }
      if (snapshot.fiveHour.remainingPercent < 15) {
        return {
          warnPercent: snapshot.fiveHour.remainingPercent,
          resetsAt: snapshot.fiveHour.resetsAt,
        };
      }
    }
  }

  return {};
}

function requireGeminiQuota(engine: Engine): void {
  if (engine !== "gemini") return;

  const state = geminiQuotaState();
  if (state.block) {
    fail(`gemini five-hour quota exhausted; resets at ${state.block.resetsAt} (in ${state.block.minutesRemaining}m). Wait, or pass --engine gpt.`);
  }

  try { unlinkSync(GEMINI_QUOTA_PATH); } catch { /* ignore */ }

  if (state.warnPercent !== undefined && state.resetsAt) {
    console.error(color.yellow(`cdx: gemini five-hour window at ${state.warnPercent}%, resets at ${state.resetsAt}; fan out with care`));
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

// A Gemini lane that hangs on its own script (a Playwright run on a remote
// client went 40 minutes silent on 2026-09-11) otherwise runs to the 12-hour
// print timeout. Codex lanes keep no default: --max-runtime stays explicit.
function defaultMaxRuntime(engine: Engine): number | undefined {
  if (engine !== "gemini") return undefined;
  return (config.gemini ?? geminiConfig()).maxRuntimeMins;
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

function accountSpec(account?: AccountChoice): Pick<Spec, "account" | "codexHome"> {
  return {
    ...(account ? { account: account.name, codexHome: account.home } : {}),
  };
}

function rejectPinnedAccountFlag(laneName: string, lane: Lane, requested?: string): void {
  if (requested === undefined) return;
  const pinned = lane.account ? `account "${lane.account}"` : `the default account at ${displayPath(defaultCodexHome())}`;
  fail(`--account is not valid for lane "${laneName}"; lane "${laneName}" is pinned to ${pinned}`);
}

interface LaneOwner { ownerSession?: string; ownerCwd: string }

function callerOwnership(): LaneOwner {
  const parent = supervisorLane();
  const inherited = parent ? readSessions().lanes[parent] ?? readLedger()[parent]?.ownerSession ?? "terminal" : undefined;
  const ownerSession = inherited === "terminal" ? undefined : inherited ?? process.env.CLAUDE_CODE_SESSION_ID?.trim();
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

async function openRound(lane: string, kind: "work" | "review", cwd: string, effort: Effort, opts?: { engine?: Engine; preserveEngine?: boolean; requireSession?: boolean; sessionOverride?: string; account?: AccountChoice; preserveAccount?: boolean; owner?: LaneOwner; preserveOwner?: boolean; worktree?: WorktreeInfo; gate?: string; preserveGate?: boolean; pre?: string; preservePre?: boolean; model?: string; lineage?: Lineage; consult?: true; forcedAccount?: string; excludedHomes?: Set<string> }): Promise<{ round: number; sessionId?: string; selection?: AccountSelection }> {
  const engine = opts?.engine ?? "gpt";
  for (;;) {
    if (engine === "gpt" && config.accounts) {
      withLedger(reconcileAccountHolds);
      await accountStandings();
    }
    const now = new Date().toISOString();
    const opened = withLedger((ledger) => {
      reconcileAccountHolds(ledger);
      // A completion can invalidate evidence while the outside-lock probes run.
      // Commit reconciliation, then refresh before making an admission decision.
      if (engine === "gpt" && Object.entries(config.accounts ?? {}).some(([name, home]) => readUsageSnapshot({ name, home })?.invalidatedAt)) return undefined;
      const existing = ledger[lane];
      if (process.argv[2] !== "_run") requireOwnChild(lane, existing);
      if (existing && laneRunning(existing) && (pidAlive(existing.pid) || pidAlive(existing.codexPid))
        && !(existing.switchingAccount && existing.pid === process.pid)) {
        throw new CmdError(`lane "${lane}" is already running (pid ${existing.pid}); pick a new name or wait`);
      }
      if (opts?.requireSession && !opts.sessionOverride && !existing?.sessionId) throw new CmdError(`lane "${lane}" has no session id; use cdx adopt or spawn`);
      const rounds = (existing?.rounds ?? 0) + 1;
      const existingWorkRounds = existing?.workRounds ?? existing?.rounds ?? 0;
      const workRounds = kind === "work" ? existingWorkRounds + 1 : existingWorkRounds;
      const preferred = opts?.account ?? (opts?.preserveAccount ? existing && laneAccount(existing) : undefined);
      const demand: Demand = kind === "review" ? "light" : (opts?.lineage?.supervisor ?? existing?.supervisor) ? "supervisor" : "work";
      const selection = engine === "gpt" ? chooseAccount(cachedAccountStandings(ledger).map((standing) => opts?.excludedHomes?.has(standing.choice.home) ? { ...standing, reached: true, reason: `already exhausted in this run; ${standing.reason}` } : standing), demand, opts?.forcedAccount, preferred) : undefined;
      const activeAccount = selection?.choice;
      const account = kind === "review" && existing ? existing.account : activeAccount?.name;
      const codexHome = kind === "review" && existing ? existing.codexHome : activeAccount?.home;
      const ownerSession = existing ? existing.ownerSession : opts?.owner?.ownerSession;
      const ownerCwd = opts?.preserveOwner ? existing?.ownerCwd : opts?.owner?.ownerCwd;
      const workCwd = kind === "work" ? cwd : existing ? workCwdOf(existing) : cwd;
      const workState = kind === "work" ? "running" : existing ? workStateOf(existing) : "adopted";
      const roundEngineType = opts?.preserveEngine || (kind === "review" && existing && hasWorkThread(existing)) ? laneEngine(existing) : opts?.engine ?? (existing ? laneEngine(existing) : engine);
      const hooksActive = roundEngineType === "gemini" && hookInstallState().state === "current";
      if (kind === "work" && roundEngineType === "gemini" && !hooksActive) {
        console.error("cdx: agy hooks not installed; steering falls back to follow-up turns (cdx doctor --fix)");
      }
      ledger[lane] = {
        ...(existing ?? {}),
        // The work engine belongs to the work thread. A review round on an
        // existing lane records its own engine beside it, so a later resume
        // still reattaches to the right runtime.
        engine: roundEngineType,
        reviewEngine: kind === "review" ? opts?.engine ?? (existing ? laneEngine(existing) : engine) : existing?.reviewEngine,
        model: roundEngineType === "gpt" ? opts?.model ?? existing?.model : existing?.model,
        // A spawn sets lineage explicitly (a respawn without --supervisor is
        // a plain lane again); every other round keeps what the lane had.
        supervisor: opts?.lineage ? (opts.lineage.supervisor ? true : undefined) : existing?.supervisor,
        parent: opts?.lineage ? opts.lineage.parent : existing?.parent,
        parentRound: opts?.lineage ? opts.lineage.parentRound : existing?.parentRound,
        consult: opts?.consult ?? existing?.consult,
        ...(opts?.worktree ? { worktreePath: opts.worktree.path, worktreeRepo: opts.worktree.repo, branch: opts.worktree.branch } : {}),
        account,
        codexHome,
        roundAccount: activeAccount ? { ...activeAccount, demand } : undefined,
        codexPid: undefined,
        ownerSession,
        ownerCwd,
        sessionId: opts?.sessionOverride ?? (opts?.requireSession ? existing?.sessionId : undefined),
        transcriptPath: undefined,
        workSessionId: kind === "review"
          ? existing?.workSessionId ?? (existing?.kind === "work" ? existing.sessionId : undefined)
          : existing?.workSessionId,
        gate: opts?.preserveGate ? existing?.gate : opts?.gate,
        pre: opts?.preservePre ? existing?.pre : opts?.pre,
        effort,
        work: kind === "work"
          ? { state: workState, round: rounds, cwd: workCwd, updatedAt: now }
          : existing?.work ?? { state: workState, cwd: workCwd },
        review: kind === "review" ? { state: "running", cwd, round: rounds, updatedAt: now } : existing?.review,
        roundStartedAt: now,
        // Reserve the lane with the parent's pid so a concurrent launch is
        // rejected before the runner records its own pid.
        pid: process.pid,
        kind,
        rounds,
        workRounds,
        reports: existing?.reports ?? [],
        tokens: existing?.tokens ?? { input: 0, cached: 0, output: 0 },
        roundTokens: { input: 0, cached: 0, output: 0 },
        roundSteps: 0, stage: "working", stageStartedAt: now, lastActionAt: undefined,
        steers: 0,
        steerOpen: kind === "work",
        continuations: 0,
        ...(hooksActive ? { hooksActive: true } : {}),
        quotaFailure: undefined,
        switchingAccount: undefined,
        lastAction: undefined,
        lastEventAt: undefined,
        diffEmpty: undefined,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return { round: rounds, sessionId: opts?.sessionOverride ?? existing?.sessionId, selection };
    });
    if (opened) return opened;
  }
}

function launch(spec: Spec, brief: string, background: boolean): Promise<never> | never {
  spec.accountHomes = config.accounts;
  spec.visibility = config.visibility ?? VISIBILITY_DEFAULTS;
  spec.taskPrompt ??= spec.prompt;
  const entry = readLane(spec.lane);
  if (spec.engine === "gpt") {
    const choice = entry.roundAccount;
    const changedHome = (spec.codexHome ?? defaultCodexHome()) !== (choice?.home ?? defaultCodexHome());
    spec.account = choice?.name;
    spec.codexHome = choice?.home;
    spec.model ??= entry.model ?? config.model;
    Object.assign(spec, accountSpec(choice));
    if (changedHome && (spec.sourceThreadId || spec.mode === "resume" || spec.mode === "fork")) {
      const historyLane = spec.sourceLane ? readLane(spec.sourceLane) : entry;
      const historySpec = spec.sourceLane ? { ...spec, lane: spec.sourceLane } : spec;
      freshAccountSpec(spec, entry, recoveryPrompt(historySpec, historyLane));
      brief = spec.prompt;
    }
  }
  if (spec.engine === "gemini") {
    const policy = config.gemini ?? geminiConfig();
    spec.model ??= policy.model;
    spec.agent ??= readLedger()[spec.lane]?.kind === "review" ? policy.reviewAgent : policy.agent;
  }
  writeFileSync(specPathOf(spec.lane, spec.round), JSON.stringify(spec, null, 2));
  writeFileSync(`${ROOT}/briefs/${spec.lane}-r${spec.round}.md`, brief);
  if (supervisorLane()) feedEvent("started", `[cdx] lane=${spec.lane} round=${spec.round} started report=${reportPathOf(spec.lane, spec.round)}`, spec.ownerSession, { lane: spec.lane, round: spec.round });
  const jsonMode = spec.engine === "gemini" || spec.reviewDir === undefined || spec.mode === "spawn";
  if (spec.reviewDir) console.log(`cdx: REVIEW DIRECTORY ${spec.reviewDir}`);
  console.log(`cdx: lane=${color.magenta(spec.lane)} engine=${spec.engine}${spec.model ? ` model=${spec.model}` : ""}${spec.supervisor ? " supervisor" : ""} mode=${spec.mode} round=${spec.round} cwd=${spec.cwd}${background ? " (background)" : ""}`);
  console.log(`cdx: log=${logPathOf(spec.lane, spec.round, jsonMode)} report=${reportPathOf(spec.lane, spec.round)}`);
  if (background) {
    const crashLog = openSync(`${ROOT}/logs/${spec.lane}-r${spec.round}.runner.log`, "a");
    const child = nodeSpawn(process.execPath, [SELF, "_run", spec.lane, String(spec.round)], {
      detached: true,
      env: runnerEnv(spec.codexHome),
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

function roundCapRefusal(lane: string, cap: number): string {
  return `round cap ${cap} reached for ${lane}: close it and spawn a new lane with the failure attached`;
}

function checkRoundCap(lane: string, engine: Engine, workRounds: number, cap = (config.gemini ?? geminiConfig()).maxRounds): void {
  if (engine === "gemini" && workRounds >= cap) fail(roundCapRefusal(lane, cap));
}

function tailOutput(text: string, count = 20): string {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  return lines.slice(-count).join("\n");
}

function executePreCheck(command: string, cwd: string): { exitCode: number; output: string } {
  const proc = Bun.spawnSync({
    cmd: ["/bin/sh", "-lc", command],
    cwd,
    env: uncoloredChildEnv(),
  });
  const exitCode = proc.exitCode ?? 1;
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  return { exitCode, output };
}

function runPreCheck(command: string, cwd: string): void {
  const result = executePreCheck(command, cwd);
  if (result.exitCode !== 0) {
    const tail = tailOutput(result.output, 20);
    if (tail.length > 0) {
      console.error(tail);
    }
    fail(`pre-check failed (exit ${result.exitCode}): ${command}`);
  }
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
    item.work.state = "gate-invalid";
    item.gateBaseline = { round, command, cwd, exitCode: result.exitCode, checkedAt };
    item.work.exitCode = result.exitCode;
    item.work.note = note;
    item.work.report = reportPath;
    item.work.updatedAt = checkedAt;
    item.pid = undefined;
    item.codexPid = undefined;
    item.reports.push(reportPath);
    item.updatedAt = checkedAt;
    return item;
  });
  feedEvent("terminal", `[cdx] lane=${lane} round=${round} state=gate-invalid exit=${result.exitCode} note=${note} report=${reportPath}`, entry.ownerSession, { lane, round });
  console.error(`cdx: lane=${color.magenta(lane)} state=${color.red("gate-invalid")} review the gate command before starting work`);
  console.error(`cdx: ${note}`);
  console.error(`cdx: gate log=${ROOT}/logs/${lane}-r${round}.gate-baseline.log`);
}

function failActiveRound(lane: string, item: Lane, note: string): void {
  if (roundEngine(item) === "gpt") invalidateAccountUsage(item.roundAccount);
  item.switchingAccount = undefined;
  const now = new Date().toISOString();
  const report = availableReportPath(lane, item.rounds);
  if (report?.endsWith(".partial.md")) note = `${singleLine(note)}; partial report=${report}`;
  if (item.kind === "review") {
    item.review!.report = report;
    item.review!.state = "failed";
    item.review!.note = note;
    item.review!.updatedAt = now;
  } else {
    item.work.report = report;
    item.work.state = "failed";
    item.work.note = note;
    item.work.updatedAt = now;
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

function isCodexQuotaFailure(text: string): boolean {
  return /rate[ _-]?limit|quota[ _-]?(?:exceeded|exhausted)|insufficient_quota|usage[ _-]?limit|you(?:'ve| have) hit.*limit|too many requests|\b429\b/i.test(text);
}

function recordCodexExhaustion(spec: Spec, evidence: string): void {
  const account = spec.account && spec.codexHome ? { name: spec.account, home: spec.codexHome } : undefined;
  withUsageState((state) => {
    const previous = usageSnapshotFrom(state, account);
    const now = Date.now();
    const delay = parseQuotaResetDelayMs(evidence);
    const epoch = /["']?resets[_A-Za-z]*["']?\s*[:=]\s*(\d{10,13})/i.exec(evidence)?.[1];
    const explicit = epoch ? Number(epoch) / (epoch.length === 13 ? 1000 : 1) : undefined;
    const blocking = previous?.windows?.filter((window) => window.usedPercent >= 99 && window.resetsAt * 1000 > now);
    const reset = explicit && explicit * 1000 > now ? explicit
      : delay !== undefined ? (now + delay) / 1000
      : blocking?.length ? Math.max(...blocking.map((window) => window.resetsAt))
      : previous?.resetsAt && previous.resetsAt * 1000 > now ? previous.resetsAt
      : (now + 30 * 60_000) / 1000;
    storeUsageSnapshot(state, {
      windowDurationMins: 0, planType: "unknown", resetCreditsAvailable: 0, ...previous,
      checkedAt: new Date(now).toISOString(), usedPercent: 100, resetsAt: reset, reached: true,
      exhaustedUntil: Math.max(reset, previous?.exhaustedUntil ?? 0),
    }, account);
  });
  withLedger((ledger) => {
    const item = ledger[spec.lane];
    if (item?.rounds === spec.round) item.quotaFailure = evidence.slice(0, 500);
  });
}

function recoveryPrompt(spec: Spec, entry: Lane): string {
  const history: string[] = [];
  let latestEvidence = "";
  for (let round = 1; round <= entry.rounds; round++) {
    let account = "default";
    try { account = JSON.parse(readFileSync(specPathOf(spec.lane, round), "utf8")).account ?? account; } catch { /* no saved spec */ }
    const report = [reportPathOf(spec.lane, round), partialReportPathOf(spec.lane, round)].find((path) => existsSync(path) && readFileSync(path, "utf8").trim());
    history.push(`round ${round}: account=${account}; ${report ?? "no report"}; log=${logPathOf(spec.lane, round, existsSync(logPathOf(spec.lane, round, true)))}`);
    if (report) latestEvidence = readFileSync(report, "utf8").slice(-30_000);
  }
  let original = "";
  try { original = readFileSync(`${ROOT}/briefs/${spec.lane}-r1.md`, "utf8"); } catch { /* initial launch */ }
  const task = spec.taskPrompt ?? spec.prompt;
  return [
    task, original && original !== task ? `Original brief:
${original}` : "",
    "Continue in a fresh session after an account switch. Reuse verified evidence, inspect the current tree, and finish the authorized outcome.",
    `Round history:
${history.join("\n")}`,
    entry.quotaFailure ? `Previous round stopped: ${entry.quotaFailure}` : "",
    latestEvidence ? `Last report or partial:
${latestEvidence}` : "No report survived; use the round logs and current tree.",
  ].filter(Boolean).join("\n\n");
}

function freshAccountSpec(spec: Spec, entry: Lane, prompt: string): void {
  const readOnly = entry.kind === "review" || Boolean(entry.consult);
  if (spec.mode === "review-native") {
    const args = spec.codexArgs ?? [];
    const base = args.indexOf("--base");
    const commit = args.indexOf("--commit");
    const target = args.includes("--uncommitted") ? "\nReview uncommitted changes with git diff HEAD."
      : base >= 0 ? `\nReview git diff ${args[base + 1]}...HEAD.`
      : commit >= 0 ? `\nReview git show ${args[commit + 1]}.` : "";
    spec.taskPrompt = (spec.taskPrompt ?? spec.prompt) + target;
    prompt += target;
  }
  spec.mode = "spawn";
  spec.sourceThreadId = undefined;
  spec.prompt = prompt;
  if (readOnly) {
    spec.reviewDir = spec.cwd;
    spec.gate = undefined;
    spec.codexArgs = ["exec", "--json", "-m", spec.model ?? config.model,
      "-c", `model_reasoning_effort=${spec.effort}`, "-s", "read-only",
      "-c", 'approval_policy="never"', "--skip-git-repo-check", "--cd", spec.cwd,
      "--output-last-message", reportPathOf(spec.lane, spec.round), prompt];
  } else {
    spec.codexArgs = undefined;
  }
  withLedger((ledger) => {
    const item = ledger[spec.lane]!;
    item.sessionId = undefined;
    if (item.kind === "work") item.workSessionId = undefined;
  });
}

async function runRound(lane: string, round: number): Promise<number> {
  const exhaustedHomes = new Set<string>();
  for (;;) {
    let spec: Spec | undefined;
    let code = 1;
    try {
      spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec;
      config.accounts = spec.accountHomes;
      code = await runRoundInner(lane, round);
    } catch (error) {
      if (spec && spec.engine === "gpt" && isCodexQuotaFailure(String(error))) recordCodexExhaustion(spec, String(error));
      withLedger((ledger) => {
        const item = ledger[lane];
        if (item?.rounds === round) {
          failActiveRound(lane, item, `runner error: ${String(error).slice(0, 200)}`);
          if (item.quotaFailure && spec?.engine === "gpt") {
            item.switchingAccount = true;
            item.pid = process.pid;
          }
        }
      });
      console.error(`cdx: lane=${lane} round=${round} runner error: ${error}`);
    }
    const entry = readLedger()[lane];
    if (!spec || !entry || entry.rounds !== round) return code;
    if (spec.engine === "gemini") {
      try { await refreshGeminiUsage(); } catch { /* best-effort */ }
    }
    if (spec.engine !== "gpt" || !entry.quotaFailure || code === 0) {
      if (code !== 0) feedEvent("terminal", `[cdx] lane=${lane} round=${round} kind=${entry.kind} state=${roundStateOf(entry)} note=${roundNoteOf(entry) ?? "runner failed"} report=${roundReportOf(entry) ?? "-"}`, entry.ownerSession, { lane, round });
      if (code !== 0 && entry.supervisor) await killChildren(lane, `supervisor ${lane} failed`);
      return code;
    }
    try {
      if (spec.codexHome) exhaustedHomes.add(spec.codexHome);
      if (!config.accounts) {
        const reset = readUsageSnapshot()?.exhaustedUntil;
        throw new CmdError(`no configured alternate accounts; resets ${reset ? new Date(reset * 1000).toISOString() : "unknown"}`);
      }
      const prompt = recoveryPrompt(spec, entry);
      const opened = await openRound(lane, entry.kind, spec.cwd, spec.effort, {
        engine: "gpt", preserveOwner: true, preserveGate: true, model: spec.model, excludedHomes: exhaustedHomes,
      });
      const next = readLane(lane);
      const account = next.roundAccount;
      const previousAccount = spec.account ?? "default";
      spec = { ...spec, round: opened.round, account: account?.name, codexHome: account?.home };
      freshAccountSpec(spec, next, prompt);
      writeFileSync(specPathOf(lane, spec.round), JSON.stringify(spec, null, 2));
      writeFileSync(`${ROOT}/briefs/${lane}-r${spec.round}.md`, spec.prompt);
      feedEvent("account", `[cdx] lane=${lane} round=${spec.round} auto-switch from=${previousAccount} to=${spec.account ?? "default"} reason=quota-exhausted fresh-session=true`, spec.ownerSession, { lane, round: spec.round });
      round = spec.round;
    } catch (error) {
      const note = `account failover unavailable: ${error instanceof Error ? error.message : String(error)}`;
      withLedger((ledger) => failActiveRound(lane, ledger[lane]!, note));
      if (entry.supervisor) await killChildren(lane, note);
      feedEvent("terminal", `[cdx] lane=${lane} round=${round} state=failed note=${note}`, spec.ownerSession, { lane, round });
      console.error(`cdx: ${note}`);
      return 1;
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

function extractFinalAgentResponse(responses: Map<string, { stepIndex: string; num: number; text: string }>): string | undefined {
  if (responses.size === 0) return undefined;
  const sorted = [...responses.values()].sort((a, b) => {
    return Number.isFinite(a.num) && Number.isFinite(b.num) ? a.num - b.num : 0;
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    const text = sorted[i].text.trim();
    if (text) return text;
  }
  return undefined;
}

async function qualifyGeminiResult({ lane, round, ownerSession, result, finalAgentResponse, isReview, childRunning, geminiContinuations, turnFailureReason, touchLedger, now, reportPath }: {
  lane: string; round: number; ownerSession?: string; result: any; finalAgentResponse?: string; isReview: boolean;
  childRunning: boolean; geminiContinuations: number; turnFailureReason?: string;
  touchLedger: (patch: (item: Lane) => void, force?: boolean) => void;
  now: string; reportPath: string;
}): Promise<{ turnFailureReason?: string; geminiContinuations: number; continueTurn: boolean }> {
  let continueTurn = false;
  const rawError = result.error?.message ?? result.error;
  const errorText = typeof rawError === "string" ? rawError : typeof rawError === "object" && rawError ? JSON.stringify(rawError) : "";
  const errorCandidates = [
    errorText,
    typeof result.response === "string" ? result.response : "",
  ].filter((s) => s.trim().length > 0);
  const effectiveError = (errorText.trim() || (typeof result.response === "string" ? result.response : "")).trim();
  const recordedError = effectiveError.slice(0, 300);

  const isTransportError = GEMINI_TRANSPORT_ERRORS.some((pattern) => errorCandidates.some((c) => pattern.test(c)));
  const previousResultError = readLedger()[lane]?.lastResultError;
  const isVerbatimReplay = Boolean(!isTransportError && previousResultError && effectiveError === previousResultError);

  let treatedAsReplay = false;
  let success = result.status === "SUCCESS";

  if (!success) {
    if (isVerbatimReplay && finalAgentResponse) {
      treatedAsReplay = true;
      success = true;
    } else {
      const quotaCandidate = errorCandidates.find((c) => /Individual quota reached/i.test(c));
      if (quotaCandidate) {
        let usageSnapshot: GeminiUsageSnapshot | undefined;
        try { usageSnapshot = await refreshGeminiUsage(); } catch {}
        if (usageSnapshot && usageSnapshot.fiveHour.remainingPercent >= 5) {
          if (finalAgentResponse) {
            treatedAsReplay = true;
            success = true;
          } else {
            touchLedger((item) => { item.lastResultError = recordedError; }, true);
            turnFailureReason = `agy reported quota exhausted but usage shows ${usageSnapshot.fiveHour.remainingPercent}% five-hour remaining; no block written`;
          }
        } else {
          touchLedger((item) => { item.lastResultError = recordedError; }, true);
          const delayMs = parseQuotaResetDelayMs(quotaCandidate);
          const observedAt = new Date().toISOString();
          const blockedUntil = new Date(Date.now() + (delayMs ?? (30 * 60 * 1000))).toISOString();
          writeGeminiQuota({ blockedUntil, observedAt, lane, round });
          turnFailureReason = `gemini five-hour quota exhausted; resets at ${blockedUntil}; resume this lane after the reset`;
          const resetDetail = delayMs !== undefined ? `resets at ${blockedUntil}` : "reset time unknown; assuming 30m";
          feedEvent("account", `[cdx] lane=${lane} round=${round} gemini quota exhausted; ${resetDetail}`, ownerSession, { lane, round });
        }
      } else {
        touchLedger((item) => { item.lastResultError = recordedError; }, true);
        if (isTransportError && childRunning && geminiContinuations < GEMINI_TRANSPORT_RETRIES) {
          geminiContinuations += 1;
          touchLedger((item) => {
            item.continuations = geminiContinuations;
            item.lastEventAt = now;
          }, true);
          const reason = singleLine(effectiveError).slice(0, 80);
          feedEvent("progress", `[cdx] lane=${lane} round=${round} auto-continue ${geminiContinuations}/${GEMINI_TRANSPORT_RETRIES} wait=${geminiContinuations}s reason=${reason}`, ownerSession, { lane, round });
          continueTurn = true;
        } else {
          turnFailureReason ??= isTransportError ? "gemini transport interrupted"
            : errorText.trim() ? singleLine(errorText).slice(0, 200)
            : `gemini result status ${result.status ?? "ERROR"}`;
        }
      }
    }
  }

  if (success) {
    if (result.status === "SUCCESS") {
      touchLedger((item) => {
        delete item.lastResultError;
      }, true);
    }
    if (treatedAsReplay) {
      feedEvent("progress", `[cdx] lane=${lane} round=${round} ignored replayed agy error: ${singleLine(effectiveError).slice(0, 80)}`, ownerSession, { lane, round });
    }
    const qualified = qualifyGeminiReport(result, finalAgentResponse, isReview);
    if (qualified.report !== undefined) writeFileSync(reportPath, qualified.report);
    if (qualified.findings !== undefined) {
      writeFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, `${JSON.stringify({ findings: qualified.findings }, null, 2)}\n`);
    }
    turnFailureReason = qualified.failureReason ?? turnFailureReason;
  } else {
    const response = typeof result.response === "string" ? result.response.trim() : "";
    const transportMessage = (text: string) => GEMINI_TRANSPORT_ERRORS.some((pattern) => pattern.test(text.split("\n", 1)[0] ?? ""));
    const partial = finalAgentResponse && !transportMessage(finalAgentResponse) ? finalAgentResponse
      : response && !transportMessage(response) ? response : "";
    if (partial) {
      writeFileSync(partialReportPathOf(lane, round), `${partial}\n`);
      feedEvent("partial", `[cdx] lane=${lane} round=${round} partial report=${partialReportPathOf(lane, round)}`, ownerSession, { lane, round });
    }
  }
  return { turnFailureReason, geminiContinuations, continueTurn };
}

function qualifyGeminiReport(result: { structured_output?: any; response?: unknown }, finalAgentResponse: string | undefined, isReview: boolean): { report?: string; findings?: unknown[]; failureReason?: string } {
  const structured = result.structured_output;
  const hasStructuredReport = isReview && structured && typeof structured === "object" && !Array.isArray(structured) && typeof structured.report === "string";
  const raw = hasStructuredReport ? structured.report : finalAgentResponse || (typeof result.response === "string" ? result.response.trim() : "");
  const report = hasStructuredReport ? `${raw.trim()}\n` : isReview ? `${raw}\n\n## Harness note\n\nStructured output was missing.\n` : raw ? `${raw}\n` : undefined;
  const failureReason = isReview && !hasStructuredReport && !raw
    ? "agy finished without a report or structured output"
    : isAgyCancellationTemplate(raw) ? "agy returned its cancellation template as the report; no qualifying report" : undefined;
  return { report, failureReason, ...(hasStructuredReport && Array.isArray(structured.findings) ? { findings: structured.findings } : {}) };
}

async function* readJsonLines(stream: ReadableStream<Uint8Array>, options: { onChunk?: (chunk: Uint8Array) => void; ignoreMalformed?: boolean } = {}): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch (error) { if (!options.ignoreMalformed) throw error; }
  };
  for await (const chunk of stream) {
    options.onChunk?.(chunk);
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) { const value = parse(line); if (value !== undefined) yield value; }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const value = parse(buffer); if (value !== undefined) yield value; }
}

async function runRoundInner(lane: string, round: number): Promise<number> {
  const spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec;
  const startingLane = readLedger()[lane];
  if (!spec.effort) throw new CmdError("round spec has no effort; start a new round with cdx 5.0");
  if (!["gpt", "gemini"].includes(spec.engine)) throw new CmdError("round spec has no valid engine; start a new round with cdx 5.0");
  const engine = spec.engine;
  const gemini = engine === "gemini";
  const appServer = !gemini && appServerWorkRound(spec, startingLane);
  const jsonMode = gemini || appServer || spec.mode === "spawn";
  const logPath = logPathOf(lane, round, jsonMode);
  const reportPath = reportPathOf(lane, round);
  try { unlinkSync(`${ROOT}/reports/${lane}-r${round}.findings.json`); } catch { /* ignore if missing */ }
  const reviewSnapshot = gemini && startingLane?.kind === "review" ? captureReviewTree(spec.cwd) : undefined;
  const workTreeStartSnapshot = startingLane?.kind === "work" ? captureReviewTree(spec.cwd) : undefined;
  const hooksInstalled = gemini ? hookInstallState().state === "current" : false;
  withLedger((ledger) => {
    const item = ledger[lane]!;
    item.pid = process.pid;
    if (item.kind === "review") item.review!.state = "running";
    else { item.work.state = "running"; }
    if (gemini && hooksInstalled) item.hooksActive = true;
    else delete item.hooksActive;
  });

  let geminiSchemaPath: string | undefined;
  if (gemini && spec.outputSchema !== undefined) {
    geminiSchemaPath = `${ROOT}/specs/${lane}-r${round}.schema.json`;
    writeFileSync(geminiSchemaPath, `${JSON.stringify(spec.outputSchema, null, 2)}\n`);
  }
  const geminiPolicy = config.gemini ?? geminiConfig();
  const geminiArgs = [
    "agy", "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", spec.model ?? geminiPolicy.model, "--dangerously-skip-permissions", "--add-dir", spec.cwd,
    ...(spec.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    "--agent", spec.agent ?? (startingLane?.kind === "review" ? geminiPolicy.reviewAgent : geminiPolicy.agent),
    ...(spec.sourceThreadId ? ["--conversation", spec.sourceThreadId] : []),
    ...(geminiSchemaPath ? ["--json-schema", geminiSchemaPath] : []),
    "--print-timeout", spec.maxRuntimeMins ? `${spec.maxRuntimeMins}m` : "12h",
  ];
  const proc = Bun.spawn({
    cmd: gemini ? geminiArgs : appServer ? ["codex", "app-server", "--listen", "stdio://"] : ["codex", ...(spec.codexArgs ?? [])],
    cwd: spec.cwd,
    env: laneChildEnv(spec.codexHome, { lane, round, owner: spec.ownerSession, supervisor: startingLane?.kind === "work" && Boolean(startingLane.supervisor) }, engine),
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
  const onTerm = () => reap("SIGTERM");
  const onInt = () => reap("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
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
    if (lastStallWarn) feedEvent("active", `[cdx] lane=${lane} round=${round} active again after quiet stretch`, spec.ownerSession, { lane, round });
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
    if (quiet >= 300_000 && !lastStallWarn) {
      lastStallWarn = Date.now();
      feedEvent("stalled", `[cdx] lane=${lane} round=${round} running but quiet ${Math.round(quiet / 60_000)}m (codex pid ${proc.pid}); cdx tail ${lane} to inspect`, spec.ownerSession, { lane, round });
    }
  }, 60_000);

  const completedTurns = new Map<string, AppTurn>();
  const turnWaiters = new Map<string, Array<(turn: AppTurn) => void>>();
  let reportOrder = 0;
  let writtenReportOrder = 0;
  let partialAnnounced = false;
  const announcePartial = () => {
    if (partialAnnounced) return;
    partialAnnounced = true;
    feedEvent("partial", `[cdx] lane=${lane} round=${round} partial report=${partialReportPathOf(lane, round)}`, spec.ownerSession, { lane, round });
  };
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
    if (!qualifying) {
      writeFileSync(partialReportPathOf(lane, round), `${item.text.trim()}\n`);
      announcePartial();
      return;
    }
    latestReportCandidate = { text: item.text, turnId, order: ++reportOrder };
    persistCapturedReport();
  };
  const turnErrorText = (turn: AppTurn): string | undefined => {
    const error = turn.error as { message?: string; additionalDetails?: string | null } | null | undefined;
    const details = [error?.message, error?.additionalDetails].filter((value): value is string => Boolean(value));
    return details.length ? details.join(": ") : lastProtocolError;
  };

  const trackProgress = roundProgress(spec.cwd, spec.visibility ?? VISIBILITY_DEFAULTS);
  // Review lanes refuse `cdx send`, so the alert points at the transcript instead.
  const thrashAdvice = (name: string): string => startingLane?.kind === "work"
    ? `cdx send ${name} "Stop repeating this attempt; inspect the cause and change approach."`
    : `cdx tail ${name}`;
  const observeTool = (event: any, now: string) => {
    const observation = toolObservation(event);
    if (!observation) return;
    const progress = trackProgress(observation);
    touchLedger((item) => {
      item.roundSteps = progress.steps;
      item.lastActionAt = now;
      item.lastEventAt = now;
      if (event.params?.item ?? event.item) item.lastAction = excerpt(event.params?.item ?? event.item);
    }, Boolean(progress.thrash));
    if (progress.thrash) feedEvent("thrash", `[cdx] lane=${lane} round=${round} ${progress.thrash}; ${thrashAdvice(lane)}`, spec.ownerSession, { lane, round });
  };
  const handleGeminiEvent = async (event: any) => {
    noteActivity();
    const now = new Date().toISOString();
    observeTool(event, now);
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
        touchLedger((item) => { item.lastAction = `${tool}${detail}`.slice(0, 160); item.lastEventAt = now; item.lastActionAt = now; });
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
          touchLedger((item) => { item.lastAction = singleLine(update.text_delta).slice(0, 160); item.lastEventAt = now; item.lastActionAt = now; });
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
      const finalAgentResponse = extractFinalAgentResponse(turnAgentResponses);

      const qualified = await qualifyGeminiResult({
        lane, round, ownerSession: spec.ownerSession, result, finalAgentResponse, isReview,
        childRunning: proc.exitCode === null, geminiContinuations, turnFailureReason, touchLedger, now, reportPath,
      });
      turnFailureReason = qualified.turnFailureReason;
      geminiContinuations = qualified.geminiContinuations;
      if (qualified.continueTurn) {
        await Bun.sleep(geminiContinuations * 1000);
        if (!receivedSignal && !maxRuntimeHit && proc.exitCode === null) {
          writeUserTurn("The previous turn was cut off by a transport error. Continue the task you were working on from where you left off. When the task is complete, print your final lane report.");
        } else if (!receivedSignal && !maxRuntimeHit) {
          turnFailureReason = "agy exited during transport retry wait";
        }
      }
      geminiTurnsCompleted += 1;
      const wake = geminiTurnWake;
      geminiTurnWake = undefined;
      wake?.();
    }
  };

  const handleCodexEvent = async (event: any) => {
    noteActivity();
    const now = new Date().toISOString();
    observeTool(event, now);
    if (event.method === "item/agentMessage/delta" && typeof event.params?.delta === "string") {
      appendFileSync(partialReportPathOf(lane, round), event.params.delta);
      announcePartial();
    } else if (event.method === "thread/started" && event.params?.thread?.id) {
      touchLedger((item) => { item.sessionId = event.params.thread.id; item.lastEventAt = now; }, true);
    } else if (event.method === "error" && event.params?.error) {
      const error = event.params.error;
      lastProtocolError = [error.message, error.additionalDetails].filter(Boolean).join(": ") || "app-server turn error";
      if (isCodexQuotaFailure(lastProtocolError)) recordCodexExhaustion(spec, lastProtocolError);
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
        if (isCodexQuotaFailure(turnFailureReason)) recordCodexExhaustion(spec, turnFailureReason);
      }
      persistCapturedReport();
      for (const resolve of turnWaiters.get(turn.id) ?? []) resolve(turn);
      turnWaiters.delete(turn.id);
      if (activeTurnId === turn.id) activeTurnId = undefined;
    } else if (event.method === "item/completed" && event.params?.item) {
      const item = event.params.item as Record<string, unknown>;
      rememberAgentMessage(item, event.params.turnId ?? activeTurnId);
      touchLedger((entry) => { entry.lastAction = excerpt(item); entry.lastEventAt = now; entry.lastActionAt = now; });
    } else if (event.type === "turn.failed" || event.type === "error") {
      const evidence = JSON.stringify(event.error ?? event.message ?? "");
      turnFailureReason = evidence;
      if (isCodexQuotaFailure(evidence)) recordCodexExhaustion(spec, evidence);
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
      touchLedger((item) => { item.lastAction = excerpt(event.item); item.lastEventAt = now; item.lastActionAt = now; });
    }
  };

  const pumpJson = async (stream: ReadableStream<Uint8Array>) => {
    for await (const event of readJsonLines(stream, { ignoreMalformed: true, onChunk: (chunk) => { log.write(chunk); log.flush(); } })) {
      await (gemini ? handleGeminiEvent(event) : handleCodexEvent(event));
    }
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
    let controlChain = Promise.resolve();
    const drainControls = async () => {
      const turnActive = geminiTurnsCompleted < geminiTurnsSent;
      const toDeliver: ControlRecord[] = [];
      withLedger((ledger) => {
        if (turnActive && hooksInstalled) return;
        const path = controlPathOf(lane, round);
        if (!existsSync(path)) return;
        const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
        const delivered = readDeliveredCount(lane, round);
        if (delivered >= lines.length) return;

        let newlyDelivered = 0;
        for (let i = delivered; i < lines.length; i++) {
          const line = lines[i]!;
          let record: ControlRecord;
          try { record = JSON.parse(line) as ControlRecord; } catch { continue; }
          if (typeof record.text !== "string" || !record.text.trim()) continue;
          toDeliver.push(record);
          newlyDelivered += 1;
        }
        writeDeliveredCount(lane, round, lines.length);
        if (newlyDelivered > 0) {
          const item = ledger[lane];
          if (item) {
            item.steers = (item.steers ?? 0) + newlyDelivered;
            item.updatedAt = new Date().toISOString();
          }
        }
      });
      for (const record of toDeliver) {
        writeUserTurn(record.text);
        const flat = singleLine(record.text);
        feedEvent("progress", `[cdx] lane=${lane} round=${round} steer delivered mode=follow-up-turn: ${flat.slice(0, 120)}`, spec.ownerSession, { lane, round });
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
      for await (const message of readJsonLines(stream, { ignoreMalformed: true, onChunk: (chunk) => { log.write(chunk); log.flush(); } })) {
        await handleCodexEvent(message);
        if (typeof message.id === "number" && pending.has(message.id)) {
          const waiter = pending.get(message.id)!;
          pending.delete(message.id);
          if (message.error) {
            const evidence = `${message.error.message ?? "app-server request failed"}${message.error.data ? `: ${JSON.stringify(message.error.data)}` : ""}`;
            if (isCodexQuotaFailure(evidence)) recordCodexExhaustion(spec, evidence);
            waiter.reject(new Error(evidence));
          }
          else waiter.resolve(message.result);
        } else if (message.id !== undefined && message.method) {
          writeRpc({ id: message.id, error: { code: -32601, message: `cdx does not handle server request ${message.method}` } });
        }
      }
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
        // A raw-session fork carries the requested model; a lane fork
        // inherits its source thread's model and sends none.
        ...(spec.mode === "spawn" ? { model: spec.model ?? config.model } : spec.mode === "fork" && !spec.sourceLane ? { model: spec.model } : {}),
        effort: spec.effort,
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
      feedEvent("progress", `[cdx] lane=${lane} round=${round} steer delivered mode=${mode}: ${short}`, spec.ownerSession, { lane, round });
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
          feedEvent("progress", `[cdx] lane=${lane} round=${round} steer rejected and retained: ${reason.slice(0, 160)}`, spec.ownerSession, { lane, round });
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
        feedEvent("progress", `[cdx] lane=${lane} round=${round} cleanup warning: ${roundCleanupWarning}`, spec.ownerSession, { lane, round });
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
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
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
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);

  return finalizeRound({ spec, lane, round, jsonMode, gemini, logPath, reportPath, reviewSnapshot, workTreeStartSnapshot, exitCode, turnFailureReason, receivedSignal, maxRuntimeHit, geminiContinuations, roundCleanupWarning });
}

async function finalizeRound({ spec, lane, round, jsonMode, gemini, logPath, reportPath, reviewSnapshot, workTreeStartSnapshot, exitCode, turnFailureReason, receivedSignal, maxRuntimeHit, geminiContinuations, roundCleanupWarning }: {
  spec: Spec; lane: string; round: number; jsonMode: boolean; gemini: boolean;
  logPath: string; reportPath: string;
  reviewSnapshot?: ReturnType<typeof captureReviewTree>;
  workTreeStartSnapshot?: ReturnType<typeof captureReviewTree>;
  exitCode: number; turnFailureReason?: string; receivedSignal?: "SIGTERM" | "SIGINT";
  maxRuntimeHit: boolean; geminiContinuations: number; roundCleanupWarning?: string;
}): Promise<number> {
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
  const setStage = (stage: "gate" | "reporting") => withLedger((ledger) => {
    const item = ledger[lane];
    if (item?.rounds === round) { item.stage = stage; item.stageStartedAt = new Date().toISOString(); }
  });
  setStage("reporting");
  const reportOk = existsSync(reportPath) && readFileSync(reportPath, "utf8").trim().length > 0;
  const stderrText = (() => {
    try { return readFileSync(`${ROOT}/logs/${lane}-r${round}.stderr.log`, "utf8"); } catch { return ""; }
  })();
  if (!gemini && !receivedSignal && !maxRuntimeHit && exitCode !== 0 && isCodexQuotaFailure(stderrText)) recordCodexExhaustion(spec, stderrText);
  const beforeFinalize = readLedger()[lane];
  const retryQuota = !gemini && !receivedSignal && !maxRuntimeHit && (exitCode !== 0 || Boolean(turnFailureReason)) && Boolean(beforeFinalize?.quotaFailure);
  const reviewModifiedPath = reviewSnapshot ? changedReviewPath(reviewSnapshot, captureReviewTree(spec.cwd)) : undefined;
  const workTreeEndSnapshot = workTreeStartSnapshot ? captureReviewTree(spec.cwd) : undefined;
  const workTreeUnchanged = Boolean(workTreeStartSnapshot && workTreeEndSnapshot && workTreeStartSnapshot.fingerprint === workTreeEndSnapshot.fingerprint);
  // An unchanged tree is evidence for the report, never a verdict: a
  // verification-only round or a supervisor whose children worked in their
  // own worktrees changes nothing here and can still be correct. The gate
  // decides; the head reads diff=empty on the feed line.
  const unchangedWork = Boolean(workTreeUnchanged && beforeFinalize?.kind === "work" && exitCode === 0 && reportOk && !turnFailureReason);

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
  if (spec.gate && beforeFinalize?.kind === "work" && exitCode === 0 && reportOk && !turnFailureReason) {
    setStage("gate");
    feedEvent("gate-started", `[cdx] lane=${lane} round=${round} gate started`, spec.ownerSession, { lane, round });
    const gate = executeGate(spec.gate, spec.cwd, `${ROOT}/logs/${lane}-r${round}.gate.log`);
    gateExit = gate.exitCode;
    gateTimedOut = gate.timedOut;
    setStage("reporting");
    feedEvent("gate-finished", `[cdx] lane=${lane} round=${round} gate finished exit=${gateExit}`, spec.ownerSession, { lane, round });
    writeFileSync(reportPath, `${readFileSync(reportPath, "utf8").trimEnd()}\n\n## Gate\n\n\`${spec.gate}\` exited ${gateExit}\n\n\`\`\`\n${gateOutputForReport(gate.output)}\n\`\`\`\n`);
  }
  if (unchangedWork && existsSync(reportPath)) {
    appendFileSync(reportPath, "\n\n## Harness note\n\nThis round changed no files.\n");
  }
  if (reportOk) feedEvent("report-written", `[cdx] lane=${lane} round=${round} report written`, spec.ownerSession, { lane, round });
  const gateFailed = gateExit !== undefined && gateExit !== 0;
  // A supervisor's round ends with its children. Whatever the outcome, any
  // child still running is stopped so nothing keeps editing after the
  // report; a round that finished with children running cannot be done.
  const orphanedChildren = beforeFinalize?.kind === "work" && beforeFinalize.supervisor && !retryQuota
    ? await killChildren(lane, receivedSignal ? `supervisor ${lane} killed` : maxRuntimeHit ? `supervisor ${lane} hit max runtime` : `supervisor ${lane} round ${round} ended`)
    : [];
  const roundState: ReviewState = exitCode === 0 && reportOk && !gateFailed && !maxRuntimeHit && !reviewModifiedPath && !turnFailureReason && orphanedChildren.length === 0 ? "done" : "failed";
  expireRoundQuestions(lane, round);
  const capturedReport = availableReportPath(lane, round);
  const entry = withLedger((ledger) => {
    const item = ledger[lane]!;
    if (!gemini) invalidateAccountUsage(item.roundAccount);
    if (!retryQuota) item.quotaFailure = undefined;
    if (!item.sessionId && resolvedSessionId) item.sessionId = resolvedSessionId;
    // Ledger kind, not spec.mode, decides work vs review: intent reviews
    // launch with mode "spawn" but must never become the resume target.
    if (item.kind === "work" && item.sessionId) item.workSessionId = item.sessionId;
    let roundNote: string | undefined;
    if (reviewModifiedPath) roundNote = `review modified the tree: ${reviewModifiedPath}`;
    else if (orphanedChildren.length > 0 && !receivedSignal && !maxRuntimeHit) roundNote = `supervisor ended with running children: ${orphanedChildren.join(", ")} (stopped)`;
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
    if (roundState === "failed" && capturedReport?.endsWith(".partial.md")) {
      roundNote = `${singleLine(roundNote ?? "round failed")}; partial report=${capturedReport}`;
    }
    if (unchangedWork) item.diffEmpty = true;
    if (item.kind === "review") {
      item.review!.state = roundState;
      item.review!.exitCode = exitCode;
      item.review!.note = roundNote;
      item.review!.report = capturedReport;
      item.review!.updatedAt = new Date().toISOString();
    } else {
      item.work.state = roundState;
      item.work.exitCode = exitCode;
      item.work.note = roundNote;
      item.work.report = capturedReport;
      item.work.updatedAt = new Date().toISOString();
    }
    item.pid = undefined;
    item.codexPid = undefined;
    if (retryQuota) { item.switchingAccount = true; item.pid = process.pid; }
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
  const finalRoundNote = entry.kind === "review" ? entry.review?.note : entry.work.note;
  const diffToken = entry.diffEmpty ? " diff=empty" : "";
  if (!entry.quotaFailure) feedEvent("terminal", `[cdx] lane=${lane} round=${round} kind=${entry.kind} state=${finalRoundState} exit=${exitCode}${diffToken}${finalRoundNote ? ` note=${finalRoundNote}` : ""} tokens=${fmtTokens(entry.roundTokens ?? entry.tokens)} report=${capturedReport ?? "-"}`, entry.ownerSession, { lane, round });
  console.log(`lane=${color.magenta(lane)} session=${entry.sessionId ?? "?"} round=${round} kind=${entry.kind} state=${coloredState(finalRoundState)} exit=${exitCode} tokens=${fmtTokens(entry.tokens)} report=${capturedReport ?? "-"}`);
  if (finalRoundNote) console.log(`note: ${finalRoundNote}`);
  if (reportOk) {
    console.log("--- report ---");
    console.log(readFileSync(reportPath, "utf8"));
  } else {
    console.log(`--- no report; log tail (${logPath}) ---`);
    console.log(renderTail(logPath, 40));
  }
  return roundState === "done" ? 0 : exitCode || 1;
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
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { from: process.env.CLAUDE_CODE_SESSION_ID } : {}),
  };
  requireOwnChild(lane, readLedger()[lane]);
  const entry = withLedger((ledger) => {
    const current = ledger[lane];
    requireOwnChild(lane, current);
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
  feedEvent("question", `[cdx] lane=${lane} round=${round} QUESTION #${created.record.seq}: ${question} (answer with: cdx reply ${lane} "<answer>")`, owner, { lane, round });
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
  console.log("cdx ask timed out. No approval was received. Continue independent authorized work and report the unresolved dependency; do not guess a required answer.");
}

function replyCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["id"]);
  const [lane, ...parts] = parsed.rest;
  const answer = singleLine(parts.join(" "));
  if (!lane || !answer) fail('usage: cdx reply <lane> [--id <seq>] "<answer>"');
  const requestedId = parsed.flags.id === undefined ? undefined : Number(parsed.flags.id);
  if (requestedId !== undefined && (!Number.isInteger(requestedId) || requestedId < 1)) fail("--id must be a positive integer");
  requireOwnChild(lane, readLedger()[lane]);
  const answered = withLedger((ledger) => {
    requireOwnChild(lane, ledger[lane]);
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
  console.log(`cdx: answered lane=${lane} question #${answered.seq}`);
}

function questionsCommand(argv: string[]): void {
  const [lane, extra] = argv;
  if (extra) fail("usage: cdx questions [lane]");
  const ledger = readLedger();
  if (lane && !ledger[lane]) fail(`unknown lane "${lane}" (cdx status lists lanes)`);
  const open = questionFiles(lane).filter(({ record }) => questionOpen(record) && ledger[record.lane]?.rounds === record.round && owned(ledger[record.lane]?.ownerSession, record.lane));
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
  const caller = callerSession();
  if (caller === "terminal") fail("cdx msg needs a Claude session owner");
  const lane = readLedger()[target];
  const recipient = lane ? recipientOf(lane.ownerSession, target) : target;
  if (recipient === "terminal" || recipient.length <= 8) fail("message target must be a lane name or full session id");
  feedEvent("message", message, caller, { recipient, from: caller });
  console.log(`cdx: message sent to=${recipient} from=${caller}`);
}

function inboxCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["n"]);
  if (parsed.rest.length) fail("usage: cdx inbox [-n <lines>]");
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  const messages = scopedEvents(limit, callerSession(), true);
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
  requireOwnChild(lane, before);
  if (supervisorLane()) fail(`supervisor ${supervisorLane()} may not change a child's gate; the gate is the liaison's acceptance check (cdx ask if it is wrong)`);
  if (laneRunning(before) && pidAlive(before.pid)) fail(`lane "${lane}" is running; stop it before changing the gate`);
  const next = parsed.bools.has("clear") ? undefined : command;
  withLedger((ledger) => {
    const item = ledger[lane]!;
    requireOwnChild(lane, item);
    item.gate = next;
    item.updatedAt = new Date().toISOString();
  });
  printGateChange(lane, before.gate, next);
}

async function spawnCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "worktree", "bg", "add-dir", "image", "schema", "account", "gate", "gate-baseline-check", "max-runtime", "model", "supervisor", "pre"]);
  const engine = engineOf(parsed, "spawn");
  const [lane, briefArg] = parsed.rest;
  const brief = await resolveBrief(briefArg);
  if (!lane || !brief) fail(`usage: cdx spawn <lane> [--engine gpt|gemini] [options] "<brief>"\n\n${ENGINE_PICKER}`);
  validLane(lane);
  const supervisor = parsed.bools.has("supervisor");
  const parent = supervisorLane();
  if (supervisor && engine !== "gpt") fail("--supervisor needs --engine gpt; a supervisor runs on Codex and drives its children through cdx");
  if (supervisor && parent) fail(`supervisor ${parent} cannot spawn another supervisor; delegation is one level deep`);
  // Cheap pre-check so a doomed launch is rejected before paying for usage
  // probes; openRound re-checks under the ledger lock.
  const existingLane = readLedger()[lane];
  if (existingLane && laneRunning(existingLane) && pidAlive(existingLane.pid)) {
    fail(`lane "${lane}" is already running (pid ${existingLane.pid}); pick a new name or wait`);
  }
  // A respawn without --model keeps the lane's model; the config default is
  // for new lanes only.
  const model = existingLane && engine === "gpt" && parsed.flags.model === undefined ? laneModel(existingLane) : modelOf(parsed, engine);
  requireEngineBinary(engine);
  requireGeminiQuota(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gemini" && (parsed.lists.image?.length ?? 0) > 0) fail("--image is not supported for gemini");
  let cwd = parsed.flags.cd ?? (existingLane ? workCwdOf(existingLane) : process.cwd());
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = resolveEffort(engine, model, parsed.flags.effort);
  const maxRuntime = maxRuntimeOf(parsed) ?? defaultMaxRuntime(engine);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  if (parsed.flags.pre !== undefined && parsed.flags.pre.trim() === "") fail("--pre needs a nonempty command");
  if (parsed.bools.has("gate-baseline-check") && parsed.flags.gate === undefined) fail("--gate-baseline-check requires --gate");
  if (existingLane) {
    requireOwnChild(lane, existingLane);
    if (parent && parsed.flags.gate !== undefined && parsed.flags.gate !== existingLane.gate) {
      fail(`supervisor ${parent} may not change a child's gate; ask the liaison if it is wrong`);
    }
    if (existingLane.consult) fail(`lane "${lane}" is a consult lane; spawn work under a new name so its resume stays read-only`);
    rejectEngineMismatch(lane, existingLane, engine);
    if (engine === "gpt") rejectPinnedAccountFlag(lane, existingLane, parsed.flags.account);
  }
  // A respawn keeps the stored gate and cwd unless the caller passes new ones.
  const gate = parsed.flags.gate ?? existingLane?.gate;
  const pre = parsed.flags.pre ?? existingLane?.pre;
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
  // Admission runs before the worktree exists so a refusal strands nothing.
  let worktree: WorktreeInfo | undefined;
  const account = engine === "gpt" ? existingLane ? laneAccount(existingLane) : undefined : undefined;
  if (engine === "gpt" && (existingLane || !config.accounts || parsed.flags.account)) warnCachedUsageBeforeLaunch(account);
  const owner = callerOwnership();
  if (engine === "gemini") {
    const words = brief.trim().split(/\s+/).filter(Boolean).length;
    if (words > 1500) {
      const warning = `cdx: gemini brief is ${words} words; gemini works best on one outcome per lane, consider splitting into parallel lanes`;
      console.error(warning);
    }
  }
  if (pre) runPreCheck(pre, cwd);
  const { round, selection } = await openRound(lane, "work", cwd, effort, {
    engine, forcedAccount: parsed.flags.account, ...(existingLane && engine === "gpt" ? { preserveAccount: true as const } : engine === "gpt" ? { account } : {}), owner, worktree, gate, pre,
    ...(model ? { model } : {}), lineage: callerLineage(supervisor),
  });
  if (parsed.flags.worktree) {
    try {
      worktree = createWorktree(cwd, parsed.flags.worktree, lane);
      cwd = worktree.path;
      withLedger((ledger) => {
        const item = ledger[lane]!;
        item.work.cwd = cwd;
        Object.assign(item, { worktreePath: worktree!.path, worktreeRepo: worktree!.repo, branch: worktree!.branch });
      });
    } catch (error) {
      withLedger((ledger) => failActiveRound(lane, ledger[lane]!, `worktree setup failed: ${error}`));
      throw error;
    }
  }
  if (selection) announceAccountSelection(lane, selection);
  const fullBrief = `Ground rules:\n${houseRules(cwd, false, engine, { supervisor })}\n\nTask:\n${brief}`;
  const gateBaselineChecked = Boolean(gate && parsed.bools.has("gate-baseline-check"));
  if (gateBaselineChecked) {
    const baselineLog = `${ROOT}/logs/${lane}-r${round}.gate-baseline.log`;
    console.log(`cdx: gate baseline check cwd=${cwd} cmd=${gate}`);
    const result = executeGate(gate!, cwd, baselineLog);
    const checkedAt = new Date().toISOString();
    withLedger((ledger) => {
      ledger[lane]!.gateBaseline = { round, command: gate!, cwd, exitCode: result.exitCode, checkedAt };
    });
    if (result.exitCode !== 0) {
      writeFileSync(`${ROOT}/briefs/${lane}-r${round}.md`, fullBrief);
      finishInvalidBaseline(lane, round, gate!, cwd, result);
      process.exitCode = 1;
      return;
    }
    console.log(`cdx: gate baseline passed cwd=${cwd}`);
  }
  return launch({
    effort, engine, mode: "spawn", lane, round, cwd, prompt: fullBrief, model: engine === "gemini" ? (config.gemini ?? geminiConfig()).model : model,
    ...(supervisor ? { supervisor: true as const } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    ...(images.length ? { images } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(gate ? { gate } : {}),
    ...(gateBaselineChecked ? { gateBaselineChecked: true as const } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...accountSpec(account), ...ownershipSpec(owner),
  }, fullBrief, parsed.bools.has("bg"));
}

async function resumeCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "gate", "bg", "max-runtime", "account", "pre"]);
  const [lane, followUpArg] = parsed.rest;
  const followUp = await resolveBrief(followUpArg);
  if (!lane || !followUp) fail('usage: cdx resume <lane> [--effort <effort>] [--bg] [--max-runtime <min>] [--pre <cmd>] "<follow-up>"');
  const before = readLane(lane);
  requireOwnChild(lane, before);
  if (supervisorLane() && parsed.flags.gate !== undefined && parsed.flags.gate !== before.gate) {
    fail(`supervisor ${supervisorLane()} may not change a child's gate; ask the liaison if it is wrong`);
  }
  const engine = laneEngine(before);
  const maxRuntime = maxRuntimeOf(parsed) ?? defaultMaxRuntime(engine);
  requireEngineBinary(engine);
  requireGeminiQuota(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gpt") rejectPinnedAccountFlag(lane, before, parsed.flags.account);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  if (parsed.flags.pre !== undefined && parsed.flags.pre.trim() === "") fail("--pre needs a nonempty command");
  const workRounds = before.workRounds ?? before.rounds;
  checkRoundCap(lane, engine, workRounds);
  const owner = storedOwnership(before);
  const effort = resolveEffort(engine, laneModel(before), parsed.flags.effort, before.effort);
  // Resume targets the lane's work thread even when the latest round was a
  // review; only a lane that never had a work session continues read-only.
  const workThread = before.workSessionId ?? (before.kind === "work" ? before.sessionId : undefined);
  const reviewResume = workThread === undefined || Boolean(before.consult);
  const account = engine === "gpt" ? reviewResume ? before.roundAccount ?? laneAccount(before) : laneAccount(before) : undefined;
  if (engine === "gpt") warnCachedUsageBeforeLaunch(account);
  const cwd = workCwdOf(before);
  const pre = parsed.flags.pre ?? before.pre;
  if (pre) runPreCheck(pre, cwd);
  const partialPath = partialReportPathOf(lane, before.rounds);
  const partial = roundStateOf(before) === "failed" && existsSync(partialPath) ? readFileSync(partialPath, "utf8").trim() : "";
  const { round, sessionId, selection } = await openRound(lane, reviewResume ? "review" : "work", cwd, effort, {
    engine, account, preserveEngine: true, requireSession: true, preserveAccount: engine === "gpt", preserveOwner: true,
    preserveGate: parsed.flags.gate === undefined,
    ...(parsed.flags.gate !== undefined ? { gate: parsed.flags.gate } : {}),
    preservePre: parsed.flags.pre === undefined,
    ...(parsed.flags.pre !== undefined ? { pre: parsed.flags.pre } : {}),
    ...(workThread ? { sessionOverride: workThread } : {}),
  });
  if (selection) announceAccountSelection(lane, selection);
  if (parsed.flags.gate !== undefined) printGateChange(lane, before.gate, parsed.flags.gate);
  const structuredInstruction = reviewResume && engine === "gemini"
    ? "\n\nYour final answer is captured as structured output: put the complete markdown report in the report field and every finding in the findings array (empty when clean)."
    : "";
  const previousRound = partial ? `\n\nYour previous round ended with this partial report at ${partialPath}; continue from it, do not redo completed work:\n${partial}` : "";
  const prompt = `Ground rules:\n${houseRules(cwd, reviewResume, engine, { supervisor: Boolean(before.supervisor) })}${previousRound}\n\nTask:\n${followUp}${structuredInstruction}`;
  // The resolved effort always travels with the turn: a resumed session would
  // otherwise keep the effort it was created with, cap or no cap.
  const codexArgs = reviewResume && engine === "gpt"
    ? ["exec", "resume", "-c", `model_reasoning_effort=${effort}`, "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "--skip-git-repo-check", sessionId!, prompt]
    : undefined;
  const gate = parsed.flags.gate ?? before.gate;
  return launch({
    effort, engine, model: engine === "gpt" ? laneModel(before) : undefined, mode: "resume", lane, round, cwd, prompt,
    ...(before.supervisor ? { supervisor: true as const } : {}),
    ...(codexArgs ? { codexArgs, reviewDir: cwd } : { sourceThreadId: sessionId }),
    ...(reviewResume && engine === "gemini" ? { reviewDir: cwd, outputSchema: REVIEW_FINDINGS_SCHEMA } : {}),
    ...(!reviewResume && gate ? { gate } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...accountSpec(account), ...ownershipSpec(owner),
  }, prompt, parsed.bools.has("bg"));
}

async function forkCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "bg", "account", "model"]);
  const [newLane, source, briefArg] = parsed.rest;
  const brief = await resolveBrief(briefArg);
  if (!newLane || !source || !brief) fail('usage: cdx fork <newLane> <fromLane|sessionId> [--bg] "<brief>"');
  validLane(newLane);
  const ledger = readLedger();
  const sourceLane = ledger[source];
  if (sourceLane && laneEngine(sourceLane) === "gemini") fail("gemini has no headless fork; use cdx resume");
  if (sourceLane && parsed.flags.model !== undefined) fail(`fork inherits the source lane's model (${laneModel(sourceLane)}); drop --model`);
  const model = sourceLane ? laneModel(sourceLane) : modelOf(parsed, "gpt")!;
  const sessionId = sourceLane
    ? sourceLane.workSessionId ?? sourceLane.sessionId ?? source
    : source;
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) fail(`"${source}" is neither a lane with a session nor a session UUID`);
  const effort = resolveEffort("gpt", model, parsed.flags.effort, sourceLane?.effort);
  let account: AccountChoice | undefined;
  if (sourceLane) {
    rejectPinnedAccountFlag(source, sourceLane, parsed.flags.account);
    account = laneAccount(sourceLane);
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
  const { round, selection } = await openRound(newLane, "work", cwd, effort, { engine: "gpt", account, owner, model, forcedAccount: sourceLane ? parsed.flags.account : account?.name });
  const prompt = `Ground rules:\n${houseRules(cwd, false)}\n\nTask:\n${brief}`;
  return launch({ effort, engine: "gpt", mode: "fork", lane: newLane, round, cwd, prompt, ...(sourceLane ? { sourceLane: source } : { model }), sourceThreadId: sessionId, ...accountSpec(account), ...ownershipSpec(owner) }, prompt, parsed.bools.has("bg"));
}

// consult: a read-only gpt lane framed as an advisor rather than a hostile
// reviewer. It shares the exec review path (read-only sandbox, report as the
// last message) and resumes read-only for follow-up questions.
async function consultCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["model", "effort", "cd", "bg", "account"]);
  const [lane, questionArg] = parsed.rest;
  if (!lane || !questionArg) fail('usage: cdx consult <lane> [--model M] [--effort E] [--cd <dir>] [--bg] "<question>"');
  return reviewCommand(["--engine", "gpt", ...argv], { consult: true });
}

async function reviewCommand(argv: string[], opts: { consult?: boolean } = {}) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "bg", "uncommitted", "base", "commit", "scope", "account", "model"]);
  const engine = engineOf(parsed, "review");
  const [lane, intentArg] = parsed.rest;
  const intent = await resolveBrief(intentArg);
  if (!lane) fail('usage: cdx review <lane> [--uncommitted | --base <branch> | --commit <sha>] [--scope "<files>"] ["<intent>"]');
  validLane(lane);
  if (opts.consult && engine !== "gpt") fail("consult runs on gpt only");
  requireEngineBinary(engine);
  requireGeminiQuota(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  const existing = readLedger()[lane];
  const parent = supervisorLane();
  requireOwnChild(lane, existing);
  if (existing && laneEngine(existing) === "gpt" && parsed.flags.model !== undefined) fail(`review of an existing lane uses its model (${laneModel(existing)}); drop --model`);
  // A consult lane must never acquire a work thread: resume would then pick
  // the writable session over the read-only one. Fresh names only.
  if (opts.consult && existing && !existing.consult) fail(`lane "${lane}" has work history; consult needs a fresh name so its resume stays read-only`);
  const model = engine === "gpt" ? existing && laneEngine(existing) === "gpt" ? laneModel(existing) : modelOf(parsed, "gpt")! : undefined;
  const roundModel = model && !existing ? { model } : {};
  const roundParent = !existing ? { lineage: callerLineage(false) } : {};
  if (existing && laneEngine(existing) === "gemini" && engine === "gemini") {
    console.log(color.yellow("cdx: gemini reviewing a gemini lane; give the intent explicit attack items"));
  }
  const cwd = parsed.flags.cd ?? (existing ? workCwdOf(existing) : process.cwd());
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = resolveEffort(engine, model, parsed.flags.effort);
  const targets = [parsed.bools.has("uncommitted") ? "--uncommitted" : "", parsed.flags.base ? "base" : "", parsed.flags.commit ? "commit" : ""].filter(Boolean);
  if (targets.length > 1) fail("pick exactly one of --uncommitted, --base, --commit");
  if (targets.length === 1 && intent) fail("native review targets (--uncommitted/--base/--commit) cannot carry a custom intent; drop it or drop the target flag");
  if (targets.length === 1 && parsed.flags.scope) fail("--scope only applies to exec review (native review always covers the whole target diff)");
  if (targets.length === 0 && !intent) fail("exec review needs an intent (or pass a native target flag)");
  const preserveAccount = Boolean(existing && (laneEngine(existing) === "gpt" || existing.account || existing.codexHome));
  if (preserveAccount && engine === "gpt") rejectPinnedAccountFlag(lane, existing!, parsed.flags.account);
  const account = engine === "gpt" ? preserveAccount ? laneAccount(existing!) : undefined : undefined;
  if (engine === "gpt" && (preserveAccount || !config.accounts || parsed.flags.account)) warnCachedUsageBeforeLaunch(account);
  const roundAccount = { forcedAccount: parsed.flags.account, ...(engine === "gpt" && !preserveAccount ? { account } : existing ? { preserveAccount: true as const } : {}) };

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
      const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundParent });
      return launch({ effort, engine, model, mode: "review-native", lane, round, cwd, reviewDir: cwd, prompt: fullBrief, outputSchema: REVIEW_FINDINGS_SCHEMA, ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
    }
    // Native `codex review`: purpose-built diff review. It rejects a custom
    // prompt alongside a target, so the adversarial frame stays home.
    const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundModel, ...roundParent });
    if (selection) announceAccountSelection(lane, selection);
    const codexArgs = [
      "review", "-c", `review_model=${JSON.stringify(model)}`, "-c", `model_reasoning_effort=${effort}`,
      "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
    ];
    if (parsed.bools.has("uncommitted")) codexArgs.push("--uncommitted");
    if (parsed.flags.base) codexArgs.push("--base", parsed.flags.base);
    if (parsed.flags.commit) codexArgs.push("--commit", parsed.flags.commit);
    const label = parsed.bools.has("uncommitted") ? "uncommitted changes" : parsed.flags.base ? `diff vs ${parsed.flags.base}` : `commit ${parsed.flags.commit}`;
    return launch({ effort, engine, model, mode: "review-native", lane, round, cwd, reviewDir: cwd, prompt: `native review of ${label}`, codexArgs, ...accountSpec(account), ...ownershipSpec(owner) }, `native review of ${label}`, parsed.bools.has("bg"));
  }

  const owner = callerOwnership();
  const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundModel, ...roundParent, ...(opts.consult ? { consult: true as const } : {}) });
  if (selection) announceAccountSelection(lane, selection);
  const scope = parsed.flags.scope
    ? `\nScope: review EXACTLY these files, ignore all other dirty files (other lanes own them): ${parsed.flags.scope}`
    : "";
  const frame = opts.consult ? CONSULT_FRAME : reviewFrame(engine) + scope;
  const fullBrief = [frame, `Ground rules:\n${houseRules(cwd, true, engine)}`, `Task:\n${intent}`].join("\n\n");
  // Reviews are read-only: enforce it with the sandbox, not just the prompt.
  const codexArgs = engine === "gpt" ? [
    "exec", "--json", "-m", model!, "-c", `model_reasoning_effort=${effort}`,
    "-s", "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check", "--cd", cwd,
    "--output-last-message", reportPathOf(lane, round), fullBrief,
  ] : undefined;
  return launch({ effort, engine, model, mode: "spawn", lane, round, cwd, reviewDir: cwd, prompt: fullBrief, ...(engine === "gemini" ? { outputSchema: REVIEW_FINDINGS_SCHEMA } : {}), ...(codexArgs ? { codexArgs } : {}), ...(engine === "gpt" ? accountSpec(account) : {}), ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
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

function statusText(text: string, limit: number): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

function porcelainFileCount(output: string): number {
  const records = output.split("\0");
  let count = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    count += 1;
    if (/[RC]/.test(record.slice(0, 2))) index += 1;
  }
  return count;
}

function changedFileCount(cwd: string): number | undefined {
  try {
    const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore", stderr: "ignore", timeout: 1000, killSignal: "SIGKILL", maxBuffer: 1_048_576 });
    return result.success ? porcelainFileCount(result.stdout.toString()) : undefined;
  } catch { return undefined; }
}

function statusAge(iso: string | undefined, now: number): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "-";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
}

function laneProgress(entry: Lane, files: number | undefined, now = Date.now()): string {
  const stage = entry.stage === "gate" ? `gate running ${statusAge(entry.stageStartedAt, now)}` : entry.stage ?? "working";
  return `${entry.roundSteps ?? 0} steps${files === undefined ? "" : ` ${files} files`} ${stage} last ${statusAge(entry.lastActionAt ?? entry.lastEventAt, now)} ${statusText(entry.lastAction ?? "-", 160)}`;
}

function renderLaneBlock(lane: string, entry: Lane): string {
  const active = laneRunning(entry);
  const stale = active && !pidAlive(entry.pid);
  const record = entry.consult ? entry.review! : entry.work;
  const workState = record.state;
  const state = (entry.consult || entry.kind === "work") && stale ? "running(dead?)" : workState;
  const workRound = record.round ?? (entry.kind === "work" ? entry.rounds : undefined);
  const engine = laneEngine(entry);
  const steerMode = entry.kind === "work" && active && engine === "gemini"
    ? `  steer=${entry.hooksActive ? "in-turn" : "follow-up"}`
    : "";
  const steerDetail = entry.kind === "work" && active ? `  steers=${entry.steers ?? 0}` : "";
  const continueDetail = (entry.continuations ?? 0) > 0 ? `  auto-continued ${entry.continuations}x` : "";
  const modelDetail = engine === "gpt" && entry.model ? `  model=${entry.model}` : "";
  const roleDetail = entry.supervisor ? "  supervisor" : entry.parent ? `  parent=${entry.parent}` : "";
  const first = `${color.magenta(lane)}  ${coloredState(state)}  ${entry.consult ? "consult" : "work"}${workRound ? ` r${workRound}` : ""}  engine=${engine}${modelDetail}${roleDetail}  ${entry.effort}${entry.account ? `  account=${entry.account}` : ""}${steerMode}${steerDetail}${continueDetail}`;
  const line = (label: string, value: string) => `${color.dim(`  ${label.padEnd(12)}`)}${value}`;
  let owner = "-";
  if (entry.ownerCwd || entry.ownerSession || readSessions().lanes[lane]) {
    const currentSession = process.env.CLAUDE_CODE_SESSION_ID?.trim();
    const resolvedOwner = recipientOf(entry.ownerSession, lane);
    const ownerId = resolvedOwner === "terminal" ? "terminal" : resolvedOwner.slice(0, 8);
    const relation = resolvedOwner === "terminal" || !currentSession ? "(terminal)"
      : resolvedOwner === currentSession ? "(this session)" : "(other session)";
    owner = `${ownerId} ${relation}  from ${entry.ownerCwd ? displayPath(entry.ownerCwd) : "-"}`;
  }
  const timing = workState === "running"
    ? `running ${fmtAge(entry.roundStartedAt ?? entry.createdAt)} · idle ${fmtAge(entry.lastEventAt ?? entry.roundStartedAt ?? entry.createdAt)}`
    : `finished ${fmtAge(record.updatedAt ?? entry.updatedAt)} ago`;
  const laneDetail = `cwd ${displayPath(workCwdOf(entry))}${entry.branch ? ` · worktree ${entry.branch}` : ""} · created ${fmtCreated(entry.createdAt)} · ${timing}`;
  const tokenLabel = active && entry.roundTokens
    ? `${fmtTokens(entry.roundTokens)} round / ${fmtTokens(entry.tokens)} total`
    : fmtTokens(entry.tokens);
  const tokenDetail = `${tokenLabel} · ${engine === "gemini" ? "gemini conversation" : "codex session"} ${(entry.workSessionId ?? entry.sessionId)?.slice(0, 8) ?? "-"}`;
  const report = record.report ?? (entry.kind === "work" ? entry.reports.at(-1) : undefined);
  const lastParts = [entry.diffEmpty ? "no tree change" : undefined, record.note, report ? `report ${displayPath(report)}` : undefined].filter(Boolean);
  const last = (entry.consult || entry.kind === "work") && active ? entry.lastAction ?? "-"
    : lastParts.join(" · ") || "-";
  const lines = [first, line("owner", owner), line("lane", laneDetail), line("tokens", tokenDetail), line("last", last)];
  if (active) lines.push(line("progress", laneProgress(entry, changedFileCount(entry.kind === "review" ? entry.review?.cwd ?? entry.work.cwd : entry.work.cwd))));
  const waiting = questionFiles(lane).find(({ record }) => record.round === entry.rounds && questionOpen(record));
  if (active && waiting) lines.push(line("question", `waiting on question #${waiting.record.seq}: ${waiting.record.question}`));
  if (entry.review?.state && !entry.consult) {
    const reviewState = entry.kind === "review" && stale ? "running(dead?)" : entry.review?.state;
    const reviewTiming = entry.review?.state === "running"
      ? `running ${fmtAge(entry.roundStartedAt)} · idle ${fmtAge(entry.lastEventAt ?? entry.roundStartedAt)}`
      : `finished ${fmtAge(entry.review?.updatedAt)} ago`;
    const reviewLast = entry.review?.state === "running" ? entry.lastAction ?? "-"
      : [entry.review?.note, entry.review?.report ? `report ${displayPath(entry.review?.report)}` : undefined].filter(Boolean).join(" · ") || "-";
    const label = entry.consult ? "consult" : "review";
    lines.push(line(label, `${coloredState(reviewState)}${entry.review?.round ? ` r${entry.review?.round}` : ""} · cwd ${displayPath(entry.review?.cwd ?? workCwdOf(entry))} · ${reviewTiming}`));
    lines.push(line(`${label} last`, reviewLast));
  }
  return lines.join("\n");
}

const FINISHED_SHOWN = 10;

function jobPhaseText(tail: string): string {
  return statusText(tail.split("\n").filter((line) => line.trim()).at(-1) ?? "", 80);
}

function jobPhase(log: string): string {
  try { return jobPhaseText(readTailLines(log, 1, (line) => line.trim().length > 0).join("\n")); }
  catch { return ""; }
}

function statusBrief(ledger: Ledger, jobs: Jobs, io: {
  files: (cwd: string) => number | undefined;
  phase: (log: string) => string;
  ownsJob: (job: Job) => boolean;
  now: number;
}): string {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(ledger)) {
    if (!laneRunning(entry)) continue;
    const cwd = entry.kind === "review" ? entry.review?.cwd ?? entry.work.cwd : entry.work.cwd;
    lines.push(statusText(`${statusText(name, 24)} ${laneProgress(entry, io.files(cwd), io.now)}`, 99));
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (!jobRunning(job) || !io.ownsJob(job)) continue;
    lines.push(statusText(`job ${statusText(name, 24)} ${statusAge(job.startedAt, io.now)} ${io.phase(job.log) || "-"}`, 99));
  }
  return lines.join("\n");
}

export { changedFileCount, jobPhase, jobPhaseText, laneProgress, porcelainFileCount, statusBrief, statusText };

async function statusCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["json", "all", "brief", "watch", "interval"]);
  if (parsed.rest.length) fail("usage: cdx status [--all | --json | --brief | --watch [--interval S]]");
  const watch = parsed.bools.has("watch");
  const interval = Number(parsed.flags.interval ?? 2);
  if (!Number.isFinite(interval) || interval <= 0 || interval > 2_147_483) fail("--interval must be positive seconds below 2147483");
  if (parsed.flags.interval !== undefined && !watch) fail("--interval requires --watch");
  if (parsed.bools.has("json") && (watch || parsed.bools.has("brief"))) fail("--json cannot be combined with --brief or --watch");
  if (parsed.bools.has("all") && (watch || parsed.bools.has("brief"))) fail("--all lists finished jobs; --brief and --watch show only running work");
  if (watch || parsed.bools.has("brief")) {
    const render = () => statusBrief(readLedger(), readJobs(), { files: changedFileCount, phase: jobPhase, ownsJob: (job) => owned(job.ownerSession), now: Date.now() });
    if (!watch) { const text = render(); if (text) console.log(text); return; }
    process.stdout.write(`\x1b[H\x1b[2J${render()}\n`);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearInterval(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
      const stop = () => { cleanup(); resolve(); };
      const timer = setInterval(() => {
        try { process.stdout.write(`\x1b[H\x1b[2J${render()}\n`); }
        catch (error) { cleanup(); reject(error); }
      }, interval * 1000);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return;
  }
  const ledger = readLedger();
  const all = Object.entries(ledger);
  if (parsed.bools.has("json")) {
    const enriched = Object.fromEntries(all.map(([lane, entry]) => [lane, { ...entry, engine: laneEngine(entry), alive: laneRunning(entry) ? pidAlive(entry.pid) : undefined }]));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  const quotaState = geminiQuotaState();
  if (quotaState.block) {
    console.log(color.yellow(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`));
  }
  if (all.length === 0) { console.log("cdx: no lanes"); printRunningJobs(); return; }
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
  printRunningJobs();
}

async function waitCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["timeout", "json", "report"]);
  const json = parsed.bools.has("json");
  const showReport = parsed.bools.has("report");
  const names = parsed.rest;
  const multiple = new Set(names).size > 1;
  const completedReports: { lane: string; entry: Lane }[] = [];
  if (names.length === 0) fail("usage: cdx wait <lane|job>... [--timeout <sec>] [--json] [--report]");
  const knownLanes = readLedger();
  const knownJobs = readJobs();
  const lanes = names.filter((name) => knownLanes[name]);
  const jobNames = names.filter((name) => !knownLanes[name]);
  for (const name of jobNames) if (!knownJobs[name]) fail(`"${name}" is neither a lane in ${LEDGER} nor a job in ${JOBS}`);
  const timeoutMs = Number(parsed.flags.timeout ?? 7200) * 1000;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(lanes);
  const pendingJobs = new Set(jobNames);
  const reportTextOf = (entry: Lane): string | undefined => {
    const path = roundReportOf(entry);
    try { return path ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
  };
  // --json prints one JSON object per finished lane, in completion order.
  const emitJson = (lane: string, entry: Lane, error?: string) => console.log(JSON.stringify({
    lane, engine: roundEngine(entry), work: entry.work, review: entry.review, roundState: roundStateOf(entry), kind: entry.kind,
    exitCode: roundExitCodeOf(entry) ?? null, tokens: entry.tokens ?? null,
    report: roundReportOf(entry) ?? null, note: roundNoteOf(entry) ?? null, sessionId: entry.sessionId ?? null,
    rounds: entry.rounds, ...(showReport ? { reportText: reportTextOf(entry) ?? null } : {}),
    ...(error ? { error } : {}),
  }));
  let failed = false;
  if (!json && multiple) console.log(`cdx: waiting for ${[...new Set(names)].join(", ")}`);
  while (pending.size > 0 || pendingJobs.size > 0) {
    const ledger = readLedger();
    // A waited lane that asks a question is blocked, not busy: return at
    // once (exit 2) so the caller answers instead of both sides idling.
    const questions = [...pending].flatMap((lane) => questionFiles(lane).filter(({ record }) => questionOpen(record) && ledger[lane]?.rounds === record.round).map(({ record }) => record));
    if (questions.length > 0) {
      for (const record of questions) {
        if (json) console.log(JSON.stringify({ lane: record.lane, round: record.round, question: record.seq, text: record.question }));
        else console.log(`cdx: lane=${color.magenta(record.lane)} round=${record.round} ${color.yellow(`QUESTION #${record.seq}`)}: ${record.question} (answer with: cdx reply ${record.lane} "<answer>", then cdx wait again)`);
      }
      process.exit(2);
    }
    for (const lane of [...pending]) {
      const entry = ledger[lane]!;
      if (laneRunning(entry) && pidAlive(entry.pid)) continue;
      if (laneRunning(entry)) {
        if (json) emitJson(lane, entry, "runner died without finalizing");
        else console.log(`cdx: lane=${color.magenta(lane)} state=failed report=${availableReportPath(lane, entry.rounds) ?? "-"} ${color.red("runner died without finalizing")} (see cdx doctor)`);
        failed = true;
      } else {
        if (json) emitJson(lane, entry);
        else {
          console.log(`cdx: lane=${color.magenta(lane)} engine=${roundEngine(entry)} kind=${entry.kind} state=${coloredState(roundStateOf(entry))} exit=${roundExitCodeOf(entry) ?? "?"} tokens=${fmtTokens(entry.tokens)} report=${roundReportOf(entry) ?? "-"}`);
          if (showReport && multiple) completedReports.push({ lane, entry });
          if (showReport && !multiple) {
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
    if (pendingJobs.size > 0) {
      for (const name of [...pendingJobs]) {
        const job = settledJob(name);
        if (!job) continue;
        if (json) console.log(JSON.stringify({ job: name, state: job.state, exitCode: job.exitCode ?? null, log: job.log, note: job.note ?? null, cwd: job.cwd, cmd: job.cmd }));
        else console.log(`cdx: ${renderJobLine(name, job)}${multiple ? ` report=${job.log}` : ""}`);
        if (job.state === "failed") failed = true;
        pendingJobs.delete(name);
      }
    }
    if (pending.size === 0 && pendingJobs.size === 0) break;
    if (Date.now() > deadline) fail(`timeout waiting for: ${[...pending, ...pendingJobs].join(", ")}`);
    await Bun.sleep(5000);
  }
  if (!json && multiple) {
    console.log(`cdx: waited for ${new Set(names).size} targets; state=${failed ? "failed" : "done"}`);
    for (const { lane, entry } of completedReports) {
      const text = reportTextOf(entry);
      if (text) console.log(`--- report ${color.magenta(lane)} ---\n${text.trimEnd()}\n--- end ${color.magenta(lane)} ---`);
    }
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

interface Cursor { committedOffset?: number; round: number; path: string; offset: number; buffer: string; json: boolean; decoder: TextDecoder }

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
    if (cursor.committedOffset !== undefined) cursor.committedOffset += Buffer.byteLength(line + "\n");
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
        console.log(`${color.magenta(`[${lane}]`)} --- attached (round ${cursor.round}, ${entry.effort}, ${entry.kind === "review" ? entry.review?.cwd ?? workCwdOf(entry) : workCwdOf(entry)}) ---`);
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
  // Every window the probe returned; the folded fields above keep the most
  // consumed one, the advisor needs the weekly one for its deadline.
  windows?: RateLimitWindow[];
  warnedAt?: string;
  probeFailedAt?: string;
  invalidatedAt?: string;
  exhaustedUntil?: number;
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
        for await (const message of readJsonLines(proc!.stdout)) {
          if (message.id === 2) return message;
        }
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
    && (snapshot.probeFailedAt === undefined || typeof snapshot.probeFailedAt === "string")
    && (snapshot.windows === undefined || (Array.isArray(snapshot.windows) && snapshot.windows.every(isRateLimitWindow)));
}

type UsageState = Record<string, any>;

function readUsageState(): UsageState {
  try {
    const value = JSON.parse(readFileSync(USAGE_PATH, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function usageSnapshotFrom(state: UsageState, account?: AccountChoice): UsageSnapshot | undefined {
  const snapshot = account ? state.accounts?.[account.name] : state;
  return isUsageSnapshot(snapshot) ? snapshot : undefined;
}

function readUsageSnapshot(account?: AccountChoice): UsageSnapshot | undefined {
  return usageSnapshotFrom(readUsageState(), account);
}

function storeUsageSnapshot(state: UsageState, snapshot: UsageSnapshot, account?: AccountChoice): void {
  const accounts = account && state.accounts && typeof state.accounts === "object" && !Array.isArray(state.accounts)
    ? Object.fromEntries(Object.entries(state.accounts).filter((entry) => isUsageSnapshot(entry[1]))) : {};
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, account ? { accounts: { ...accounts, [account.name]: snapshot } } : snapshot);
}

// Every usage mutation reads and merges under this lock, including warning
// deduplication and failed probes. No nested or separate writer lock.
function withUsageState<T>(mutate: (state: UsageState) => T): T {
  return withLockedJson(USAGE_PATH, `${ROOT}/.usage.lock`, readUsageState, mutate);
}

function writeUsageSnapshot(snapshot: UsageSnapshot, account?: AccountChoice) {
  withUsageState((state) => storeUsageSnapshot(state, snapshot, account));
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
    windows,
  };
}

function usageFeedWarning(snapshot: UsageSnapshot, account?: AccountChoice): string {
  const credit = snapshot.resetCreditsAvailable > 0 ? ", reset credit available" : "";
  const owner = account ? `usage for account ${account.name}` : "usage";
  return `[cdx] WARNING: OpenAI Codex ${owner} ${snapshot.usedPercent}% consumed (${rateLimitWindowName(snapshot.windowDurationMins)} window, resets ${rateLimitResetDate(snapshot.resetsAt)})${credit}`;
}

async function refreshUsageSnapshot(options: { warnFeed?: boolean; account?: AccountChoice; ownerSession?: string } = {}): Promise<RefreshedUsage | undefined> {
  const probeStartedAt = Date.now();
  const usage = await readAccountUsage(options.account?.home);
  if (!usage) {
    // Negative-cache the failure so a hung app-server does not cost every
    // subsequent launch a fresh probe timeout (accountSnapshot honors this
    // marker for 5 minutes).
    withUsageState((state) => {
      const previous = usageSnapshotFrom(state, options.account);
      storeUsageSnapshot(state, {
        checkedAt: new Date(0).toISOString(),
        usedPercent: 0,
        windowDurationMins: 0,
        resetsAt: 0,
        planType: "unknown",
        resetCreditsAvailable: 0,
        reached: false,
        ...previous,
        ...(previous?.invalidatedAt ? { checkedAt: new Date(0).toISOString(), invalidatedAt: undefined } : {}),
        probeFailedAt: new Date().toISOString(),
      }, options.account);
    });
    return undefined;
  }
  const fresh = snapshotFromAccountUsage(usage);
  const stored = withUsageState((state) => {
    const previous = usageSnapshotFrom(state, options.account);
    const previousIsNewer = previous && (Date.parse(previous.checkedAt) > Date.parse(fresh.checkedAt) || Date.parse(previous.invalidatedAt ?? "") >= probeStartedAt);
    let snapshot = previousIsNewer ? previous : {
      ...fresh,
      ...(previous?.exhaustedUntil && previous.exhaustedUntil * 1000 > Date.now() ? { exhaustedUntil: previous.exhaustedUntil } : {}),
      ...(previous?.warnedAt ? { warnedAt: previous.warnedAt } : {}),
    };
    if (options.warnFeed && snapshotReached(snapshot)) {
      const warnedAt = snapshot.warnedAt ? Date.parse(snapshot.warnedAt) : Number.NaN;
      if (!Number.isFinite(warnedAt) || Date.now() - warnedAt >= 3_600_000) {
        const warned = { ...snapshot, warnedAt: new Date().toISOString() };
        storeUsageSnapshot(state, warned, options.account);
        feedEvent("account", usageFeedWarning(warned, options.account), options.ownerSession);
        return warned;
      }
    }
    storeUsageSnapshot(state, snapshot, options.account);
    return snapshot;
  });
  return { usage, snapshot: stored };
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
interface AccountSelection { choice?: AccountChoice; skipped: ReachedAccount[]; pick?: AccountStanding; demand?: Demand }

// Fixed allowances guide placement; they are not completion budgets.
type Demand = "light" | "work" | "supervisor";
// Owner ruling 2026-09-11: the risk line is 3% remaining, for every lane kind;
// the allowance is a placement hint and never a refusal on its own.
const HEADROOM_PERCENT: Record<Demand, number> = { light: 3, work: 3, supervisor: 3 };
// A usage reading serves this long before the next launch probes again.
const USAGE_CACHE_MS = 30 * 60 * 1000;
const DEMAND_LABEL: Record<Demand, string> = { light: "consult/review", work: "work", supervisor: "supervisor" };

interface AccountStanding {
  choice: AccountChoice;
  snapshot?: UsageSnapshot;
  // The longest window the probe returned, weekly on ChatGPT plans. Its reset
  // is the deadline: whatever is unspent then is lost.
  weekly?: RateLimitWindow;
  remainingPercent: number;
  // Percent of the weekly window per day that spends the remainder exactly at
  // reset; a pace far above real burn means the window will expire unused.
  paceToEmpty?: number;
  reached: boolean;
  reason: string;
}

function fmtUntil(unixSeconds: number): string {
  const ms = unixSeconds * 1000 - Date.now();
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${(minutes / 1440).toFixed(1)}d`;
}

// The longest returned window supplies weekly headroom on subscription plans.
function weeklyWindow(snapshot: UsageSnapshot): RateLimitWindow | undefined {
  const windows = snapshot.windows ?? [];
  if (windows.length === 0) return undefined;
  return windows.reduce((longest, window) => window.windowDurationMins > longest.windowDurationMins ? window : longest);
}

// A snapshot stops being evidence once any of its windows has reset: the
// percentages belong to the old window.
function snapshotExpired(snapshot: UsageSnapshot): boolean {
  const now = Date.now();
  return (snapshot.windows ?? [snapshot]).some((window) => window.resetsAt * 1000 <= now);
}

function unknownStanding(choice: AccountChoice, reason: string): AccountStanding {
  return { choice, remainingPercent: 0, reached: false, reason: `usage unknown: ${reason}` };
}

function standingOf(choice: AccountChoice, snapshot: UsageSnapshot | undefined): AccountStanding {
  const now = Date.now();
  if (snapshot?.exhaustedUntil && snapshot.exhaustedUntil * 1000 > now) return {
    choice, snapshot, reached: true, remainingPercent: 0,
    reason: `quota exhausted; resets ${new Date(snapshot.exhaustedUntil * 1000).toISOString()}`,
  };
  if (snapshot?.invalidatedAt) return unknownStanding(choice, "consuming round ended; refresh required");
  if (!snapshot || snapshot.planType === "unknown") return unknownStanding(choice, "probe failed; codex login?");
  const weekly = weeklyWindow(snapshot);
  if (!weekly) return unknownStanding(choice, "snapshot has no quota windows; run cdx usage");
  if (weekly.resetsAt * 1000 <= now) return unknownStanding(choice, `window reset ${fmtAge(new Date(weekly.resetsAt * 1000).toISOString())} ago, probe failed`);
  // A reading older than the cache window that the last probe could not
  // confirm is history, not headroom. A fresh reading survives a failed
  // probe: it would not have been probed at all.
  const probeFailedAt = snapshot.probeFailedAt ? Date.parse(snapshot.probeFailedAt) : Number.NaN;
  if (probeFailedAt > Date.parse(snapshot.checkedAt) && !snapshotFresh(snapshot, USAGE_CACHE_MS)) {
    return unknownStanding(choice, `probe failed; last reading ${fmtAge(snapshot.checkedAt)} ago said ${Math.round(100 - weekly.usedPercent)}% left`);
  }
  const live = snapshot.windows!.filter((window) => window.resetsAt * 1000 > now);
  const reached = snapshotReached(snapshot) || live.some((window) => window.usedPercent >= 99);
  // Exact share for decisions; the text rounds.
  const remainingPercent = Math.max(0, 100 - weekly.usedPercent);
  const daysToReset = (weekly.resetsAt * 1000 - now) / 86_400_000;
  const paceToEmpty = Math.round(remainingPercent / daysToReset);
  const base = { choice, snapshot, weekly, remainingPercent, paceToEmpty, reached };
  if (reached) {
    const blocking = live.filter((window) => window.usedPercent >= 99).sort((a, b) => a.resetsAt - b.resetsAt)[0] ?? snapshot;
    return { ...base, reason: `${rateLimitWindowName(blocking.windowDurationMins)} window exhausted, back ${fmtUntil(blocking.resetsAt)}` };
  }
  return { ...base, reason: `${Math.round(remainingPercent)}% left, resets ${rateLimitResetDate(weekly.resetsAt)} ${fmtUntil(weekly.resetsAt)}, ${paceToEmpty}%/day empties it` };
}

// Earliest deadline first. An account whose window resets soonest loses its
// unspent share first, so it is spent first; among equal deadlines the fuller
// one goes first. Accounts short of the demand's headroom rank next (fullest
// first), unknown usage after them, exhausted windows last (soonest reset
// first, for the warning).
function standingTier(standing: AccountStanding, demand: Demand): number {
  if (standing.reached) return 3;
  if (!standing.snapshot) return 2;
  return standing.remainingPercent >= HEADROOM_PERCENT[demand] ? 0 : 1;
}

function rankAccounts(standings: AccountStanding[], demand: Demand): AccountStanding[] {
  return standings.map((standing, index) => ({ standing, index })).sort((a, b) => {
    const tier = standingTier(a.standing, demand);
    const tierDelta = tier - standingTier(b.standing, demand);
    if (tierDelta !== 0) return tierDelta;
    if (tier === 0) {
      const deadline = a.standing.weekly!.resetsAt - b.standing.weekly!.resetsAt;
      if (deadline !== 0) return deadline;
      return b.standing.remainingPercent - a.standing.remainingPercent;
    }
    if (tier === 1) return b.standing.remainingPercent - a.standing.remainingPercent;
    if (tier === 3) return (a.standing.snapshot?.exhaustedUntil ?? a.standing.snapshot?.resetsAt ?? Infinity) - (b.standing.snapshot?.exhaustedUntil ?? b.standing.snapshot?.resetsAt ?? Infinity);
    return a.index - b.index;
  }).map(({ standing }) => standing);
}

// Eligibility is shared by launch and usage advice. Unknown evidence is a
// fallback after sufficient known capacity; light turns admit with warnings.
function accountEligible(standing: AccountStanding, demand: Demand): boolean {
  return !standing.reached && (!standing.snapshot || (demand === "light" ? standing.remainingPercent > 0 : standing.remainingPercent >= HEADROOM_PERCENT[demand]));
}

function decideAccount(standings: AccountStanding[], demand: Demand): AccountStanding | undefined {
  return rankAccounts(standings.filter((standing) => accountEligible(standing, demand)), demand)[0];
}

function fullestOpenAccount(standings: AccountStanding[]): AccountStanding | undefined {
  return standings
    .filter((standing) => !standing.reached && (!standing.snapshot || standing.remainingPercent > 0))
    .sort((a, b) => b.remainingPercent - a.remainingPercent)[0];
}

// A cached snapshot serves for 30 minutes unless a window has reset or it
// predates per-window storage; after a failed refresh the stale copy stays
// on disk and standingOf decides how much of it to trust.
async function accountSnapshot(choice: AccountChoice): Promise<UsageSnapshot | undefined> {
  const cached = readUsageSnapshot(choice);
  const usable = !cached?.invalidatedAt && snapshotFresh(cached, USAGE_CACHE_MS) && cached.windows !== undefined && !snapshotExpired(cached);
  if (usable || (!cached?.invalidatedAt && probeFailedRecently(cached))) return cached;
  const refreshed = await refreshUsageSnapshot({ account: choice });
  // A failed refresh writes its marker beside the old reading; read it back
  // so the standing sees the failure.
  return refreshed?.snapshot ?? readUsageSnapshot(choice);
}

async function accountStandings(): Promise<AccountStanding[]> {
  const standings = await Promise.all(Object.entries(config.accounts ?? {}).map(async ([name, home]) => {
    const choice = { name, home };
    return standingOf(choice, await accountSnapshot(choice));
  }));
  return withAccountHolds(standings, readLedger());
}

function cachedAccountStandings(ledger = readLedger()): AccountStanding[] {
  return withAccountHolds(Object.entries(config.accounts ?? {}).map(([name, home]) => {
    const choice = { name, home };
    return standingOf(choice, readUsageSnapshot(choice));
  }), ledger);
}

interface AccountAdvice {
  order: string[];
  picks: Record<Demand, string | null>;
  accounts: Array<{ account: string; remainingPercent: number; reached: boolean; resetsAt?: number; paceToEmpty?: number; reason: string }>;
}

function accountAdvice(standings: AccountStanding[]): AccountAdvice {
  const ranked = rankAccounts(standings, "light");
  const pickFor = (demand: Demand) => decideAccount(standings, demand)?.choice.name ?? null;
  return {
    order: ranked.map((standing) => standing.choice.name),
    picks: { light: pickFor("light"), work: pickFor("work"), supervisor: pickFor("supervisor") },
    accounts: ranked.map((standing) => ({
      account: standing.choice.name,
      remainingPercent: standing.remainingPercent,
      reached: standing.reached,
      ...(standing.weekly ? { resetsAt: standing.weekly.resetsAt } : {}),
      ...(standing.paceToEmpty !== undefined ? { paceToEmpty: standing.paceToEmpty } : {}),
      reason: standing.reason,
    })),
  };
}

function adviceLines(standings: AccountStanding[]): string[] {
  if (standings.length === 0) return [];
  const ranked = rankAccounts(standings, "light");
  const advice = accountAdvice(standings);
  const spend = ranked.filter((standing) => !standing.reached).map((standing) => `${standing.choice.name} (${standing.reason})`);
  const out = ranked.filter((standing) => standing.reached).map((standing) => `${standing.choice.name} ${standing.reason}`);
  const lines = [`advice: ${spend.length ? `spend ${spend.join(", then ")}` : "every account is exhausted"}${out.length ? `; ${out.join("; ")}` : ""}`];
  const picks = (Object.keys(HEADROOM_PERCENT) as Demand[])
    .map((demand) => `${DEMAND_LABEL[demand]} ${advice.picks[demand] ?? "none"}`).join(" · ");
  lines.push(`  picks by headroom (${(Object.keys(HEADROOM_PERCENT) as Demand[]).map((demand) => `${DEMAND_LABEL[demand]} ${HEADROOM_PERCENT[demand]}%`).join(", ")}): ${picks}`);
  return lines;
}

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

function chooseAccount(standings: AccountStanding[], demand: Demand, forced?: string, preferred?: AccountChoice): AccountSelection {
  if (!config.accounts) {
    if (forced !== undefined) configuredAccount(forced);
    return { skipped: [], choice: preferred };
  }
  if (forced !== undefined) configuredAccount(forced);
  const pinned = standings.find((standing) => standing.choice.name === (forced ?? preferred?.name) && accountEligible(standing, demand));
  // Below the allowance, the fullest account that has not hit its limit still
  // runs the lane (announceAccountSelection warns); only exhaustion refuses.
  const pick = pinned ?? (forced === undefined ? (decideAccount(standings, demand) ?? fullestOpenAccount(standings)) : undefined);
  if (!pick) {
    const detail = standings.map((standing) => `${standing.choice.name}: ${standing.reason}`).join("; ");
    throw new CmdError(`every account has reached its limit for a ${DEMAND_LABEL[demand]} lane (${detail}); wait for a reset or use gemini`);
  }
  return { choice: pick.choice, skipped: standings.filter((s) => s.reached && s.snapshot).map((s) => ({ choice: s.choice, snapshot: s.snapshot! })), pick, demand };
}

function reconcileAccountHolds(ledger: Ledger): void {
  for (const [name, lane] of Object.entries(ledger)) {
    if (laneRunning(lane) && !pidAlive(lane.pid) && !pidAlive(lane.codexPid)) {
      failActiveRound(name, lane, "runner and engine exited; account hold released");
    }
  }
}

function withAccountHolds(standings: AccountStanding[], ledger: Ledger): AccountStanding[] {
  return standings.map((standing) => {
    const held = Object.values(ledger).filter((lane) => laneRunning(lane)
      && (pidAlive(lane.pid) || pidAlive(lane.codexPid))
      && lane.roundAccount?.home === standing.choice.home)
      .reduce((total, lane) => total + HEADROOM_PERCENT[lane.roundAccount!.demand], 0);
    return { ...standing, heldPercent: held, remainingPercent: Math.max(0, standing.remainingPercent - held),
      reason: held ? `${standing.reason}; ${held}% held by active rounds` : standing.reason };
  });
}

function invalidateAccountUsage(account?: AccountChoice): void {
  // Single-account configurations still invalidate the default snapshot.
  withUsageState((state) => {
    const previous = usageSnapshotFrom(state, account);
    if (previous) storeUsageSnapshot(state, { ...previous, invalidatedAt: new Date().toISOString() }, account);
  });
}

function announceAccountSelection(lane: string, selection: AccountSelection) {
  if (!selection.choice) return;
  const { pick, demand } = selection;
  if (pick && demand) {
    // The reason line explains a choice; one account is no choice. The
    // headroom warning stands on its own.
    if (Object.keys(config.accounts ?? {}).length > 1) console.log(`cdx: account=${color.bold(pick.choice.name)} for ${DEMAND_LABEL[demand]} lane: ${pick.reason}`);
    if (!pick.snapshot) {
      console.error(color.yellow(`cdx: WARNING: ${pick.choice.name} ${pick.reason}; ${lane} starts on it unverified`));
    } else if (pick.remainingPercent < HEADROOM_PERCENT[demand]) {
      console.error(color.yellow(`cdx: WARNING: no account has ${HEADROOM_PERCENT[demand]}% remaining headroom for a ${DEMAND_LABEL[demand]} lane; ${pick.choice.name} has ${Math.round(pick.remainingPercent)}% and ${lane} may hit the limit mid-run`));
    }
  }
  if (selection.skipped.length === 0) return;
  for (const { choice, snapshot } of selection.skipped) {
    const message = `[cdx] account ${choice.name} consumed (resets ${rateLimitResetDate(snapshot.exhaustedUntil ?? snapshot.resetsAt)}); ${lane} using ${selection.choice.name}`;
    console.error(color.yellow(message.replace(/^\[cdx\]/, "cdx:")));
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
    const advice = config.accounts ? accountAdvice(cachedAccountStandings()) : null;
    console.log(JSON.stringify({ codex: rows, advice, gemini: geminiUsage ?? readGeminiUsageSnapshot() ?? null, geminiLedger: geminiTotals }, null, 2));
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
  for (const line of adviceLines(cachedAccountStandings())) console.log(color.cyan(line));
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
      for await (const event of readJsonLines(proc.stdout)) {
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
      effort: resolveEffort("gpt", config.model),
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

function agyConfigHome(): string {
  return `${HOME}/.gemini/config`;
}

function hooksJsonPath(): string {
  return join(agyConfigHome(), "hooks.json");
}

function desiredHookEntry(): Record<string, unknown> {
  const cmd = `${process.execPath} ${realpathSync(SELF)}`;
  return {
    enabled: true,
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `${cmd} hook pre-tool`,
            timeout: 10,
          },
        ],
      },
    ],
    PreInvocation: [
      {
        type: "command",
        command: `${cmd} hook pre-invocation`,
        timeout: 10,
      },
    ],
  };
}

function hookInstallState(): { path: string; state: "missing" | "stale" | "corrupt" | "current"; detail: string } {
  const path = hooksJsonPath();
  if (!existsSync(path)) return { path, state: "missing", detail: `missing: ${path}` };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, state: "corrupt", detail: `corrupt JSON at ${path}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path, state: "corrupt", detail: `corrupt config at ${path}` };
  }
  const cdxEntry = parsed.cdx;
  if (!cdxEntry || typeof cdxEntry !== "object") {
    return { path, state: "missing", detail: `entry "cdx" missing in ${path}` };
  }
  const cmd = `${process.execPath} ${realpathSync(SELF)}`;
  const desiredPreToolCmd = `${cmd} hook pre-tool`;
  const desiredPreInvocationCmd = `${cmd} hook pre-invocation`;

  const preToolHook = cdxEntry.PreToolUse?.[0]?.hooks?.[0];
  const preInvocationHook = cdxEntry.PreInvocation?.[0];

  const current =
    cdxEntry.enabled === true &&
    Array.isArray(cdxEntry.PreToolUse) &&
    cdxEntry.PreToolUse.length === 1 &&
    cdxEntry.PreToolUse[0]?.matcher === "*" &&
    Array.isArray(cdxEntry.PreToolUse[0]?.hooks) &&
    cdxEntry.PreToolUse[0]?.hooks.length === 1 &&
    preToolHook?.type === "command" &&
    preToolHook?.command === desiredPreToolCmd &&
    preToolHook?.timeout === 10 &&
    Array.isArray(cdxEntry.PreInvocation) &&
    cdxEntry.PreInvocation.length === 1 &&
    preInvocationHook?.type === "command" &&
    preInvocationHook?.command === desiredPreInvocationCmd &&
    preInvocationHook?.timeout === 10;

  return current
    ? { path, state: "current", detail: path }
    : { path, state: "stale", detail: `stale hook commands in ${path}` };
}

function installHooks(): boolean {
  const path = hooksJsonPath();
  mkdirSync(join(path, ".."), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    existing = parsed as Record<string, unknown>;
  }
  existing.cdx = desiredHookEntry();
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  return true;
}

const REVIEW_DENIED_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
  "notebook_execution",
  "delete_knowledge",
]);

async function hookCommand(argv: string[]): Promise<void> {
  const [subcommand] = argv;
  const isPreTool = subcommand === "pre-tool";
  const passThrough = (): never => {
    console.log(isPreTool ? JSON.stringify({ decision: "allow" }) : "{}");
    process.exit(0);
  };
  try {
    const rawStdin = await Bun.stdin.text();
    let input: any;
    try {
      input = JSON.parse(rawStdin);
    } catch {
      passThrough();
    }
    const lane = process.env.CDX_LANE;
    if (!lane || typeof input !== "object" || input === null) {
      passThrough();
    }

    if (subcommand === "pre-tool") {
      const ledger = readLedger();
      const entry = ledger[lane];
      if (!entry) passThrough();
      const currentRound = process.env.CDX_ROUND;
      const isReview = entry.kind === "review" || (entry.review?.state === "running" && currentRound !== undefined && String(entry.review?.round) === String(currentRound));
      const toolName = input.toolCall?.name;
      if (isReview && toolName && REVIEW_DENIED_TOOLS.has(toolName)) {
        console.log(JSON.stringify({
          decision: "deny",
          reason: "cdx: review lanes are read-only; put findings in the report instead",
        }));
        return;
      }
      console.log(JSON.stringify({ decision: "allow" }));
      return;
    }

    if (subcommand === "pre-invocation") {
      const ledger = readLedger();
      const entry = ledger[lane];
      if (!entry) passThrough();
      const currentRound = process.env.CDX_ROUND;
      const isReview = entry.kind === "review" || (entry.review?.state === "running" && currentRound !== undefined && String(entry.review?.round) === String(currentRound));
      if (isReview || entry.kind !== "work") {
        console.log("{}");
        return;
      }
      const round = Number(currentRound ?? entry.rounds);
      if (!Number.isFinite(round) || round < 1) {
        console.log("{}");
        return;
      }

      const injectSteps: Array<{ userMessage: string }> = [];
      withLedger((led) => {
        const item = led[lane];
        if (!item) return;
        const path = controlPathOf(lane, round);
        if (!existsSync(path)) return;
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
        const delivered = readDeliveredCount(lane, round);
        if (delivered >= lines.length) return;

        let newlyDelivered = 0;
        for (let i = delivered; i < lines.length; i++) {
          const line = lines[i]!;
          let record: ControlRecord;
          try {
            record = JSON.parse(line) as ControlRecord;
          } catch {
            continue;
          }
          if (typeof record.text !== "string" || !record.text.trim()) continue;
          injectSteps.push({
            userMessage: `HEAD STEER (sent ${record.sentAt}): ${record.text}`,
          });
          newlyDelivered += 1;
          const flat = singleLine(record.text);
          feedEvent("progress", `[cdx] lane=${lane} round=${round} steer delivered mode=in-turn: ${flat.slice(0, 120)}`, item.ownerSession, { lane, round });
        }
        writeDeliveredCount(lane, round, lines.length);
        if (newlyDelivered > 0) {
          item.steers = (item.steers ?? 0) + newlyDelivered;
          item.updatedAt = new Date().toISOString();
        }
      });

      if (injectSteps.length === 0) {
        console.log("{}");
      } else {
        console.log(JSON.stringify({ injectSteps }));
      }
      return;
    }

    passThrough();
  } catch {
    passThrough();
  }
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

function parseAgyHooksLoaded(stdout: string): boolean {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return false;
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    const hooks = parsed?.command?.data?.hooks;
    if (Array.isArray(hooks)) {
      for (const hook of hooks) {
        if (hook?.name === "cdx") return true;
        if (Array.isArray(hook?.actions)) {
          for (const action of hook.actions) {
            if (typeof action?.command === "string" && action.command.includes("hook pre-invocation")) {
              return true;
            }
          }
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function checkDoctorAgyHooks(
  good: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  const agy = Bun.which("agy");
  if (!agy) {
    warn("agy hooks: CLI not found");
    return;
  }
  const proc = Bun.spawn([agy, "--print=/hooks", "--output-format", "json", "--add-dir", "/tmp"], {
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
  }, 15_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, stdout]);
    await stderr;
    if (timedOut || proc.signalCode === "SIGKILL") {
      warn("agy hooks: probe timed out after 15s");
      return;
    }
    if (exitCode !== 0) {
      warn(`agy hooks: probe exited ${exitCode}`);
      return;
    }
    if (parseAgyHooksLoaded(text)) {
      good("agy hooks: loaded in agy");
    } else {
      warn("agy hooks: cdx hook not loaded in agy");
    }
  } catch (error) {
    warn(`agy hooks: probe failed (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    clearTimeout(timer);
  }
}

// Account homes share directives and tools, not credentials. Report config
// differences without printing values that might contain server credentials.
function checkDoctorAccountHomes(fix: boolean, good: (message: string) => void, bad: (label: string, detail: string, remedy: string) => void): void {
  syncAccountHomes(config.accounts ?? { default: defaultCodexHome() }, fix, good, bad);
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

    const quotaState = geminiQuotaState();
    const snapshot = geminiUsage ?? readGeminiUsageSnapshot();
    if (quotaState.block) {
      warn(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
    } else if (quotaState.warnPercent !== undefined && quotaState.resetsAt) {
      warn(`gemini quota: five-hour window at ${quotaState.warnPercent}%, resets at ${quotaState.resetsAt}; fan out with care`);
    } else if (snapshot && snapshot.fiveHour.remainingPercent >= 15) {
      good("gemini quota: clear");
    }

    await checkDoctorGeminiModel(good, warn, bad);
  } else {
    warn("agy usage: unavailable");
    const quotaState = geminiQuotaState();
    if (quotaState.block) {
      warn(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
    }
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

  let hookState = hookInstallState();
  let hookInstalled = false;
  if (hookState.state === "corrupt") {
    bad("agy hooks", hookState.detail, `fix or move ${hookState.path} by hand`);
  } else {
    if (hookState.state !== "current" && parsed.bools.has("fix")) {
      installHooks();
      hookState = hookInstallState();
      if (hookState.state === "current") { good(`agy hooks: installed ${hookState.path}`); hookInstalled = true; }
    }
    if (hookState.state === "current") {
      if (!hookInstalled) good(`agy hooks: current (${hookState.path})`);
      await checkDoctorAgyHooks(good, warn);
    } else if (config.gemini) {
      bad("agy hooks", hookState.detail, "run `cdx doctor --fix` to install hooks");
    } else {
      warn(`agy hooks: ${hookState.detail}; run cdx doctor --fix to install`);
    }
  }

  checkDoctorAccountHomes(parsed.bools.has("fix"), good, bad);

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
      if (index === 0) loggedIn = login.success;
      if (login.success) good("  auth: logged in");
      else {
        bad(`${name} auth`, "not logged in", `run \`CODEX_HOME=${home} codex login\`, then re-run \`cdx doctor\``);
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
    for (const line of adviceLines(cachedAccountStandings())) console.log(color.cyan(line));
  } else if (version?.success) {
    const login = Bun.spawnSync({ cmd: ["codex", "login", "status"] });
    loggedIn = login.success;
    if (loggedIn) good("auth: logged in");
    else bad("auth", "not logged in", "run `codex login` in a terminal (opens a browser), then re-run `cdx doctor`");
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

  const primaryHome = primaryAccount()?.home ?? defaultCodexHome();
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
  const pluginLink = `${HOME}/.claude/skills/cdx`;
  const currentSession = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  const receipt = currentSession ? readSessions().sessions[currentSession] : undefined;
  const expectedEvents = ["PreToolUse", "SessionStart", "PostToolBatch", "UserPromptSubmit"];
  try {
    const pluginRoot = realpathSync(pluginLink);
    const manifest = JSON.parse(readFileSync(`${pluginRoot}/.claude-plugin/plugin.json`, "utf8"));
    const hookText = readFileSync(`${pluginRoot}/hooks/hooks.json`, "utf8");
    const hooks = JSON.parse(hookText).hooks;
    if (manifest.name !== "cdx") throw new Error("plugin name is not cdx");
    good(`plugin: cdx@skills-dir personal path=${pluginRoot} version=${manifest.version}`);
    const missing = expectedEvents.filter((event) => !hooks?.[event]?.some((group: any) => group.hooks?.some((hook: any) =>
      hook.type === "command" && hook.command?.includes(event === "PreToolUse" ? "guard-raw-codex.ts" : "cdx.ts\" _session"))));
    if (missing.length) warn(`plugin: missing hooks ${missing.join(", ")}; restore hooks/hooks.json and /reload-plugins`);
    else good(`plugin: hook set ${expectedEvents.join(", ")}`);
    const hash = createHash("sha256").update(hookText).digest("hex");
    if (receipt?.plugin?.root === pluginRoot && receipt.plugin.version === manifest.version && receipt.plugin.hooks === hash) {
      good(`plugin: this session observed ${receipt.plugin.observed.join(", ")}`);
    } else warn("plugin: this session has no current hook receipt; /reload-plugins or restart, then submit a prompt");
    const monitors = JSON.parse(readFileSync(`${pluginRoot}/monitors/monitors.json`, "utf8"));
    if (!monitors.some((monitor: any) => monitor.command === '\"${CLAUDE_PLUGIN_ROOT}/cdx.ts\" watch')) warn("plugin: scoped watcher declaration missing; /reload-plugins after restoring monitors/monitors.json");
  } catch {
    warn("plugin: cdx@skills-dir personal link or plugin files unavailable; check ~/.claude/skills/cdx");
  }
  if (receipt?.lease && receipt.lease.claudePid === Number(process.env.CLAUDE_PID)
    && pidAlive(receipt.lease.pid) && pidAlive(receipt.lease.claudePid)) good("plugin: this session's watcher holds its lease");
  else warn("plugin: this session has no live watcher lease; /reload-plugins or restart");

  if (parsed.bools.has("fix")) withLedger(() => {});
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
        for (let waited = 0; waited < 3000 && pidAlive(entry.codexPid); waited += 100) Bun.sleepSync(100);
      }
    }
    withLedger((ledger) => {
      for (const [lane] of stale) {
        const item = ledger[lane]!;
        if (!pidAlive(item.codexPid)) failActiveRound(lane, item, "runner died without finalizing; repaired by cdx doctor --fix");
      }
    });
    good("fixed: reconciled stale runners; holds remain until live engine children exit");
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

function briefCommand() {
  const quotaState = geminiQuotaState();
  if (quotaState.block) console.log(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
  const summary = sessionSummary(callerSession());
  if (summary) console.log(summary);
}

function feedCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["n"]);
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  console.log(scopedEvents(limit).join("\n"));
}

function cleanCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["days"]);
  const days = Number(parsed.flags.days ?? 14);
  const cutoff = Date.now() - days * 86_400_000;
  const removed: string[] = [];
  withLedger((ledger) => {
    for (const [lane, entry] of Object.entries(ledger)) {
      if (entry.work.state !== "closed" || Date.parse(entry.updatedAt) > cutoff) continue;
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
    withEvents((state) => {
      for (const lane of removed) delete state.lanes[lane];
      for (const pid of Object.keys(state.heads)) if (!pidAlive(Number(pid))) delete state.heads[pid];
      const records = readEvents();
      state.sequence = Math.max(state.sequence, records.at(-1)?.id ?? 0);
      const keep = records.filter((record, index) => {
        if (record.lane && removed.includes(record.lane)) return false;
        if (index >= records.length - 2000) return true;
        const session = state.sessions[recipientOf(record.recipient ?? record.owner, record.lane, state)];
        return session && record.id > session[WAKE_EVENTS.has(record.kind) ? "wake" : "quiet"];
      });
      const temporary = `${ROOT}/feed.log.tmp.${process.pid}`;
      writeFileSync(temporary, keep.map((record) => JSON.stringify(record) + "\n").join(""));
      renameSync(temporary, `${ROOT}/feed.log`);
    });
  });
  console.log(removed.length > 0 ? `cdx: pruned closed lanes older than ${days}d: ${removed.join(", ")}` : `cdx: nothing to prune (closed lanes older than ${days}d)`);
}

// SIGTERM first: the runner's reap handler kills its codex child and finalizes
// the round itself (signal note, feed line). Only a runner that fails to
// finalize within 10s, or a dead runner with a live codex orphan, gets the
// force path: SIGKILL what remains and finalize the ledger here.
async function killCommand(argv: string[]) {
  const [lane, note] = argv;
  if (!lane) fail('usage: cdx kill <lane|job> ["note"]');
  if (!readLedger()[lane]) {
    const job = readJobs()[lane];
    if (job) {
      if (supervisorLane()) fail(`supervisor ${supervisorLane()} may not stop jobs; jobs belong to the liaison`);
      await killJob(lane, job, note);
      return;
    }
  }
  const entry = readLane(lane);
  requireOwnChild(lane, entry);
  if (!laneRunning(entry)) fail(`lane "${lane}" is not running (latest ${entry.kind} state ${roundStateOf(entry)})`);
  await killLane(lane, entry, note);
  if (entry.supervisor) await killChildren(lane, note ? `${note} (supervisor ${lane} killed)` : `supervisor ${lane} killed`);
}

// Stopping a supervisor takes its running children with it; nothing else
// would ever collect them. Every child gets its turn: one whose processes
// already died is reported and left to cdx doctor, never a reason to skip
// the rest. Returns the names of the children that were running.
async function killChildren(supervisor: string, note: string): Promise<string[]> {
  const children = Object.entries(readLedger()).filter(([, item]) => item.parent === supervisor && laneRunning(item));
  const names: string[] = [];
  for (const [child, item] of children) {
    names.push(child);
    console.log(`cdx: lane=${color.magenta(child)} is a child of ${supervisor}; stopping it too`);
    try { await killLane(child, item, note); }
    catch (error) {
      if (!(error instanceof CmdError)) throw error;
      console.error(color.yellow(`cdx: ${error.message}`));
    }
  }
  return names;
}

async function killLane(lane: string, entry: Lane, note?: string) {
  const runnerAlive = pidAlive(entry.pid);
  if (!runnerAlive && !pidAlive(entry.codexPid)) {
    throw new CmdError(`lane "${lane}" is marked running but its runner and codex child are both dead; run cdx doctor --fix`);
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
              if (item.kind === "review") item.review!.note = item.review!.note ? `${item.review!.note}; ${note}` : note;
              else item.work.note = item.work.note ? `${item.work.note}; ${note}` : note;
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
    if (item.kind === "review") item.review!.exitCode = undefined;
    else item.work.exitCode = undefined;
    return item;
  });
  feedEvent("terminal", `[cdx] lane=${lane} round=${finalized.rounds} kind=${finalized.kind} state=failed note=${roundNoteOf(finalized)}`, finalized.ownerSession, { lane, round: finalized.rounds });
  console.log(`cdx: lane=${color.magenta(lane)} killed; ${finalized.kind} state=${coloredState("failed")} note=${roundNoteOf(finalized)}`);
}

// ---------------------------------------------------------------------------
// Jobs: background shell commands the head runs beside lanes (a wall, a
// deploy chain, a long gate). No engine, no brief, no report: one log, one
// exit code, and one feed line the plugin monitor delivers when the job ends,
// so the head never polls a summary file from a sleep loop.

type JobState = "running" | "done" | "failed";
interface Job {
  cmd: string;
  cwd: string;
  exitCode?: number;
  finishedAt?: string;
  log: string;
  note?: string;
  ownerSession?: string;
  pid?: number;
  startedAt: string;
  state: JobState;
}
type Jobs = Record<string, Job>;
const JOBS = `${ROOT}/jobs.json`;
const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

function readJobs(): Jobs {
  if (!existsSync(JOBS)) return {};
  return JSON.parse(readFileSync(JOBS, "utf8")) as Jobs;
}

function withJobs<T>(mutate: (jobs: Jobs) => T): T {
  return withLockedJson(JOBS, `${ROOT}/.jobs.lock`, readJobs, mutate);
}

function jobRunning(job: Job): boolean {
  return job.state === "running";
}

function jobDuration(job: Job): string {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

function renderJobLine(name: string, job: Job): string {
  const state = jobRunning(job) && !pidAlive(job.pid) ? "running(dead?)" : job.state;
  const exit = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
  const note = job.note ? ` note=${job.note}` : "";
  const phase = jobRunning(job) ? jobPhase(job.log) : "";
  return `job=${color.magenta(name)} state=${coloredState(state)}${exit} ${jobDuration(job)}${phase ? ` phase=${phase}` : ""} log=${job.log}${note}`;
}

// A running job whose runner died never finalized itself; record that here so
// wait and status stop showing it as live.
function settledJob(name: string): Job | undefined {
  const job = readJobs()[name];
  if (!job) return undefined;
  if (!jobRunning(job)) return job;
  if (pidAlive(job.pid)) return undefined;
  return withJobs((jobs) => {
    const entry = jobs[name]!;
    if (jobRunning(entry)) {
      entry.state = "failed";
      entry.note = "runner died without finalizing";
      entry.finishedAt = new Date().toISOString();
    }
    return entry;
  });
}

function printRunningJobs(): void {
  const running = Object.entries(readJobs()).filter(([, job]) => jobRunning(job) && owned(job.ownerSession));
  if (running.length === 0) return;
  console.log(`\njobs running:\n${running.map(([name, job]) => `  ${renderJobLine(name, job)}`).join("\n")}`);
}

function listJobs(): void {
  const entries = Object.entries(readJobs());
  if (entries.length === 0) { console.log("cdx: no jobs"); return; }
  const byRecency = (a: [string, Job], b: [string, Job]) => Date.parse(b[1].startedAt) - Date.parse(a[1].startedAt);
  const running = entries.filter(([, job]) => jobRunning(job)).sort(byRecency);
  const finished = entries.filter(([, job]) => !jobRunning(job)).sort(byRecency).slice(0, FINISHED_SHOWN);
  for (const [name, job] of [...running, ...finished]) console.log(renderJobLine(name, job));
}

async function jobCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["cd"]);
  const [name, ...rest] = parsed.rest;
  if (!name) { listJobs(); return; }
  if (!JOB_NAME.test(name)) fail(`job name "${name}" must match ${JOB_NAME.source}`);
  if (readLedger()[name]) fail(`"${name}" is a lane; pick another job name`);
  let cmd = rest.join(" ");
  if (cmd === "-") cmd = await Bun.stdin.text();
  cmd = cmd.trim();
  if (!cmd) fail('usage: cdx job <name> [--cd <dir>] "<cmd>"   (a "-" command reads stdin; no arguments lists jobs)');
  const cwd = parsed.flags.cd ?? process.cwd();
  if (!existsSync(cwd)) fail(`--cd ${cwd} does not exist`);
  mkdirSync(`${ROOT}/logs`, { recursive: true });
  const log = `${ROOT}/logs/job-${name}.log`;
  const startedAt = new Date().toISOString();
  const ownerSession = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  // Reserve the name under the lock with this process's pid, as openRound
  // does for lanes: two concurrent launches cannot both pass the running
  // check, and a concurrent wait never sees a running job without a pid.
  withJobs((jobs) => {
    const existing = jobs[name];
    if (existing && !owned(existing.ownerSession)) fail(`job "${name}" belongs to another session; explicit takeover required`);
    if (existing && jobRunning(existing) && pidAlive(existing.pid)) {
      throw new CmdError(`job "${name}" is still running (pid ${existing.pid}); cdx kill ${name} first or pick another name`);
    }
    jobs[name] = { cmd, cwd, log, startedAt, state: "running", pid: process.pid, ...(ownerSession ? { ownerSession } : {}) };
  });
  writeFileSync(log, `# cdx job ${name}\n# cwd ${cwd}\n# cmd ${cmd}\n# started ${startedAt}\n`);
  const runnerLog = openSync(`${ROOT}/logs/job-${name}.runner.log`, "a");
  const child = nodeSpawn(process.execPath, [SELF, "_job", name], {
    detached: true,
    env: { ...uncoloredChildEnv(undefined, ROOT), CDX_JOB_CMD: cmd, CDX_JOB_CWD: cwd, ...(ownerSession ? { CDX_JOB_OWNER: ownerSession } : {}) },
    stdio: ["ignore", runnerLog, runnerLog],
  });
  child.unref();
  withJobs((jobs) => { jobs[name]!.pid = child.pid; });
  console.log(`cdx: job=${color.magenta(name)} pid=${child.pid} cwd=${cwd}`);
  console.log(`cdx: log=${log}; a feed line arrives on exit; cdx wait ${color.magenta(name)} blocks until then`);
  process.exit(0);
}

async function runJob(name: string): Promise<number> {
  const cmd = process.env.CDX_JOB_CMD;
  const cwd = process.env.CDX_JOB_CWD;
  if (!cmd || !cwd) fail("internal: _job needs CDX_JOB_CMD and CDX_JOB_CWD");
  const job = readJobs()[name];
  if (!job) fail(`internal: job "${name}" is missing from ${JOBS}`);
  const log = openSync(job.log, "a");
  const env = { ...process.env };
  for (const key of ["CDX_JOB_CMD", "CDX_JOB_CWD", "CDX_JOB_OWNER", "CDX_STATE_HOME"]) delete env[key];
  const child = nodeSpawn("/bin/sh", ["-lc", cmd], { cwd, env, stdio: ["ignore", log, log] });
  let signal: string | undefined;
  const forward = (sig: NodeJS.Signals) => {
    signal = sig;
    try { child.kill(sig); } catch { /* already gone */ }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code, sig) => resolve(code ?? (sig ? SIGNAL_EXIT_CODES[sig] ?? 1 : 1)));
    child.on("error", () => resolve(1));
  });
  closeSync(log);
  const state: JobState = exitCode === 0 ? "done" : "failed";
  const note = signal ? `terminated by ${signal}` : undefined;
  const finished = withJobs((jobs) => {
    const entry = jobs[name]!;
    entry.exitCode = exitCode;
    entry.finishedAt = new Date().toISOString();
    entry.state = state;
    if (note) entry.note = note;
    return entry;
  });
  feedEvent("job-exit", `[cdx] job=${name} state=${state} exit=${exitCode} in=${jobDuration(finished)} log=${finished.log}${note ? ` note=${note}` : ""}`, process.env.CDX_JOB_OWNER, { job: name });
  return exitCode;
}

async function killJob(name: string, job: Job, note?: string): Promise<void> {
  if (!owned(job.ownerSession)) fail(`job "${name}" belongs to another session; use cdx takeover ${job.ownerSession} first`);
  if (!jobRunning(job)) fail(`job "${name}" is not running (state ${job.state})`);
  const finalize = (exitCode: number, why: string): Job => withJobs((jobs) => {
    const entry = jobs[name]!;
    if (jobRunning(entry)) {
      entry.exitCode = exitCode;
      entry.finishedAt = new Date().toISOString();
      entry.state = "failed";
      entry.note = why;
    }
    return entry;
  });
  if (!pidAlive(job.pid)) {
    const finished = finalize(1, note ?? "runner died without finalizing");
    console.log(`cdx: ${renderJobLine(name, finished)}`);
    return;
  }
  // The runner is a session leader (detached), so its pid names the process
  // group: one signal reaches the shell and everything it started.
  const signalGroup = (sig: NodeJS.Signals) => {
    try { process.kill(-job.pid!, sig); } catch { try { process.kill(job.pid!, sig); } catch { /* gone */ } }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readJobs()[name];
    if (current && !jobRunning(current)) {
      const finished = note ? withJobs((jobs) => { jobs[name]!.note = note; return jobs[name]!; }) : current;
      console.log(`cdx: ${renderJobLine(name, finished)}`);
      return;
    }
    await Bun.sleep(200);
  }
  signalGroup("SIGKILL");
  const finished = finalize(137, note ?? "killed");
  feedEvent("job-exit", `[cdx] job=${name} state=failed exit=137 in=${jobDuration(finished)} log=${finished.log} note=${finished.note}`, finished.ownerSession, { job: name });
  console.log(`cdx: ${renderJobLine(name, finished)}`);
}

// The browser receives only rendered, redacted text. Terminal output stays unchanged.
function redactViewText(text: string): string {
  return text
    .replace(/(CONTEXT7_API_KEY\s*=\s*|--api-key\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;"']+)/gi, "$1[redacted]")
    .replace(/ctx7sk[-_A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]{16,}|ghp_[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/\b(key|token|secret|password)\b[^\r\n]*/gi, (line) => line.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]"))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function viewJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "string" ? redactViewText(item) : item);
}

function viewStatusGroup(state: string): "running" | "done" | "failed" | "other" {
  if (state === "running" || state === "done") return state;
  return state === "failed" || state === "gate-invalid" ? "failed" : "other";
}

function viewActivityOrder(a: { statusGroup: string; lastActivityAt: string }, b: { statusGroup: string; lastActivityAt: string }) {
  return Number(b.statusGroup === "running") - Number(a.statusGroup === "running")
    || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

function viewLaneSummary(name: string, entry: Lane) {
  const startedAt = entry.roundStartedAt ?? entry.createdAt;
  const statusGroup = viewStatusGroup(activeStateOf(entry));
  const lastActivityAt = [startedAt, entry.updatedAt, entry.lastEventAt, entry.review?.updatedAt]
    .filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
  return { ...entry, name, engine: roundEngine(entry), startedAt, lastActivityAt, statusGroup,
    model: roundEngine(entry) === laneEngine(entry) ? entry.model : undefined,
    stalled: statusGroup === "running" && Date.now() - Date.parse(entry.lastEventAt ?? startedAt) >= 300_000,
  };
}

function viewState() {
  return {
    lanes: Object.entries(readLedger()).map(([name, entry]) => viewLaneSummary(name, entry)).sort(viewActivityOrder),
    jobs: Object.entries(readJobs()).map(([name, job]) => {
      let activity = Date.parse(job.finishedAt ?? job.startedAt);
      try { activity = Math.max(activity, statSync(job.log).mtimeMs); } catch { /* A job may not have written output yet. */ }
      return { ...job, name, engine: "job", statusGroup: viewStatusGroup(job.state), lastActivityAt: new Date(activity).toISOString(),
        duration: jobDuration(job), lastLines: readTailLines(job.log, 20),
      };
    }).sort(viewActivityOrder),
    feed: withEvents(() => readEvents().slice(-200).map(renderEvent), false),
  };
}

function viewLane(name: string, ledger = readLedger()) {
  const entry = Object.hasOwn(ledger, name) ? ledger[name] : undefined;
  if (!entry) return undefined;
  return { ...viewLaneSummary(name, entry),
    roundList: Array.from({ length: entry.rounds }, (_, index) => index + 1),
    reports: entry.reports.map((path) => ({ path, text: existsSync(path) ? readFileSync(path, "utf8") : null })),
    parent: entry.parent ? { name: entry.parent, entry: ledger[entry.parent] ?? null } : null,
    children: Object.entries(ledger).filter(([, lane]) => lane.parent === name).map(([name, lane]) => ({ ...lane, name })),
    questions: existsSync(`${ROOT}/questions`) ? questionFiles(name).map(({ record }) => record) : [],
  };
}

function viewTranscript(name: string, round: number, after = "") {
  const path = [true, false].map((json) => logPathOf(name, round, json)).find(existsSync);
  if (!path) return { round, lines: [] as string[], cursor: "", reset: after !== "" };
  const stat = statSync(path);
  const identity = `${round}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  let offset = 0;
  if (after) {
    const parts = after.split("@");
    if (parts[0] === identity && /^\d+$/.test(parts[1] ?? "") && Number(parts[1]) <= stat.size) offset = Number(parts[1]);
  }
  const cursor: Cursor = { round, path, offset, committedOffset: offset, buffer: "", json: path.endsWith(".jsonl"), decoder: new TextDecoder() };
  const lines: string[] = [];
  drainCursor(cursor, "", (line) => { lines.push(line); });
  return { round, lines, cursor: `${identity}@${cursor.committedOffset}`, reset: Boolean(after && offset === 0) };
}

function viewCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["port", "open"]);
  if (parsed.rest.length) throw new CmdError("usage: cdx view [--port N] [--open]");
  const port = Number(parsed.flags.port ?? 7477);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CmdError("--port must be an integer from 0 to 65535");
  if (parsed.bools.has("open") && process.platform !== "darwin") throw new CmdError("--open requires macOS; run cdx view and open the printed URL");
  const html = readFileSync(new URL("./assets/view.html", import.meta.url), "utf8");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
  type Client = { send: (event: string, value: unknown) => void; close: () => void; lane?: string; round?: number; cursor: string; detail: string };
  const clients = new Set<Client>();
  let previous = "";
  const feedPath = `${ROOT}/feed.log`;
  let feedIdentity = "";
  const feedCursor: Cursor = { round: 0, path: feedPath, offset: 0, buffer: "", json: false, decoder: new TextDecoder() };
  withEvents(() => {
    if (!existsSync(feedPath)) return;
    const stat = statSync(feedPath);
    feedCursor.offset = stat.size;
    feedIdentity = `${stat.dev}:${stat.ino}`;
  }, false);
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    fetch(request, server) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      const response = (value: unknown, status = 200) => new Response(viewJSON(value), { status, headers: { ...headers, "Content-Type": "application/json" } });
      // Reject cross-origin browser reads and DNS rebinding to the loopback listener.
      if (request.headers.get("host") !== `127.0.0.1:${server.port}` || (request.headers.get("origin") && request.headers.get("origin") !== origin)
        || request.headers.get("sec-fetch-site") === "cross-site") return response({ error: "Local requests only" }, 403);
      if (request.method !== "GET") return response({ error: "View only" }, 405);
      try {
        if (url.pathname === "/") return new Response(html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
        if (url.pathname === "/api/state") return response(viewState());
        const match = url.pathname.match(/^\/api\/lanes\/([a-z0-9._-]+)(\/transcript)?$/i);
        if (match) {
          const name = match[1]!;
          const ledger = readLedger();
          if (!Object.hasOwn(ledger, name)) return response({ error: "Lane not found" }, 404);
          if (!match[2]) return response(viewLane(name, ledger));
          const round = Number(url.searchParams.get("round") ?? ledger[name]!.rounds);
          if (!Number.isInteger(round) || round < 1 || round > ledger[name]!.rounds) return response({ error: "Round not found" }, 404);
          return response(viewTranscript(name, round, url.searchParams.get("after") ?? ""));
        }
        if (url.pathname !== "/events") return response({ error: "Not found" }, 404);
        const lane = url.searchParams.get("lane") ?? undefined;
        const ledger = readLedger();
        if (lane && (!/^[a-z0-9][a-z0-9._-]*$/i.test(lane) || !Object.hasOwn(ledger, lane))) return response({ error: "Lane not found" }, 404);
        const round = url.searchParams.has("round") ? Number(url.searchParams.get("round")) : undefined;
        if (round !== undefined && (!lane || !Number.isInteger(round) || round < 1 || round > ledger[lane]!.rounds)) return response({ error: "Round not found" }, 404);
        server.timeout(request, 0);
        let client: Client;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            client = { lane, round, cursor: "", detail: "",
              close() { clients.delete(client); request.signal.removeEventListener("abort", client.close); try { controller.close(); } catch {} },
              send(event, value) {
                if ((controller.desiredSize ?? 0) < -1_048_576) { client.close(); return; }
                try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${viewJSON(value)}\n\n`)); } catch { client.close(); }
              },
            };
            clients.add(client);
            request.signal.addEventListener("abort", client.close, { once: true });
            try { client.send("state", viewState()); updateLane(client, ledger, true); }
            catch { client.send("notice", "State is temporarily unreadable. Retrying."); }
          },
          cancel() { client.close(); },
        }, { highWaterMark: 1_048_576, size: (chunk) => chunk.byteLength });
        return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream", "Connection": "keep-alive" } });
      } catch { return response({ error: "State is temporarily unreadable" }, 503); }
    },
  });
  function updateLane(client: Client, ledger: Ledger, initial = false) {
    if (!client.lane) return;
    const detail = viewLane(client.lane, ledger);
    const serialized = viewJSON(detail ?? null);
    if (serialized !== client.detail) { client.send("lane", detail ?? null); client.detail = serialized; }
    if (!detail) return;
    const transcript = viewTranscript(client.lane, client.round ?? detail.rounds, client.cursor);
    if (initial || transcript.cursor !== client.cursor || transcript.reset) client.send(`transcript:${client.lane}`, transcript);
    client.cursor = transcript.cursor;
  }
  const timer = setInterval(() => {
    if (!clients.size) return;
    try {
      const state = viewState();
      const serialized = viewJSON(state);
      if (serialized !== previous) { for (const client of clients) client.send("state", state); previous = serialized; }
      withEvents(() => {
        if (!existsSync(feedPath)) return;
        const stat = statSync(feedPath);
        const identity = `${stat.dev}:${stat.ino}`;
        if (identity !== feedIdentity || stat.size < feedCursor.offset) {
          feedCursor.offset = 0; feedCursor.buffer = ""; feedCursor.decoder = new TextDecoder();
        }
        feedIdentity = identity;
        drainCursor(feedCursor, "", (line) => {
          const event = parseFeedEvent(line);
          if (event) for (const client of clients) client.send("feed", renderEvent(event));
        });
      }, false);
      const ledger = readLedger();
      for (const client of clients) {
        try { updateLane(client, ledger); }
        catch { client.send("notice", "Lane files are temporarily unreadable. Retrying."); }
      }
    } catch { for (const client of clients) client.send("notice", "State is temporarily unreadable. Retrying."); }
  }, 1000);
  const stop = () => { clearInterval(timer); for (const client of clients) client.close(); void server.stop(true); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`cdx: ${url} (view only; Ctrl-C to stop)`);
  if (parsed.bools.has("open")) Bun.spawn(["open", url], { stdout: "ignore", stderr: "inherit" });
}

const USAGE = `cdx tracks Codex and Gemini execution lanes
cdx policy: model ${config.model}${modelAliases() ? ` (aliases ${modelAliases()})` : ""}; efforts ${config.efforts.join(", ")}; default effort ${config.defaultEffort}; set in ${CONFIG_PATH}

Engines:
${ENGINE_PICKER}

  spawn  <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--account NAME] [--effort E] [--cd D] [--worktree P] [--bg] [--add-dir D]... [--schema F] [--image F]... [--gate CMD] [--gate-baseline-check] [--max-runtime MIN] "<brief>"
  resume <lane> [--effort E] [--gate CMD] [--bg] [--max-runtime MIN] "<follow-up>"
  fork   <newLane> <fromLane|sessionId> [--model M] [--account NAME] [--effort E] [--bg] "<brief>"
  review <lane> [--engine gpt|gemini] [--model M] [--account NAME] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "files"] ["<intent>"]
  consult <lane> [--model M] [--account NAME] [--effort E] [--cd D] [--bg] "<question>"  # read-only gpt advisor; resume for follow-ups
  adopt  <lane> <sessionId> [--engine gpt|gemini] [--model M] [--account NAME] [--cd D]

  --model M picks a Codex model for a gpt lane: an alias from config.models or a raw id.
  --supervisor (gpt only) lets the lane drive GPT or Gemini children and consults
  through cdx, one level deep; killing the supervisor kills its children.
  send   <lane> "<text>"  # steer the active work turn, or start an idle follow-up turn
  ask    [--timeout MIN] "<question>"  # work-lane command; default 30 minutes
  reply  <lane> [--id SEQ] "<answer>"  questions [lane]
  msg    <lane|full-session-id> "<text>"  inbox [-n N]
  takeover <lane|full-session-id> # explicitly connect ownership to this head
  watch                    # plugin monitor; finds its head through CLAUDE_PID
  status [--all | --json | --brief | --watch [--interval S]]
  wait <lane>... [--timeout S] [--json] [--report]
  usage  [--json]         # per-account plan, rate-limit windows, ledger totals
  tail   <lane> [-n N]    tail -f [lane]           # -f: live transcript; no lane = all running lanes
  view   [--port N] [--open] # local browser view; Ctrl-C stops it
  feed   [-n N]           # replay recent completion/stall lines
  report <lane> [round]    log <lane> [round]
  gate   <lane> "<cmd>" | gate <lane> --clear
  kill   <lane> ["note"]  # SIGTERM the runner; force-finalize if it hangs
  close  <lane> [--remove-worktree] ["note"]       clean [--days N]
  job    <name> [--cd D] "<cmd>"  # background shell job: one log, a feed line on exit; wait/kill/status know it
  job                     # list jobs
  doctor [--fix] [--probe]
  brief                   # owned lanes, completed work awaiting attention, and open questions

--bg detaches the lane (survives the parent shell); combine with "cdx wait" for
one blocking call over many lanes. Foreground lanes print the report on exit.
--worktree P creates a git worktree at P on branch lane/<lane> from the repo at
--cd (or the current directory) and runs the lane there. A "-" brief reads stdin.
--gate CMD runs after a green work round (sh -lc, lane cwd); a nonzero exit
fails the round. Work resumes rerun the lane's stored gate; reviews never do.
Only --gate-baseline-check runs the gate before worker startup, including worktrees. A baseline failure is gate-invalid.
--max-runtime MIN kills the round past the cap and marks it failed.`;

const REFUSED_INSIDE_LANE = new Set([
  "spawn", "resume", "fork", "review", "consult", "adopt",
  "kill", "close", "clean", "gate", "reply", "job", "takeover", "watch", "_session",
]);
// A supervisor drives its children with these; each mutation checks ownership.
const SUPERVISOR_COMMANDS = new Set(["spawn", "resume", "review", "consult", "kill", "close", "gate", "reply"]);

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    await dispatch(command, argv);
  } catch (err) {
    if (command === "hook") {
      const isPreTool = argv[0] === "pre-tool";
      console.log(isPreTool ? JSON.stringify({ decision: "allow" }) : "{}");
      process.exit(0);
    }
    // CmdError is a user-facing refusal thrown from inside withLedger callbacks,
    // where process.exit would strand the lock. Convert it here, after unlock.
    if (err instanceof CmdError) { console.error(color.red(`cdx: ${err.message}`)); process.exit(1); }
    throw err;
  }
}

export { summaryJobs, WAKE_EVENTS, parseFeedEvent, recipientOf, owned, eventOwned, parseConfig, parseArgs, checkRoundCap, roundCapRefusal, geminiConfig, tailOutput };

async function dispatch(command: string | undefined, argv: string[]) {
  if (process.env.CDX_LANE && command && REFUSED_INSIDE_LANE.has(command)) {
    const supervisor = supervisorLane();
    if (supervisor && !SUPERVISOR_COMMANDS.has(command)) {
      fail(`supervisor ${supervisor} may run ${[...SUPERVISOR_COMMANDS].join(", ")} on its children; command "${command}" refused`);
    }
    if (!supervisor) fail(`lane workers cannot drive the harness (command "${command}" refused inside lane ${process.env.CDX_LANE}); use cdx ask for anything you need from the liaison`);
  }
switch (command) {
  case "watch": await watchCommand(argv); break;
  case "_session": await sessionCommand(); break;
  case "takeover": takeoverCommand(argv); break;
  case "spawn": await spawnCommand(argv); break;
  case "review": await reviewCommand(argv); break;
  case "consult": await consultCommand(argv); break;
  case "resume": await resumeCommand(argv); break;
  case "fork": await forkCommand(argv); break;
  case "send": sendCommand(argv); break;
  case "ask": await askCommand(argv); break;
  case "reply": replyCommand(argv); break;
  case "questions": questionsCommand(argv); break;
  case "msg": msgCommand(argv); break;
  case "inbox": inboxCommand(argv); break;
  case "hook": await hookCommand(argv); break;
  case "_run": {
    const [lane, round] = argv;
    if (!lane || !round) fail("internal: _run <lane> <round>");
    process.exit(await runRound(lane, Number(round)));
  }
  case "adopt": {
    const parsed = parseArgs(argv, ["engine", "cd", "account", "model"]);
    const engine = engineOf(parsed, "adopt");
    const model = modelOf(parsed, engine);
    const [lane, sessionId] = parsed.rest;
    if (!lane || !sessionId) fail("usage: cdx adopt <lane> <sessionId> [--engine gpt|gemini] [--cd <dir>]");
    validLane(lane);
    requireEngineBinary(engine);
    if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
    const account = engine === "gpt" ? primaryAccount(parsed.flags.account) : undefined;
    const owner = callerOwnership();
    const now = new Date().toISOString();
    withLedger((ledger) => {
      requireOwnChild(lane, ledger[lane]);
      ledger[lane] = {
        engine,
        ...(model ? { model } : {}),
        ...(account ? { account: account.name, codexHome: account.home } : {}),
        ...owner,
        sessionId, workSessionId: sessionId, work: { state: "adopted", cwd: parsed.flags.cd ?? process.cwd(), updatedAt: now }, effort: resolveEffort(engine, model),
        kind: "work", rounds: ledger[lane]?.rounds ?? 0, workRounds: ledger[lane]?.workRounds ?? ledger[lane]?.rounds ?? 0,
        reports: ledger[lane]?.reports ?? [], createdAt: ledger[lane]?.createdAt ?? now, updatedAt: now,
      };
    });
    console.log(`cdx: adopted lane=${lane} session=${sessionId}`);
    break;
  }
  case "view": viewCommand(argv); break;
  case "status": await statusCommand(argv); break;
  case "job": await jobCommand(argv); break;
  case "_job": {
    if (!argv[0]) fail("internal: _job <name>");
    process.exit(await runJob(argv[0]));
  }
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
    requireOwnChild(lane, entry);
    if (laneRunning(entry) && (pidAlive(entry.pid) || pidAlive(entry.codexPid))) fail(`lane "${lane}" is running; kill it first`);
    withLedger((ledger) => {
      const item = ledger[lane]!;
      requireOwnChild(lane, item);
      item.work.state = "closed";
      if (note) item.work.note = note;
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
