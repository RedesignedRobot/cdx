// Terminal status, wait and tail views, and usage presentation.

import {
  accountAdvice, adviceLines, cachedAccountStandings, HEADROOM_PERCENT, refreshUsageSnapshot, standingOf, withAccountHolds,
} from "./accounts.ts";
import { config } from "./config.ts";
import { GEMINI_OUTAGE_RETRIES } from "./engines.ts";
import {
  geminiQuotaState, type GeminiQuotaState, type GeminiUsageSnapshot, geminiWindows, readGeminiUsageSnapshot,
  refreshGeminiUsage,
} from "./gemini-usage.ts";
import {
  type Job, jobRunning, type Jobs, JOBS, printRunningJobs, readJobs, renderJobLine, settledJob,
} from "./jobs.ts";
import {
  type AccountChoice, activeStateOf, callerSession, type Lane, laneEngine, type LaneOutage, laneRunning,
  type Ledger, owned, readLedger, readSessions, recipientOf, roundEngine, roundExitCodeOf, roundNoteOf,
  roundReportOf, type Tokens, workCwdOf,
} from "./ledger.ts";
import { questionFiles, questionOpen, type QuestionRecord } from "./questions.ts";
import { availableReportPath, jobPhase, logPathOf, openCursor, readTailLines, renderEventLine } from "./reports.ts";
import { safeText } from "./safe-text.ts";
import {
  color, coloredState, displayPath, fail, FINISHED_SHOWN, fmtAge, fmtCreated, fmtTokens, fmtTokensFull,
  fmtUntil, HOME, LEDGER, parseArgs, pidAlive, rateLimitResetDate, statusAge, statusText, uncoloredChildEnv,
} from "./runtime.ts";
import {
  firstExhaustion, liveView, renderNote, renderStatus, renderTable, renderUsageTable, tuiEnabled, type View,
} from "./tui.ts";
import {
  projectWindow, readUsageHistory, readUsageSnapshot, type UsageReading, type UsageSnapshot, type WindowProjection,
} from "./usage-store.ts";
import { existsSync, readFileSync } from "node:fs";

export function porcelainFileCount(output: string): number {
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

export function changedFileCount(cwd: string, timeoutMs = 1000): number | undefined {
  try {
    const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdin: "ignore", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1_048_576 });
    return result.success ? porcelainFileCount(result.stdout.toString()) : undefined;
  } catch { return undefined; }
}

export interface LiveRow {
  name: string;
  parent?: string;
  kind: "lane" | "job";
  engine: string;
  model?: string;
  stage: string;
  startedAt: string;
  steps: number;
  files?: number;
  action: string;
  question?: string;
  transcript?: string[];
}

function recentTranscript(name: string, round: number): string[] {
  try {
    const log = [true, false].map((json) => logPathOf(name, round, json)).find(existsSync);
    if (!log) return [];
    return readTailLines(log, 80).map((line) => log.endsWith(".jsonl") ? renderEventLine(line) : line)
      .filter((line): line is string => Boolean(line)).slice(-3)
      .map((line) => Array.from(safeText(line).replace(/\s+/g, " ")).slice(0, 160).join(""));
  } catch { return []; }
}

export function liveRows(now = Date.now()): LiveRow[] {
  const detailDeadline = Date.now() + 200;
  const files = new Map<string, number | undefined>();
  const rows: LiveRow[] = [];
  const ledger = readLedger();
  const questions = questionFiles();
  for (const [name, entry] of Object.entries(ledger)) {
    if (!laneRunning(entry)) continue;
    const cwd = entry.kind === "review" ? entry.review?.cwd ?? entry.work.cwd : entry.work.cwd;
    if (!files.has(cwd)) {
      const remaining = detailDeadline - Date.now();
      files.set(cwd, remaining > 0 ? changedFileCount(cwd, Math.min(remaining, 75)) : undefined);
    }
    const question = questions.find(({ record }) => record.lane === name && record.round === entry.rounds && questionOpen(record));
    rows.push({ name, parent: entry.parent, kind: "lane", engine: roundEngine(entry),
      model: entry.kind === "review" ? entry.reviewModel ?? entry.model : entry.fallbackModel ?? entry.model,
      stage: question ? "question" : entry.outage ? "outage" : entry.queuedUntil && Date.parse(entry.queuedUntil) > now ? "queued"
        : now - Date.parse(entry.lastEventAt ?? entry.roundStartedAt ?? entry.createdAt) >= 300_000 ? "stalled" : entry.stage ?? "working",
      startedAt: entry.roundStartedAt ?? entry.createdAt, steps: entry.roundSteps ?? 0,
      files: files.get(cwd), action: entry.lastAction ?? "", question: question?.record.question,
      transcript: Date.now() < detailDeadline ? recentTranscript(name, entry.rounds) : [] });
  }
  for (const [name, job] of Object.entries(readJobs())) {
    if (!jobRunning(job)) continue;
    rows.push({ name, kind: "job", engine: "job", stage: "working", startedAt: job.startedAt,
      steps: 0, action: Date.now() < detailDeadline ? jobPhase(job.log) || "running" : "running" });
  }
  return rows;
}

