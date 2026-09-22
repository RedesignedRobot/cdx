// Lane launch, spawn, resume, fork, review, consult, and cleanup commands.

import {
  accountSpec, announceAccountSelection, defaultCodexHome, laneAccount, primaryAccount,
  rejectPinnedAccountFlag, warnCachedUsageBeforeLaunch,
} from "./accounts.ts";
import {
  checkChildAstraRefusal, checkRoundCap, config, defaultMaxRuntime, ENGINE_PICKER, engineOf, geminiConfig,
  laneModel, maxRuntimeOf, modelOf, rejectEngineMismatch, requireEngineBinary, resolveEffort,
} from "./config.ts";
import {
  CODEX_DISABLE_NATIVE_SUBAGENTS, freshAccountSpec, geminiCapacityNotice, recoveryPrompt,
  rolloutCwdForSession,
} from "./engines.ts";
import {
  composeGate, executeGate, finishInvalidBaseline, printGateChange, repositoryGate, runPreCheck,
} from "./gates.ts";
import { formatGeminiStanding, readGeminiUsageSnapshot, requireGeminiQuota } from "./gemini-usage.ts";
import {
  type AccountChoice, activeStateOf, callerLineage, callerOwnership, feedEvent, laneEngine, laneRunning,
  ownershipSpec, readEvents, readLane, readLedger, recipientOf, requireOwnChild, spawnRoots, type Spec,
  storedOwnership, supervisorLane, validLane, withEvents, withLedger, workCwdOf,
} from "./ledger.ts";
import {
  CONSULT_FRAME, conversationRules, houseRules, pendingTestsRefusal, promptRules, resumePrompt,
  REVIEW_FINDINGS_SCHEMA, reviewFrame,
} from "./prompts.ts";
import { logPathOf, partialReportPathOf, reportPathOf, specPathOf } from "./reports.ts";
import { failActiveRound } from "./round-state.ts";
import { openRound } from "./rounds.ts";
import { runRound } from "./runner.ts";
import {
  color, displayPath, fail, fmtAge, HOME, parseArgs, pidAlive, resolveBrief, ROOT, runnerEnv, SELF,
  settleHint,
} from "./runtime.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import { createWorktree, mergeDirectories, storedDirectories, type WorktreeInfo } from "./worktrees.ts";
import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";

function launch(spec: Spec, brief: string, background: boolean): Promise<never> | never {
  spec.accountHomes = config.accounts;
  spec.visibility = config.visibility ?? VISIBILITY_DEFAULTS;
  spec.taskPrompt ??= spec.prompt;
  spec.injectedRules ??= promptRules(spec.prompt);
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
  spec.startedAt ??= entry.roundStartedAt ?? new Date().toISOString();
  writeFileSync(specPathOf(spec.lane, spec.round), JSON.stringify(spec, null, 2));
  writeFileSync(`${ROOT}/briefs/${spec.lane}-r${spec.round}.md`, brief);
  feedEvent("started", `[cdx] lane=${spec.lane} round=${spec.round} started report=${reportPathOf(spec.lane, spec.round)}`, spec.ownerSession, { lane: spec.lane, round: spec.round });
  const jsonMode = spec.engine === "gemini" || spec.reviewDir === undefined || spec.mode === "spawn";
  if (spec.reviewDir) console.log(`cdx: REVIEW DIRECTORY ${spec.reviewDir}`);
  console.log(`cdx: lane=${color.magenta(spec.lane)} engine=${spec.engine}${spec.model ? ` model=${spec.model}` : ""}${spec.supervisor ? " supervisor" : ""} mode=${spec.mode} round=${spec.round} cwd=${spec.cwd}${background ? " (background)" : ""}`);
  console.log(`cdx: log=${logPathOf(spec.lane, spec.round, jsonMode)} report=${reportPathOf(spec.lane, spec.round)}`);
  if (spec.engine === "gemini") {
    const snapshot = readGeminiUsageSnapshot();
    if (snapshot) {
      const standing = formatGeminiStanding(snapshot);
      const paint = standing.usedPercent >= 95 ? color.red : standing.usedPercent >= 75 ? color.yellow : (text: string) => text;
      console.log(`cdx: gemini for this lane: ${paint(standing.detail)} (checked ${fmtAge(snapshot.checkedAt)} ago)`);
    } else {
      console.log("cdx: gemini for this lane: usage unknown (run cdx usage once agy is signed in)");
    }
    const capacity = geminiCapacityNotice();
    console.log(capacity.peak ? color.yellow(`cdx: ${capacity.text}`) : `cdx: ${capacity.text}`);
  }
  if (background) {
    const crashLog = openSync(`${ROOT}/logs/${spec.lane}-r${spec.round}.runner.log`, "a");
    const child = nodeSpawn(process.execPath, [SELF, "_run", spec.lane, String(spec.round)], {
      detached: true,
      env: runnerEnv(spec.codexHome),
      stdio: ["ignore", crashLog, crashLog],
    });
    child.unref();
    withLedger((ledger) => { ledger[spec.lane]!.pid = child.pid; });
    console.log(`cdx: detached pid=${child.pid}; ${settleHint(spec.lane)}`);
    process.exit(0);
  }
  return runRound(spec.lane, spec.round).then((code) => process.exit(code));
}

