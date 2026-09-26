import { createReviewSnapshot, removeReviewSnapshot, runFrozenGate } from "./snapshots.ts";
import { codexSandbox, geminiProfile, indexIgnoreFingerprint, LANE_TOOL_ENV, plantedPermissionLayers, prepareSandboxDirs, reviewSandboxRefusal } from "./sandbox.ts";
import { monitorOverruns } from "./session-commands.ts";
import { geminiTokens } from "./tokens.ts";
import { CAP_HOOK_COMMAND, installLaneHome, laneCodexHome } from "./account-sync.ts";
import { defaultCodexHome } from "./accounts.ts";
import { safeText, safeJSON } from "./safe-text.ts";
import { safeLines } from "./safe-lines.ts";
import { drainGeminiControls } from "./gemini-controls.ts";
import { runClaudeRound } from "./claude.ts";
import { scopeExtensions } from "./brief-contract.ts";
// Round execution, engine event handling, account failover, and finalization.

import { config, geminiConfig } from "./config.ts";
import { hookInstallState } from "./doctor.ts";
import {
  AGY_RETRY_WAKE_ATTEMPT, type AppInput, appThreadParams, type AppTurn,
  classifyGeminiError, CODEX_DISABLE_NATIVE_SUBAGENTS, type CodexThreadUsage, extractFinalAgentResponse,
  freshAccountSpec, GEMINI_OUTAGE_RETRIES, GEMINI_PRINT_TIMEOUT_SLACK_MINS, geminiCapacityNotice,
  geminiTranscriptPath, goDurationMs, inputText, isCodexQuotaFailure, outageMinutes, parseAgyRetryLine,
  qualifyGeminiResult, recordCodexTokenDelta, recoveryPrompt, resolveSessionIdFromRollouts, roundTools,
  shortGeminiReason, shouldRetryGeminiTransport,
} from "./engines.ts";
import {
  captureGateTree, captureReviewTree, changedPaths, repairGateOnce, gateFailure, executeGate, finishGateReceipt,
  gateAcceptanceFailed, gateOutputForReport, verifyGate, attestReview, reviewAttests, reviewRoot,
} from "./gates.ts";
import { geminiAdmission, readGeminiUsageSnapshot, parseQuotaResetIso, refreshGeminiUsage, writeGeminiQuota } from "./gemini-usage.ts";
import { runWorktreeSetup } from "./worktrees.ts";
import {
  activeStateOf, feedEvent, findLane, type GateReceipt, type Lane, type LaneOutage, readLane, readLedger,
  type ReviewState, roundNoteOf, roundReportOf, type Spec, type Tokens, withLane, withLedger,
} from "./ledger.ts";
import { sharedTreeLanes, reviewLoopClosed, withCodegraphFact } from "./prompts.ts";
import {
  type ControlRecord, controlText, expireRoundQuestions, notifyParent, readDeliveredCount,
  writeDeliveredCount,
} from "./questions.ts";
import {
  availableReportPath, captureRecoveryPartial, controlPathOf, excerpt, logPathOf, partialReportPathOf,
  readJsonLines, renderTail, reportPathOf, logProgress, progressLogPathOf, specPathOf, writeCapturedReport, writeProtocolEvent,
} from "./reports.ts";
import { failActiveRound, killChildren } from "./round-state.ts";
import { openRound } from "./rounds.ts";
import {
  CmdError, color, coloredState, completionVerdict, fmtTokens, laneChildEnv, ROOT, singleLine, VERSION,
} from "./runtime.ts";
import { invalidateAccountUsage, isFiniteCount, readUsageSnapshot, recordCodexExhaustion } from "./usage-store.ts";
import { toolObservation, VISIBILITY_DEFAULTS } from "./visibility.ts";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { resolve, relative } from "node:path";

export async function runRound(lane: string, round: number): Promise<number> {
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
      const startingItem = readLedger()[lane];
      if (startingItem?.supervisor) await killChildren(lane, `supervisor ${lane} failed with runner error`);
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
    if (spec.engine === "gemini" && entry.outageFallbackPending) {
      const policy = config.gemini ?? geminiConfig();
      const previousModel = spec.model ?? policy.model;
      try {
        const thread = entry.kind === "review" ? entry.sessionId : entry.workSessionId ?? entry.sessionId;
        const partialPath = partialReportPathOf(lane, round);
        const partial = existsSync(partialPath) ? readFileSync(partialPath, "utf8").trim() : "";
        const prompt = `The model service was unavailable (503) for about ${outageMinutes(GEMINI_OUTAGE_RETRIES)} minutes; this round continues the same conversation on ${policy.outageFallbackModel}. Continue the task you were working on from where you left off, without redoing completed work.${partial ? `\n\nYour previous round ended with this partial report at ${partialPath}:\n${partial}` : ""}\n\nWhen the task is complete, print your final lane report.`;
        const opened = await openRound(lane, entry.consult ? "review" : entry.kind, spec.cwd, spec.effort, {
          engine: "gemini", preserveEngine: true, preserveOwner: true, preserveGate: true, requireSession: true,
          ...(thread ? { sessionOverride: thread } : {}),
        });
        const next = readLane(lane);
        spec = { ...spec, round: opened.round, mode: "resume", model: policy.outageFallbackModel, sourceThreadId: opened.sessionId, prompt, startedAt: next.roundStartedAt ?? new Date().toISOString() };
        withLedger((ledger) => {
          const item = ledger[lane];
          if (!item) return;
          item.fallbackModel = policy.outageFallbackModel;
          // A harness-inserted round does not count against gemini.maxRounds;
          // the head keeps its full resume budget.
          if (item.kind === "work" && item.workRounds) item.workRounds -= 1;
        });
        writeFileSync(specPathOf(lane, spec.round), safeJSON(spec, 2));
        writeFileSync(`${ROOT}/briefs/${lane}-r${spec.round}.md`, safeText(spec.prompt));
        const notice = `[cdx] lane=${lane} round=${spec.round} capacity fallback: the 503 ladder on ${previousModel} ran out, this round continues the same conversation on ${policy.outageFallbackModel} (3.8 family, lower reasoning tier); the next resume returns to ${policy.model}; review this round's diff with the tier in mind`;
        feedEvent("outage", notice, spec.ownerSession, { lane, round: spec.round });
        notifyParent(lane, notice);
        round = spec.round;
        continue;
      } catch (error) {
        const note = `capacity fallback unavailable: ${error instanceof Error ? error.message : String(error)}`;
        withLedger((ledger) => failActiveRound(lane, ledger[lane]!, note));
        if (entry.supervisor) await killChildren(lane, note);
        feedEvent("terminal", `[cdx] lane=${lane} round=${round} state=failed note=${note} report=${availableReportPath(lane, round) ?? "-"} log=${logPathOf(lane, round, true)} gateExit=not-run verdict=${JSON.stringify(completionVerdict("failed", note))}`, spec.ownerSession, { lane, round });
        console.error(`cdx: ${note}`);
        return 1;
      }
    }
    if (spec.engine !== "gpt" || !entry.quotaFailure || code === 0) {
      if (code !== 0) feedEvent("terminal", `[cdx] lane=${lane} round=${round} kind=${entry.kind} state=${activeStateOf(entry)} note=${roundNoteOf(entry) ?? "runner failed"} report=${roundReportOf(entry) ?? "-"} log=${logPathOf(lane, round, true)} gateExit=${entry.kind === "work" ? entry.gateReceipt?.exitCode ?? "not-run" : "not-run"} verdict=${JSON.stringify(completionVerdict(activeStateOf(entry), roundNoteOf(entry)))}`, entry.ownerSession, { lane, round });
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
        engine: "gpt", preserveOwner: true, preserveGate: true, excludedHomes: exhaustedHomes,
        // A review round keeps its own model; the work thread keeps its model.
        ...(entry.kind === "review" ? { reviewModel: spec.model } : { model: spec.model }),
      });
      const next = readLane(lane);
      const account = next.roundAccount;
      const previousAccount = spec.account ?? "default";
      spec = { ...spec, round: opened.round, account: account?.name, codexHome: account?.home, startedAt: next.roundStartedAt ?? new Date().toISOString() };
      freshAccountSpec(spec, next, prompt);
      writeFileSync(specPathOf(lane, spec.round), safeJSON(spec, 2));
      writeFileSync(`${ROOT}/briefs/${lane}-r${spec.round}.md`, safeText(spec.prompt));
      feedEvent("account", `[cdx] lane=${lane} round=${spec.round} auto-switch from=${previousAccount} to=${spec.account ?? "default"} reason=quota-exhausted fresh-session=true`, spec.ownerSession, { lane, round: spec.round });
      round = spec.round;
    } catch (error) {
      const note = `account failover unavailable: ${error instanceof Error ? error.message : String(error)}`;
      withLedger((ledger) => failActiveRound(lane, ledger[lane]!, note));
      if (entry.supervisor) await killChildren(lane, note);
      feedEvent("terminal", `[cdx] lane=${lane} round=${round} state=failed note=${note} report=${availableReportPath(lane, round) ?? "-"} log=${logPathOf(lane, round, true)} gateExit=not-run verdict=${JSON.stringify(completionVerdict("failed", note))}`, spec.ownerSession, { lane, round });
      console.error(`cdx: ${note}`);
      return 1;
    }
  }
}