export function outageText(outage: LaneOutage, agyRetries: number | undefined, now = Date.now()): string {
  const layer = outage.layer === "agy"
    ? `agy in-process retry ${outage.attempt}`
    : `cdx ladder ${outage.attempt}/${outage.limit ?? GEMINI_OUTAGE_RETRIES}`;
  const nextMs = outage.nextRetryAt ? Date.parse(outage.nextRetryAt) - now : Number.NaN;
  const next = Number.isFinite(nextMs) ? (nextMs > 0 ? `next retry in ${Math.round(nextMs / 1000)}s` : "retry in flight") : "";
  const total = agyRetries ? `agy retries this round ${agyRetries}` : "";
  return [`${outage.reason} for ${statusAge(outage.since, now)}`, layer, next, total].filter(Boolean).join(" · ");
}

export function laneProgress(entry: Lane, files: number | undefined, now = Date.now()): string {
  const stage = entry.stage === "gate" ? `gate running ${statusAge(entry.stageStartedAt, now)}` : entry.stage ?? "working";
  const tests = entry.roundTestRuns ? ` tests=${entry.roundTestRuns} suites=${entry.roundTestSuites ?? 0} ${entry.roundTestStatus ?? "running"}` : "";
  const graph = entry.roundCodegraphCalls !== undefined || entry.roundCodeSearchesBeforeGraph !== undefined
    ? ` codegraph=${entry.roundCodegraphCalls ?? 0} code-before-graph=${entry.roundCodeSearchesBeforeGraph ?? 0}` : "";
  return `${entry.roundSteps ?? 0} steps${files === undefined ? "" : ` ${files} files`}${tests}${graph} ${stage} last ${statusAge(entry.lastActionAt ?? entry.lastEventAt, now)} ${statusText(entry.lastAction ?? "-", 160)}`;
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
  const roundModel = entry.kind === "review" ? entry.reviewModel ?? entry.model : entry.model;
  const modelDetail = engine === "gpt" && roundModel ? `  model=${roundModel}`
    : engine === "gemini" && active && entry.fallbackModel ? `  model=${entry.fallbackModel} (capacity fallback)` : "";
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
  const laneDetail = `cwd ${displayPath(workCwdOf(entry))}${entry.branch ? ` · worktree ${entry.branch}` : ""} · created ${fmtCreated(entry.createdAt)} · ${timing}${entry.expectMinutes ? ` · expect ${entry.expectMinutes}m` : ""}`;
  const tokenLabel = active && entry.roundTokens
    ? `${fmtTokens(entry.roundTokens, record.tokensIncomplete)} round / ${fmtTokens(entry.tokens, entry.tokensIncomplete)} total`
    : fmtTokens(entry.tokens, entry.tokensIncomplete);
  const tokenDetail = `${tokenLabel} · ${engine === "gemini" ? "gemini conversation" : "codex session"} ${(entry.workSessionId ?? entry.sessionId)?.slice(0, 8) ?? "-"}`;
  const report = record.report ?? (entry.kind === "work" ? entry.reports.at(-1) : undefined);
  const lastParts = [entry.diffEmpty ? "no tree change" : undefined, record.note, report ? `report ${displayPath(report)}` : undefined].filter(Boolean);
  const last = (entry.consult || entry.kind === "work") && active ? entry.lastAction ?? "-"
    : lastParts.join(" · ") || "-";
  const lines = [first, line("owner", owner), line("lane", laneDetail), line("tokens", tokenDetail), line("last", last)];
  if (active) lines.push(line("progress", laneProgress(entry, changedFileCount(entry.kind === "review" ? entry.review?.cwd ?? entry.work.cwd : entry.work.cwd))));
  if (active && entry.outage) lines.push(line("outage", color.yellow(outageText(entry.outage, entry.agyRetries))));
  const waiting = questionFiles(lane).find(({ record }) => record.round === entry.rounds && questionOpen(record));
  if (active && waiting) lines.push(line("question", `waiting on question #${waiting.record.seq}: ${waiting.record.question}`));
  if (entry.review?.state && !entry.consult) {
    const reviewState = entry.kind === "review" && stale ? "running(dead?)" : entry.review?.state;
    const reviewTiming = entry.review?.state === "running"
      ? `running ${fmtAge(entry.roundStartedAt)} · idle ${fmtAge(entry.lastEventAt ?? entry.roundStartedAt)}`
      : `finished ${fmtAge(entry.review?.updatedAt)} ago`;
    const reviewLast = entry.review?.state === "running" ? entry.lastAction ?? "-"
      : [entry.review?.note, entry.review?.report ? `report ${displayPath(entry.review?.report)}` : undefined].filter(Boolean).join(" · ") || "-";
    const label = "review";
    lines.push(line(label, `${coloredState(reviewState)}${entry.review?.round ? ` r${entry.review?.round}` : ""} · cwd ${displayPath(entry.review?.cwd ?? workCwdOf(entry))} · ${reviewTiming}`));
    lines.push(line(`${label} last`, reviewLast));
  }
  return lines.join("\n");
}