export async function spawnCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "worktree", "bg", "add-dir", "image", "schema", "account", "gate", "gate-baseline-check", "max-runtime", "model", "supervisor", "pre"]);
  const engine = engineOf(parsed, "spawn");
  const [lane, briefArg] = parsed.rest;
  const usage = `usage: cdx spawn <lane> [--engine gpt|gemini] [options] "<brief>"\n\n${ENGINE_PICKER}`;
  const brief = await resolveBrief(briefArg, usage);
  if (!lane || !brief) fail(usage);
  validLane(lane);
  const supervisor = parsed.bools.has("supervisor");
  const parent = supervisorLane();
  if (parent) {
    const parentEntry = readLedger()[parent];
    if (parentEntry?.consult) {
      fail("consult supervisor cannot spawn writable workers; use cdx consult --engine gemini for read-only helpers");
    }
  }
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
  checkChildAstraRefusal(Boolean(parent || existingLane?.parent), engine, model);
  requireEngineBinary(engine);
  requireGeminiQuota(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gemini" && (parsed.lists.image?.length ?? 0) > 0) fail("--image is not supported for gemini");
  const roots = spawnRoots(parsed.flags.cd, existingLane, process.cwd(), existsSync);
  let cwd = roots.cwd;
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  const effort = resolveEffort(engine, model, parsed.flags.effort);
  const maxRuntime = maxRuntimeOf(parsed) ?? defaultMaxRuntime(engine);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  if (parsed.flags.pre !== undefined && parsed.flags.pre.trim() === "") fail("--pre needs a nonempty command");
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
  const effectiveGate = composeGate(repositoryGate(cwd), gate);
  if (parsed.bools.has("gate-baseline-check") && !effectiveGate) fail("--gate-baseline-check requires --gate or .cdx-gate");
  const pre = parsed.flags.pre ?? existingLane?.pre;
  const additionalDirectories = mergeDirectories(storedDirectories(lane, existingLane), (parsed.lists["add-dir"] ?? []).map((dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`--add-dir is not a directory: ${dir}`);
    return realpathSync(dir);
  }));
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
      worktree = createWorktree(roots.worktreeRepo, parsed.flags.worktree, lane);
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
  withLedger((ledger) => { ledger[lane]!.additionalDirectories = additionalDirectories; });
  const gateBaselineChecked = Boolean(effectiveGate && parsed.bools.has("gate-baseline-check"));
  if (gateBaselineChecked) {
    const baselineLog = `${ROOT}/logs/${lane}-r${round}.gate-baseline.log`;
    console.log(`cdx: gate baseline check cwd=${cwd} cmd=${effectiveGate}`);
    const result = executeGate(effectiveGate!, cwd, baselineLog);
    const checkedAt = new Date().toISOString();
    withLedger((ledger) => {
      ledger[lane]!.gateBaseline = { round, command: effectiveGate!, cwd, exitCode: result.exitCode, checkedAt };
    });
    if (result.exitCode !== 0) {
      writeFileSync(`${ROOT}/briefs/${lane}-r${round}.md`, fullBrief);
      finishInvalidBaseline(lane, round, effectiveGate!, cwd, result);
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
    ...(effectiveGate ? { gate: effectiveGate } : {}),
    ...(gateBaselineChecked ? { gateBaselineChecked: true as const } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...accountSpec(account), ...ownershipSpec(owner),
  }, fullBrief, parsed.bools.has("bg"));
}

