import { fixReviewPrompt } from "./prompts.ts";
import { briefContractRefusal, isNoOpGate, SCOPE_POLICIES, type ScopePolicy, scopeRule } from "./brief-contract.ts";
import { retiredLaneRule } from "./account-sync.ts";
import { requireGeminiAgent } from "./doctor.ts";
import { safeText, safeJSON } from "./safe-text.ts";
// Lane launch, spawn, resume, review, consult, and cleanup commands.

import {
  accountSpec, announceAccountSelection, defaultCodexHome, laneAccount, rejectPinnedAccountFlag, warnCachedUsageBeforeLaunch,
} from "./accounts.ts";
import {
  checkChildAstraRefusal, checkRoundCap, config, defaultMaxRuntime, ENGINE_PICKER, engineOf, geminiConfig,
  laneModel, maxRuntimeOf, modelOf, rejectEngineMismatch, requireEngineBinary, resolveEffort,
} from "./config.ts";
import {
  freshAccountSpec, geminiCapacityNotice, recoveryPrompt,
} from "./engines.ts";
import { captureGateTree, composeGate, printGateChange, repositoryGate, runPreCheck } from "./gates.ts";
import { formatGeminiStanding, readGeminiUsageSnapshot, requireGeminiQuota } from "./gemini-usage.ts";
import {
  activeStateOf, callerLineage, callerOwnership, dropLane, type GateTree, laneEngine, laneRunning,
  ownershipSpec, readLane, readLedger, requireOwnChild, spawnRoots, type Spec,
  storedOwnership, supervisorLane, validLane, withLedger, workCwdOf,
} from "./ledger.ts";
import {
  resumeRefusal, CODEGRAPH_RULE, CONSULT_FRAME, laneInstructions, conversationRules, houseRules, pendingTestsRefusal, promptRules, resumePrompt,
  REVIEW_FINDINGS_SCHEMA, reviewFrame,
} from "./prompts.ts";
import { logPathOf, partialReportPathOf, reportPathOf, specPathOf } from "./reports.ts";
import { failActiveRound } from "./round-state.ts";
import { db, write } from "./store.ts";
import { expectMinutes, historyMinutes } from "./duration.ts";
import { openRound } from "./rounds.ts";
import { chooseSpawnModel } from "./repo-routing.ts";
import { runRound } from "./runner.ts";
import {
  color, fail, fmtAge, uncoloredChildEnv, parseArgs, pidAlive, resolveBrief, ROOT, runnerEnv, SELF,
  settleHint,
} from "./runtime.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import { childWorktreeTarget, createWorktree, mergeDirectories, storedDirectories, type WorktreeInfo } from "./worktrees.ts";
import { geminiProfile } from "./sandbox.ts";
import { spawn as nodeSpawn } from "node:child_process";
import {
  existsSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";

function gitCommonDir(cwd: string): string | undefined {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"] });
  if (!result.success) return undefined;
  const path = result.stdout.toString().trim();
  return path && existsSync(path) ? realpathSync(path) : undefined;
}

function launch(spec: Spec, brief: string, background: boolean): Promise<never> | never {
  spec.accountHomes = config.accounts;
  spec.model_auto_compact_token_limit = config.model_auto_compact_token_limit ?? 150_000;
  spec.tool_output_token_limit = config.tool_output_token_limit ?? 6_000;
  spec.visibility = config.visibility ?? VISIBILITY_DEFAULTS;
  spec.taskPrompt ??= spec.prompt;
  spec.injectedRules ??= promptRules(spec.prompt);
  const project = `${spec.cwd}/.cdx-rules.md`;
  const projectRules = existsSync(project) ? readFileSync(project, "utf8").trim() : "";
  const configured = config.rules.filter((rule) => !retiredLaneRule(rule)).map((rule) => `- ${rule}`).join("\n");
  const rules = spec.injectedRules && spec.prompt.includes(spec.injectedRules) ? spec.injectedRules : "";
  const projectBytes = projectRules && rules.includes(projectRules) ? Buffer.byteLength(projectRules) : 0;
  const configuredBytes = configured && rules.includes(configured) ? Buffer.byteLength(configured) : 0;
  spec.promptBytes = { taskAndFraming: Buffer.byteLength(spec.prompt) - Buffer.byteLength(rules),
    repositoryRules: projectBytes, configRules: configuredBytes,
    laneRules: Math.max(0, Buffer.byteLength(rules) - projectBytes - configuredBytes) };
  const entry = readLane(spec.lane);
  const history = Object.entries(readLedger()).filter(([name, lane]) => name !== spec.lane && lane.kind === entry.kind
    && Boolean(lane.consult) === Boolean(entry.consult)
    && (entry.kind === "review" || Boolean(lane.supervisor) === Boolean(entry.supervisor)))
    .map(([, lane]) => entry.kind === "review" ? lane.review : lane.work)
    .filter((record) => record && record.state !== "running" && record.updatedAt)
    .map((record) => ({ startedAt: record!.startedAt, finishedAt: record!.updatedAt }));
  spec.expectMinutes ??= historyMinutes(history, config.expectMinutes ?? 15);
  withLedger((ledger) => {
    const current = ledger[spec.lane];
    if (!current || current.rounds !== spec.round) return;
    current.expectMinutes = spec.expectMinutes;
    const record = current.kind === "review" ? current.review : current.work;
    if (record) record.expectMinutes = spec.expectMinutes;
  });
  spec.queuedUntil = entry.queuedUntil;
  if (spec.engine === "gpt") {
    const choice = entry.roundAccount;
    const changedHome = (spec.codexHome ?? defaultCodexHome()) !== (choice?.home ?? defaultCodexHome());
    spec.account = choice?.name;
    spec.codexHome = choice?.home;
    spec.model ??= entry.model ?? config.model;
    Object.assign(spec, accountSpec(choice));
    spec.laneInstructions = laneInstructions({ review: spec.reviewDir !== undefined, supervisor: Boolean(spec.supervisor) });
    if (changedHome && (spec.sourceThreadId || spec.mode === "resume")) {
      freshAccountSpec(spec, entry, recoveryPrompt(spec, entry));
      brief = spec.prompt;
    }
  }
  if (spec.engine === "gemini") {
    const policy = config.gemini ?? geminiConfig();
    spec.model ??= policy.model;
    spec.agent ??= readLedger()[spec.lane]?.kind === "review" ? policy.reviewAgent : policy.agent;
  }
  spec.startedAt ??= entry.roundStartedAt ?? new Date().toISOString();
  writeFileSync(specPathOf(spec.lane, spec.round), safeJSON(spec, 2));
  writeFileSync(`${ROOT}/briefs/${spec.lane}-r${spec.round}.md`, safeText(brief));
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
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "worktree", "bg", "add-dir", "image", "schema", "account", "gate", "max-runtime", "expect", "model", "supervisor", "pre", "scope-policy"]);
  const expected = parsed.flags.expect === undefined ? undefined : expectMinutes(parsed.flags.expect, config.expectMinutes ?? 15);
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
  const scopePolicy = (parsed.flags["scope-policy"] ?? "extend") as ScopePolicy;
  if (!SCOPE_POLICIES.includes(scopePolicy)) fail(`--scope-policy must be one of ${SCOPE_POLICIES.join(", ")}`);
  // Cheap pre-check so a doomed launch is rejected before paying for usage
  // probes; openRound re-checks under the ledger lock.
  const existingLane = readLedger()[lane];
  if (existingLane && laneRunning(existingLane) && pidAlive(existingLane.pid)) {
    fail(`lane "${lane}" is already running (pid ${existingLane.pid}); pick a new name or wait`);
  }
  requireEngineBinary(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gemini") requireGeminiAgent((config.gemini ?? geminiConfig()).agent, parsed.flags.cd ?? process.cwd());
  if (engine === "gemini" && (parsed.lists.image?.length ?? 0) > 0) fail("--image is not supported for gemini");
  const roots = spawnRoots(parsed.flags.cd, existingLane, process.cwd(), existsSync);
  let cwd = roots.cwd;
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  // A respawn keeps the stored gate and cwd unless the caller passes new ones.
  const gate = parsed.flags.gate ?? existingLane?.gate;
  const requiredGate = repositoryGate(cwd);
  if (gate && requiredGate && isNoOpGate(gate)) fail(`--gate "${gate}" checks nothing and this repository has .cdx-gate; drop --gate to run the repository gate, or pass a real check`);
  const contractRefusal = briefContractRefusal(brief, Boolean(gate || requiredGate), supervisor);
  if (contractRefusal) fail(contractRefusal);
  if (engine === "gemini") console.error("cdx: routing reserves Gemini for read-only work (consults, reviews, pre-reads); this work lane runs anyway");
  // A respawn without --model keeps the stored model. Fresh head work may
  // instead use the repository route for the actual working directory.
  const retained = Boolean(existingLane && engine === "gpt" && parsed.flags.model === undefined);
  const baseModel = retained ? laneModel(existingLane) : modelOf(parsed, engine, supervisor ? "think" : "work", Boolean(parent));
  const choice = chooseSpawnModel(baseModel, {
    engine, cwd, routing: config.repoRouting, commonDir: () => gitCommonDir(cwd),
    explicit: parsed.flags.model !== undefined, retained, thinking: supervisor,
    child: Boolean(parent || existingLane?.parent),
  });
  const model = choice.model;
  checkChildAstraRefusal(Boolean(parent || existingLane?.parent), engine, model);
  const effort = resolveEffort(engine, model, parsed.flags.effort);
  const maxRuntime = maxRuntimeOf(parsed) ?? defaultMaxRuntime(engine);
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
  const effectiveGate = composeGate(parent ? undefined : requiredGate, gate);
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
  const worktreeTarget = childWorktreeTarget(lane, parsed.flags.worktree, parent, Boolean(existingLane), supervisor);
  if (worktreeTarget) {
    try {
      worktree = createWorktree(roots.worktreeRepo, worktreeTarget, lane);
      cwd = worktree.path;
      withLedger((ledger) => {
        const item = ledger[lane]!;
        item.work.cwd = cwd;
        Object.assign(item, { worktreePath: worktree!.path, worktreeRepo: worktree!.repo, branch: worktree!.branch, baseBranch: worktree!.baseBranch });
      });
    } catch (error) {
      withLedger((ledger) => failActiveRound(lane, ledger[lane]!, `worktree setup failed: ${error}`));
      throw error;
    }
  }
  if (selection) announceAccountSelection(lane, selection);
  console.log(`cdx: model selection ${engine === "gemini" ? (config.gemini ?? geminiConfig()).model : model} because ${choice.reason}`);
  const fullBrief = `Ground rules:\n${houseRules(cwd, false, engine, { supervisor })}\n- ${scopeRule(scopePolicy)}\n\nTask:\n${brief}`;
  withLedger((ledger) => { Object.assign(ledger[lane]!, { additionalDirectories, scopePolicy }); });
  return launch({
    effort, engine, mode: "spawn", lane, round, cwd, prompt: fullBrief, model: engine === "gemini" ? (config.gemini ?? geminiConfig()).model : model,
    ...(supervisor ? { supervisor: true as const } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    ...(images.length ? { images } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(effectiveGate ? { gate: effectiveGate } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...(expected !== undefined ? { expectMinutes: expected } : {}),
    ...accountSpec(account), ...ownershipSpec(owner),
  }, fullBrief, parsed.bools.has("bg"));
}

export async function resumeCommand(argv: string[]) {
  // --fix is a switch for doctor, so parseArgs would drop the word after it;
  // resume takes that word (gate or review) out before parsing.
  const fixAt = argv.indexOf("--fix");
  const fix = fixAt < 0 ? undefined : argv[fixAt + 1];
  const parsed = parseArgs(fixAt < 0 ? argv : argv.toSpliced(fixAt, 2), ["effort", "gate", "bg", "max-runtime", "expect", "account", "pre", "add-dir"]);
  const expected = parsed.flags.expect === undefined ? undefined : expectMinutes(parsed.flags.expect, config.expectMinutes ?? 15);
  const [lane, followUpArg] = parsed.rest;
  const usage = 'usage: cdx resume <lane> --fix gate|review [--effort <effort>] [--bg] "<fix instructions>"';
  const followUp = await resolveBrief(followUpArg, usage);
  if (!lane || !followUp) fail(usage);
  const before = readLane(lane);
  const head = Bun.spawnSync({ cmd: ["git", "-C", workCwdOf(before), "rev-parse", "HEAD"] }).stdout.toString().trim();
  const fixRefusal = resumeRefusal(fix, before, head);
  if (fixRefusal) fail(fixRefusal);
  if (parsed.flags.gate !== undefined && parsed.flags.gate !== before.gate || parsed.lists["add-dir"]?.length || parsed.flags.pre !== undefined && parsed.flags.pre !== before.pre) fail("A fix resume cannot change the gate, setup, or directories; spawn a fresh lane seeded from the report");
  requireOwnChild(lane, before);
  const parent = supervisorLane();
  if (parent && parsed.flags.gate !== undefined && parsed.flags.gate !== before.gate) {
    fail(`supervisor ${parent} may not change a child's gate; ask the liaison if it is wrong`);
  }
  const engine = laneEngine(before);
  if (engine === "gemini") requireGeminiAgent((config.gemini ?? geminiConfig()).agent, workCwdOf(before));
  checkChildAstraRefusal(Boolean(parent || before.parent), engine, before.model);
  const maxRuntime = maxRuntimeOf(parsed) ?? defaultMaxRuntime(engine);
  requireEngineBinary(engine);
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gpt") rejectPinnedAccountFlag(lane, before, parsed.flags.account);
  if (parsed.flags.gate !== undefined && parsed.flags.gate.trim() === "") fail("--gate needs a nonempty command");
  if (parsed.flags.pre !== undefined && parsed.flags.pre.trim() === "") fail("--pre needs a nonempty command");
  const workRounds = before.workRounds ?? before.rounds;
  checkRoundCap(lane, engine, workRounds);
  const owner = storedOwnership(before);
  const effort = resolveEffort(engine, laneModel(before), parsed.flags.effort, before.effort);
  // Fixes always target the work conversation, never the reviewer.
  const workThread = before.workSessionId ?? (before.kind === "work" ? before.sessionId : undefined);
  if (!workThread) fail("No work conversation to repair; spawn a fresh lane seeded from the report");
  const account = engine === "gpt" ? laneAccount(before) : undefined;
  if (engine === "gpt") warnCachedUsageBeforeLaunch(account);
  const cwd = workCwdOf(before);
  const additionalDirectories = storedDirectories(lane, before);
  const effectiveGate = composeGate(before.parent ? undefined : repositoryGate(cwd), parsed.flags.gate ?? before.gate);
  const pre = parsed.flags.pre ?? before.pre;
  const partialPath = partialReportPathOf(lane, before.rounds);
  const partial = activeStateOf(before) === "failed" && existsSync(partialPath) ? readFileSync(partialPath, "utf8").trim() : "";
  const refusal = pendingTestsRefusal(partial, followUp);
  if (refusal) {
    const status = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--short"] });
    fail(`${refusal}\nPartial: ${partialPath}\nChanged paths now:\n${status.success ? status.stdout.toString().trim() || "None." : "Unavailable."}\nLast action: ${before.lastAction ?? "unknown"}`);
  }
  if (pre) runPreCheck(pre, cwd);
  const { round, sessionId, selection } = await openRound(lane, "work", cwd, effort, {
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
  const injectedRules = `${houseRules(cwd, false, engine, { supervisor: Boolean(before.supervisor) })}${before.scopePolicy ? `\n- ${scopeRule(before.scopePolicy)}` : ""}`;
  const prompt = resumePrompt(followUp, injectedRules, conversationRules(lane, before.rounds, sessionId, engine, false), previousRound.trim());
  return launch({
    effort, engine, model: engine === "gpt" ? laneModel(before) : undefined, mode: "resume", lane, round, cwd, prompt, injectedRules,
    ...(before.supervisor ? { supervisor: true as const } : {}),
    sourceThreadId: sessionId,
    ...(effectiveGate ? { gate: effectiveGate } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    ...(maxRuntime ? { maxRuntimeMins: maxRuntime } : {}),
    ...(expected !== undefined ? { expectMinutes: expected } : {}),
    ...accountSpec(account), ...ownershipSpec(owner),
  }, prompt, parsed.bools.has("bg"));
}

// consult: a read-only advisor lane. It runs as a read-only review, framed
// as an advisor rather than a hostile reviewer. Further questions use a fresh consult.
// A head consult may opt into --supervisor to spawn read-only Gemini helpers.
export async function consultCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["engine", "model", "effort", "cd", "bg", "account", "supervisor", "image"]);
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

export function reviewBaseTarget(cwd: string, base: string, run = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
  if (!result.success) fail(`cannot resolve review base: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}): string {
  const commit = run(cwd, "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`);
  return `Review git diff ${commit}...HEAD.`;
}

export async function reviewCommand(argv: string[], opts: { consult?: boolean; supervisor?: boolean } = {}) {
  const parsed = parseArgs(argv, ["engine", "effort", "cd", "bg", "uncommitted", "base", "commit", "scope", "account", "model", "supervisor", "image"]);
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
  if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
  if (engine === "gemini") requireGeminiAgent((config.gemini ?? geminiConfig()).reviewAgent, parsed.flags.cd ?? process.cwd());
  const existing = readLedger()[lane];
  requireOwnChild(lane, existing);
  // A consult lane must never acquire a work thread: resume would then pick
  // the writable session over the read-only one. Fresh names only.
  if (opts.consult && existing && !existing.consult) fail(`lane "${lane}" has work history; consult needs a fresh name so its resume stays read-only`);
  // Reviews and consults think: they default to the thinker model whatever
  // model wrote the work. The round records it as reviewModel, so the work
  // thread keeps its own model; a lane without one adopts it as its model.
  const model = engine === "gpt" ? modelOf(parsed, "gpt", "think", Boolean(parent || existing?.parent))! : undefined;
  checkChildAstraRefusal(Boolean(parent || existing?.parent), engine, model);
  const roundModel = model ? { reviewModel: model, ...(!existing?.model ? { model } : {}) } : {};
  const roundParent = !existing ? { lineage: callerLineage(supervisor) } : {};
  if (existing && laneEngine(existing) === "gemini" && engine === "gemini") {
    console.log(color.yellow("cdx: gemini reviewing a gemini lane; give the intent explicit attack items"));
  }
  const cwd = parsed.flags.cd ?? (existing ? workCwdOf(existing) : process.cwd());
  if (!existsSync(cwd)) fail(`cwd does not exist: ${cwd}`);
  if (engine !== "gpt" && parsed.lists.image) fail("--image needs --engine gpt; agy takes no image attachments");
  const images = (parsed.lists.image ?? []).map((image) => existsSync(image) ? realpathSync(image) : fail(`--image does not exist: ${image}`));
  const effort = resolveEffort(engine, model, parsed.flags.effort);
  const targets = [parsed.bools.has("uncommitted") ? "--uncommitted" : "", parsed.flags.base ? "base" : "", parsed.flags.commit ? "commit" : ""].filter(Boolean);
  if (targets.length > 1) fail("pick exactly one of --uncommitted, --base, --commit");
  if (targets.length === 1 && intent) fail("review targets (--uncommitted/--base/--commit) cannot carry a custom intent; drop it or drop the target flag");
  if (targets.length === 1 && parsed.flags.scope) fail("--scope requires an intent without a target flag");
  if (targets.length === 0 && !intent) fail("review needs an intent or a target flag");
  const preserveAccount = Boolean(existing && (laneEngine(existing) === "gpt" || existing.account || existing.codexHome));
  if (preserveAccount && engine === "gpt") rejectPinnedAccountFlag(lane, existing!, parsed.flags.account);
  const account = engine === "gpt" ? preserveAccount ? laneAccount(existing!) : undefined : undefined;
  if (engine === "gpt" && (preserveAccount || !config.accounts || parsed.flags.account)) warnCachedUsageBeforeLaunch(account);
  const roundAccount = { forcedAccount: parsed.flags.account, ...(engine === "gpt" && !preserveAccount ? { account } : existing ? { preserveAccount: true as const } : {}) };

  const target = parsed.bools.has("uncommitted") ? "Review git diff HEAD."
    : parsed.flags.base ? reviewBaseTarget(cwd, parsed.flags.base)
    : parsed.flags.commit ? `Review git show ${parsed.flags.commit}.` : intent;
  const reviewTree = !opts.consult ? captureGateTree(cwd) : undefined;
  if (!opts.consult && !reviewTree) fail("review requires a git tree snapshot");
  const previous = existing?.reviewTree;
  let prior = "";
  if (!opts.consult && existing?.review?.report && existsSync(existing.review.report)) prior = readFileSync(existing.review.report, "utf8");
  const fix = reviewFollowUp(prior, existing?.reviewClosed, previous, reviewTree);
  const scope = parsed.flags.scope ? `\nReview only these paths: ${parsed.flags.scope}` : "";
  const owner = callerOwnership();
  const fullBrief = [opts.consult ? CONSULT_FRAME : reviewFrame(engine) + scope,
    `Ground rules:\n${houseRules(cwd, true, engine, { supervisor })}`, `Task:\n${fix || target}`].join("\n\n");
  const { round, selection } = await openRound(lane, "review", cwd, effort, { engine, ...roundAccount, owner, preserveGate: true, ...roundModel, ...roundParent,
    ...(opts.consult ? { consult: true as const } : { reviewTree }) });
  if (selection) announceAccountSelection(lane, selection);
  return launch({ effort, engine, model, mode: "spawn", lane, round, cwd, reviewDir: cwd, prompt: fullBrief,
    ...(supervisor ? { supervisor: true as const } : {}), ...(!opts.consult ? { outputSchema: REVIEW_FINDINGS_SCHEMA, reviewTree } : {}),
    ...(images.length ? { images } : {}),
    ...(engine === "gpt" ? accountSpec(account) : {}), ...ownershipSpec(owner) }, fullBrief, parsed.bools.has("bg"));
}

// An open review's next round checks the fix diff against its findings. A
// closed review left nothing to check, so a changed tree gets a fresh review
// and the same tree reuses the report.
export function reviewFollowUp(prior: string, closed: boolean | undefined, previous: GateTree | undefined, current: GateTree | undefined): string {
  if (!prior || !previous || !current) return "";
  if (!closed) return fixReviewPrompt(previous, current, prior);
  if (previous.tree === current.tree) fail("the previous review found no P1/P2 findings on this tree; reuse its report");
  return "";
}

export function cleanCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["days"]);
  const days = Number(parsed.flags.days ?? 14);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  // Only archived lanes qualify, so a lane closed while its round still ran
  // stays. Events and sessions older than the cutoff go too: every cursor
  // that could still want them belongs to a session that stopped polling.
  const removed = write(() => {
    const lanes = db().query<{ name: string }, [string]>("SELECT name FROM archive WHERE updated_at <= ?").all(cutoff).map((row) => row.name);
    for (const lane of lanes) {
      dropLane(lane);
      db().query("DELETE FROM events WHERE lane = ?").run(lane);
      db().query("DELETE FROM questions WHERE lane = ?").run(lane);
    }
    db().query("DELETE FROM events WHERE at <= ?").run(cutoff);
    db().query("DELETE FROM sessions WHERE polled_at <= ?").run(cutoff);
    return lanes;
  });
  for (const lane of removed) {
    // Anchor on "-r<digits>" plus a separator so lane "foo" never matches
    // "foo-review-r1".
    const escaped = lane.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}-r\\d+(?:\\.|-)`);
    for (const dir of ["logs", "reports", "briefs", "specs", "control"]) {
      if (!existsSync(`${ROOT}/${dir}`)) continue;
      for (const file of readdirSync(`${ROOT}/${dir}`)) {
        if (pattern.test(file)) rmSync(`${ROOT}/${dir}/${file}`, { force: true, recursive: true });
      }
    }
  }
  console.log(removed.length > 0 ? `cdx: pruned closed lanes older than ${days}d: ${removed.join(", ")}` : `cdx: nothing to prune (closed lanes older than ${days}d)`);
}

export async function codeQuestionCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["cd"]);
  const question = await resolveBrief(parsed.rest.join(" "), "usage: cdx ask --cd <repo> <question>");
  if (!question || !parsed.flags.cd) fail("usage: cdx ask --cd <repo> <question>");
  const cwd = realpathSync(parsed.flags.cd);
  const policy = config.gemini ?? geminiConfig();
  requireGeminiQuota("gemini");
  requireGeminiAgent(policy.reviewAgent, cwd);
  // Keep this request read-only even when its shell tool tries to write.
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) fail("read-only ask requires macOS sandbox-exec");
  const proc = Bun.spawn({ cmd: ["sandbox-exec", "-p", geminiProfile({ cwd, reviewDir: cwd }), "agy", "--print", `Answer this code question with file:line evidence. Read only. ${CODEGRAPH_RULE}\n${question}`,
    "--model", policy.model, "--agent", policy.reviewAgent, "--output-format", "json", "--print-timeout", "90s", "--add-dir", cwd],
    cwd, env: uncoloredChildEnv(), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 90_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (exitCode) fail(safeText(stderr || `Gemini ask exited ${exitCode}`));
    const value = JSON.parse(stdout);
    const result = value.result && typeof value.result === "object" ? value.result : value;
    if (result.error || result.status && result.status !== "SUCCESS" || typeof result.response !== "string" || !result.response.trim()) fail("Gemini ask returned no successful answer");
    console.log(safeText(result.response));
  } finally { clearTimeout(timer); }
}