export function statusBrief(ledger: Ledger, jobs: Jobs, io: {
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
    lines.push(statusText(`job ${statusText(name, 24)} ${statusAge(job.startedAt, io.now)}${job.expectMinutes ? ` expect ${job.expectMinutes}m` : ""} ${io.phase(job.log) || "-"}`, 99));
  }
  return lines.join("\n");
}

interface StatusLineIO {
  ownsLane?: (name: string, entry: Lane) => boolean;
  ownsJob?: (name: string, job: Job) => boolean;
  now?: number;
}

export function statusLine(
  ledger: Ledger,
  jobs: Jobs,
  questions: number | { record: QuestionRecord }[] = 0,
  quota: GeminiQuotaState | number | undefined = undefined,
  io: StatusLineIO = {}
): string {
  const now = io.now ?? Date.now();
  const runningLanes: { name: string; stage: string; age: string }[] = [];
  for (const [name, entry] of Object.entries(ledger)) {
    if (!laneRunning(entry)) continue;
    if (io.ownsLane && !io.ownsLane(name, entry)) continue;
    const stage = entry.stage === "gate" ? "gate" : entry.stage ?? "working";
    const age = statusAge(entry.lastActionAt ?? entry.lastEventAt, now);
    runningLanes.push({ name, stage, age });
  }

  const runningJobs: { name: string; age: string }[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!jobRunning(job)) continue;
    if (io.ownsJob && !io.ownsJob(name, job)) continue;
    const age = statusAge(job.startedAt, now);
    runningJobs.push({ name, age });
  }

  let questionCount = 0;
  if (typeof questions === "number") {
    questionCount = questions;
  } else if (Array.isArray(questions)) {
    for (const q of questions) {
      const rec = "record" in q ? q.record : q;
      const entry = ledger[rec.lane];
      if (entry && entry.rounds === rec.round && questionOpen(rec)) {
        if (!io.ownsLane || io.ownsLane(rec.lane, entry)) questionCount += 1;
      }
    }
  }

  if (runningLanes.length === 0 && runningJobs.length === 0 && questionCount === 0) {
    return "";
  }

  let blockedMinutes: number | undefined;
  if (typeof quota === "number") {
    blockedMinutes = quota;
  } else if (quota && "block" in quota && quota.block) {
    blockedMinutes = quota.block.minutesRemaining;
  }

  const head = runningLanes.length > 0
    ? `cdx ${runningLanes.length} ${runningLanes.length === 1 ? "lane" : "lanes"}`
    : runningJobs.length > 0
    ? `cdx ${runningJobs.length} ${runningJobs.length === 1 ? "job" : "jobs"}`
    : "cdx";

  const laneItems = runningLanes.map((l) => `${l.name} ${l.stage} ${l.age}`);
  const jobItems = runningJobs.map((j) => `job ${j.name} ${j.age}`);
  const middle = [...laneItems, ...jobItems];

  const trailing: string[] = [];
  if (questionCount > 0) {
    trailing.push(`${questionCount} ${questionCount === 1 ? "question" : "questions"}`);
  }
  if (blockedMinutes !== undefined && blockedMinutes > 0) {
    trailing.push(`gemini blocked ${blockedMinutes}m`);
  }

  function assemble(mid: string[]): string {
    return [head, ...mid, ...trailing].join(" · ");
  }

  let currentMiddle = [...middle];
  let line = assemble(currentMiddle);
  while (line.length > 100 && currentMiddle.length > 0) {
    currentMiddle.pop();
    line = assemble(currentMiddle);
  }
  if (line.length > 100) {
    line = line.slice(0, 100);
  }
  return line;
}