export async function resumeCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "gate", "bg", "max-runtime", "account", "pre", "add-dir"]);
  const [lane, followUpArg] = parsed.rest;
  const usage = 'usage: cdx resume <lane> [--add-dir <dir>]... [--effort <effort>] [--bg] [--max-runtime <min>] [--pre <cmd>] "<follow-up>"';
  const followUp = await resolveBrief(followUpArg, usage);
  if (!lane || !followUp) fail(usage);
  const before = readLane(lane);
  requireOwnChild(lane, before);
  const parent = supervisorLane();
  if (parent && parsed.flags.gate !== undefined && parsed.flags.gate !== before.gate) {
    fail(`supervisor ${parent} may not change a child's gate; ask the liaison if it is wrong`);
  }
  const engine = laneEngine(before);
  checkChildAstraRefusal(Boolean(parent || before.parent), engine, before.model);
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
  const additionalDirectories = mergeDirectories(storedDirectories(lane, before), (parsed.lists["add-dir"] ?? []).map((dir) => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`--add-dir is not a directory: ${dir}`);
    return realpathSync(dir);
  }));
  if (reviewResume && parsed.lists["add-dir"]?.length) fail("--add-dir is only supported on work resumes");
  const effectiveGate = composeGate(repositoryGate(cwd), parsed.flags.gate ?? before.gate);
  const pre = parsed.flags.pre ?? before.pre;
  const partialPath = partialReportPathOf(lane, before.rounds);
  const partial = activeStateOf(before) === "failed" && existsSync(partialPath) ? readFileSync(partialPath, "utf8").trim() : "";
  const refusal = pendingTestsRefusal(partial, followUp);
  if (refusal) {
    const status = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--short"] });
    fail(`${refusal}\nPartial: ${partialPath}\nChanged paths now:\n${status.success ? status.stdout.toString().trim() || "None." : "Unavailable."}\nLast action: ${before.lastAction ?? "unknown"}`);
  }
  if (pre) runPreCheck(pre, cwd);
  const { round, sessionId, selection } = await openRound(lane, reviewResume ? "review" : "work", cwd, effort, {
    engine, account, preserveEngine: true, requireSession: true, preserveAccount: engine === "gpt", preserveOwner: true,
    preserveGate: parsed.flags.gate === undefined,
    ...(parsed.flags.gate !== undefined ? { gate: parsed.flags.gate } : {}),
    preservePre: parsed.flags.pre === undefined,
    ...(parsed.flags.pre !== undefined ? { pre: parsed.flags.pre } : {}),
    ...(workThread ? { sessionOverride: workThread } : {}),
  });
  withLedger((ledger) => { ledger[lane]!.additionalDirectories = additionalDirectories; });
  if (selection) announceAccountSelection(lane, selection);
  if (parsed.flags.gate !== undefined) printGateChange(lane, before.gate, parsed.flags.gate);
  const previousRound = partial ? `\n\nYour previous round ended with this partial report at ${partialPath}; continue from it, do not redo completed work:\n${partial}` : "";
  const injectedRules = houseRules(cwd, reviewResume, engine, { supervisor: Boolean(before.supervisor) });
  const prompt = resumePrompt(followUp, injectedRules, conversationRules(lane, before.rounds, sessionId, engine, reviewResume), previousRound.trim());
  // The resolved effort always travels with the turn: a resumed session would
  // otherwise keep the effort it was created with, cap or no cap.
  const codexArgs = reviewResume && engine === "gpt"
    ? ["exec", "resume", ...CODEX_DISABLE_NATIVE_SUBAGENTS, "-c", `model_reasoning_effort=${effort}`, "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"', "--skip-git-repo-check", sessionId!, prompt]
    : undefined;
  return launch({
    effort, engine, model: engine === "gpt" ? laneModel(before) : undefined, mode: "resume", lane, round, cwd, prompt, injectedRules,
    ...(before.supervisor ? { supervisor: true as const } : {}),
    ...(codexArgs ? { codexArgs, reviewDir: cwd } : { sourceThreadId: sessionId }),
    ...(reviewResume && engine === "gemini" ? { reviewDir: cwd, outputSchema: REVIEW_FINDINGS_SCHEMA } : {}),
    ...(!reviewResume && effectiveGate ? { gate: effectiveGate } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...accountSpec(account), ...ownershipSpec(owner),
  }, prompt, parsed.bools.has("bg"));
}

export async function forkCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["effort", "bg", "account", "model"]);
  const [newLane, source, briefArg] = parsed.rest;
  const usage = 'usage: cdx fork <newLane> <fromLane|sessionId> [--bg] "<brief>"';
  const brief = await resolveBrief(briefArg, usage);
  if (!newLane || !source || !brief) fail(usage);
  validLane(newLane);
  const ledger = readLedger();
  const sourceLane = ledger[source];
  if (sourceLane && laneEngine(sourceLane) === "gemini") fail("gemini has no headless fork; use cdx resume");
  if (sourceLane && parsed.flags.model !== undefined) fail(`fork inherits the source lane's model (${laneModel(sourceLane)}); drop --model`);
  const model = sourceLane ? laneModel(sourceLane) : modelOf(parsed, "gpt")!;
  const parent = supervisorLane();
  checkChildAstraRefusal(Boolean(parent), "gpt", model);
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
  const additionalDirectories = storedDirectories(source, sourceLane);
  const effectiveGate = composeGate(repositoryGate(cwd), sourceLane?.gate);
  const { round, selection } = await openRound(newLane, "work", cwd, effort, { engine: "gpt", account, owner, model, gate: sourceLane?.gate, forcedAccount: sourceLane ? parsed.flags.account : account?.name });
  withLedger((ledger) => { ledger[newLane]!.additionalDirectories = additionalDirectories; });
  const prompt = `Ground rules:\n${houseRules(cwd, false)}\n\nTask:\n${brief}`;
  return launch({ effort, engine: "gpt", mode: "fork", ...(effectiveGate ? { gate: effectiveGate } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}), lane: newLane, round, cwd, prompt, ...(sourceLane ? { sourceLane: source } : { model }), sourceThreadId: sessionId, ...accountSpec(account), ...ownershipSpec(owner) }, prompt, parsed.bools.has("bg"));
}

