import { reviewerForTree } from "./prompts.ts";
// Round admission and ledger reservation.

import {
  accountChoices, type AccountSelection, accountStandings, cachedAccountStandings, chooseAccount, laneAccount,
  reconcileAccountHolds, requireAccountModel,
} from "./accounts.ts";
import { checkChildAstraRefusal, resolveCodexModel } from "./config.ts";
import { geminiAdmission, readGeminiUsageSnapshot, geminiQuotaState } from "./gemini-usage.ts";
import { hookInstallState } from "./doctor.ts";
import {
  type GateTree, type AccountChoice, type Demand, type Effort, type Engine, hasWorkThread, laneEngine, type LaneOwner,
  laneRunning, type Lane, type Lineage, readLedger, requireOwnChild, supervisorLane, withLedger, workCwdOf, workStateOf,
} from "./ledger.ts";
import { CmdError, pidAlive } from "./runtime.ts";
import { readUsageSnapshot } from "./usage-store.ts";
import { type WorktreeInfo } from "./worktrees.ts";

// Round lifecycle: open a round in the ledger, write its spec, run or detach.

// The Codex model this round runs: a review runs its own model beside the
// work thread's.
function roundModelOf(kind: "work" | "review", opts: { model?: string; reviewModel?: string } | undefined, existing: Pick<Lane, "model"> | undefined): string | undefined {
  return (kind === "review" ? opts?.reviewModel : undefined) ?? opts?.model ?? existing?.model;
}