function laneView(): View {
  const entries = Object.entries(readLedger()).filter(([, entry]) => laneRunning(entry) || entry.work.state !== "closed")
    .sort((a, b) => Number(laneRunning(b[1])) - Number(laneRunning(a[1])) || Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt));
  const files = new Map<string, number | undefined>();
  const rows = entries.map(([name, entry]) => {
    const cwd = entry.kind === "review" ? entry.review?.cwd ?? entry.work.cwd : entry.work.cwd;
    if (!files.has(cwd)) files.set(cwd, changedFileCount(cwd));
    const gate = entry.stage === "gate" && laneRunning(entry) ? "running"
      : entry.gateReceipt ? entry.gateReceipt.valid ? `passed r${entry.gateReceipt.round}` : `${entry.gateReceipt.exitCode ? "failed" : "invalid"} r${entry.gateReceipt.round}`
      : entry.work.state === "gate-invalid" ? "invalid" : entry.gate ? "pending" : "-";
    return [name, String(entry.rounds), activeStateOf(entry), entry.lastAction ?? "-", String(files.get(cwd) ?? "?"), gate];
  });
  const jobs = Object.entries(readJobs()).filter(([, job]) => jobRunning(job) && owned(job.ownerSession));
  return { title: "lanes", header: ["lane", "round", "state", "last step", "files", "gate"], rows,
    reports: entries.map(([, entry]) => roundReportOf(entry)),
    progress: `${entries.filter(([, entry]) => laneRunning(entry)).length} running lanes; ${jobs.length} running jobs`,
    lines: jobs.map(([name, job]) => `job ${name} ${jobPhase(job.log) || "-"}`) };
}

// Read only the final rendered records. Never reload a whole round's log per frame.
function paneLines(path: string | undefined, count: number): string[] {
  if (!path) return [];
  const json = path.endsWith(".jsonl");
  return readTailLines(path, count, (line) => !json || renderEventLine(line) !== undefined)
    .map((line) => json ? renderEventLine(line)! : line).flatMap((line) => line.split("\n")).slice(-count);
}

export function targetView(names: string[], title: string, count = 30): View {
  const ledger = readLedger(), jobs = readJobs();
  const lines: string[] = [], progress: string[] = [], reports: (string | undefined)[] = [];
  for (const name of names) {
    const entry = ledger[name], job = jobs[name];
    if (entry) {
      const cursor = openCursor(name, entry, true);
      lines.push(...paneLines(cursor?.path, count).map((line) => names.length > 1 ? `[${name}] ${line}` : line));
      progress.push(`${name} r${entry.rounds} ${activeStateOf(entry)} ${entry.roundSteps ?? 0} steps ${entry.lastAction ?? "-"}`);
      reports.push(roundReportOf(entry));
    } else if (job) {
      lines.push(...paneLines(job.log, count).map((line) => names.length > 1 ? `[${name}] ${line}` : line));
      progress.push(`${name} ${job.state} ${jobPhase(job.log) || "-"}`);
      reports.push(job.log);
    } else progress.push(`${name} unavailable`);
  }
  return { title, lines, progress: progress.join("; "), reports };
}

export async function tailView(name: string | undefined, count: number): Promise<void> {
  let failed = false;
  await liveView(() => {
    const ledger = readLedger(), jobs = readJobs();
    const names = name ? [name] : Object.entries(ledger).filter(([, entry]) => laneRunning(entry)).map(([lane]) => lane);
    if (name && !ledger[name] && !jobs[name]) fail(`unknown lane or job "${name}"`);
    const entry = name ? ledger[name] : undefined;
    const job = name && !entry ? jobs[name] : undefined;
    const dead = Boolean(entry && laneRunning(entry) && !pidAlive(entry.pid) || job && jobRunning(job) && !pidAlive(job.pid));
    failed = dead || Boolean(entry && ["failed", "gate-invalid"].includes(activeStateOf(entry)) || job?.state === "failed");
    const view = targetView(names, "tail", count);
    if (dead) view.progress += "; runner died without finalizing";
    return { ...view, done: Boolean(name && (dead || entry && !laneRunning(entry) || job && !jobRunning(job))) };
  });
  if (failed) process.exitCode = 1;
}

