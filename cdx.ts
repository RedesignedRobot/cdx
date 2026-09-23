#!/usr/bin/env bun
// CLI entrypoint and stable public imports. See docs/modules.md for module ownership.

import { format } from "node:util";
import { safeText } from "./safe-text.ts";
import { dispatch } from "./commands.ts";
import { CmdError, color, ROOT } from "./runtime.ts";
import { mkdirSync } from "node:fs";

export {
  requireAccountModel, reconcileExhaustionWithSnapshot, isExhaustionObsolete, standingOf, formatAccountUsage,
  describeResetCredits, resetCreditAlerts, rankAccounts, accountAdvice, chooseAccount, decideAccount,
  demandSizing, shouldRedeemCredit, withAccountHolds, adviceLines, RESET_CREDIT_ALERT_DAYS,
} from "./accounts.ts";
export {
  parseConfig, checkRoundCap, roundCapRefusal, geminiConfig, checkChildAstraRefusal, resolveCodexModel,
  cappedEffort,
} from "./config.ts";
export {
  roundTools, recordCodexTokenDelta, CODEX_DISABLE_NATIVE_SUBAGENTS, classifyGeminiError,
  shouldRetryGeminiTransport, qualifyGeminiResult, outageMinutes, GEMINI_OUTAGE_RETRIES, geminiCapacityNotice,
  parseAgyRetryLine, goDurationMs, GEMINI_PEAK_WINDOWS_RIYADH,
} from "./engines.ts";
export {
  verifyGate, finishGateReceipt, gateTreeFromGit, makeGateReceipt, gateAcceptanceFailed, receiptRefusal,
  composeGate, gateEnv, classifyGateFailure,
} from "./gates.ts";
export {
  geminiQuotaState, geminiWindows,
} from "./gemini-usage.ts";
export {
  jobCwd, summaryJobs,
} from "./jobs.ts";
export {
  WAKE_EVENTS, parseFeedEvent, recipientOf, owned, eventOwned, callerLineage, selectEvents, delivery,
  spawnRoots,
} from "./ledger.ts";
export {
  resumePrompt, promptRules, pendingTestsRefusal, sharedTreeLanes, VERIFICATION_RULE, GEMINI_WORKER_RULES,
} from "./prompts.ts";
export {
  controlText,
} from "./questions.ts";
export {
  writeCapturedReport, jobPhase, jobPhaseText, recoveryPartial, toolLogRecords, tailOutput,
} from "./reports.ts";
export {
  statusText, shellQuote, completionVerdict, parseArgs, fmtTokens, fmtTokensFull, resolveStdinText,
} from "./runtime.ts";
export {
  changedFileCount, laneProgress, porcelainFileCount, statusBrief, statusLine, geminiUsageRows, usageTable,
  outageText, usageLine,
} from "./status.ts";
export {
  parseAccountUsage, publishUsageSnapshot, projectWindow, mergeUsageHistory,
} from "./usage-store.ts";
export {
  storedDirectories, closeKeepsWorktree, worktreeCleanupCommands, removeWorktree, mergeDirectories,
  worktreeReuseRefusal, cleanupRefusal,
} from "./worktrees.ts";

if (import.meta.main) {
  for (const output of [process.stdout, process.stderr]) {
    const write: (...args: any[]) => boolean = output.write.bind(output);
    output.write = ((chunk: any, ...args: any[]) => write(typeof chunk === "string" ? safeText(chunk) : Buffer.from(safeText(Buffer.from(chunk).toString())), ...args)) as typeof output.write;
  }
  for (const method of ["log", "error", "warn"] as const) {
    const print = console[method].bind(console);
    console[method] = (...args: unknown[]) => print(safeText(format(...args)));
  }
  const isHookInvocation = process.argv[2] === "hook";
  if (!isHookInvocation && process.argv[2] !== "view" && process.argv[2] !== "status") {
    for (const dir of ["logs", "reports", "briefs", "specs", "control", "questions"]) {
      try {
        mkdirSync(`${ROOT}/${dir}`, { recursive: true });
      } catch { /* ignore if read-only or raced */ }
    }
  }
}

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