function treeHash(cwd: string): string | undefined {
  try { return captureGateTree(cwd)?.tree; } catch { return undefined; }
}

// Codex runs a user hook only once the user config trusts its hash. The lane
// home links the account config.toml, so the trust entry lands there, keyed on
// the lane home's hooks.json. Other hooks keep whatever trust they had.
async function trustCapHook(request: (method: string, params: Record<string, unknown>) => Promise<any>, cwd: string): Promise<boolean> {
  const hooks = ((await request("hooks/list", { cwds: [cwd] }))?.data ?? []).flatMap((entry: any) => entry.hooks ?? [])
    .filter((hook: any) => hook.command === CAP_HOOK_COMMAND);
  const edits = hooks.filter((hook: any) => hook.trustStatus !== "trusted")
    .map((hook: any) => ({ keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" }));
  if (edits.length) await request("config/batchWrite", { edits, reloadUserConfig: true });
  return hooks.length > 0;
}

async function runRoundInner(lane: string, round: number): Promise<number> {
  const spec = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec;
  const entry = readLedger()[lane];
  if (spec.engine === "claude") return runClaudeRound(lane, round, spec);
  if (entry?.kind !== "review" || entry.consult) return executeRound(lane, round, spec);
  const snapshot = createReviewSnapshot(spec.cwd, lane, round, spec.reviewTree);
  try {
    return await executeRound(lane, round, { ...spec, cwd: snapshot.cwd, reviewDir: snapshot.cwd,
      prompt: `${spec.prompt}\n\nThe reviewed checkout is ${snapshot.cwd}. Inspect this detached snapshot for all review findings.`,
    });
  } finally {
    try {
      const persisted = JSON.parse(readFileSync(specPathOf(lane, round), "utf8")) as Spec;
      writeFileSync(specPathOf(lane, round), safeJSON({ ...persisted, cwd: spec.cwd, reviewDir: spec.reviewDir, prompt: spec.prompt }, 2));
    } finally { removeReviewSnapshot(snapshot.path); }
  }
}

async function executeRound(lane: string, round: number, spec: Spec): Promise<number> {
  let startingLane = readLedger()[lane];
  while (startingLane?.queuedUntil) {
    withLedger((ledger) => { ledger[lane]!.pid = process.pid; ledger[lane]!.lastAction = `queued until ${startingLane!.queuedUntil}`; });
    const delay = Math.max(0, Date.parse(startingLane.queuedUntil) - Date.now());
    await Bun.sleep(delay);
    const usage = await refreshGeminiUsage();
    withLedger((ledger) => { ledger[lane]!.queuedUntil = geminiAdmission(usage, ledger, Date.now(), lane).queuedUntil; });
    startingLane = readLedger()[lane];
  }
  if (!spec.effort) throw new CmdError("round spec has no effort; start a new round with cdx 5.0");
  if (!["gpt", "gemini"].includes(spec.engine)) throw new CmdError("round spec has no valid engine; start a new round with cdx 5.0");
  const engine = spec.engine;
  const gemini = engine === "gemini";
  const jsonMode = true;
  const role = { review: spec.reviewDir !== undefined, supervisor: Boolean(spec.supervisor) };
  if (!gemini && spec.laneInstructions === undefined) throw new CmdError("round spec has no lane instructions; start a new round with cdx 10");
  const logPath = logPathOf(lane, round, jsonMode);
  const setup = spec.worktreeSetupRound === round ? runWorktreeSetup(spec.cwd, `${ROOT}/logs/${lane}-r${round}.setup.log`) : undefined;
  if (setup?.exitCode) {
    writeFileSync(logPath, `${safeJSON(setup)}\n`);
    throw new CmdError(`worktree setup failed in ${spec.cwd} (log ${setup.log}): ${setup.tail?.split("\n").at(-1) ?? ""}`);
  }
  spec = { ...spec, prompt: withCodegraphFact(spec.prompt, spec.cwd) };
  if (!gemini) installLaneHome(spec.codexHome ?? defaultCodexHome(), spec.laneInstructions!, role);
  prepareSandboxDirs(spec);
  const planted = role.review && !gemini ? plantedPermissionLayers(spec.cwd) : [];
  if (planted.length) throw new CmdError(`review refused: ${planted.join(", ")} sets permissions, which Codex would merge into the review profile`);
  const reportPath = reportPathOf(lane, round);
  try { unlinkSync(`${ROOT}/reports/${lane}-r${round}.findings.json`); } catch { /* ignore if missing */ }
  const treeProbe = Bun.spawnSync({ cmd: ["git", "-C", spec.cwd, "rev-parse", "--show-toplevel"] });
  const treeCwd = treeProbe.success ? treeProbe.stdout.toString().trim() : spec.cwd;
  // The sandbox keeps a review read-only; this tree hash pair is only evidence.
  const reviewTreeStart = startingLane?.kind === "review" && !startingLane.consult ? treeHash(treeCwd) : undefined;
  const indexIgnoreStart = role.review ? indexIgnoreFingerprint(spec) : undefined;
  const workTreeStartSnapshot = startingLane?.kind === "work" ? captureReviewTree(treeCwd) : undefined;
  const hooksInstalled = gemini ? hookInstallState().state === "current" : false;
  withLedger((ledger) => {
    const item = ledger[lane]!;
    item.pid = process.pid;
    item.expectMinutes ??= spec.expectMinutes ?? config.expectMinutes ?? 15;
    const record = item.kind === "review" ? item.review! : item.work;
    record.expectMinutes = item.expectMinutes;
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
  const agyLogPath = `${ROOT}/logs/${lane}-r${round}.agy.log`;
  const geminiArgs = [
    "agy", "--input-format", "stream-json", "--output-format", "stream-json",
    "--model", spec.model ?? geminiPolicy.model, "--add-dir", spec.cwd,
    ...(spec.additionalDirectories ?? []).flatMap((dir) => ["--add-dir", dir]),
    "--agent", spec.agent ?? (startingLane?.kind === "review" && !startingLane.consult ? geminiPolicy.reviewAgent : geminiPolicy.agent),
    ...(spec.sourceThreadId ? ["--conversation", spec.sourceThreadId] : []),
    ...(geminiSchemaPath ? ["--json-schema", geminiSchemaPath] : []),
    "--print-timeout", spec.maxRuntimeMins ? `${spec.maxRuntimeMins + GEMINI_PRINT_TIMEOUT_SLACK_MINS}m` : "12h",
    "--log-file", agyLogPath,
  ];
  const proc = Bun.spawn({
    cmd: gemini
      ? ["sandbox-exec", "-p", geminiProfile(spec, [agyLogPath, partialReportPathOf(lane, round), progressLogPathOf(lane, round)]), ...geminiArgs]
      : ["codex", "app-server", ...CODEX_DISABLE_NATIVE_SUBAGENTS, "--listen", "stdio://"],
    cwd: spec.cwd,
    env: { ...laneChildEnv(gemini ? undefined : laneCodexHome(spec.codexHome ?? defaultCodexHome(), role), { lane, round, owner: spec.ownerSession, supervisor: startingLane?.kind === "work" && Boolean(startingLane.supervisor) }, engine), ...LANE_TOOL_ENV },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  withLedger((ledger) => { const item = ledger[lane]; if (item) item.codexPid = proc.pid; });
  // A killed runner must not orphan its codex child mid-edit.
  let receivedSignal: "SIGTERM" | "SIGINT" | undefined;
  const reap = (signal: "SIGTERM" | "SIGINT") => {
    receivedSignal = signal;
    try { stopEngine(signal, `runner received ${signal}`); } catch { /* already gone */ }
  };
  const onTerm = () => reap("SIGTERM");
  const onInt = () => reap("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  const log = Bun.file(logPath).writer();
  const accountPercent = (phase: "Start" | "End", value: Record<string, number> | undefined) => {
    withLedger((ledger) => { ledger[lane]![`accountPercent${phase}`] = value; });
    log.write(`${safeJSON({ type: "cdx_account_percent", phase: phase.toLowerCase(), timestamp: new Date().toISOString(), percent: value ?? null })}\n`);
  };
  const geminiPercent = () => {
    const usage = readGeminiUsageSnapshot();
    return usage ? { fiveHour: 100 - usage.fiveHour.remainingPercent, weekly: 100 - usage.weekly.remainingPercent } : undefined;
  };
  if (setup) log.write(`${safeJSON(setup)}\n`);
  if (gemini) accountPercent("Start", geminiPercent());
  log.write(`${safeJSON({ type: "cdx_prompt_size", sources: spec.promptBytes ?? { supplied: Buffer.byteLength(spec.prompt) }, providerInjected: null })}\n`);
  const stopEngine = (signal: "SIGTERM" | "SIGINT" | "SIGKILL", reason: string) => {
    captureRecoveryPartial(lane, round, spec.cwd, true);
    log.write(`${safeJSON({ type: "cdx_kill", lane, round, signal, reason, timestamp: new Date().toISOString(), partial: partialReportPathOf(lane, round) })}\n`);
    log.flush();
    proc.kill(signal);
  };
  const errLog = Bun.file(`${ROOT}/logs/${lane}-r${round}.stderr.log`).writer();
  let lastFlush = 0;
  // Throttled patches queue instead of dropping. A forced write (token
  // deltas arrive with every step) used to reset the throttle, so the
  // unforced step counter never landed and status showed steps=0 all round.
  let pendingPatches: Array<(item: Lane) => void> = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushLedger = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    if (pendingPatches.length === 0) return;
    const patches = pendingPatches;
    pendingPatches = [];
    lastFlush = Date.now();
    withLane(lane, (item) => {
      if (!item) return;
      for (const patch of patches) patch(item);
      item.updatedAt = new Date().toISOString();
    });
  };
  const touchLedger = (patch: (item: Lane) => void, force = false) => {
    pendingPatches.push(patch);
    const due = 3000 - (Date.now() - lastFlush);
    if (force || due <= 0) { flushLedger(); return; }
    // A quiet stretch after a throttled patch (the model thinking after a
    // tool step) must not hold the step counter back until the next event.
    flushTimer ??= setTimeout(flushLedger, due);
  };

  // Stall watchdog: a lane that goes quiet gets flagged on the feed without
  // polling. Workers cannot be stuck on an approval prompt (approvals are
  // never/bypass), so long silence means a slow reasoning stretch, a network
  // stall, or a wedged process.
  let lastEventMs = Date.now();
  let lastStallWarn = 0;
  const noteActivity = () => {
    if (lastStallWarn) logProgress(lane, round, "active again after quiet stretch");
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
        captureRecoveryPartial(lane, round, spec.cwd, true);
        maxRuntimeHit = true;
        try { stopEngine("SIGTERM", maxRuntimeHit ? "max runtime" : turnFailureReason ?? "engine cleanup after turn"); } catch { /* already gone */ }
        maxRuntimeForceTimer = setTimeout(() => {
          if (proc.exitCode === null) {
            try { stopEngine("SIGKILL", "engine did not stop after SIGTERM"); } catch { /* already gone */ }
          }
        }, 10_000);
      }, spec.maxRuntimeMins * 60_000)
    : undefined;
  const watchdog = setInterval(() => {
    flushLedger();
    monitorOverruns(Date.now());
    if (gemini && Date.now() - Date.parse(readGeminiUsageSnapshot()?.checkedAt ?? "1970-01-01") > 60_000) void refreshGeminiUsage().catch(() => undefined);
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
  const codexThreadUsages = new Map<string, CodexThreadUsage>();
  let geminiTurnsSent = 0;
  let geminiTurnsCompleted = 0;
  let geminiTurnWake: (() => void) | undefined;
  let geminiContinuations = 0;
  let stepsAtLastContinuation: number | undefined;
  const turnAgentResponses = new Map<string, { stepIndex: string; num: number; text: string }>();
  const writeUserTurn = (text: string) => {
    turnAgentResponses.clear();
    if (!proc.stdin) throw new Error("process stdin is not available");
    proc.stdin.write(`${JSON.stringify({ event: "user", message: { content: text } })}\n`);
    proc.stdin.flush();
    geminiTurnsSent += 1;
  };

  // Live 503 state. agy retries in-process first (its per-round log names
  // each attempt); cdx's ladder takes over when agy returns the error. Both
  // layers land in item.outage for status, and the head is woken once per
  // burst, not once per attempt.
  let roundStepCount = 0;
  let outageSince: string | undefined;
  let outageAttempts = 0;
  let outageAnnounced = false;
  let earlyAbort: string | undefined;
  const clearOutage = () => {
    if (!outageSince) return;
    const detail = `${outageAttempts} retr${outageAttempts === 1 ? "y" : "ies"} over ${Math.round((Date.now() - Date.parse(outageSince)) / 1000)}s`;
    outageSince = undefined;
    outageAttempts = 0;
    touchLedger((item) => { item.outage = undefined; }, true);
    if (!outageAnnounced) return;
    outageAnnounced = false;
    logProgress(lane, round, `gemini answering again after ${detail}`);
  };
  const announceOutage = (notice: string) => {
    if (outageAnnounced) return;
    outageAnnounced = true;
    const full = `${notice}; ${geminiCapacityNotice().text}`;
    feedEvent("outage", full, spec.ownerSession, { lane, round });
    notifyParent(lane, full);
  };
  const onAgyRetry = ({ attempt, reason, delay }: { attempt: number; reason: string; delay: string }) => {
    const now = new Date().toISOString();
    const short = shortGeminiReason(reason);
    outageSince ??= now;
    outageAttempts += 1;
    noteActivity();
    touchLedger((item) => {
      item.agyRetries = (item.agyRetries ?? 0) + 1;
      item.outage = { layer: "agy", since: outageSince!, attempt, reason: short, nextRetryAt: new Date(Date.now() + goDurationMs(delay)).toISOString() };
      item.lastAction = `agy retry ${attempt}: ${short}, next in ${delay}`;
      item.lastEventAt = now;
      item.lastActionAt = now;
    }, true);
    if (/Individual quota reached/i.test(reason) && !earlyAbort) {
      // agy would retry a spent five-hour window until its print timeout;
      // cdx stops the round now and records the block so the next resume
      // waits for the reset instead of burning the runtime cap.
      const blockedUntil = parseQuotaResetIso(reason);
      writeGeminiQuota({ blockedUntil, observedAt: now, lane, round });
      earlyAbort = `gemini five-hour quota exhausted mid-turn (agy attempt ${attempt}); resets at ${blockedUntil}; resume this lane after the reset, the partial report is kept`;
      feedEvent("account", `[cdx] lane=${lane} round=${round} ${earlyAbort}`, spec.ownerSession, { lane, round });
      try { stopEngine("SIGTERM", maxRuntimeHit ? "max runtime" : turnFailureReason ?? "engine cleanup after turn"); } catch { /* already gone */ }
      return;
    }
    if (attempt >= AGY_RETRY_WAKE_ATTEMPT) {
      announceOutage(`[cdx] lane=${lane} round=${round} gemini ${short}: agy is retrying in-process (attempt ${attempt}, next in ${delay}) and cdx ladders up to ${GEMINI_OUTAGE_RETRIES} more times (~${outageMinutes(GEMINI_OUTAGE_RETRIES)} min) if agy gives up; the process is alive, do not resume or respawn it`);
    } else {
      logProgress(lane, round, `agy retry ${attempt} ${short} next=${delay}`);
    }
  };
  let agyLogOffset = 0;
  let agyLogCarry = "";
  const pollAgyLog = () => {
    let size: number;
    try { size = statSync(agyLogPath).size; } catch { return; }
    if (size <= agyLogOffset) return;
    const chunk = Buffer.alloc(size - agyLogOffset);
    const fd = openSync(agyLogPath, "r");
    try { readSync(fd, chunk, 0, chunk.length, agyLogOffset); } finally { closeSync(fd); }
    agyLogOffset = size;
    const lines = (agyLogCarry + chunk.toString("utf8")).split("\n");
    agyLogCarry = lines.pop() ?? "";
    for (const line of lines) {
      if (/Agent .*not found, falling back to default/.test(line)) {
        turnFailureReason = "configured agy agent did not load; run cdx doctor --fix";
        touchLedger((item) => { item.agentLoaded = false; }, true);
        try { stopEngine("SIGTERM", maxRuntimeHit ? "max runtime" : turnFailureReason ?? "engine cleanup after turn"); } catch { /* exited */ }
      }
      const retry = parseAgyRetryLine(line);
      if (retry) onAgyRetry(retry);
    }
  };
  const agyLogPoll = gemini ? setInterval(pollAgyLog, 2_000) : undefined;
  const stopAgyLogPoll = () => {
    if (!agyLogPoll) return;
    clearInterval(agyLogPoll);
    pollAgyLog();
  };

  const writeReport = (message: string) => {
    if (startingLane?.kind === "review" && !startingLane.consult) {
      try {
        const parsed = JSON.parse(message);
        if (typeof parsed.report === "string" && Array.isArray(parsed.findings)) {
          writeFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, safeJSON(parsed, 2));
          return writeCapturedReport(reportPath, parsed.report);
        }
      } catch { /* fenced findings remain supported */ }
    }
    return writeCapturedReport(reportPath, message);
  };
  const persistCapturedReport = () => {
    const candidate = latestReportCandidate;
    if (!candidate || candidate.order <= writtenReportOrder || !completedTurns.has(candidate.turnId)) return;
    writeReport(candidate.text);
    writtenReportOrder = candidate.order;
  };
  const rememberAgentMessage = (item: Record<string, unknown>, turnId: string | undefined) => {
    if (!turnId || item.type !== "agentMessage" || typeof item.text !== "string") return;
    const qualifying = item.phase === "final_answer" || item.phase == null;
    if (!qualifying) {
      writeFileSync(partialReportPathOf(lane, round), safeText(`${item.text.trim()}\n`));
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

  const trackTools = roundTools(spec.cwd, spec.visibility ?? VISIBILITY_DEFAULTS,
    (path) => { try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; } }, spec.gate);
  // Files this round's own tool calls wrote, for the shared-worktree check below.
  const writtenPaths = new Set<string>();
  const commandTrees = new Map<string, ReturnType<typeof captureReviewTree>>();
  const siblingPaths = () => new Set(Object.entries(readLedger()).filter(([name, item]) => name !== lane && item.roundStartedAt &&
    (item.work.state === "running" || Date.parse(item.updatedAt) >= Date.parse(startingLane?.roundStartedAt ?? "1970-01-01")))
    .flatMap(([, item]) => item.touchedPaths ?? []));
  const gatePaths = () => {
    const after = workTreeStartSnapshot ? captureReviewTree(treeCwd) : undefined;
    const siblings = siblingPaths();
    const changed = workTreeStartSnapshot && after ? changedPaths(workTreeStartSnapshot, after).map((path) => resolve(treeCwd, path)) : [];
    const children = startingLane?.supervisor ? Object.values(readLedger()).filter((item) => item.parent === lane && item.parentRound === round).flatMap((item) => item.touchedPaths ?? []) : [];
    const paths = [...new Set([...(startingLane?.touchedPaths ?? []), ...writtenPaths, ...children, ...changed.filter((path) => !siblings.has(path))])];
    withLedger((ledger) => { ledger[lane]!.touchedPaths = paths; });
    const root = Bun.spawnSync({ cmd: ["git", "-C", spec.cwd, "rev-parse", "--show-toplevel"] }).stdout.toString().trim();
    return paths.map((path) => relative(root || spec.cwd, path)).filter((path) => path && !path.startsWith("../"));
  };
  const persistProgress = (progress: NonNullable<ReturnType<typeof trackTools>>, now: string) => {
    if (progress.record) { log.write(`${safeJSON(progress.record)}\n`); log.flush(); }
    roundStepCount = progress.steps;
    touchLedger((item) => {
      item.roundSteps = progress.steps;
      item.roundTestRuns = progress.testRuns;
      item.roundTestSuites = progress.testSuites;
      item.roundTestStatus = progress.testStatus;
      item.roundCodegraphCalls = progress.codegraphCalls;
      item.roundCodeSearchesBeforeGraph = progress.codeSearchesBeforeGraph;
      const record = item.kind === "review" ? item.review! : item.work;
      record.testRuns = progress.testRuns;
      record.testSuites = progress.testSuites;
      record.testStatus = progress.testStatus;
      record.codegraphCalls = progress.codegraphCalls;
      record.codeSearchesBeforeGraph = progress.codeSearchesBeforeGraph;
      item.lastActionAt = now;
      item.lastEventAt = now;
    }, Boolean(progress.testThrash || progress.thrash || progress.codegraphThrash));
    if (progress.codegraphThrash) {
      mkdirSync(`${ROOT}/control`, { recursive: true });
      appendFileSync(controlPathOf(lane, round), `${safeJSON({ from: "cdx", sentAt: now, text: progress.codegraphThrash })}\n`);
    }
    if (progress.testThrash || progress.thrash || progress.codegraphThrash) {
      const reason = [progress.testThrash, progress.thrash, progress.codegraphThrash].filter(Boolean).join("; ");
      const notice = `[cdx] lane=${lane} round=${round} ${reason}; ${thrashAdvice(lane)}`;
      feedEvent("thrash", notice, spec.ownerSession, { lane, round });
      notifyParent(lane, notice);
    }
  };
  let gateAttempt = 0;
  let preparedGate: ReturnType<typeof verifyGate> | undefined;
  const runAcceptedGate = async (repair: (prompt: string) => Promise<boolean>) => {
    if (!spec.gate || startingLane?.kind !== "work" || turnFailureReason || receivedSignal || maxRuntimeHit || !existsSync(reportPath)) return;
    const run = () => {
      gatePaths();
      const gateItem = { id: `cdx-gate-${++gateAttempt}`, type: "commandExecution", command: spec.gate };
      persistProgress(trackTools({ method: "item/started", params: { item: gateItem } }, new Date().toISOString())!, new Date().toISOString());
      flushLedger();
      withLedger((ledger) => { ledger[lane]!.stage = "gate"; });
      logProgress(lane, round, "gate started");
      const verified = runFrozenGate(round, spec.cwd, spec.gate!, `${ROOT}/logs/${lane}-r${round}.gate.log`, lane);
      persistProgress(trackTools({ method: "item/completed", params: { item: { ...gateItem, exitCode: verified.gate.exitCode } } }, new Date().toISOString())!, new Date().toISOString());
      flushLedger();
      return verified;
    };
    preparedGate = await repairGateOnce(() => (preparedGate = run()), async (prompt) => {
      if (readLedger()[lane]?.callLimitHit || receivedSignal || maxRuntimeHit) return false;
      withLedger((ledger) => { ledger[lane]!.stage = "working"; });
      log.write(`${safeJSON({ type: "cdx_gate_repair", timestamp: new Date().toISOString(), lane, round, prompt })}\n`);
      log.flush();
      try { return await repair(prompt); }
      catch (error) {
        turnFailureReason = `gate repair failed: ${String(error)}`;
        log.write(`${safeJSON({ type: "cdx_gate_repair_failure", timestamp: new Date().toISOString(), error: String(error) })}\n`);
        return false;
      }
    });
  };
  const thrashAdvice = (name: string): string => startingLane?.kind === "work"
    ? `cdx send ${name} "Stop repeating this attempt; inspect the cause and change approach."`
    : `cdx tail ${name}`;
  const observeTool = (event: any, now: string) => {
    const session = event.conversation_id ?? event.params?.thread?.id ?? event.thread_id;
    if (typeof session === "string" && session !== spec.sessionId) {
      spec.sessionId = session;
      writeFileSync(specPathOf(lane, round), safeJSON(spec, 2));
    }
    const observation = toolObservation(event);
    if (!observation) return;
    for (const file of observation.files) writtenPaths.add(resolve(spec.cwd, file));
    const toolType = (event.params?.item ?? event.item)?.type;
    if (observation.id && (observation.command !== undefined || ["mcpToolCall", "mcp_tool_call", "dynamicToolCall"].includes(toolType))) {
      if (workTreeStartSnapshot && !observation.completed && !commandTrees.has(observation.id)) commandTrees.set(observation.id, captureReviewTree(treeCwd));
      if (observation.completed) {
        const before = commandTrees.get(observation.id);
        if (before) for (const path of changedPaths(before, captureReviewTree(treeCwd))) {
          const absolute = resolve(treeCwd, path);
          if (!siblingPaths().has(absolute)) writtenPaths.add(absolute);
        }
        commandTrees.delete(observation.id);
      }
    }
    if (writtenPaths.size) touchLedger((item) => { item.touchedPaths = [...new Set([...(startingLane?.touchedPaths ?? []), ...writtenPaths])]; });
    const progress = trackTools(event, now)!;
    persistProgress(progress, now);
    if (event.params?.item ?? event.item) touchLedger((item) => { item.lastAction = excerpt(event.params?.item ?? event.item); });
  };
  const handleGeminiEvent = async (event: any) => {
    noteActivity();
    const now = new Date().toISOString();
    observeTool(event, now);
    if (event.event === "init" && event.conversation_id) {
      touchLedger((item) => {
        item.agentLoaded = event.init?.agent === spec.agent;
        item.sessionId = event.conversation_id;
        item.transcriptPath = geminiTranscriptPath(event.conversation_id);
        item.lastEventAt = now;
      }, true);
    } else if (event.event === "step_update" && event.step_update) {
      const update = event.step_update;
      const stepUsage = update.usage;
      if (stepUsage && typeof stepUsage === "object") {
        const delta = geminiTokens(stepUsage);
        if (!delta) {
          touchLedger((item) => {
            item.tokensIncomplete = true;
            if (item.kind === "review") {
              if (item.review) item.review.tokensIncomplete = true;
            } else {
              item.work.tokensIncomplete = true;
            }
            item.lastEventAt = now;
          }, true);
        } else {
          if (delta.input || delta.cached || delta.output) {
            touchLedger((item) => {
              const cumulative = (item.tokens ??= { input: 0, cached: 0, output: 0 });
              const roundTokens = (item.roundTokens ??= { input: 0, cached: 0, output: 0 });
              for (const tokens of [cumulative, roundTokens]) {
                tokens.input = (tokens.input ?? 0) + delta.input;
                tokens.cached = (tokens.cached ?? 0) + delta.cached;
                tokens.output = (tokens.output ?? 0) + delta.output;
              }
              item.lastEventAt = now;
            }, true);
          }
        }
      }
      if (update.step_type === "tool" || update.step_type === "agent_response") clearOutage();
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
      const rawError = result.error?.message ?? result.error;
      const errorText = typeof rawError === "string" ? rawError : typeof rawError === "object" && rawError ? JSON.stringify(rawError) : "";
      const isSuccess = result.status === "SUCCESS";
      const isReview = startingLane?.kind === "review" && !startingLane.consult;
      const finalAgentResponse = extractFinalAgentResponse(turnAgentResponses);

      if (isSuccess) {
        clearOutage();
        const qualified = await qualifyGeminiResult({
          lane, round, ownerSession: spec.ownerSession, result, finalAgentResponse, isReview,
          turnFailureReason, touchLedger, reportPath,
        });
        turnFailureReason = qualified.turnFailureReason;
      } else {
        const currentSteps = roundStepCount;
        const hasProgress = stepsAtLastContinuation !== undefined && currentSteps > stepsAtLastContinuation;
        const kind = classifyGeminiError(errorText);
        const isTransport = kind === "transport" || kind === "503";

        if (earlyAbort || maxRuntimeHit || receivedSignal) {
          // cdx stopped agy itself (quota abort, runtime cap, kill). The 503
          // or interrupted stream that came back with the result is the
          // stop, not an outage, so no ladder and no wake.
          turnFailureReason = earlyAbort ?? turnFailureReason ?? `stopped by cdx with a ${kind} error in flight`;
          const qualified = await qualifyGeminiResult({
            lane, round, ownerSession: spec.ownerSession, result, finalAgentResponse, isReview,
            turnFailureReason, touchLedger, reportPath,
          });
          turnFailureReason = qualified.turnFailureReason ?? turnFailureReason;
        } else if (isTransport && proc.exitCode !== null) {
          turnFailureReason = "transport death; spawn a fresh lane seeded from the partial";
          const qualified = await qualifyGeminiResult({
            lane, round, ownerSession: spec.ownerSession, result, finalAgentResponse, isReview,
            turnFailureReason, touchLedger, reportPath,
          });
          turnFailureReason = qualified.turnFailureReason ?? turnFailureReason;
        } else if (isTransport) {
          const retryDecision = shouldRetryGeminiTransport({
            errorText,
            continuations: geminiContinuations,
            currentSteps,
            stepsAtLastContinuation,
          });

          if (retryDecision.retry) {
            geminiContinuations = (hasProgress ? 0 : geminiContinuations) + 1;
            stepsAtLastContinuation = currentSteps;
            touchLedger((item) => {
              item.continuations = geminiContinuations;
              item.lastEventAt = now;
            }, true);
            const reason = singleLine(errorText).slice(0, 80);
            const waitNotice = retryDecision.backoffMs > 0 ? ` wait=${retryDecision.backoffMs / 1000}s` : "";
            logProgress(lane, round, `auto-continue ${geminiContinuations}/${retryDecision.limit}${waitNotice} reason=${reason}`);
            outageSince ??= now;
            outageAttempts += 1;
            const short = shortGeminiReason(errorText);
            const ladderOutage: LaneOutage = { layer: "cdx", since: outageSince, attempt: geminiContinuations, limit: retryDecision.limit, reason: short, nextRetryAt: new Date(Date.now() + retryDecision.backoffMs).toISOString() };
            touchLedger((item) => {
              item.outage = ladderOutage;
              item.lastAction = `cdx ladder ${geminiContinuations}/${retryDecision.limit}: ${short}, retry in ${Math.round(retryDecision.backoffMs / 1000)}s`;
              item.lastActionAt = now;
            }, true);
            if (kind === "503") {
              const fallback = geminiPolicy.outageFallbackModel && spec.model !== geminiPolicy.outageFallbackModel
                ? `, then one round on ${geminiPolicy.outageFallbackModel} continues the same conversation`
                : "";
              announceOutage(`[cdx] lane=${lane} round=${round} gemini 503 outage: agy gave up after its in-process retries; the process is alive and cdx retries up to ${retryDecision.limit} times over ~${outageMinutes(retryDecision.limit)} min${fallback}; do not resume or respawn it, a terminal event follows if the outage outlasts all of that`);
            }
            const response = typeof result.response === "string" ? result.response.trim() : "";
            const partial = finalAgentResponse || response;
            if (partial) {
              writeFileSync(partialReportPathOf(lane, round), safeText(`${partial}\n`));
              announcePartial();
            }
            if (retryDecision.backoffMs > 0) {
              await Bun.sleep(retryDecision.backoffMs);
            }
            if (proc.exitCode !== null) {
              turnFailureReason = "transport death; spawn a fresh lane seeded from the partial";
            } else if (!receivedSignal && !maxRuntimeHit) {
              try {
                writeUserTurn(kind === "503"
                  ? "The previous turn failed because the model service was temporarily unavailable (503). The service has been given time to recover. Continue the task you were working on from where you left off, without redoing completed work. When the task is complete, print your final lane report."
                  : "The previous turn was cut off by a transport error. Continue the task you were working on from where you left off. When the task is complete, print your final lane report.");
              } catch {
                turnFailureReason = "transport death; spawn a fresh lane seeded from the partial";
              }
            }
          } else {
            const qualified = await qualifyGeminiResult({
              lane, round, ownerSession: spec.ownerSession, result, finalAgentResponse, isReview,
              turnFailureReason, touchLedger, reportPath,
            });
            turnFailureReason = qualified.turnFailureReason;
          }
        } else {
          const qualified = await qualifyGeminiResult({
            lane, round, ownerSession: spec.ownerSession, result, finalAgentResponse, isReview,
            turnFailureReason, touchLedger, reportPath,
          });
          turnFailureReason = qualified.turnFailureReason;
        }
      }
      geminiTurnsCompleted += 1;
      const wake = geminiTurnWake;
      geminiTurnWake = undefined;
      wake?.();
    }
  };

  let partialText = "";
  const handleCodexEvent = async (event: any) => {
    noteActivity();
    const now = new Date().toISOString();
    observeTool(event, now);
    if (event.method === "item/agentMessage/delta" && typeof event.params?.delta === "string") {
      partialText += event.params.delta;
      writeFileSync(partialReportPathOf(lane, round), safeText(partialText));
      announcePartial();
    } else if (event.method === "thread/started" && event.params?.thread?.id) {
      touchLedger((item) => { item.sessionId = event.params.thread.id; item.lastEventAt = now; }, true);
    } else if (event.method === "error" && event.params?.error) {
      const error = event.params.error;
      lastProtocolError = [error.message, error.additionalDetails].filter(Boolean).join(": ") || "app-server turn error";
      if (isCodexQuotaFailure(lastProtocolError)) recordCodexExhaustion(spec, lastProtocolError);
      touchLedger((item) => { item.lastAction = `error: ${lastProtocolError}`; item.lastEventAt = now; }, true);
    } else if (event.method === "thread/tokenUsage/updated" && event.params?.turnId && event.params?.tokenUsage) {
      const threadId = String(event.params?.threadId ?? event.params?.thread?.id ?? spec.sessionId ?? "default");
      const delta = recordCodexTokenDelta(codexThreadUsages, threadId, event.params.tokenUsage);
      if (delta === null) {
        touchLedger((item) => {
          item.tokensIncomplete = true;
          if (item.kind === "review") {
            if (item.review) item.review.tokensIncomplete = true;
          } else {
            item.work.tokensIncomplete = true;
          }
          item.lastEventAt = now;
        }, true);
      } else if (delta.input || delta.cached || delta.output) {
        touchLedger((item) => {
          const cumulative = (item.tokens ??= { input: 0, cached: 0, output: 0 });
          const roundTokens = (item.roundTokens ??= { input: 0, cached: 0, output: 0 });
          for (const tokens of [cumulative, roundTokens]) {
            tokens.input = (tokens.input ?? 0) + delta.input;
            tokens.cached = (tokens.cached ?? 0) + delta.cached;
            tokens.output = (tokens.output ?? 0) + delta.output;
          }
          item.lastEventAt = now;
        }, true);
      }
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
    }
  };

  const pumpJson = async (stream: ReadableStream<Uint8Array>) => {
    for await (const event of readJsonLines(stream, { ignoreMalformed: true })) {
      await (gemini ? handleGeminiEvent(event) : handleCodexEvent(event));
      writeProtocolEvent(log, event);
    }
  };
  const pumpRaw = async (stream: ReadableStream<Uint8Array>, sink: typeof log) => {
    for await (const text of safeLines(stream)) {
      sink.write(text);
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
      drainGeminiControls(controlPathOf(lane, round), geminiTurnsCompleted < geminiTurnsSent, hooksInstalled, {
        exists: existsSync,
        lines: (path) => readFileSync(path, "utf8").split("\n").filter((line) => line.trim()),
        deliveredCount: () => readDeliveredCount(lane, round),
        markDelivered: (count) => writeDeliveredCount(lane, round, count),
        callLimitHit: () => Boolean(findLane(lane)?.callLimitHit),
        withLane: (action) => withLane(lane, action),
        deliver: (record) => {
          writeUserTurn(controlText(record));
          const flat = singleLine(record.text);
          logProgress(lane, round, `steer delivered mode=follow-up-turn: ${flat.slice(0, 120)}`);
        },
        now: () => new Date().toISOString(),
      });
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
    await runAcceptedGate(async (prompt) => {
      writeUserTurn(prompt);
      await awaitTurns();
      return !turnFailureReason && !receivedSignal && !maxRuntimeHit;
    });
    try { proc.stdin?.end(); } catch { /* already closed */ }
    if (proc.exitCode === null) await Promise.race([proc.exited, Bun.sleep(10_000)]);
    if (proc.exitCode === null) {
      roundCleanupWarning = "agy did not exit within 10s after stdin closed";
      try { stopEngine("SIGTERM", maxRuntimeHit ? "max runtime" : turnFailureReason ?? "engine cleanup after turn"); } catch { /* already gone */ }
      await Promise.race([proc.exited, Bun.sleep(10_000)]);
    }
    if (proc.exitCode === null) {
      try { stopEngine("SIGKILL", "engine did not stop after SIGTERM"); } catch { /* already gone */ }
    }
    exitCode = await proc.exited;
    await Promise.allSettled([stdoutPump, stderrPump]);
    if (geminiTurnsCompleted < geminiTurnsSent && !maxRuntimeHit && !receivedSignal) {
      turnFailureReason ??= earlyAbort ?? `agy exited before result (${geminiTurnsCompleted}/${geminiTurnsSent} turns completed)`;
    }
    if (turnFailureReason) exitCode ||= 1;
  } else {
    let requestId = 0;
    let rpcClosed = false;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    const writeRpc = (message: Record<string, unknown>) => {
      if (!proc.stdin) throw new Error("process stdin is not available");
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
      for await (const message of readJsonLines(stream, { ignoreMalformed: true })) {
        writeProtocolEvent(log, message);
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
        ...codexSandbox(spec).turn,
        ...(spec.mode === "spawn" ? { model: spec.model ?? config.model } : {}),
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
      logProgress(lane, round, `steer delivered mode=${mode}: ${short}`);
    };
    const deliverControl = async (record: ControlRecord): Promise<"steered" | "follow-up-turn" | undefined> => {
      const expectedTurnId = activeTurnId;
      try {
        if (expectedTurnId) {
          await request("turn/steer", { threadId, expectedTurnId, input: [inputText(controlText(record))] });
          return "steered";
        } else {
          await startTurn(threadId, controlText(record), false);
          return "follow-up-turn";
        }
      } catch (steerError) {
        if (expectedTurnId) {
          try {
            await waitForTurn(expectedTurnId);
            await startTurn(threadId, controlText(record), false);
            return "follow-up-turn";
          } catch (followUpError) {
            steerError = followUpError;
          }
        }
        const reason = steerError instanceof Error ? steerError.message : String(steerError);
        if (!reportedControlFailures.has(controlIndex)) {
          reportedControlFailures.add(controlIndex);
          logProgress(lane, round, `steer rejected and retained: ${reason.slice(0, 160)}`);
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
      const capHook = await trustCapHook(request, spec.cwd).catch((error: Error) => { console.error(`cdx: output cap hook not trusted: ${error.message}`); return false; });
      log.write(`${safeJSON({ type: "cdx_cap_hook", active: capHook })}\n`);
      const recordAccount = async (phase: "Start" | "End") => {
        try {
          const result = await request("account/rateLimits/read", {});
          const limits = result?.rateLimits;
          const windows = Object.fromEntries(["primary", "secondary"].flatMap((key) => typeof limits?.[key]?.usedPercent === "number" ? [[key, limits[key].usedPercent]] : []));
          accountPercent(phase, Object.keys(windows).length ? windows : undefined);
        } catch { accountPercent(phase, undefined); }
      };
      await recordAccount("Start");
      const threadParams = appThreadParams(spec);
      const method = spec.mode === "spawn" ? "thread/start" : "thread/resume";
      const sourceThreadId = spec.sourceThreadId;
      if (method !== "thread/start" && !sourceThreadId) throw new Error(`${method} needs a source thread id`);
      const threadResult = await request(method, {
        ...(method === "thread/start" ? {} : { threadId: sourceThreadId }),
        ...threadParams,
      });
      threadId = threadResult?.thread?.id;
      if (typeof threadId !== "string") throw new Error(`${method} returned no thread id`);
      const sandboxRefusal = role.review ? reviewSandboxRefusal(threadResult, spec) : undefined;
      if (sandboxRefusal) throw new Error(sandboxRefusal);
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
      if (!protocolFailed) await runAcceptedGate(async (prompt) => {
        const fix = await waitForTurn(await startTurn(threadId, prompt, false));
        if (activeTurnId === fix.id) activeTurnId = undefined;
        return fix.status === "completed";
      });
      if (!rpcClosed) await recordAccount("End");
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
      try { proc.stdin?.end(); } catch { /* child already closed */ }
      if (proc.exitCode === null) await Promise.race([proc.exited, Bun.sleep(3000)]);
      if (proc.exitCode !== null && proc.exitCode !== 0 && existsSync(reportPath) && !maxRuntimeHit) {
        roundCleanupWarning ??= `app-server exited ${proc.exitCode} after completed turn`;
      }
      if (proc.exitCode === null) {
        roundCleanupWarning ??= "app-server did not exit after stdin closed";
        try { stopEngine("SIGTERM", maxRuntimeHit ? "max runtime" : turnFailureReason ?? "engine cleanup after turn"); } catch { /* already gone */ }
        await Promise.race([proc.exited, Bun.sleep(10_000)]);
      }
      if (proc.exitCode === null) {
        try { stopEngine("SIGKILL", "engine did not stop after SIGTERM"); } catch { /* already gone */ }
        await proc.exited;
      }
      await Promise.allSettled([stdoutPump, stderrPump]);
      if (roundCleanupWarning) {
        logProgress(lane, round, `cleanup warning: ${roundCleanupWarning}`);
        console.error(`cdx: lane=${lane} round=${round} cleanup warning: ${roundCleanupWarning}`);
      }
    } catch (error) {
      if (controlWatcher) clearInterval(controlWatcher);
      try { proc.stdin?.end(); } catch { /* child already closed */ }
      try { stopEngine("SIGTERM", `protocol failure: ${String(error)}`); } catch { /* child already closed */ }
      await Promise.allSettled([stdoutPump, stderrPump, proc.exited]);
      if (receivedSignal) {
        exitCode = receivedSignal === "SIGINT" ? 130 : 143;
        turnFailureReason = undefined;
      } else if (maxRuntimeHit) {
        exitCode = proc.exitCode ?? 143;
      } else {
        clearInterval(watchdog);
        stopAgyLogPoll();
        if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
        if (maxRuntimeForceTimer) clearTimeout(maxRuntimeForceTimer);
        log.end();
        errLog.end();
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
        throw error;
      }
    }
  }
  if (receivedSignal) {
    exitCode = receivedSignal === "SIGINT" ? 130 : 143;
    turnFailureReason = undefined;
  }
  if (gemini) { await refreshGeminiUsage().catch(() => undefined); accountPercent("End", geminiPercent()); }
  clearInterval(watchdog);
  stopAgyLogPoll();
  if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
  if (maxRuntimeForceTimer) clearTimeout(maxRuntimeForceTimer);
  await log.end();
  await errLog.end();
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);

  flushLedger();
  return finalizeRound({ treeCwd, preparedGate, spec, lane, round, jsonMode, gemini, logPath, reportPath, reviewTreeStart, indexIgnoreStart, workTreeStartSnapshot, exitCode, turnFailureReason, receivedSignal, maxRuntimeHit, geminiContinuations, roundCleanupWarning });
}

export async function finalizeRound({ treeCwd, preparedGate, spec, lane, round, jsonMode, gemini, logPath, reportPath, reviewTreeStart, indexIgnoreStart, workTreeStartSnapshot, exitCode, turnFailureReason, receivedSignal, maxRuntimeHit, geminiContinuations, roundCleanupWarning }: {
  treeCwd: string;
  preparedGate?: ReturnType<typeof verifyGate>;
  spec: Spec; lane: string; round: number; jsonMode: boolean; gemini: boolean;
  logPath: string; reportPath: string;
  reviewTreeStart?: string; indexIgnoreStart?: string;
  workTreeStartSnapshot?: ReturnType<typeof captureReviewTree>;
  exitCode: number; turnFailureReason?: string; receivedSignal?: "SIGTERM" | "SIGINT";
  maxRuntimeHit: boolean; geminiContinuations: number; roundCleanupWarning?: string;
}): Promise<number> {

  const setStage = (stage: "gate" | "reporting") => withLedger((ledger) => {
    const item = ledger[lane];
    if (item?.rounds === round) { item.stage = stage; item.stageStartedAt = new Date().toISOString(); }
  });
  setStage("reporting");
  if (readLedger()[lane]?.callLimitHit) turnFailureReason = "Gemini round reached 250 calls; continue in a fresh lane seeded from the handoff report";
  const reportOk = existsSync(reportPath) && readFileSync(reportPath, "utf8").trim().length > 0;
  if (!reportOk) {
    captureRecoveryPartial(lane, round, spec.cwd);
    feedEvent("partial", `[cdx] lane=${lane} round=${round} partial report=${partialReportPathOf(lane, round)}`, spec.ownerSession, { lane, round });
  }
  const stderrText = (() => {
    try { return readFileSync(`${ROOT}/logs/${lane}-r${round}.stderr.log`, "utf8"); } catch { return ""; }
  })();
  const codex = spec.engine === "gpt";
  if (codex && !receivedSignal && !maxRuntimeHit && exitCode !== 0 && isCodexQuotaFailure(stderrText)) recordCodexExhaustion(spec, stderrText);
  const beforeFinalize = readLedger()[lane];
  const retryQuota = codex && !receivedSignal && !maxRuntimeHit && (exitCode !== 0 || Boolean(turnFailureReason)) && Boolean(beforeFinalize?.quotaFailure);
  // The 503 ladder ran out on the policy model: one more round continues the
  // same conversation on the fallback tier (same 3.8 family, own capacity
  // pool). The runner opens it; the lane stays "running" meanwhile.
  const geminiPolicy = config.gemini ?? geminiConfig();
  const ladderExhausted = gemini && turnFailureReason === "gemini service unavailable (503)" && geminiContinuations >= GEMINI_OUTAGE_RETRIES;
  const fallbackRound = ladderExhausted && !receivedSignal && !maxRuntimeHit
    && Boolean(geminiPolicy.outageFallbackModel) && spec.model !== geminiPolicy.outageFallbackModel && Boolean(beforeFinalize?.sessionId);
  const reviewTreeEnd = reviewTreeStart ? treeHash(treeCwd) : undefined;
  const indexIgnoreMoved = indexIgnoreStart !== undefined && indexIgnoreFingerprint(spec) !== indexIgnoreStart;
  const reviewTreeMoved = Boolean(reviewTreeStart && reviewTreeEnd && reviewTreeEnd !== reviewTreeStart) || indexIgnoreMoved;
  const workTreeEndSnapshot = workTreeStartSnapshot ? captureReviewTree(treeCwd) : undefined;
  const workTreeUnchanged = Boolean(workTreeStartSnapshot && workTreeEndSnapshot && workTreeStartSnapshot.fingerprint === workTreeEndSnapshot.fingerprint);
  // An unchanged tree is evidence for the report, never a verdict: a
  // verification-only round or a supervisor whose children worked in their
  // own worktrees changes nothing here and can still be correct. The gate
  // decides; the head reads diff=empty on the feed line.
  const unchangedWork = Boolean(workTreeUnchanged && beforeFinalize?.kind === "work" && exitCode === 0 && reportOk && !turnFailureReason);

  const capturedSessionId = beforeFinalize?.sessionId;
  const resolvedSessionId = capturedSessionId
    || (codex ? resolveSessionIdFromRollouts(spec, beforeFinalize?.roundStartedAt) : undefined);
  if (resolvedSessionId && spec.sessionId !== resolvedSessionId) {
    spec.sessionId = resolvedSessionId;
    writeFileSync(specPathOf(lane, round), safeJSON(spec, 2));
  }
  // The gate is the harness's own verification: a worker's optimistic done
  // claim cannot finalize green unless the gate command also passes. Work
  // rounds only (ledger kind, since intent reviews launch with mode "spawn").
  let gateExit: number | undefined;
  let gateTimedOut = false;
  let gateReceipt: GateReceipt | undefined;
  let proofRequired = false;
  if (preparedGate && spec.gate && beforeFinalize?.kind === "work") {
    setStage("gate");
    const shared = sharedTreeLanes(lane, spec.cwd, readLedger(), (cwd) => {
      try {
        const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--show-toplevel"] });
        return result.success ? realpathSync(result.stdout.toString().trim()) : undefined;
      } catch { return undefined; }
    });
    if (shared.length) {
      const notice = `[cdx] lane=${lane} round=${round} gate starts while lanes share this working tree: ${shared.join(", ")}`;
      console.error(notice);
      logProgress(lane, round, notice);
    }
    const verified = preparedGate;
    if (!verified) throw new CmdError("work report has no gate execution evidence");
    const { gate } = verified;
    gateReceipt = verified.receipt;
    if (shared.length) gateReceipt.sharedTreeLanes = shared;
    proofRequired = verified.proofRequired;
    gateExit = gate.exitCode;
    gateTimedOut = gate.timedOut;
    setStage("reporting");
    feedEvent("gate-finished", `[cdx] lane=${lane} round=${round} gate finished exit=${gateExit} receipt=${gateReceipt.valid ? "valid" : "invalid"} log=${ROOT}/logs/${lane}-r${round}.gate.log`, spec.ownerSession, { lane, round });
    writeFileSync(reportPath, safeText(`${readFileSync(reportPath, "utf8").trimEnd()}\n\n## Gate\n\n\`${spec.gate}\` exited ${gateExit}\n\n\`\`\`\n${gateOutputForReport(gate.output, gateExit)}\n\`\`\`\n`));
  }
  if (unchangedWork && existsSync(reportPath)) {
    appendFileSync(reportPath, "\n\n## Harness note\n\nThis round changed no files.\n");
  }
  const gateFailed = gateAcceptanceFailed(gateExit, gateReceipt, proofRequired);
  // A supervisor's round ends with its children. Whatever the outcome, any
  // child still running is stopped so nothing keeps editing after the
  // report; a round that finished with children running cannot be done.
  const orphanedChildren = (beforeFinalize?.kind === "work" || beforeFinalize?.consult) && beforeFinalize.supervisor && !retryQuota && !fallbackRound
    ? await killChildren(lane, receivedSignal ? `supervisor ${lane} killed` : maxRuntimeHit ? `supervisor ${lane} hit max runtime` : `supervisor ${lane} round ${round} ended`)
    : [];
  const roundState: ReviewState = exitCode === 0 && reportOk && !gateFailed && !maxRuntimeHit && !reviewTreeMoved && !turnFailureReason && orphanedChildren.length === 0 ? "done" : "failed";
  if (gateReceipt) {
    const extensions = existsSync(reportPath) ? scopeExtensions(readFileSync(reportPath, "utf8")) : [];
    if (extensions.length) gateReceipt.scopeExtensions = extensions;
    const final = finishGateReceipt(gateReceipt, roundState);
    gateReceipt = final.receipt;
    appendFileSync(reportPath, final.report);
  }
  expireRoundQuestions(lane, round);
  const capturedReport = availableReportPath(lane, round);
  const entry = withLedger((ledger) => {
    const item = ledger[lane]!;
    if (codex) invalidateAccountUsage(item.roundAccount);
    if (!retryQuota) item.quotaFailure = undefined;
    if (!item.sessionId && resolvedSessionId) item.sessionId = resolvedSessionId;
    // Ledger kind, not spec.mode, decides work vs review: intent reviews
    // launch with mode "spawn" but must never become the resume target.
    if (item.kind === "work" && item.sessionId) item.workSessionId = item.sessionId;
    let roundNote: string | undefined;
    if (indexIgnoreMoved) roundNote = "review changed a codegraph index .gitignore, which the checkout tracks";
    else if (reviewTreeMoved) roundNote = `review tree changed despite the read-only sandbox: ${reviewTreeStart} -> ${reviewTreeEnd}`;
    else if (orphanedChildren.length > 0 && !receivedSignal && !maxRuntimeHit) roundNote = `supervisor ended with running children: ${orphanedChildren.join(", ")} (stopped)`;
    else if (gateFailed && gateExit === 0) roundNote = gateReceipt?.reason ?? "gate receipt unavailable";
    else if (gateFailed) {
      const gateLogPath = `${ROOT}/logs/${lane}-r${round}.gate.log`;
      let gateLogOutput = "";
      try { gateLogOutput = readFileSync(gateLogPath, "utf8"); } catch {}
      const failure = gateFailure(gateExit ?? 1, gateLogOutput);
      const kindLabel = `gate ${failure.kind} failed`;
      roundNote = gateTimedOut ? `gate timed out after 60 minutes: ${spec.gate}`
        : `${kindLabel} (exit ${gateExit}): ${spec.gate} (cwd=${spec.cwd}, log=${gateLogPath})`;
      roundNote = `${failure.diagnostic}\n${roundNote}`;
    } else if (maxRuntimeHit) roundNote = `max runtime exceeded (${spec.maxRuntimeMins}m)`;
    else if (receivedSignal) roundNote = `terminated by signal (exit ${exitCode}): cdx kill or a manual stop`;
    else if (turnFailureReason) {
      if (turnFailureReason === "transport death; spawn a fresh lane seeded from the partial") {
        roundNote = turnFailureReason;
      } else {
        const continuePrefix = geminiContinuations > 0
          ? `turn failed after ${geminiContinuations} auto-continue${geminiContinuations === 1 ? "" : "s"}`
          : "turn failed";
        roundNote = fallbackRound
          ? `gemini 503 outage outlasted ${geminiContinuations} auto-retries (~${outageMinutes(geminiContinuations)} min) on ${spec.model}; round ${round + 1} continues the conversation on ${geminiPolicy.outageFallbackModel}`
          : ladderExhausted
            ? `gemini 503 outage outlasted ${geminiContinuations} auto-retries (~${outageMinutes(geminiContinuations)} min)${spec.model === geminiPolicy.outageFallbackModel ? ` on the fallback model ${spec.model} too` : ""}; when Gemini answers again spawn a fresh lane seeded from the partial`
            : `${continuePrefix}: ${turnFailureReason.slice(0, 200)}`;
      }
    }
    else if (exitCode === 0 && !reportOk) roundNote = "no final report";
    else if (roundCleanupWarning) roundNote = `cleanup warning: ${roundCleanupWarning.slice(0, 200)}`;
    // Signal exits outrank the auth regex: a SIGTERM'd codex can leave auth
    // words in stderr and a kill must never read as a login failure.
    else if (exitCode === 130 || exitCode === 137 || exitCode === 143) {
      roundNote = `terminated by signal (exit ${exitCode}): cdx kill or a manual stop`;
    } else if (exitCode !== 0 && /login|auth|401|unauthorized|token.*expired/i.test(stderrText)) {
      roundNote = "auth failure: run `codex login`, then spawn a fresh lane seeded from the report";
    } else if (exitCode !== 0) {
      const errTail = stderrText.trim().split("\n").at(-1);
      if (errTail) roundNote = `stderr: ${errTail.slice(0, 200)}`;
    }
    if (roundState === "failed") {
      const hasReport = reportOk ? `report=${reportPath}` : capturedReport ? `partial=${capturedReport}` : "no report";
      const lastStep = item.roundSteps ? `lastStep=${item.roundSteps}` : "";
      const gateInfo = spec.gate ? `gateRan=${gateExit !== undefined}` : "";
      const summaryParts = [
        roundNote ?? "round failed",
        hasReport,
        lastStep,
        gateInfo,
      ].filter(Boolean);
      roundNote = summaryParts.join("; ");
    }
    if (unchangedWork) item.diffEmpty = true;
    if (item.kind === "review") {
      item.review!.state = roundState;
      item.review!.exitCode = exitCode;
      item.review!.note = roundNote;
      item.review!.report = capturedReport;
      item.review!.updatedAt = new Date().toISOString();
    } else {
      item.gateReceipt = gateReceipt;
      item.work.state = roundState;
      item.work.exitCode = exitCode;
      item.work.note = roundNote;
      item.work.report = capturedReport;
      item.work.updatedAt = new Date().toISOString();
    }
    if (item.kind === "review" ? item.review?.tokensIncomplete : item.work.tokensIncomplete) {
      item.tokensIncomplete = true;
    }
    item.pid = undefined;
    item.codexPid = undefined;
    item.outage = undefined;
    if (retryQuota) { item.switchingAccount = true; item.pid = process.pid; }
    if (fallbackRound) { item.outageFallbackPending = true; item.pid = process.pid; }
    if (existsSync(reportPath)) item.reports.push(reportPath);
    if (geminiContinuations > 0) item.continuations = geminiContinuations;
    item.updatedAt = new Date().toISOString();
    return item;
  });
  if (jsonMode) appendFileSync(logPath, `${JSON.stringify({ type: "cdx_round_end", timestamp: entry.updatedAt,
    roundStart: workTreeStartSnapshot ? { kind: workTreeStartSnapshot.kind, fingerprint: workTreeStartSnapshot.fingerprint } : null,
    ...(reviewTreeStart ? { reviewTree: { before: reviewTreeStart, after: reviewTreeEnd ?? null } } : {}),
    gateReceiptId: gateReceipt ? `${lane}:r${round}` : null, ...(gateReceipt ? { gateReceipt } : {}) })}\n`);
  // Structured verdict: reviewers end reports with a fenced json findings
  // block. Persist the last parsable one for machine consumers; a malformed
  // block leaves the markdown report as the only artifact, never a failure.
  if (beforeFinalize?.kind === "review" && reportOk && !existsSync(`${ROOT}/reports/${lane}-r${round}.findings.json`)) {
    const blocks = [...readFileSync(reportPath, "utf8").matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/g)];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      try {
        const verdict = JSON.parse(blocks[index]![1]!) as { findings?: unknown };
        if (Array.isArray(verdict.findings)) {
          writeFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, `${safeJSON(verdict, 2)}\n`);
          break;
        }
      } catch { /* not the verdict block */ }
    }
  }
  if (reviewAttests(entry)) {
    try {
      const verdict = JSON.parse(readFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, "utf8"));
      const closed = reviewLoopClosed(verdict.findings);
      const root = reviewRoot(entry.review!.cwd);
      const skipped = withLedger((ledger) => {
        ledger[lane]!.reviewClosed = closed;
        return attestReview(ledger, lane, closed, existsSync(reportPath) ? reportPath : undefined, root);
      });
      if (skipped) console.log(`cdx: ${skipped}`);
    } catch { /* absent verdict cannot close the loop */ }
  }
  const finalRoundState = activeStateOf(entry);
  const finalRoundNote = entry.kind === "review" ? entry.review?.note : entry.work.note;
  const roundIncomplete = entry.kind === "review" ? entry.review?.tokensIncomplete : entry.work.tokensIncomplete;
  const diffToken = entry.diffEmpty ? " diff=empty" : "";
  const geminiStanding = gemini ? readGeminiUsageSnapshot() : undefined;
  const standingToken = geminiStanding ? ` gemini=${geminiStanding.weekly.remainingPercent}% weekly left/${geminiStanding.fiveHour.remainingPercent}% five-hour left` : "";
  if (!entry.quotaFailure && !fallbackRound) feedEvent("terminal", `[cdx] lane=${lane} round=${round} kind=${entry.kind} state=${finalRoundState} exit=${exitCode}${diffToken}${finalRoundNote ? ` note=${finalRoundNote}` : ""} tokens=${fmtTokens(entry.roundTokens ?? entry.tokens, roundIncomplete)}${standingToken} report=${capturedReport ?? "-"} log=${logPath} gateExit=${gateExit ?? "not-run"} gateLog=${gateExit === undefined ? "-" : `${ROOT}/logs/${lane}-r${round}.gate.log`} verdict=${JSON.stringify(completionVerdict(finalRoundState, finalRoundNote))}`, entry.ownerSession, { lane, round });
  console.log(`lane=${color.magenta(lane)} session=${entry.sessionId ?? "?"} round=${round} kind=${entry.kind} state=${coloredState(finalRoundState)} exit=${exitCode} tests=${entry.roundTestRuns ?? 0} suites=${entry.roundTestSuites ?? 0} tokens=${fmtTokens(entry.tokens, entry.tokensIncomplete)} report=${capturedReport ?? "-"}`);
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