export async function statusCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["json", "all", "brief", "line", "watch", "interval"]);
  if (parsed.rest.length) fail("usage: cdx status [--all | --json | --brief | --line | --watch [--interval S]]");
  const watch = parsed.bools.has("watch");
  const interval = Number(parsed.flags.interval ?? 2);
  if (!Number.isFinite(interval) || interval <= 0 || interval > 2_147_483) fail("--interval must be positive seconds below 2147483");
  if (parsed.flags.interval !== undefined && !watch) fail("--interval requires --watch");
  if (parsed.bools.has("line") && (watch || parsed.bools.has("brief") || parsed.bools.has("json") || parsed.bools.has("all"))) fail("--line cannot be combined with other display modes");
  if (parsed.bools.has("json") && (watch || parsed.bools.has("brief"))) fail("--json cannot be combined with --brief or --watch");
  if (parsed.bools.has("all") && (watch || parsed.bools.has("brief"))) fail("--all lists finished jobs; --brief and --watch show only running work");
  if (parsed.bools.has("line")) {
    const session = callerSession();
    const state = readSessions();
    const ledger = readLedger();
    const jobs = readJobs();
    const questions = questionFiles().filter(({ record }) => {
      const entry = ledger[record.lane];
      return entry && entry.rounds === record.round && questionOpen(record) && owned(entry.ownerSession, record.lane, session, state);
    }).length;
    const quota = geminiQuotaState();
    const line = statusLine(ledger, jobs, questions, quota, {
      ownsLane: (name, entry) => owned(entry.ownerSession, name, session, state),
      ownsJob: (_name, job) => owned(job.ownerSession, undefined, session, state),
      now: Date.now(),
    });
    if (line) console.log(line);
    return;
  }
  if (watch && tuiEnabled()) {
    await liveView(() => laneView(), interval * 1000);
    return;
  }
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
  const tui = tuiEnabled();
  const quotaState = geminiQuotaState();
  if (quotaState.block) {
    const note = `gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`;
    console.log(tui ? renderNote(note) : color.yellow(note));
  }
  if (all.length === 0) { console.log(tui ? renderStatus([]) : "cdx: no lanes"); printRunningJobs(tui); return; }
  // Running lanes first (most recent activity on top), then finished ones
  // newest first, capped unless --all.
  const byRecency = (a: [string, Lane], b: [string, Lane]) =>
    Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt);
  const showAll = parsed.bools.has("all");
  const running = all.filter(([, entry]) => laneRunning(entry)).sort(byRecency);
  // Closed lanes are handled history; only --all lists them.
  const finished = all.filter(([, entry]) => !laneRunning(entry) && (showAll || entry.work.state !== "closed")).sort(byRecency);
  const hidden = showAll ? 0 : Math.max(0, finished.length - FINISHED_SHOWN);
  const lanes = [...running, ...finished.slice(0, finished.length - hidden)];
  console.log(tui ? renderStatus(lanes.map(([name, entry]) => ({
    name, parent: entry.parent, active: laneRunning(entry), block: renderLaneBlock(name, entry),
  }))) : lanes.map(([lane, entry]) => renderLaneBlock(lane, entry)).join("\n\n"));
  if (hidden > 0) {
    const note = `${hidden} older finished lane${hidden === 1 ? "" : "s"} hidden (cdx status --all)`;
    console.log(`\n${tui ? renderNote(note) : color.dim(`… ${note}`)}`);
  }
  printRunningJobs(tui);
}

