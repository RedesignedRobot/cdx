import { captureGateTree } from "./gates.ts";
import { safeText } from "./safe-text.ts";
import { safeLines } from "./safe-lines.ts";
// Detached shell jobs and their lifecycle.

import { feedEvent, owned, readLedger, withLockedJson } from "./ledger.ts";
import { jobPhase } from "./reports.ts";
import {
  CmdError, color, coloredState, completionVerdict, fail, FINISHED_SHOWN, parseArgs, pidAlive, ROOT, SELF,
  settleHint, uncoloredChildEnv,
} from "./runtime.ts";
import { renderNote } from "./tui.ts";
import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function jobCwd(explicit: string | undefined): string {
  if (!explicit?.trim()) throw new CmdError("cdx job requires --cd <repo>; caller cwd is not a job target");
  return resolve(explicit);
}

export function summaryJobs(jobs: Jobs, finishedShown = FINISHED_SHOWN, maxFinishedAgeMs?: number, now = Date.now()): [string, Job][] {
  const entries = Object.entries(jobs).sort((a, b) => b[1].startedAt.localeCompare(a[1].startedAt));
  const recent = ([, job]: [string, Job]) => maxFinishedAgeMs === undefined
    || now - Date.parse(job.finishedAt ?? job.startedAt) <= maxFinishedAgeMs;
  return [...entries.filter(([, job]) => jobRunning(job)), ...entries.filter(([, job]) => !jobRunning(job)).filter(recent).slice(0, finishedShown)];
}

// Jobs: background shell commands the head runs beside lanes (a wall, a
// deploy chain, a long gate). No engine, no brief, no report: one log, one
// exit code, and one feed line the plugin monitor delivers when the job ends,
// so the head never polls a summary file from a sleep loop.

type JobState = "running" | "done" | "failed";

export interface Job {
  treeStart?: import("./ledger.ts").GateTree;
  treeEnd?: import("./ledger.ts").GateTree;
  cmd?: string;
  cwd?: string;
  exitCode?: number;
  finishedAt?: string;
  log: string;
  note?: string;
  ownerSession?: string;
  pid?: number;
  startedAt: string;
  state: JobState;
}

export type Jobs = Record<string, Job>;

export const JOBS = `${ROOT}/jobs.json`;

const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGKILL: 137, SIGTERM: 143 };

export function readJobs(): Jobs {
  if (!existsSync(JOBS)) return {};
  return JSON.parse(readFileSync(JOBS, "utf8")) as Jobs;
}

function withJobs<T>(mutate: (jobs: Jobs) => T): T {
  return withLockedJson(JOBS, `${ROOT}/.jobs.lock`, readJobs, mutate);
}

export function jobRunning(job: Job): boolean {
  return job.state === "running";
}

export function jobDuration(job: Job): string {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
}

export function renderJobLine(name: string, job: Job): string {
  const state = jobRunning(job) && !pidAlive(job.pid) ? "running(dead?)" : job.state;
  const exit = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
  const note = job.note ? ` note=${job.note}` : "";
  const phase = jobRunning(job) ? jobPhase(job.log) : "";
  return `job=${color.magenta(name)} state=${coloredState(state)}${exit} ${jobDuration(job)}${phase ? ` phase=${phase}` : ""} log=${job.log}${note}`;
}