export async function openRound(lane: string, kind: "work" | "review", cwd: string, effort: Effort, opts?: { reviewTree?: GateTree; engine?: Engine; preserveEngine?: boolean; requireSession?: boolean; sessionOverride?: string; account?: AccountChoice; preserveAccount?: boolean; owner?: LaneOwner; preserveOwner?: boolean; worktree?: WorktreeInfo; gate?: string; preserveGate?: boolean; pre?: string; preservePre?: boolean; model?: string; reviewModel?: string; lineage?: Lineage; consult?: true; forcedAccount?: string; excludedHomes?: Set<string> }): Promise<{ round: number; sessionId?: string; selection?: AccountSelection }> {
  const engine = opts?.engine ?? "gpt";
  const existingBefore = readLedger()[lane];
  const isChildPre = Boolean(opts?.lineage?.parent ?? existingBefore?.parent ?? supervisorLane());
  const roundEnginePre = opts?.preserveEngine || (kind === "review" && existingBefore && hasWorkThread(existingBefore))
    ? laneEngine(existingBefore)
    : opts?.engine ?? (existingBefore ? laneEngine(existingBefore) : engine);
  const resolvedModelCandidate = roundEnginePre === "gpt" ? roundModelOf(kind, opts, existingBefore) : undefined;
  checkChildAstraRefusal(isChildPre, roundEnginePre, resolvedModelCandidate);

  for (;;) {
    if (engine === "gpt") {
      withLedger(reconcileAccountHolds);
      await accountStandings();
    }
    const now = new Date().toISOString();
    const opened = withLedger((ledger) => {
      reconcileAccountHolds(ledger);
      // A completion can invalidate evidence while the outside-lock probes run.
      // Commit reconciliation, then refresh before making an admission decision.
      if (engine === "gpt" && accountChoices().some((choice) => readUsageSnapshot(choice)?.invalidatedAt)) return undefined;
      const existing = ledger[lane];
      if (process.argv[2] !== "_run") requireOwnChild(lane, existing);
      if (existing && laneRunning(existing) && (pidAlive(existing.pid) || pidAlive(existing.codexPid))
        && !((existing.switchingAccount || existing.outageFallbackPending) && existing.pid === process.pid)) {
        throw new CmdError(`lane "${lane}" is already running (pid ${existing.pid}); pick a new name or wait`);
      }
      if (opts?.requireSession && !opts.sessionOverride && !existing?.sessionId) throw new CmdError(`lane "${lane}" has no session id; use cdx adopt or spawn`);
      if (opts?.reviewTree) {
        const duplicate = reviewerForTree(ledger, opts.reviewTree);
        if (duplicate) throw new CmdError(`SHA ${opts.reviewTree.tree} already has reviewer ${duplicate}; reuse its report`);
      }
      const rounds = (existing?.rounds ?? 0) + 1;
      const existingWorkRounds = existing?.workRounds ?? existing?.rounds ?? 0;
      const workRounds = kind === "work" ? existingWorkRounds + 1 : existingWorkRounds;
      const preferred = opts?.account ?? (opts?.preserveAccount ? existing && laneAccount(existing) : undefined);
      const demand: Demand = kind === "review" || (opts?.consult ?? existing?.consult) ? "light" : (opts?.lineage?.supervisor ?? existing?.supervisor) ? "supervisor" : "work";
      const selection = engine === "gpt" ? chooseAccount(cachedAccountStandings(ledger).map((standing) => opts?.excludedHomes?.has(standing.choice.home) ? { ...standing, reached: true, reason: `already exhausted in this run; ${standing.reason}` } : standing), demand, opts?.forcedAccount, preferred) : undefined;
      const activeAccount = selection?.choice;
      if (engine === "gpt" && activeAccount) {
        const model = resolveCodexModel(roundModelOf(kind, opts, existing));
        const models = readUsageSnapshot(activeAccount)?.models;
        requireAccountModel(model, activeAccount.name, models);
      }
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
      const isChildCommitted = Boolean(opts?.lineage?.parent ?? existing?.parent ?? supervisorLane());
      const roundModelCommitted = roundEngineType === "gpt" ? roundModelOf(kind, opts, existing) : undefined;
      checkChildAstraRefusal(isChildCommitted, roundEngineType, roundModelCommitted);
      const queuedUntil = engine === "gemini" ? geminiQuotaState().block?.resetsAt ?? geminiAdmission(readGeminiUsageSnapshot(), ledger, Date.now(), lane).queuedUntil : undefined;
      ledger[lane] = {
        ...(existing ?? {}),
        queuedUntil, modelCalls: 0, callLimitHit: false, quotaWrapSent: false,
        accountPercentStart: undefined, accountPercentEnd: undefined, agentLoaded: undefined,
        // The work engine belongs to the work thread. A review round on an
        // existing lane records its own engine beside it, so a later resume
        // still reattaches to the right runtime.
        engine: roundEngineType,
        reviewEngine: kind === "review" ? opts?.engine ?? (existing ? laneEngine(existing) : engine) : existing?.reviewEngine,
        model: roundEngineType === "gpt" ? opts?.model ?? existing?.model : existing?.model,
        reviewModel: kind === "review" ? opts?.reviewModel : existing?.reviewModel,
        // A spawn sets lineage explicitly (a respawn without --supervisor is
        // a plain lane again); every other round keeps what the lane had.
        supervisor: opts?.lineage ? (opts.lineage.supervisor ? true : undefined) : existing?.supervisor,
        parent: opts?.lineage ? opts.lineage.parent : existing?.parent,
        parentRound: opts?.lineage ? opts.lineage.parentRound : existing?.parentRound,
        consult: opts?.consult ?? existing?.consult,
        ...(opts?.worktree ? { worktreePath: opts.worktree.path, worktreeRepo: opts.worktree.repo, branch: opts.worktree.branch, baseBranch: opts.worktree.baseBranch } : {}),
        account,
        codexHome,
        roundAccount: activeAccount ? { ...activeAccount, demand } : undefined,
        codexPid: undefined,
        ownerSession,
        ownerCwd,
        sessionId: opts?.sessionOverride ?? (opts?.requireSession ? existing?.sessionId : undefined),
        transcriptPath: undefined,
        reviewTree: opts?.reviewTree ?? existing?.reviewTree,
        reviewClosed: kind === "review" ? undefined : existing?.reviewClosed,
        // Fix, review and continuation rounds work on the same diff, so the
        // gate receipt must still cover files earlier rounds touched.
        touchedPaths: opts?.preserveGate ? existing?.touchedPaths ?? [] : [],
        workSessionId: kind === "review"
          ? existing?.workSessionId ?? (existing?.kind === "work" ? existing.sessionId : undefined)
          : existing?.workSessionId,
        gateReceipt: kind === "work" ? undefined : existing?.gateReceipt,
        gate: opts?.preserveGate ? existing?.gate : opts?.gate,
        pre: opts?.preservePre ? existing?.pre : opts?.pre,
        effort,
        work: kind === "work"
          ? { state: workState, round: rounds, cwd: workCwd, startedAt: now, updatedAt: now, testRuns: 0, testSuites: 0, codegraphCalls: 0, codeSearchesBeforeGraph: 0 }
          : existing?.work ?? { state: workState, cwd: workCwd, startedAt: now },
        review: kind === "review" ? { state: "running", cwd, round: rounds, startedAt: now, updatedAt: now, testRuns: 0, testSuites: 0, codegraphCalls: 0, codeSearchesBeforeGraph: 0 } : existing?.review,
        roundStartedAt: now,
        // Reserve the lane with the parent's pid so a concurrent launch is
        // rejected before the runner records its own pid.
        pid: process.pid,
        kind,
        rounds,
        workRounds,
        reports: existing?.reports ?? [],
        tokens: existing?.tokens,
        roundTokens: undefined,
        roundSteps: 0, roundTestRuns: 0, roundTestSuites: 0, roundTestStatus: undefined, roundCodegraphCalls: 0, roundCodeSearchesBeforeGraph: 0, overrunSent: false,
        stage: "working", stageStartedAt: now, lastActionAt: undefined,
        steers: 0,
        steerOpen: true,
        continuations: 0,
        ...(hooksActive ? { hooksActive: true } : {}),
        quotaFailure: undefined,
        switchingAccount: undefined,
        outageFallbackPending: undefined,
        fallbackModel: undefined,
        outage: undefined,
        agyRetries: 0,
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