export async function waitCommand(argv: string[]) {
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
    try {
      if (!path) return undefined;
      const text = readFileSync(path, "utf8");
      return !json && tuiEnabled() ? text.split("\n").map((line) => renderNote(line)).join("\n") : text;
    } catch { return undefined; }
  };
  if (tuiEnabled() && !json) {
    const result = await liveView(() => {
      const ledger = readLedger(), jobs = readJobs();
      const questions = lanes.some((lane) => questionFiles(lane).some(({ record }) => questionOpen(record) && ledger[lane]?.rounds === record.round));
      const running = lanes.some((lane) => ledger[lane] && laneRunning(ledger[lane]) && pidAlive(ledger[lane].pid))
        || jobNames.some((name) => jobs[name] && jobRunning(jobs[name]) && pidAlive(jobs[name].pid));
      if (running && !questions && Date.now() > deadline) fail(`timeout waiting for: ${names.join(", ")}`);
      return { ...targetView(names, "wait"), done: questions || !running };
    });
    if (result === "quit") return;
  }
  // --json prints one JSON object per finished lane, in completion order.
  const emitJson = (lane: string, entry: Lane, error?: string) => console.log(JSON.stringify({
    lane, engine: roundEngine(entry), work: entry.work, review: entry.review, roundState: activeStateOf(entry), kind: entry.kind,
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
          console.log(`cdx: lane=${color.magenta(lane)} engine=${roundEngine(entry)} kind=${entry.kind} state=${coloredState(activeStateOf(entry))} exit=${roundExitCodeOf(entry) ?? "?"} tokens=${fmtTokens(entry.tokens, entry.tokensIncomplete)} report=${roundReportOf(entry) ?? "-"}`);
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
        if (activeStateOf(entry) === "failed" || activeStateOf(entry) === "gate-invalid") failed = true;
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

type UsageRow = Omit<WindowProjection, "usedPercent" | "remainingPercent" | "checkedAt"> & { usedPercent: number | null; remainingPercent: number | null; checkedAt: string | null };

export function geminiUsageRows(snapshot: GeminiUsageSnapshot | undefined, quota: GeminiQuotaState, history: UsageReading[], heldPercent: number, now: number): UsageRow[] {
  const blockedUntil = quota.block ? Date.parse(quota.block.resetsAt) / 1000 : null;
  const windows = snapshot ? geminiWindows(snapshot) : blockedUntil ? [{ usedPercent: 100, windowDurationMins: 300, resetsAt: blockedUntil }] : [];
  return windows.map((w) => {
    const row = { ...projectWindow("gemini", w, snapshot?.checkedAt ?? new Date(now).toISOString(), snapshot ? history : [], now), heldPercent,
      blockedUntil: w.windowDurationMins === 300 ? blockedUntil : null };
    row.available = row.available && !row.blockedUntil && Boolean(snapshot);
    row.reason = row.blockedUntil ? `hold until ${rateLimitResetDate(row.blockedUntil)}` : !row.available ? "usage unknown; window reset"
      : row.hoursToExhaustion !== null ? "hold; projected exhaustion before reset" : heldPercent ? `${heldPercent}% held by running lanes` : "spend normally";
    return snapshot ? row : { ...row, usedPercent: null, remainingPercent: null, checkedAt: null };
  });
}

interface CcaLimit { label: string; percent: number; resetsAt: string | null }
export interface CcaStatus {
  advice?: { reason?: string };
  accounts: Array<{ name: string; active?: boolean; checkedAt?: string; limits: CcaLimit[] }>;
}

// The head's own Claude seats from cca (~/code/claude-accounts), so one table
// shows every weekly reset. cca refreshes each account at most every 15 minutes.
async function readCcaStatus(): Promise<CcaStatus | undefined> {
  const cca = Bun.which("cca");
  if (!cca) return undefined;
  const proc = Bun.spawn([cca, "status", "--json"], { env: uncoloredChildEnv(), stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, 20_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    const value = exitCode === 0 ? JSON.parse(text) : undefined;
    return Array.isArray(value?.accounts) ? value : undefined;
  } catch { return undefined; } finally { clearTimeout(timeout); }
}

// Weekly limits only: the five-hour window is too small to plan around.
export function claudeUsageRows(status: CcaStatus | undefined, now: number): UsageRow[] {
  return (status?.accounts ?? []).flatMap((account) => account.limits
    .filter((limit) => limit.label !== "5h" && limit.resetsAt && Number.isFinite(Date.parse(limit.resetsAt)))
    .map((limit) => ({
      ...projectWindow(`claude ${account.name}${account.active ? "*" : ""}`,
        { usedPercent: limit.percent, windowDurationMins: 10_080, resetsAt: Date.parse(limit.resetsAt!) / 1000 },
        account.checkedAt ?? new Date(now).toISOString(), [], now),
      window: limit.label === "week" ? "weekly" : limit.label.toLowerCase(),
    })));
}

export function usageTable(rows: UsageRow[], now = Date.now(), tui = false): string[] {
  const percent = (n: number | null) => n === null ? "?" : `${n.toFixed(1)}%`;
  const cells = rows.map((r) => [r.account, r.window, percent(r.usedPercent), percent(r.remainingPercent),
    `${r.blockedUntil ? "blocked " : ""}${fmtUntil(r.blockedUntil ?? r.resetsAt, now)}`,
    percent(r.burnPerHour), percent(r.projectedRemainingAtReset), r.hoursToExhaustion === null ? "-" : `${r.hoursToExhaustion.toFixed(1)}h`,
    `${r.heldPercent}%`, r.tokensPerPercent === undefined ? "-" : String(r.tokensPerPercent)]);
  const header = ["account", "window", "used", "left", "resets in", "burn/h", "at reset", "empty in", "holds", "tokens/%"];
  if (!rows.some((r) => r.tokensPerPercent !== undefined)) { header.pop(); cells.forEach((c) => c.pop()); }
  if (tui) {
    return renderUsageTable(header, cells, undefined, firstExhaustion(rows)).split("\n");
  }
  return renderTable(header, cells, { columns: Number.MAX_SAFE_INTEGER, color: false, unicode: false },
    { legacy: true }).split("\n");
}

function fmtSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
}

// 256-color codes shared with cca's row: a solid chip per row led by a Nerd
// Font 3.5+ logo (codicon OpenAI U+EC81, Material four-point star U+F0AE2 for
// Gemini), near-white names, green for the account the next work lane gets.
// Color carries two signals and nothing else: usage stays grey until 50%,
// then runs yellow to red, bold red once spent; a reset timer starts muted,
// turns bluer as it nears, and goes green in its last day.
const LINE = {
  codex: "1;38;5;16;48;5;110", gemini: "1;38;5;16;48;5;105", text: "38;5;253", sub: "38;5;246", rule: "38;5;240",
  next: "1;38;5;120",
};
const USAGE_RAMP: [number, string][] = [
  [95, "1;38;5;196"], [85, "38;5;202"], [75, "38;5;208"], [60, "38;5;214"], [50, "38;5;220"], [0, "38;5;250"],
];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RESET_RAMP: [number, string][] = [
  [3 * HOUR_MS, "1;38;5;46"], [8 * HOUR_MS, "1;38;5;48"], [DAY_MS, "38;5;50"], [2 * DAY_MS, "38;5;45"],
  [3 * DAY_MS, "38;5;39"], [5 * DAY_MS, "38;5;33"], [Infinity, "38;5;61"],
];
// Every cell pads to this many columns, the same as cca's claude row, so the
// claude, codex and gemini rows share one column grid.
const CELL_WIDTH = 34;
const ANSI = /\x1b\[[0-9;]*m/g;

// Status line rows from the stored snapshots: one for the Codex accounts'
// weekly windows, one for Gemini's weekly window. No probe and
// no network, so a status line can run it on every render. Status lines read
// ANSI from a pipe, so it colors without a TTY unless NO_COLOR is set. `pick`
// is the account cdx would give the next work lane, marked with a green arrow.
export function usageLine(accounts: { name: string; snapshot?: UsageSnapshot }[], gemini: GeminiUsageSnapshot | undefined,
  pick: string | null = null, now = Date.now(), colored = process.env.NO_COLOR === undefined): string {
  const sgr = (code: string, text: string) => (colored ? `\x1b[${code}m${text}\x1b[0m` : text);
  const chip = (code: string, logo: string, text: string) => sgr(code, ` ${logo} ${text.padEnd(6)} `);
  const timer = (ms: number) => sgr(RESET_RAMP.find(([max]) => ms < max)![1], `↻${fmtSpan(ms)}`);
  const pct = (used: number) => sgr(USAGE_RAMP.find(([min]) => used >= min)![1], `${used}%`.padStart(4));
  const cell = (name: string, window?: { usedPercent: number; resetsAt: number }, labelCode = LINE.text) => {
    const fields = [name === pick ? sgr(LINE.next, `→ ${name}`) : sgr(labelCode, `  ${name}`)];
    if (!window) fields.push(sgr(LINE.sub, "?"));
    else if (window.resetsAt * 1000 <= now) fields.push(pct(0));
    else fields.push(pct(Math.round(window.usedPercent)), timer(window.resetsAt * 1000 - now));
    const content = fields.join(" ");
    return ` ${content}${" ".repeat(Math.max(0, CELL_WIDTH - content.replace(ANSI, "").length))} `;
  };
  const weekly = (snapshot?: UsageSnapshot) => snapshot?.windows?.length
    ? snapshot.windows.reduce((longest, w) => (w.windowDurationMins > longest.windowDurationMins ? w : longest))
    : undefined;
  const rule = sgr(LINE.rule, "│");
  const rows = [`${chip(LINE.codex, "\u{ec81}", "Codex")} ${accounts.map((a) => cell(a.name, weekly(a.snapshot))).join(rule)}`];
  if (gemini) {
    const [week] = geminiWindows(gemini);
    rows.push(`${chip(LINE.gemini, "\u{f0ae2}", "Gemini")} ${cell("week", week, LINE.sub)}`);
  }
  return rows.join("\n");
}

export async function usageCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["json", "totals", "line"]);
  const json = parsed.bools.has("json");
  const accounts: (AccountChoice | undefined)[] = config.accounts
    ? Object.entries(config.accounts).map(([name, home]) => ({ name, home }))
    : [undefined];
  if (parsed.bools.has("line")) {
    const pick = accountAdvice(cachedAccountStandings()).picks.work;
    console.log(usageLine(accounts.map((account) => ({ name: account?.name ?? "codex", snapshot: readUsageSnapshot(account) })), readGeminiUsageSnapshot(), pick));
    return;
  }

  // All-time lane and token totals from the ledger, grouped by account.
  // Tokens only accrue on JSONL rounds (spawn, exec review); text rounds
  // (resume, native review) report none.
  const totals = new Map<string, { lanes: number; tokens: Tokens; incomplete: boolean }>();
  const geminiTotals = { lanes: 0, tokens: { input: 0, cached: 0, output: 0 } as Tokens, incomplete: false };
  for (const entry of Object.values(readLedger())) {
    if (laneEngine(entry) === "gemini") {
      geminiTotals.lanes += 1;
      if (entry.tokensIncomplete) geminiTotals.incomplete = true;
      if (entry.tokens) {
        geminiTotals.tokens.input += entry.tokens.input ?? 0;
        geminiTotals.tokens.cached += entry.tokens.cached ?? 0;
        geminiTotals.tokens.output += entry.tokens.output ?? 0;
      }
      continue;
    }
    const key = entry.account ?? "default";
    const bucket = totals.get(key) ?? { lanes: 0, tokens: { input: 0, cached: 0, output: 0 }, incomplete: false };
    bucket.lanes += 1;
    if (entry.tokensIncomplete) bucket.incomplete = true;
    if (entry.tokens) {
      bucket.tokens.input += entry.tokens.input ?? 0;
      bucket.tokens.cached += entry.tokens.cached ?? 0;
      bucket.tokens.output += entry.tokens.output ?? 0;
    }
    totals.set(key, bucket);
  }

  const [refreshed, geminiUsage, cca] = await Promise.all([
    Promise.all(accounts.map((account) => refreshUsageSnapshot({ account }))),
    refreshGeminiUsage(),
    readCcaStatus(),
  ]);
  const now = Date.now(), history = readUsageHistory(), ledger = readLedger();
  const effectiveStandings = withAccountHolds(accounts.map((account, index) =>
    standingOf(account ?? { name: "default", home: process.env.CODEX_HOME ?? `${HOME}/.codex` },
      refreshed[index]?.snapshot ?? readUsageSnapshot(account), history, now)), ledger);
  const gemini = geminiUsage ?? readGeminiUsageSnapshot();
  const rows = accounts.flatMap((account, index) => {
    const snapshot = refreshed[index]?.snapshot ?? readUsageSnapshot(account);
    return (snapshot?.windows ?? (snapshot ? [snapshot] : [])).map((w) => ({
      ...projectWindow(account?.name ?? "default", w, snapshot!.checkedAt, effectiveStandings[index].snapshot ? history : [], now),
      heldPercent: effectiveStandings[index].heldPercent ?? 0,
      reason: effectiveStandings[index].reason, available: Boolean(effectiveStandings[index].snapshot),
    }));
  });
  const geminiHeld = Object.values(ledger).filter((lane) => roundEngine(lane) === "gemini" && laneRunning(lane)
    && (pidAlive(lane.pid) || pidAlive(lane.codexPid))).length * HEADROOM_PERCENT.work;
  const geminiRows = geminiUsageRows(gemini, geminiQuotaState(now), history, geminiHeld, now);
  const windows = [...rows, ...geminiRows];
  const advice = accountAdvice(effectiveStandings, now);
  if (json) {
    const codex = accounts.map((account, index) => {
      const key = account?.name ?? "default", total = totals.get(key), snapshot = refreshed[index]?.snapshot ?? readUsageSnapshot(account);
      return { account: key, home: account?.home ?? process.env.CODEX_HOME ?? `${HOME}/.codex`,
        usage: refreshed[index]?.usage ?? null, checkedAt: snapshot?.checkedAt ?? null,
        resetsAt: snapshot ? new Date(snapshot.resetsAt * 1000).toISOString() : null,
        lanes: total?.lanes ?? 0, ledgerTokens: total?.tokens ?? null, incomplete: Boolean(total?.incomplete) };
    });
    console.log(JSON.stringify({ windows, codex, advice, alerts: advice.alerts, gemini: gemini ?? null, geminiLedger: geminiTotals,
      claude: cca ?? null }, null, 2));
    return;
  }
  const tui = tuiEnabled();
  const shown = [...windows.filter((w) => w.window !== "5h"), ...claudeUsageRows(cca, now)].sort((a, b) => Math.round(a.resetsAt / 60) - Math.round(b.resetsAt / 60));
  usageTable(shown, now, tui).forEach((line, index) => {
    const used = shown[index - 1]?.usedPercent ?? 0;
    console.log(tui ? line : used >= 95 ? color.red(line) : used >= 75 ? color.yellow(line) : line);
  });
  const lines = adviceLines(effectiveStandings, now);
  const geminiReason = geminiRows.find((w) => w.blockedUntil)?.reason ?? geminiRows.find((w) => w.reason !== "spend normally")?.reason;
  const geminiNote = geminiReason ? `gemini: ${geminiReason}.` : !gemini ? "gemini: usage unknown; probe failed." : "";
  if (geminiNote) lines[1] = [lines[1], geminiNote].filter(Boolean).join(" ");
  const claudeNote = cca?.advice?.reason ? `claude: ${cca.advice.reason}` : !cca ? "claude: usage unknown; cca status failed." : "";
  if (claudeNote) lines.push(claudeNote);
  for (const line of lines) console.log(tui ? renderNote(line) : line);
  if (parsed.bools.has("totals")) {
    for (const [account, total] of [...totals, ["gemini", geminiTotals] as const])
      console.log(`${account}: lanes ${total.lanes}, ledger tokens ${fmtTokensFull(total.tokens, total.incomplete)}`);
  }
}
