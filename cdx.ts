#!/usr/bin/env bun
// cdx runs tracked Codex execution lanes for Claude Code and Codex CLI users.
//
//   cdx spawn  <lane> [--account <name>] [--effort <effort>] [--cd <dir>] [--bg] [--add-dir <d>]... [--schema <file>] [--image <f>]... "<brief>"
//   cdx resume <lane> [--bg] "<follow-up>"
//   cdx fork   <newLane> <fromLane|sessionId> [--account <name>] [--effort <effort>] [--bg] "<brief>"
//   cdx review <lane> [--account <name>] [--effort <effort>] [--cd <dir>] [--bg] [--uncommitted | --base <branch> | --commit <sha>] [--scope "<files>"] ["<intent>"]
//   cdx adopt  <lane> <sessionId> [--account <name>] [--cd <dir>]
//   cdx status [--all] [--json]
//   cdx wait   <lane>... [--timeout <sec>]
//   cdx tail   <lane> [-n <lines>]
//   cdx report <lane> [round]
//   cdx log    <lane> [round]
//   cdx close  <lane> ["note"]
//   cdx clean  [--days <n>]
//   cdx doctor [--fix] [--probe]
//
// cdx policy comes from $CDX_HOME/config.json. Work lanes cannot commit, push,
// or deploy, and reviews always get a fresh read-only session.
//
// CLI facts this harness absorbs (codex-cli 0.149.x, verified):
// - `exec` supports --json (JSONL events), -o last-message, --cd, --output-schema.
// - `exec resume` and `exec fork` support NONE of --json/-o/--cd: they keep the
//   session's workdir, print human text, and the report is requested in-prompt.
// - `codex review` takes exactly one of --uncommitted/--base/--commit OR a
//   custom prompt, never both; it reviews the process cwd.
// - JSONL events: thread.started{thread_id}, turn.started,
//   item.completed{item:{type,...}}, turn.completed{usage{...}}.

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";

const HOME = process.env.HOME ?? "";
const ROOT = (process.argv[2] === "_run" ? process.env.CDX_STATE_HOME : undefined)
  || process.env.CDX_HOME || `${HOME}/.cdx`;
const LEDGER = `${ROOT}/ledger.json`;
const CONFIG_PATH = `${ROOT}/config.json`;
const USAGE_PATH = `${ROOT}/usage.json`;
const SELF = import.meta.path;

const COLOR_ENABLED = process.argv[2] !== "_run" && process.env.NO_COLOR === undefined
  && (process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== "0"
    : Boolean(process.stdout.isTTY && process.stderr.isTTY));
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

type Effort = string;
type Mode = "spawn" | "resume" | "fork" | "review-exec" | "review-native";

interface Config {
  model: string;
  efforts: string[];
  defaultEffort: string;
  rules: string[];
  accounts?: Record<string, string>;
}

interface Tokens { input: number; cached: number; output: number }

interface Lane {
  account?: string;
  codexHome?: string;
  ownerSession?: string;
  ownerCwd?: string;
  sessionId?: string;
  cwd: string;
  effort: Effort;
  state: "running" | "done" | "failed" | "adopted" | "closed";
  kind: "work" | "review";
  rounds: number;
  reports: string[];
  tokens?: Tokens;
  pid?: number;
  codexPid?: number;
  lastAction?: string;
  lastEventAt?: string;
  exitCode?: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
  roundStartedAt?: string;
}

interface Spec {
  mode: Mode;
  lane: string;
  round: number;
  cwd: string;
  prompt: string;
  codexArgs: string[];
  account?: string;
  codexHome?: string;
  multiAccountUsage?: true;
  ownerSession?: string;
  ownerCwd?: string;
}

type Ledger = Record<string, Lane>;

function coloredState(state: string, text = state): string {
  if (state === "running") return color.yellow(text);
  if (state === "running(dead?)" || state === "failed") return color.red(text);
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
  const allowed = new Set(["model", "efforts", "defaultEffort", "rules", "accounts"]);
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

  return { model, efforts: efforts as string[], defaultEffort, rules: rules as string[], ...(accounts ? { accounts } : {}) };
}

const config = readConfig(process.argv[2] === "_run");

for (const dir of ["logs", "reports", "briefs", "specs"]) mkdirSync(`${ROOT}/${dir}`, { recursive: true });

// Thrown instead of fail() inside withLedger callbacks: process.exit skips
// finally blocks and would strand the ledger lock. The dispatcher converts it.
class CmdError extends Error {}