// consult: a read-only advisor lane. It runs as a read-only review, framed
// as an advisor rather than a hostile reviewer, and resumes read-only.
// A head consult may opt into --supervisor to spawn read-only Gemini helpers.
export async function consultCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["engine", "model", "effort", "cd", "bg", "account", "supervisor"]);
  const [lane, questionArg] = parsed.rest;
  const usage = 'usage: cdx consult <lane> [--engine gpt|gemini] [--supervisor] [--model M] [--effort E] [--cd <dir>] [--bg] "<question>"';
  const question = await resolveBrief(questionArg, usage);
  if (!lane || !question) fail(usage);
  const parent = supervisorLane();
  const parentEntry = parent ? readLedger()[parent] : undefined;
  if (parentEntry?.consult && parsed.flags.engine && parsed.flags.engine !== "gemini") {
    fail("consult supervisor may only spawn read-only gemini helpers; gpt helpers are refused");
  }
  const engine = parsed.flags.engine ?? (parentEntry?.consult ? "gemini" : "gpt");
  const forwardArgv = argv.filter((arg) => arg !== questionArg);
  return reviewCommand(["--engine", engine, ...forwardArgv, "--", question], { consult: true, supervisor: parsed.bools.has("supervisor") });
}

export async function reviewCommand(argv: string[], opts: { consult?: boolean; supervisor?: boolean } = {}) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "bg", "uncommitted", "base", "commit", "scope", "account", "model", "supervisor"]);
  const engine = engineOf(parsed, "review");
  const [lane, intentArg] = parsed.rest;
  const usage = 'usage: cdx review <lane> [--uncommitted | --base <branch> | --commit <sha>] [--scope "<files>"] ["<intent>"]';
  const intent = await resolveBrief(intentArg, usage);
  if (!lane) fail(usage);
  validLane(lane);
  const parent = supervisorLane();
  if (parent) {
    const parentEntry = readLedger()[parent];
    if (parentEntry?.consult) {
      if (engine !== "gemini") {
        fail("consult supervisor may only spawn read-only gemini helpers; gpt helpers are refused");
      }
      if (!opts.consult) {
        fail("consult supervisor may only spawn read-only gemini helpers; reviews are refused");
      }
    }
  }
  const supervisor = opts.supervisor ?? parsed.bools.has("supervisor");
  if (supervisor && parent) {
    fail(`supervisor ${parent} cannot spawn another supervisor; delegation is one level deep`);
  }
  requireEngineBinary(engine);
  requireGeminiQuota(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  const existing = readLedger()[lane];
  requireOwnChild(lane, existing);
  if (existing && laneEngine(existing) === "gpt" && parsed.flags.model !== undefined) fail(`review of an existing lane uses its model (${laneModel(existing)}); drop --model`);
  // A consult lane must never acquire a work thread: resume would then pick
  // the writable session over the read-only one. Fresh names only.
  if (opts.consult && existing && !existing.consult) fail(`lane "${lane}" has work history; consult needs a fresh name so its resume stays read-only`);
  const model = engine === "gpt" ? existing && laneEngine(existing) === "gpt" ? laneModel(existing) : modelOf(parsed, "gpt")! : undefined;
  checkChildAstraRefusal(Boolean(parent || existing?.parent), engine, model);
  const roundModel = model && (!existing || parsed.flags.model !== undefined || !existing.model) ? { model } : {};
  const roundParent = !existing ? { lineage: callerLineage(supervisor) } : {};
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
      const fullBrief = [reviewFrame(engine), `Ground rules:\n${houseRules(cwd, true, engine, { supervisor })}`, `Task:\n${task}`].join("\n\n");
      const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundParent });
      return launch({ effort, engine, model, mode: "review-native", lane, round, cwd, reviewDir: cwd, prompt: fullBrief, ...(supervisor ? { supervisor: true as const } : {}), outputSchema: REVIEW_FINDINGS_SCHEMA, ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
    }
    // Native `codex review`: purpose-built diff review. It rejects a custom
    // prompt alongside a target, so the adversarial frame stays home.
    const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundModel, ...roundParent });
    if (selection) announceAccountSelection(lane, selection);
    const codexArgs = [
      "review", ...CODEX_DISABLE_NATIVE_SUBAGENTS, "-c", `review_model=${JSON.stringify(model)}`, "-c", `model_reasoning_effort=${effort}`,
      "-c", 'sandbox_mode="danger-full-access"', "-c", 'approval_policy="never"',
    ];
    if (parsed.bools.has("uncommitted")) codexArgs.push("--uncommitted");
    if (parsed.flags.base) codexArgs.push("--base", parsed.flags.base);
    if (parsed.flags.commit) codexArgs.push("--commit", parsed.flags.commit);
    const label = parsed.bools.has("uncommitted") ? "uncommitted changes" : parsed.flags.base ? `diff vs ${parsed.flags.base}` : `commit ${parsed.flags.commit}`;
    return launch({ effort, engine, model, mode: "review-native", lane, round, cwd, reviewDir: cwd, prompt: `native review of ${label}`, codexArgs, ...(supervisor ? { supervisor: true as const } : {}), ...accountSpec(account), ...ownershipSpec(owner) }, `native review of ${label}`, parsed.bools.has("bg"));
  }

  const owner = callerOwnership();
  const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundModel, ...roundParent, ...(opts.consult ? { consult: true as const } : {}) });
  if (selection) announceAccountSelection(lane, selection);
  const scope = parsed.flags.scope
    ? `\nScope: review EXACTLY these files, ignore all other dirty files (other lanes own them): ${parsed.flags.scope}`
    : "";
  const frame = opts.consult ? CONSULT_FRAME : reviewFrame(engine) + scope;
  const fullBrief = [frame, `Ground rules:\n${houseRules(cwd, true, engine, { supervisor })}`, `Task:\n${intent}`].join("\n\n");
  // Reviews and consults run with full access (owner ruling 2026-09-21). A
  // review still fails when the tree moves; a consult has no tree check.
  const codexArgs = engine === "gpt" ? [
    "exec", ...CODEX_DISABLE_NATIVE_SUBAGENTS, "--json", "-m", model!, "-c", `model_reasoning_effort=${effort}`,
    "-s", "danger-full-access", "-c", 'approval_policy="never"', "--skip-git-repo-check", "--cd", cwd,
    "--output-last-message", reportPathOf(lane, round), fullBrief,
  ] : undefined;
  return launch({ effort, engine, model, mode: "spawn", lane, round, cwd, reviewDir: cwd, prompt: fullBrief, ...(supervisor ? { supervisor: true as const } : {}), ...(engine === "gemini" && !opts.consult ? { outputSchema: REVIEW_FINDINGS_SCHEMA } : {}), ...(codexArgs ? { codexArgs } : {}), ...(engine === "gpt" ? accountSpec(account) : {}), ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
}

export function cleanCommand(argv: string[]) {
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
          if (pattern.test(file)) rmSync(`${ROOT}/${dir}/${file}`, { force: true, recursive: true });
        }
      }
      delete ledger[lane];
      removed.push(lane);
    }
    withEvents((state) => {
      for (const lane of removed) delete state.lanes[lane];
      const records = readEvents();
      state.sequence = Math.max(state.sequence, records.at(-1)?.id ?? 0);
      const keep = records.filter((record, index) => {
        if (record.lane && removed.includes(record.lane)) return false;
        if (index >= records.length - 2000) return true;
        const session = state.sessions[recipientOf(record.recipient ?? record.owner, record.lane, state)];
        return session && record.id > session.cursor;
      });
      const temporary = `${ROOT}/feed.log.tmp.${process.pid}`;
      writeFileSync(temporary, keep.map((record) => JSON.stringify(record) + "\n").join(""));
      renameSync(temporary, `${ROOT}/feed.log`);
    });
  });
  console.log(removed.length > 0 ? `cdx: pruned closed lanes older than ${days}d: ${removed.join(", ")}` : `cdx: nothing to prune (closed lanes older than ${days}d)`);
}