// A running job whose runner died never finalized itself; record that here so
// wait and status stop showing it as live.
export function settledJob(name: string): Job | undefined {
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

export function printRunningJobs(tui = false): void {
  const running = Object.entries(readJobs()).filter(([, job]) => jobRunning(job) && owned(job.ownerSession));
  if (running.length === 0) return;
  const text = `jobs running:\n${running.map(([name, job]) => `  ${renderJobLine(name, job)}`).join("\n")}`;
  console.log(`\n${tui ? text.split("\n").map((line) => renderNote(line)).join("\n") : text}`);
}

function listJobs(): void {
  const entries = Object.entries(readJobs());
  if (entries.length === 0) { console.log("cdx: no jobs"); return; }
  const byRecency = (a: [string, Job], b: [string, Job]) => Date.parse(b[1].startedAt) - Date.parse(a[1].startedAt);
  const running = entries.filter(([, job]) => jobRunning(job)).sort(byRecency);
  const finished = entries.filter(([, job]) => !jobRunning(job)).sort(byRecency).slice(0, FINISHED_SHOWN);
  for (const [name, job] of [...running, ...finished]) console.log(renderJobLine(name, job));
}

export async function jobCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["cd"]);
  const [name, ...rest] = parsed.rest;
  if (!name) { listJobs(); return; }
  if (!JOB_NAME.test(name)) fail(`job name "${name}" must match ${JOB_NAME.source}`);
  if (readLedger()[name]) fail(`"${name}" is a lane; pick another job name`);
  let cmd = rest.join(" ");
  if (cmd === "-") cmd = await Bun.stdin.text();
  cmd = cmd.trim();
  if (!cmd) fail('usage: cdx job <name> --cd <dir> "<cmd>"   (a "-" command reads stdin; no arguments lists jobs)');
  const cwd = jobCwd(parsed.flags.cd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) fail(`--cd ${cwd} is not a directory`);
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
  writeFileSync(log, safeText(`# cdx job ${name}\n# cwd ${cwd}\n# cmd ${cmd}\n# started ${startedAt}\n`));
  const runnerLog = openSync(`${ROOT}/logs/job-${name}.runner.log`, "a");
  const child = nodeSpawn(process.execPath, [SELF, "_job", name], {
    detached: true,
    env: { ...uncoloredChildEnv(undefined, ROOT), CDX_JOB_CMD: cmd, CDX_JOB_CWD: cwd, ...(ownerSession ? { CDX_JOB_OWNER: ownerSession } : {}) },
    stdio: ["ignore", runnerLog, runnerLog],
  });
  child.unref();
  withJobs((jobs) => { jobs[name]!.pid = child.pid; });
  console.log(`cdx: job=${color.magenta(name)} pid=${child.pid} cwd=${cwd}`);
  console.log(`cdx: log=${log}; ${settleHint(name)}`);
  process.exit(0);
}

function jobTree(cwd: string): import("./ledger.ts").GateTree | undefined {
  try { return captureGateTree(cwd); } catch { return undefined; }
}

export async function runJob(name: string): Promise<number> {
  const cmd = process.env.CDX_JOB_CMD;
  const cwd = process.env.CDX_JOB_CWD;
  if (!cmd || !cwd) fail("internal: _job needs CDX_JOB_CMD and CDX_JOB_CWD");
  const job = readJobs()[name];
  if (!job) fail(`internal: job "${name}" is missing from ${JOBS}`);
  const env = { ...process.env };
  for (const key of ["CDX_JOB_CMD", "CDX_JOB_CWD", "CDX_JOB_OWNER", "CDX_STATE_HOME"]) delete env[key];
  withJobs((jobs) => { jobs[name]!.treeStart = jobTree(cwd); });
  const child = nodeSpawn("/bin/sh", ["-lc", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let signal: string | undefined;
  const forward = (sig: NodeJS.Signals) => {
    signal = sig;
    try { child.kill(sig); } catch { /* already gone */ }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  const exited = new Promise<number>((resolve) => {
    child.on("close", (code, sig) => resolve(code ?? (sig ? SIGNAL_EXIT_CODES[sig] ?? 1 : 1)));
    child.on("error", () => resolve(1));
  });
  const drain = async (stream: AsyncIterable<Uint8Array>) => {
    for await (const text of safeLines(stream)) appendFileSync(job.log, text);
  };
  const [exitCode] = await Promise.all([exited, drain(child.stdout!), drain(child.stderr!)]);
  const state: JobState = exitCode === 0 ? "done" : "failed";
  const note = signal ? `terminated by ${signal}` : undefined;
  const finished = withJobs((jobs) => {
    const entry = jobs[name]!;
    entry.treeEnd = jobTree(cwd);
    entry.exitCode = exitCode;
    entry.finishedAt = new Date().toISOString();
    entry.state = state;
    if (note) entry.note = note;
    return entry;
  });
  feedEvent("job-exit", `[cdx] job=${name} state=${state} exit=${exitCode} in=${jobDuration(finished)} log=${finished.log} report=- gateExit=not-applicable verdict=${JSON.stringify(completionVerdict(state, note))}${note ? ` note=${note}` : ""}`, process.env.CDX_JOB_OWNER, { job: name });
  return exitCode;
}

export async function killJob(name: string, job: Job, note?: string): Promise<void> {
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
  feedEvent("job-exit", `[cdx] job=${name} state=failed exit=137 in=${jobDuration(finished)} log=${finished.log} report=- gateExit=not-applicable verdict=${JSON.stringify(completionVerdict("failed", finished.note))} note=${finished.note}`, finished.ownerSession, { job: name });
  console.log(`cdx: ${renderJobLine(name, finished)}`);
}