// One line per lane completion; the plugin monitor tails this file and
// delivers each line to the Claude session as a notification.
function feed(line: string): boolean {
  try {
    writeFileSync(`${ROOT}/feed.log`, `${line}\n`, { flag: "a" });
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

function validLane(lane: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(lane)) fail(`lane name "${lane}" must be alphanumeric with . _ - only`);
  return lane;
}

const reportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.md`;
const logPathOf = (lane: string, round: number, json: boolean) => `${ROOT}/logs/${lane}-r${round}.${json ? "jsonl" : "log"}`;
const specPathOf = (lane: string, round: number) => `${ROOT}/specs/${lane}-r${round}.json`;

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Briefs: standing rules injected once here so per-lane briefs stay short.
// ---------------------------------------------------------------------------

function houseRules(cwd: string, reviewOnly: boolean): string {
  const builtIns = [
    reviewOnly
      ? "READ-ONLY: change nothing in the tree; write only your report."
      : "Never commit, push, deploy, or start long-running servers beyond what specs start themselves.",
    "Your final response is the lane report. Include what changed or what you reviewed, verification evidence, and any risks or follow-ups.",
  ];
  if (!reviewOnly) {
    builtIns.push("If the task splits into independent parts, parallelize with your own subagent threads rather than working them serially.");
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

const REVIEW_FRAME = `ADVERSARIAL REVIEW. Hunt real defects: correctness bugs, races, authorization holes, contract breaks, test gaps. Severity-rank findings, each with a concrete failure scenario, and mark each CONFIRMED (you traced the code path) or PLAUSIBLE (you could not fully trace it). If clean, say clean and list exactly what you checked.`;

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["effort", "cd", "scope", "schema", "base", "commit", "timeout", "days", "n", "note", "account"]);
const LIST_FLAGS = new Set(["add-dir", "image"]);
const BOOL_FLAGS = new Set(["bg", "json", "uncommitted", "fix", "probe", "follow", "all"]);

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

function accountSpec(account?: AccountChoice): Pick<Spec, "account" | "codexHome" | "multiAccountUsage"> {
  return {
    ...(account ? { account: account.name, codexHome: account.home } : {}),
    ...(config.accounts ? { multiAccountUsage: true as const } : {}),
  };
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

// ---------------------------------------------------------------------------
// Round lifecycle: open a round in the ledger, write its spec, run or detach.
// ---------------------------------------------------------------------------

function openRound(lane: string, kind: "work" | "review", cwd: string, effort: Effort, opts?: { requireSession?: boolean; account?: AccountChoice; preserveAccount?: boolean; owner?: LaneOwner; preserveOwner?: boolean }): { round: number; sessionId?: string } {
  const now = new Date().toISOString();
  return withLedger((ledger) => {
    const existing = ledger[lane];
    if (existing?.state === "running" && pidAlive(existing.pid)) {
      throw new CmdError(`lane "${lane}" is already running (pid ${existing.pid}); pick a new name or wait`);
    }
    if (opts?.requireSession && !existing?.sessionId) throw new CmdError(`lane "${lane}" has no session id; use cdx adopt or spawn`);
    const rounds = (existing?.rounds ?? 0) + 1;
    const account = opts?.preserveAccount ? existing?.account : opts?.account?.name;
    const codexHome = opts?.preserveAccount ? existing?.codexHome : opts?.account?.home;
    const ownerSession = opts?.preserveOwner ? existing?.ownerSession : opts?.owner?.ownerSession;
    const ownerCwd = opts?.preserveOwner ? existing?.ownerCwd : opts?.owner?.ownerCwd;
    ledger[lane] = {
      ...(existing ?? {}),
      account,
      codexHome,
      ownerSession,
      ownerCwd,
      sessionId: opts?.requireSession ? existing?.sessionId : undefined,
      cwd,
      effort,
      state: "running",
      roundStartedAt: now,
      // Reserve the lane with the parent's pid so a concurrent launch is
      // rejected before the runner records its own pid.
      pid: process.pid,
      kind,
      rounds,
      reports: existing?.reports ?? [],
      tokens: existing?.tokens ?? { input: 0, cached: 0, output: 0 },
      exitCode: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { round: rounds, sessionId: existing?.sessionId };
  });
}

function launch(spec: Spec, brief: string, background: boolean): Promise<never> | never {
  writeFileSync(specPathOf(spec.lane, spec.round), JSON.stringify(spec, null, 2));
  writeFileSync(`${ROOT}/briefs/${spec.lane}-r${spec.round}.md`, brief);
  const jsonMode = spec.mode === "spawn";
  console.log(`cdx: lane=${color.magenta(spec.lane)} mode=${spec.mode} round=${spec.round} cwd=${spec.cwd}${background ? " (background)" : ""}`);
  console.log(`cdx: log=${logPathOf(spec.lane, spec.round, jsonMode)} report=${reportPathOf(spec.lane, spec.round)}`);
  if (background) {
    const crashLog = openSync(`${ROOT}/logs/${spec.lane}-r${spec.round}.runner.log`, "a");
    const child = nodeSpawn(process.execPath, [SELF, "_run", spec.lane, String(spec.round)], {
      detached: true,
      env: uncoloredChildEnv(spec.codexHome, spec.codexHome ? ROOT : undefined),
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

async function runRound(lane: string, round: number): Promise<number> {
  let spec: Spec | undefined;
  try { spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec; } catch { /* handled by runner */ }
  try {
    return await runRoundInner(lane, round);
  } catch (error) {
    withLedger((ledger) => {
      const item = ledger[lane];
      if (item) {
        item.state = "failed";
        item.pid = undefined;
        item.note = `runner error: ${String(error).slice(0, 200)}`;
        item.updatedAt = new Date().toISOString();
      }
    });
    console.error(`cdx: lane=${color.magenta(lane)} state=${color.red("failed")} runner error: ${error}`);
    const ownerSession = spec?.ownerSession ?? readLedger()[lane]?.ownerSession;
    feedOwned(`[cdx] lane=${lane} state=failed (runner error)`, ownerSession);
    return 1;
  } finally {
    if (process.argv[2] === "_run" && spec) {
      const account = spec.account && spec.codexHome ? { name: spec.account, home: spec.codexHome } : undefined;
      // Without a readable spec the account context is unknown; refreshing
      // would misfile per-account usage as a flat usage.json.
      if (!spec.multiAccountUsage || account) {
        try { await refreshUsageSnapshot({ warnFeed: true, account, ownerSession: spec?.ownerSession }); } catch { /* best-effort */ }
      }
    }
  }
}

async function runRoundInner(lane: string, round: number): Promise<number> {
  const spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec;
  const jsonMode = spec.mode === "spawn";
  const logPath = logPathOf(lane, round, jsonMode);
  const reportPath = reportPathOf(lane, round);
  withLedger((ledger) => { ledger[lane]!.pid = process.pid; ledger[lane]!.state = "running"; });

  const proc = Bun.spawn({
    cmd: ["codex", ...spec.codexArgs],
    cwd: spec.cwd,
    env: uncoloredChildEnv(spec.codexHome),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  withLedger((ledger) => { const item = ledger[lane]; if (item) item.codexPid = proc.pid; });
  // A killed runner must not orphan its codex child mid-edit.
  const reap = () => { try { proc.kill(); } catch { /* already gone */ } };
  process.on("SIGTERM", reap);
  process.on("SIGINT", reap);
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
  const watchdog = setInterval(() => {
    const quiet = Date.now() - lastEventMs;
    if (quiet >= 300_000 && Date.now() - lastStallWarn >= 600_000) {
      lastStallWarn = Date.now();
      feedOwned(`[cdx] lane=${lane} round=${round} running but quiet ${Math.round(quiet / 60_000)}m (codex pid ${proc.pid}); cdx tail ${lane} to inspect`, spec.ownerSession);
    }
  }, 60_000);

  const handleEvent = (line: string) => {
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    noteActivity();
    const now = new Date().toISOString();
    if (event.type === "thread.started" && event.thread_id) {
      touchLedger((item) => { item.sessionId = event.thread_id; item.lastEventAt = now; }, true);
    } else if (event.type === "turn.completed" && event.usage) {
      touchLedger((item) => {
        const tokens = (item.tokens ??= { input: 0, cached: 0, output: 0 });
        tokens.input += event.usage.input_tokens ?? 0;
        tokens.cached += event.usage.cached_input_tokens ?? 0;
        tokens.output += event.usage.output_tokens ?? 0;
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

  await Promise.all([jsonMode ? pumpJson(proc.stdout) : pumpRaw(proc.stdout, log), pumpRaw(proc.stderr, errLog)]);
  clearInterval(watchdog);
  const exitCode = await proc.exited;
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
  const entry = withLedger((ledger) => {
    const item = ledger[lane]!;
    if (!jsonMode && !item.sessionId) {
      const match = /session id: ([0-9a-f-]{36})/.exec(readFileSync(logPath, "utf8"));
      if (match) item.sessionId = match[1];
    }
    item.state = exitCode === 0 && reportOk ? "done" : "failed";
    if (exitCode === 0 && !reportOk) item.note = "exit 0 but no report produced; inspect the log";
    else if (exitCode !== 0 && /login|auth|401|unauthorized|token.*expired/i.test(stderrText)) {
      item.note = "auth failure: run `codex login`, then `cdx resume` this lane";
    } else if (exitCode !== 0) {
      const errTail = stderrText.trim().split("\n").at(-1);
      if (errTail) item.note = `stderr: ${errTail.slice(0, 200)}`;
    }
    item.exitCode = exitCode;
    item.pid = undefined;
    item.codexPid = undefined;
    if (existsSync(reportPath)) item.reports.push(reportPath);
    item.updatedAt = new Date().toISOString();
    return item;
  });
  feedOwned(`[cdx] lane=${lane} round=${round} state=${entry.state} exit=${exitCode}${entry.note ? ` note=${entry.note}` : ""} tokens=${fmtTokens(entry.tokens)} report=${reportOk ? reportPath : "-"}`, entry.ownerSession);
  console.log(`lane=${color.magenta(lane)} session=${entry.sessionId ?? "?"} round=${round} state=${coloredState(entry.state)} exit=${exitCode} tokens=${fmtTokens(entry.tokens)} report=${reportPath}`);
  if (entry.note) console.log(`note: ${entry.note}`);
  if (reportOk) {
    console.log("--- report ---");
    console.log(readFileSync(reportPath, "utf8"));
  } else {
    console.log(`--- no report; log tail (${logPath}) ---`);
    console.log(renderTail(logPath, 40));
  }
  return entry.state === "done" ? 0 : exitCode || 1;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function spawnCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "cd", "bg", "add-dir", "image", "schema", "account"]);
  const [lane, brief] = parsed.rest;
  if (!lane || !brief) fail('usage: cdx spawn <lane> [--effort <effort>] [--cd <dir>] [--bg] "<brief>"');
  validLane(lane);
  const cwd = parsed.flags.cd ?? process.cwd();
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = effortOf(parsed);
  // Cheap pre-check so a doomed launch is rejected before paying for usage
  // probes; openRound re-checks under the ledger lock.
  const existingLane = readLedger()[lane];
  if (existingLane?.state === "running" && pidAlive(existingLane.pid)) {
    fail(`lane "${lane}" is already running (pid ${existingLane.pid}); pick a new name or wait`);
  }
  const selection = await selectAccount(parsed.flags.account);
  if (!config.accounts || parsed.flags.account) warnCachedUsageBeforeLaunch(selection.choice);
  const account = selection.choice;
  const owner = callerOwnership();
  const { round } = openRound(lane, "work", cwd, effort, { account, owner });
  announceAccountSelection(lane, selection, owner.ownerSession);
  const fullBrief = `Ground rules:\n${houseRules(cwd, false)}\n\nTask:\n${brief}`;
  const codexArgs = [
    "exec", "--json", "-m", config.model, "-c", `model_reasoning_effort=${effort}`,
    "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--cd", cwd,
    "--output-last-message", reportPathOf(lane, round),
  ];
  for (const dir of parsed.lists["add-dir"] ?? []) codexArgs.push("--add-dir", dir);
  for (const image of parsed.lists.image ?? []) codexArgs.push("--image", image);
  if (parsed.flags.schema) codexArgs.push("--output-schema", parsed.flags.schema);
  codexArgs.push(fullBrief);
  return launch({ mode: "spawn", lane, round, cwd, prompt: fullBrief, codexArgs, ...accountSpec(account), ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
}

function resumeCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["bg"]);
  const [lane, followUp] = parsed.rest;
  if (!lane || !followUp) fail('usage: cdx resume <lane> [--bg] "<follow-up>"');
  const before = readLane(lane);
  const account = laneAccount(before);
  warnCachedUsageBeforeLaunch(account);
  const owner = storedOwnership(before);
  const { round, sessionId } = openRound(lane, before.kind, before.cwd, before.effort, { requireSession: true, preserveAccount: true, preserveOwner: true });
  const reviewResume = before.kind === "review";
  const reportInstruction = reviewResume
    ? "Print your final report. cdx captures it from the transcript."
    : `Write your final report to ${reportPathOf(lane, round)} as well as printing it.`;
  const prompt = `Ground rules:\n${houseRules(before.cwd, reviewResume)}\n\nTask:\n${followUp}\n\n${reportInstruction}`;
  const codexArgs = reviewResume
    ? ["exec", "resume", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', "--skip-git-repo-check", sessionId!, prompt]
    : ["exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", sessionId!, prompt];
  return launch({ mode: "resume", lane, round, cwd: before.cwd, prompt, codexArgs, ...accountSpec(account), ...ownershipSpec(owner) }, prompt, parsed.bools.has("bg"));
}

function forkCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "bg", "account"]);
  const [newLane, source, brief] = parsed.rest;
  if (!newLane || !source || !brief) fail('usage: cdx fork <newLane> <fromLane|sessionId> [--bg] "<brief>"');
  validLane(newLane);
  const ledger = readLedger();
  const sourceLane = ledger[source];
  const sessionId = sourceLane?.sessionId ?? source;
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) fail(`"${source}" is neither a lane with a session nor a session UUID`);
  // exec fork keeps the source session's workdir; --cd would be a lie.
  const cwd = sourceLane?.cwd ?? process.cwd();
  const effort = parsed.flags.effort
    ? effortOf(parsed)
    : configuredEffort(sourceLane?.effort ?? config.defaultEffort);
  let account: AccountChoice | undefined;
  if (sourceLane) {
    account = laneAccount(sourceLane);
    if (parsed.flags.account !== undefined && parsed.flags.account !== sourceLane.account) {
      // A pre-account lane's session lives in the default Codex home, so
      // naming the account that maps there is a no-op, not a switch.
      const requested = configuredAccount(parsed.flags.account);
      if (account !== undefined || requested.home !== `${HOME}/.codex`) {
        fail("--account cannot switch a lane-based fork; the source session belongs to its recorded Codex home");
      }
      account = requested;
    }
  } else {
    account = primaryAccount(parsed.flags.account);
  }
  warnCachedUsageBeforeLaunch(account);
  const owner = callerOwnership();
  const { round } = openRound(newLane, "work", cwd, effort, { account, owner });
  const prompt = `Ground rules:\n${houseRules(cwd, false)}\n\nTask:\n${brief}\n\nWrite your final report to ${reportPathOf(newLane, round)} as well as printing it.`;
  const codexArgs = [
    "exec", "fork", "-m", config.model, "-c", `model_reasoning_effort=${effort}`,
    "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", sessionId, prompt,
  ];
  return launch({ mode: "fork", lane: newLane, round, cwd, prompt, codexArgs, ...accountSpec(account), ...ownershipSpec(owner) }, prompt, parsed.bools.has("bg"));
}

async function reviewCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "cd", "bg", "uncommitted", "base", "commit", "scope", "account"]);
  const [lane, intent] = parsed.rest;
  if (!lane) fail('usage: cdx review <lane> [--uncommitted | --base <branch> | --commit <sha>] [--scope "<files>"] ["<intent>"]');
  validLane(lane);
  const cwd = parsed.flags.cd ?? process.cwd();
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = effortOf(parsed);
  const targets = [parsed.bools.has("uncommitted") ? "--uncommitted" : "", parsed.flags.base ? "base" : "", parsed.flags.commit ? "commit" : ""].filter(Boolean);
  if (targets.length > 1) fail("pick exactly one of --uncommitted, --base, --commit");

  if (targets.length === 1) {
    // Native `codex review`: purpose-built diff review. It rejects a custom
    // prompt alongside a target, so the adversarial frame stays home.
    if (intent) fail("native review targets (--uncommitted/--base/--commit) cannot carry a custom intent; drop it or drop the target flag");
    if (parsed.flags.scope) fail("--scope only applies to exec review (native review always covers the whole target diff)");
    const selection = await selectAccount(parsed.flags.account);
    if (!config.accounts || parsed.flags.account) warnCachedUsageBeforeLaunch(selection.choice);
    const account = selection.choice;
    const owner = callerOwnership();
    const { round } = openRound(lane, "review", cwd, effort, { account, owner });
    announceAccountSelection(lane, selection, owner.ownerSession);
    const codexArgs = [
      "review", "-c", `review_model=${JSON.stringify(config.model)}`, "-c", `model_reasoning_effort=${effort}`,
      "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"',
    ];
    if (parsed.bools.has("uncommitted")) codexArgs.push("--uncommitted");
    if (parsed.flags.base) codexArgs.push("--base", parsed.flags.base);
    if (parsed.flags.commit) codexArgs.push("--commit", parsed.flags.commit);
    const label = parsed.bools.has("uncommitted") ? "uncommitted changes" : parsed.flags.base ? `diff vs ${parsed.flags.base}` : `commit ${parsed.flags.commit}`;
    return launch({ mode: "review-native", lane, round, cwd, prompt: `native review of ${label}`, codexArgs, ...accountSpec(account), ...ownershipSpec(owner) }, `native review of ${label}`, parsed.bools.has("bg"));
  }

  if (!intent) fail("exec review needs an intent (or pass a native target flag)");
  const selection = await selectAccount(parsed.flags.account);
  if (!config.accounts || parsed.flags.account) warnCachedUsageBeforeLaunch(selection.choice);
  const account = selection.choice;
  const owner = callerOwnership();
  const { round } = openRound(lane, "review", cwd, effort, { account, owner });
  announceAccountSelection(lane, selection, owner.ownerSession);
  const scope = parsed.flags.scope
    ? `\nScope: review EXACTLY these files, ignore all other dirty files (other lanes own them): ${parsed.flags.scope}`
    : "";
  const fullBrief = [REVIEW_FRAME + scope, `Ground rules:\n${houseRules(cwd, true)}`, `Task:\n${intent}`].join("\n\n");
  // Reviews are read-only: enforce it with the sandbox, not just the prompt.
  const codexArgs = [
    "exec", "--json", "-m", config.model, "-c", `model_reasoning_effort=${effort}`,
    "-s", "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check", "--cd", cwd,
    "--output-last-message", reportPathOf(lane, round), fullBrief,
  ];
  return launch({ mode: "spawn", lane, round, cwd, prompt: fullBrief, codexArgs, ...accountSpec(account), ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
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
  const stale = entry.state === "running" && !pidAlive(entry.pid);
  const state = stale ? "running(dead?)" : entry.state;
  const first = `${color.magenta(lane)}  ${coloredState(state)}  ${entry.kind} r${entry.rounds} ${entry.effort}${entry.account ? `  account=${entry.account}` : ""}`;
  const line = (label: string, value: string) => `${color.dim(`  ${label.padEnd(9)}`)}${value}`;
  let owner = "-";
  if (entry.ownerCwd) {
    const currentSession = process.env.CLAUDE_CODE_SESSION_ID?.trim();
    const ownerId = entry.ownerSession?.slice(0, 8) || "terminal";
    const relation = !entry.ownerSession || !currentSession ? "(terminal)"
      : entry.ownerSession === currentSession ? "(this session)" : "(other session)";
    owner = `${ownerId} ${relation}  from ${displayPath(entry.ownerCwd)}`;
  }
  const timing = entry.state === "running"
    ? `running ${fmtAge(entry.roundStartedAt ?? entry.createdAt)} · idle ${fmtAge(entry.lastEventAt ?? entry.roundStartedAt ?? entry.createdAt)}`
    : `finished ${fmtAge(entry.updatedAt)} ago`;
  const laneDetail = `cwd ${displayPath(entry.cwd)} · created ${fmtCreated(entry.createdAt)} · ${timing}`;
  const tokenDetail = `${fmtTokens(entry.tokens)} · codex session ${entry.sessionId?.slice(0, 8) ?? "-"}`;
  const report = entry.reports.at(-1);
  const last = entry.state === "running" ? entry.lastAction ?? "-"
    : [entry.note, report ? `report ${displayPath(report)}` : undefined].filter(Boolean).join(" · ") || "-";
  return [first, line("owner", owner), line("lane", laneDetail), line("tokens", tokenDetail), line("last", last)].join("\n");
}

const FINISHED_SHOWN = 10;

function statusCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["json", "all"]);
  const ledger = readLedger();
  const all = Object.entries(ledger);
  if (parsed.bools.has("json")) {
    const enriched = Object.fromEntries(all.map(([lane, entry]) => [lane, { ...entry, alive: entry.state === "running" ? pidAlive(entry.pid) : undefined }]));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  if (all.length === 0) { console.log("cdx: no lanes"); return; }
  // Running lanes first (most recent activity on top), then finished ones
  // newest first, capped unless --all.
  const byRecency = (a: [string, Lane], b: [string, Lane]) =>
    Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt);
  const running = all.filter(([, entry]) => entry.state === "running").sort(byRecency);
  const finished = all.filter(([, entry]) => entry.state !== "running").sort(byRecency);
  const hidden = parsed.bools.has("all") ? 0 : Math.max(0, finished.length - FINISHED_SHOWN);
  const lanes = [...running, ...finished.slice(0, finished.length - hidden)];
  console.log(lanes.map(([lane, entry]) => renderLaneBlock(lane, entry)).join("\n\n"));
  if (hidden > 0) console.log(`\n${color.dim(`… ${hidden} older finished lane${hidden === 1 ? "" : "s"} hidden (cdx status --all)`)}`);
}

async function waitCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["timeout"]);
  const lanes = parsed.rest;
  if (lanes.length === 0) fail("usage: cdx wait <lane>... [--timeout <sec>]");
  for (const lane of lanes) readLane(lane);
  const timeoutMs = Number(parsed.flags.timeout ?? 7200) * 1000;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(lanes);
  let failed = false;
  while (pending.size > 0) {
    const ledger = readLedger();
    for (const lane of [...pending]) {
      const entry = ledger[lane]!;
      if (entry.state === "running" && pidAlive(entry.pid)) continue;
      if (entry.state === "running") {
        console.log(`cdx: lane=${color.magenta(lane)} ${color.red("runner died without finalizing")} (see cdx doctor)`);
        failed = true;
      } else {
        console.log(`cdx: lane=${color.magenta(lane)} state=${coloredState(entry.state)} exit=${entry.exitCode ?? "?"} tokens=${fmtTokens(entry.tokens)} report=${entry.reports.at(-1) ?? "-"}`);
        if (entry.state === "failed") failed = true;
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
    if (entry.state !== "running") {
      console.log(`--- lane ${color.magenta(lane)} ${coloredState(entry.state)}${entry.exitCode !== undefined ? ` (exit ${entry.exitCode})` : ""}${entry.note ? `: ${entry.note}` : ""} report=${entry.reports.at(-1) ?? "-"} ---`);
      process.exit(entry.state === "failed" ? 1 : 0);
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
      if (entry.state !== "running" || cursors.has(lane)) continue;
      const cursor = openCursor(lane, entry, true);
      if (cursor) {
        cursors.set(lane, cursor);
        console.log(`${color.magenta(`[${lane}]`)} --- attached (round ${cursor.round}, ${entry.effort}, ${entry.cwd}) ---`);
      }
    }
    for (const [lane, cursor] of cursors) {
      const entry = ledger[lane];
      if (entry && entry.state === "running" && entry.rounds > cursor.round) {
        cursors.set(lane, openCursor(lane, entry, false) ?? cursor);
        continue;
      }
      drainCursor(cursor, `${color.magenta(`[${lane}]`)} `);
      if (!entry || entry.state !== "running") {
        console.log(`${color.magenta(`[${lane}]`)} --- ${entry ? coloredState(entry.state) : "gone"}${entry?.note ? `: ${entry.note}` : ""} ---`);
        cursors.delete(lane);
      }
    }
    if (cursors.size === 0) {
      const running = Object.values(readLedger()).some((entry) => entry.state === "running");
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
      { id: 1, method: "initialize", params: { clientInfo: { name: "cdx", title: "cdx", version: "2" } } },
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
  const stale = Object.entries(readLedger()).filter(([, entry]) => entry.state === "running" && !pidAlive(entry.pid));
  for (const [lane, entry] of stale) {
    const orphan = pidAlive(entry.codexPid) ? ` and its codex child (pid ${entry.codexPid}) is STILL RUNNING` : "";
    console.log(color.red(`stale: lane "${lane}" marked running but its runner is dead${orphan}`));
  }
  if (stale.length > 0 && parsed.bools.has("fix")) {
    for (const [lane, entry] of stale) {
      if (pidAlive(entry.codexPid)) {
        try { process.kill(entry.codexPid!, "SIGTERM"); good(`fixed: sent SIGTERM to orphaned codex pid ${entry.codexPid} (lane "${lane}")`); } catch { /* raced */ }
      }
    }
    withLedger((ledger) => {
      for (const [lane] of stale) {
        ledger[lane]!.state = "failed";
        ledger[lane]!.pid = undefined;
        ledger[lane]!.codexPid = undefined;
        ledger[lane]!.updatedAt = new Date().toISOString();
      }
    });
    good(`fixed: marked ${stale.length} stale lane(s) failed`);
  } else if (stale.length > 0) {
    warn("run `cdx doctor --fix` to mark them failed (kills orphaned codex children)");
  }

  if (parsed.bools.has("probe")) {
    if (!version?.success || !loggedIn) {
      warn("probe: skipped, fix the failures above first");
    } else {
      console.log(color.cyan("probe: live exec round-trip, may take about 30s..."));
      const started = Date.now();
      const proc = Bun.spawn({
        cmd: ["codex", "exec", "--json", "-m", config.model, "-c", `model_reasoning_effort=${config.defaultEffort}`, "-s", "read-only", "-c", 'approval_policy="never"', "--skip-git-repo-check", "--cd", "/tmp", "Reply with the single word OK and nothing else."],
        ...(doctorAccount ? { env: uncoloredChildEnv(doctorAccount.home) } : {}),
        stdout: "pipe", stderr: "pipe",
      });
      const killer = setTimeout(() => proc.kill(), 180_000);
      const [out, errText, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      clearTimeout(killer);
      let reply = "";
      let usage = "";
      for (const line of out.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "item.completed" && event.item?.type === "agent_message") reply = event.item.text;
          if (event.type === "turn.completed") usage = `${event.usage?.input_tokens ?? "?"} in / ${event.usage?.output_tokens ?? "?"} out`;
        } catch { /* interleaved non-JSON noise */ }
      }
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (exitCode === 0 && reply) {
        good(`probe: OK in ${secs}s (reply "${reply.trim()}", ${usage})`);
      } else {
        const errTail = errText.trim().split("\n").at(-1) ?? "";
        const remedy = /auth|login|401|unauthorized/i.test(errText) ? "run `codex login`"
          : /model/i.test(errText) ? `model ${config.model} rejected; check \`codex features\` and account access`
          : "check network, then `codex login status`; full stderr is above";
        bad("probe", `exec exited ${exitCode} after ${secs}s${errTail ? ` (${errTail})` : ""}`, remedy);
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
  const running = entries.filter(([, entry]) => entry.state === "running").sort(byRecency);
  const failed = entries.filter(([, entry]) => entry.state === "failed").sort(byRecency);
  const lanes = [...running, ...failed];
  if (lanes.length > 0) console.log(lanes.map(([lane, entry]) => renderLaneBlock(lane, entry)).join("\n\n"));
}

function cleanCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["days"]);
  const days = Number(parsed.flags.days ?? 14);
  const cutoff = Date.now() - days * 86_400_000;
  const removed: string[] = [];
  withLedger((ledger) => {
    for (const [lane, entry] of Object.entries(ledger)) {
      if (entry.state !== "closed" || Date.parse(entry.updatedAt) > cutoff) continue;
      // Anchor on "-r<digits>." so lane "foo" never matches "foo-review-r1".
      const escaped = lane.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escaped}-r\\d+\\.`);
      for (const dir of ["logs", "reports", "briefs", "specs"]) {
        for (const file of readdirSync(`${ROOT}/${dir}`)) {
          if (pattern.test(file)) rmSync(`${ROOT}/${dir}/${file}`, { force: true });
        }
      }
      delete ledger[lane];
      removed.push(lane);
    }
  });
  console.log(removed.length > 0 ? `cdx: pruned closed lanes older than ${days}d: ${removed.join(", ")}` : `cdx: nothing to prune (closed lanes older than ${days}d)`);
}

const USAGE = `cdx tracks Codex execution lanes
cdx policy: model ${config.model}; efforts ${config.efforts.join(", ")}; default effort ${config.defaultEffort}; set in ${CONFIG_PATH}

  spawn  <lane> [--account NAME] [--effort E] [--cd D] [--bg] [--add-dir D]... [--schema F] [--image F]... "<brief>"
  resume <lane> [--bg] "<follow-up>"
  fork   <newLane> <fromLane|sessionId> [--account NAME] [--effort E] [--bg] "<brief>"
  review <lane> [--account NAME] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "files"] ["<intent>"]
  adopt  <lane> <sessionId> [--account NAME] [--cd D]
  status [--json]         wait <lane>... [--timeout S]
  tail   <lane> [-n N]    tail -f [lane]           # -f: live transcript; no lane = all running lanes
  report <lane> [round]    log <lane> [round]
  close  <lane> ["note"]  clean [--days N]         doctor [--fix] [--probe]
  brief                   # running/failed lanes only; silent when all settled

--bg detaches the lane (survives the parent shell); combine with "cdx wait" for
one blocking call over many lanes. Foreground lanes print the report on exit.`;

// ---------------------------------------------------------------------------

const [command, ...argv] = process.argv.slice(2);
try {
  await dispatch(command, argv);
} catch (err) {
  // CmdError is a user-facing refusal thrown from inside withLedger callbacks,
  // where process.exit would strand the lock. Convert it here, after unlock.
  if (err instanceof CmdError) fail(err.message);
  throw err;
}

async function dispatch(command: string | undefined, argv: string[]) {
switch (command) {
  case "spawn": await spawnCommand(argv); break;
  case "review": await reviewCommand(argv); break;
  case "resume": await resumeCommand(argv); break;
  case "fork": await forkCommand(argv); break;
  case "_run": {
    const [lane, round] = argv;
    if (!lane || !round) fail("internal: _run <lane> <round>");
    process.exit(await runRound(lane, Number(round)));
  }
  case "adopt": {
    const parsed = parseArgs(argv, ["cd", "account"]);
    const [lane, sessionId] = parsed.rest;
    if (!lane || !sessionId) fail("usage: cdx adopt <lane> <sessionId> [--cd <dir>]");
    validLane(lane);
    const account = primaryAccount(parsed.flags.account);
    const owner = callerOwnership();
    const now = new Date().toISOString();
    withLedger((ledger) => {
      ledger[lane] = {
        ...(account ? { account: account.name, codexHome: account.home } : {}),
        ...owner,
        sessionId, cwd: parsed.flags.cd ?? process.cwd(), effort: config.defaultEffort, state: "adopted",
        kind: "work", rounds: ledger[lane]?.rounds ?? 0, reports: ledger[lane]?.reports ?? [],
        createdAt: ledger[lane]?.createdAt ?? now, updatedAt: now,
      };
    });
    console.log(`cdx: adopted lane=${lane} session=${sessionId}`);
    break;
  }
  case "status": statusCommand(argv); break;
  case "wait": await waitCommand(argv); break;
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
    const [lane, roundArg] = argv;
    if (!lane) fail("usage: cdx log <lane> [round]");
    const entry = readLane(lane);
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
    const [lane, note] = argv;
    if (!lane) fail('usage: cdx close <lane> ["note"]');
    readLane(lane);
    withLedger((ledger) => {
      const item = ledger[lane]!;
      item.state = "closed";
      if (note) item.note = note;
      item.updatedAt = new Date().toISOString();
    });
    console.log(`cdx: closed lane=${lane}`);
    break;
  }
  case "clean": cleanCommand(argv); break;
  case "doctor": await doctorCommand(argv); break;
  case "brief": briefCommand(); break;
  case "help": case "--help": case "-h": case undefined: console.log(USAGE); break;
  default:
    fail(`unknown command "${command}"\n${USAGE}`);
}
}
