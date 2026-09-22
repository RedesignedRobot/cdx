import "./visibility.test.ts";
import "./status-progress.test.ts";
import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  verifyGate, requireAccountModel, recoveryPartial, roundTools, resumePrompt, promptRules, pendingTestsRefusal, sharedTreeLanes, VERIFICATION_RULE, GEMINI_WORKER_RULES, toolLogRecords,
  checkRoundCap, eventOwned, summaryJobs, owned, parseArgs, parseConfig, parseFeedEvent, recipientOf, roundCapRefusal,
  recordCodexTokenDelta, reconcileExhaustionWithSnapshot, isExhaustionObsolete, standingOf,
  parseAccountUsage, formatAccountUsage, describeResetCredits, resetCreditAlerts, rankAccounts, accountAdvice, chooseAccount, decideAccount, demandSizing, shouldRedeemCredit, publishUsageSnapshot, geminiQuotaState, geminiUsageRows, withAccountHolds, projectWindow, mergeUsageHistory, usageTable, geminiWindows, adviceLines, RESET_CREDIT_ALERT_DAYS,
  checkChildAstraRefusal, resolveCodexModel, CODEX_DISABLE_NATIVE_SUBAGENTS,
  classifyGeminiError, shouldRetryGeminiTransport, qualifyGeminiResult, gateEnv, classifyGateFailure,
  fmtTokens, fmtTokensFull, cappedEffort, controlText, outageMinutes, GEMINI_OUTAGE_RETRIES,
  geminiCapacityNotice, parseAgyRetryLine, goDurationMs, outageText,
  selectEvents, statusLine, resolveStdinText, delivery, spawnRoots,
} from "./cdx.ts";

import { finishGateReceipt, gateTreeFromGit, storedDirectories, closeKeepsWorktree, worktreeCleanupCommands, removeWorktree, makeGateReceipt, gateAcceptanceFailed, receiptRefusal, composeGate, shellQuote, completionVerdict, jobCwd, mergeDirectories, worktreeReuseRefusal, cleanupRefusal } from "./cdx.ts";
import { blockingCdxCommand, nativeCdxCommand, nativeCdxRefusal } from "./guard.ts";
import { TOOLS_BY_NAME } from "./hooks/tools.ts";

// Keep tests pure. Pass state explicitly so these tests
// never read user files, spawn engines, or wait on timers.
const state = {
  sequence: 0,
  bindings: { "former-head": "current-head" },
  lanes: { claimed: "lane-head", unclaimed: "former-head", detached: "terminal" },
  sessions: {},
};

test("feed parsing requires a valid envelope before accepting a record", () => {
  const event = { id: 1, timestamp: "2026-09-07T00:00:00Z", kind: "question", owner: "head", message: "Which file?" };
  expect(parseFeedEvent(JSON.stringify(event))).toEqual(event);
  for (const line of ["", "[cdx] old free-text record", "{", "null", "[]", "42"]) {
    expect(parseFeedEvent(line)).toBeUndefined();
  }
  for (const patch of [
    { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: "1" },
    { timestamp: null }, { owner: null }, { message: null }, { kind: "unknown" },
  ]) {
    expect(parseFeedEvent(JSON.stringify({ ...event, ...patch }))).toBeUndefined();
  }
});

test("a lane claim overrides its recorded owner and that owner's takeover", () => {
  expect(recipientOf("former-head", "claimed", state)).toBe("lane-head");
  expect(owned("former-head", "claimed", "lane-head", state)).toBe(true);
  expect(owned("former-head", "claimed", "current-head", state)).toBe(false);
});

test("a session takeover redirects both lane owners and owner-only records", () => {
  expect(recipientOf("former-head", undefined, state)).toBe("current-head");
  expect(owned("former-head", "unclaimed", "current-head", state)).toBe(true);
  expect(owned("former-head", "unclaimed", "former-head", state)).toBe(false);
});

test("terminal ownership survives an absent owner or an explicit lane claim", () => {
  expect(recipientOf(undefined, undefined, state)).toBe("terminal");
  expect(owned("former-head", "detached", "terminal", state)).toBe(true);
  expect(owned("former-head", "detached", "current-head", state)).toBe(false);
});

test("ownership compares full session ids even when prefixes collide", () => {
  const owner = "12345678-1111-4111-8111-111111111111";
  const other = "12345678-2222-4222-8222-222222222222";
  expect(owned(owner, undefined, owner, state)).toBe(true);
  expect(owned(owner, undefined, other, state)).toBe(false);
  expect(owned(owner, undefined, "12345678", state)).toBe(false);
});

test("a peer message reaches its recipient rather than its sender or message text", () => {
  const event = parseFeedEvent(JSON.stringify({
    id: 2, timestamp: "2026-09-07T00:00:00Z", kind: "message",
    owner: "sender", recipient: "former-head", from: "sender", message: "owner=sender recipient=someone-else",
  }))!;
  expect(eventOwned(event, "current-head", state)).toBe(true);
  expect(eventOwned(event, "sender", state)).toBe(false);
  expect(eventOwned(event, "someone-else", state)).toBe(false);
});

test("config parsing reads gemini.maxRounds and defaults to 2", () => {
  const empty = parseConfig("{}");
  expect(empty.gemini?.maxRounds).toBe(2);

  const custom = parseConfig(JSON.stringify({ gemini: { maxRounds: 4 } }));
  expect(custom.gemini?.maxRounds).toBe(4);

  const partial = parseConfig(JSON.stringify({ gemini: { model: "custom-gemini" } }));
  expect(partial.gemini?.maxRounds).toBe(2);
  expect(partial.gemini?.model).toBe("custom-gemini");
});

test("config parsing reads gemini.maxRuntimeMins and defaults to 90", () => {
  const empty = parseConfig("{}");
  expect(empty.gemini?.maxRuntimeMins).toBe(90);
  const custom = parseConfig(JSON.stringify({ gemini: { maxRuntimeMins: 30 } }));
  expect(custom.gemini?.maxRuntimeMins).toBe(30);
  for (const bad of [0, -5, "90", null]) {
    expect(() => parseConfig(JSON.stringify({ gemini: { maxRuntimeMins: bad } }))).toThrow("gemini.maxRuntimeMins must be a positive number of minutes");
  }
});

test("config parsing rejects invalid gemini.maxRounds values", () => {
  for (const bad of [0, -1, 1.5, "2", null, []]) {
    expect(() => parseConfig(JSON.stringify({ gemini: { maxRounds: bad } }))).toThrow("gemini.maxRounds must be a positive integer");
  }
});

test("round cap refusal formats exact refusal message", () => {
  expect(roundCapRefusal("worker-lane", 2)).toBe(
    "round cap 2 reached for worker-lane: close it and spawn a new lane with the failure attached"
  );
  expect(roundCapRefusal("hs-cell-9", 5)).toBe(
    "round cap 5 reached for hs-cell-9: close it and spawn a new lane with the failure attached"
  );
});

test("checkRoundCap refuses gemini lanes at or above the round cap", () => {
  expect(() => checkRoundCap("gemini-lane", "gemini", 2, 2)).toThrow(
    "round cap 2 reached for gemini-lane: close it and spawn a new lane with the failure attached"
  );
  expect(() => checkRoundCap("gemini-lane", "gemini", 3, 2)).toThrow(
    "round cap 2 reached for gemini-lane: close it and spawn a new lane with the failure attached"
  );
  // Work rounds only: a lane at rounds 2 with one review round has workRounds 1.
  expect(() => checkRoundCap("gemini-lane", "gemini", 1, 2)).not.toThrow();
});

test("checkRoundCap does not cap Astra or GPT lanes", () => {
  expect(() => checkRoundCap("gpt-lane", "gpt", 2, 2)).not.toThrow();
  expect(() => checkRoundCap("gpt-lane", "gpt", 5, 2)).not.toThrow();
  expect(() => checkRoundCap("gpt-lane", "gpt", 100, 2)).not.toThrow();
});

test("parseArgs parses --pre flag for spawn and resume", () => {
  const spawnArgs = parseArgs(
    ["lane-1", "--pre", "bun qa.ts readiness-check --release abc", "task brief"],
    ["pre"]
  );
  expect(spawnArgs.flags.pre).toBe("bun qa.ts readiness-check --release abc");
  expect(spawnArgs.rest).toEqual(["lane-1", "task brief"]);

  const resumeArgs = parseArgs(
    ["lane-1", "--pre", "make test", "follow up"],
    ["pre"]
  );
  expect(resumeArgs.flags.pre).toBe("make test");
  expect(resumeArgs.rest).toEqual(["lane-1", "follow up"]);
});

test("parseArgs rejects --pre without a value or when disallowed", () => {
  expect(() => parseArgs(["lane-1", "--pre"], ["pre"])).toThrow("--pre needs a value");
  expect(() => parseArgs(["lane-1", "--pre", "cmd"], [])).toThrow("--pre is not valid for this command");
});

test("Rank 4: recordCodexTokenDelta computes per-thread increments and ignores duplicate events", () => {
  const threadUsages = new Map();
  const roundTokens = { input: 0, cached: 0, output: 0 };

  // Event 1 on root thread: pre-existing baseline is deducted, only delta added to roundTokens
  const delta1 = recordCodexTokenDelta(threadUsages, "thread-root", {
    total: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 },
    last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
  });
  roundTokens.input += delta1!.input;
  roundTokens.cached += delta1!.cached;
  roundTokens.output += delta1!.output;
  expect(roundTokens).toEqual({ input: 100, cached: 20, output: 10 });

  // Event 2 on child thread: interleaved child usage
  const delta2 = recordCodexTokenDelta(threadUsages, "thread-child", {
    total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
    last: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
  });
  roundTokens.input += delta2!.input;
  roundTokens.cached += delta2!.cached;
  roundTokens.output += delta2!.output;
  expect(roundTokens).toEqual({ input: 600, cached: 120, output: 60 });

  // Event 3 duplicate on child thread: idempotence, no double counting
  const delta3 = recordCodexTokenDelta(threadUsages, "thread-child", {
    total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
    last: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
  });
  roundTokens.input += delta3!.input;
  roundTokens.cached += delta3!.cached;
  roundTokens.output += delta3!.output;
  expect(roundTokens).toEqual({ input: 600, cached: 120, output: 60 });

  // Event 4 subsequent update on root thread
  const delta4 = recordCodexTokenDelta(threadUsages, "thread-root", {
    total: { inputTokens: 1200, cachedInputTokens: 250, outputTokens: 80 },
    last: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 30 },
  });
  roundTokens.input += delta4!.input;
  roundTokens.cached += delta4!.cached;
  roundTokens.output += delta4!.output;
  expect(roundTokens).toEqual({ input: 800, cached: 170, output: 90 });

  // Missing token fields return null to signal incomplete token counts
  const deltaMissing = recordCodexTokenDelta(threadUsages, "thread-partial", {
    total: { inputTokens: 500 },
    last: { inputTokens: 50 },
  });
  expect(deltaMissing).toBeNull();

  // Absent last returns null (P2 6)
  expect(recordCodexTokenDelta(threadUsages, "thread-partial", {
    total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
  })).toBeNull();

  // Non-number in total counters returns null
  expect(recordCodexTokenDelta(threadUsages, "thread-infinite", {
    total: { inputTokens: Infinity, cachedInputTokens: 0, outputTokens: 50 },
    last: { inputTokens: Infinity, cachedInputTokens: 0, outputTokens: 5 },
  })).toBeNull();
  expect(recordCodexTokenDelta(threadUsages, "thread-partial", {
    total: { inputTokens: 500, cachedInputTokens: NaN, outputTokens: 50 },
    last: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 5 },
  })).toBeNull();

  expect(recordCodexTokenDelta(threadUsages, "thread-partial", {
    total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: undefined as any },
    last: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 5 },
  })).toBeNull();

  // Non-number in last counters returns null
  expect(recordCodexTokenDelta(threadUsages, "thread-partial", {
    total: { inputTokens: 500, cachedInputTokens: 100, outputTokens: 50 },
    last: { inputTokens: 50, cachedInputTokens: "NaN" as any, outputTokens: 5 },
  })).toBeNull();
});

test("Rank 6: reconcileExhaustionWithSnapshot clears obsolete legacy marker and standingOf marks account eligible", () => {
  const now = Date.now();
  const futureReset = Math.floor(now / 1000) + 3600 * 24 * 5;
  const probeStartedAt = now - 5000;

  // Stale legacy marker (e.g. codex-2 case from study)
  const legacyPrevious = {
    checkedAt: new Date(now - 3600_000).toISOString(),
    usedPercent: 100,
    windowDurationMins: 10080,
    resetsAt: futureReset,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: true,
    exhaustedUntil: futureReset,
  };

  // Fresh authoritative usage probe showing 0% weekly usage and not reached
  const freshSnapshot = {
    checkedAt: new Date(now).toISOString(),
    usedPercent: 0,
    windowDurationMins: 10080,
    resetsAt: futureReset,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: false,
    windows: [{ usedPercent: 0, windowDurationMins: 10080, resetsAt: futureReset }],
  };

  // Reconciliation clears the obsolete marker
  const reconciled = reconcileExhaustionWithSnapshot(legacyPrevious, freshSnapshot, probeStartedAt);
  expect(reconciled.exhaustedUntil).toBeUndefined();

  // Standing evaluated on reconciled snapshot is eligible with 100% capacity left
  const standing = standingOf({ name: "codex-2", home: "/home/codex-2" }, { ...freshSnapshot, ...reconciled });
  expect(standing.reached).toBe(false);
  expect(standing.remainingPercent).toBe(100);

  // Cached legacy snapshot without re-probe is also recognized as obsolete in standingOf
  expect(isExhaustionObsolete({ ...freshSnapshot, exhaustedUntil: futureReset }, now)).toBe(true);
  const directStanding = standingOf({ name: "codex-2", home: "/home/codex-2" }, { ...freshSnapshot, exhaustedUntil: futureReset });
  expect(directStanding.reached).toBe(false);
  expect(directStanding.remainingPercent).toBe(100);
});

test("Rank 6: reconcileExhaustionWithSnapshot retains active exhausted windows and racing newer refusals", () => {
  const now = Date.now();
  const futureReset = Math.floor(now / 1000) + 3600;

  // Case A: Window is currently exhausted (>= 99%)
  const previousExhausted = {
    checkedAt: new Date(now - 10000).toISOString(),
    usedPercent: 100,
    windowDurationMins: 300,
    resetsAt: futureReset,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: true,
    exhaustedUntil: futureReset,
    exhaustedWindowDurationMins: 300,
  };
  const freshExhausted = {
    checkedAt: new Date(now).toISOString(),
    usedPercent: 99.5,
    windowDurationMins: 300,
    resetsAt: futureReset,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: true,
    windows: [{ usedPercent: 99.5, windowDurationMins: 300, resetsAt: futureReset }],
  };
  const keptExhausted = reconcileExhaustionWithSnapshot(previousExhausted, freshExhausted, now - 5000);
  expect(keptExhausted.exhaustedUntil).toBe(futureReset);

  // Case B: Later refusal wins racing earlier probe (refusal recorded during/after probe started)
  const racingRefusal = {
    ...previousExhausted,
    exhaustedRecordedAt: new Date(now - 2000).toISOString(),
    exhaustedUntil: futureReset + 1000,
  };
  const probeEarlier = {
    checkedAt: new Date(now - 1000).toISOString(),
    usedPercent: 10,
    windowDurationMins: 300,
    resetsAt: futureReset,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: false,
    windows: [{ usedPercent: 10, windowDurationMins: 300, resetsAt: futureReset }],
  };
  const refusalWins = reconcileExhaustionWithSnapshot(racingRefusal, probeEarlier, now - 5000);
  expect(refusalWins.exhaustedUntil).toBe(futureReset + 1000);

  // Case C: Two-window case (weekly reset, five-hour window at 100%)
  const previousWeekly = {
    checkedAt: new Date(now - 10000).toISOString(),
    usedPercent: 100,
    windowDurationMins: 10080,
    resetsAt: futureReset + 86400,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: true,
    exhaustedUntil: futureReset + 86400,
    exhaustedWindowDurationMins: 10080,
  };
  const freshTwoWindows = {
    checkedAt: new Date(now).toISOString(),
    usedPercent: 100,
    windowDurationMins: 300,
    resetsAt: futureReset,
    planType: "chatgpt",
    resetCreditsAvailable: 0,
    reached: true,
    windows: [
      { usedPercent: 0, windowDurationMins: 10080, resetsAt: futureReset + 86400 },
      { usedPercent: 100, windowDurationMins: 300, resetsAt: futureReset },
    ],
  };
  const twoWindowsKept = reconcileExhaustionWithSnapshot(previousWeekly, freshTwoWindows, now - 5000);
  expect(twoWindowsKept.exhaustedUntil).toBe(futureReset + 86400);
  expect(isExhaustionObsolete({ ...freshTwoWindows, exhaustedUntil: futureReset + 86400 }, now)).toBe(false);
});

test("Rank 3: child Astra is refused across all resolution routes while head Astra and Gemini are allowed", () => {
  // Head Astra is allowed
  expect(() => checkChildAstraRefusal(false, "gpt", "gpt-6-astra")).not.toThrow();

  // Child Astra is refused for explicit model name
  expect(() => checkChildAstraRefusal(true, "gpt", "gpt-6-astra")).toThrow(
    "child lane cannot run gpt-6-astra; gpt-6-astra is reserved for head-launched lanes"
  );

  // Child Astra is refused for alias resolution ("astra" -> "gpt-6-astra")
  expect(resolveCodexModel("astra")).toBe("gpt-6-astra");
  expect(() => checkChildAstraRefusal(true, "gpt", resolveCodexModel("astra"))).toThrow(
    "child lane cannot run gpt-6-astra; gpt-6-astra is reserved for head-launched lanes"
  );

  // Child Astra is refused when model is omitted and defaults to astra
  expect(resolveCodexModel(undefined)).toBe("gpt-6-astra");
  expect(() => checkChildAstraRefusal(true, "gpt", resolveCodexModel(undefined))).toThrow(
    "child lane cannot run gpt-6-astra; gpt-6-astra is reserved for head-launched lanes"
  );

  // Child Astra is refused when config.model is an alias ("astra" -> "gpt-6-astra")
  const aliasCfg = { model: "astra" };
  expect(resolveCodexModel(undefined, aliasCfg)).toBe("gpt-6-astra");
  expect(() => checkChildAstraRefusal(true, "gpt", undefined, aliasCfg)).toThrow(
    "child lane cannot run gpt-6-astra; gpt-6-astra is reserved for head-launched lanes"
  );

  // Other GPT models and Gemini engines are permitted for children
  expect(() => checkChildAstraRefusal(true, "gpt", "gpt-5-codex")).not.toThrow();
  expect(() => checkChildAstraRefusal(true, "gemini", undefined)).not.toThrow();

  // Native subagent disabling flags and the standard service tier are passed to GPT sessions
  expect(CODEX_DISABLE_NATIVE_SUBAGENTS).toEqual([
    "-c", "agents.enabled=false",
    "-c", 'service_tier="default"',
    "--disable", "multi_agent",
    "--disable", "multi_agent_v2",
  ]);
});

test("Rank 5: classifyGeminiError distinguishes transport and 503 from malformed, quota, and cancellation", () => {
  expect(classifyGeminiError("stream closed unexpectedly: broken pipe")).toBe("transport");
  expect(classifyGeminiError("fetch failed: connection reset by peer")).toBe("transport");
  expect(classifyGeminiError("HTTP 503: Service Unavailable")).toBe("503");
  expect(classifyGeminiError("RESOURCE_EXHAUSTED: rate limit exceeded")).toBe("quota");
  expect(classifyGeminiError("malformed function call in response")).toBe("malformed");
  expect(classifyGeminiError("operation cancelled by user")).toBe("cancellation");
  expect(classifyGeminiError("syntax error in generated script")).toBe("other");
});

test("Rank 5: shouldRetryGeminiTransport allows 1 retry without progress, resets on progress, and refuses terminal errors", () => {
  // Transport error on attempt 1 without progress: allowed 1 retry
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 0, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: true, backoffMs: 0, limit: 1 });

  // Transport error on attempt 2 without progress: stopped (no repeated failure without progress)
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 1, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: false, backoffMs: 0, limit: 1 });
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 2, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: false, backoffMs: 0, limit: 1 });

  // Progress made: counter resets, retry allowed
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 1, currentSteps: 6, stepsAtLastContinuation: 5 })).toEqual({ retry: true, backoffMs: 0, limit: 1 });

  // Terminal errors are never transport-retried even on first attempt
  expect(shouldRetryGeminiTransport({ errorText: "malformed", continuations: 0, currentSteps: 5 })).toEqual({ retry: false, backoffMs: 0, limit: 0 });
  expect(shouldRetryGeminiTransport({ errorText: "quota", continuations: 0, currentSteps: 5 })).toEqual({ retry: false, backoffMs: 0, limit: 0 });
  expect(shouldRetryGeminiTransport({ errorText: "cancellation", continuations: 0, currentSteps: 5 })).toEqual({ retry: false, backoffMs: 0, limit: 0 });
});

test("6.6.0: a 503 outage climbs a waiting ladder of six retries, resets on progress, and stops after the sixth", () => {
  const waits = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
  waits.forEach((backoffMs, continuations) => {
    expect(shouldRetryGeminiTransport({ errorText: "HTTP 503: Service Unavailable", continuations, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: true, backoffMs, limit: GEMINI_OUTAGE_RETRIES });
  });
  expect(shouldRetryGeminiTransport({ errorText: "503", continuations: 6, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: false, backoffMs: 0, limit: 6 });
  // A completed step since the last continuation restarts the ladder at the first wait.
  expect(shouldRetryGeminiTransport({ errorText: "503", continuations: 4, currentSteps: 9, stepsAtLastContinuation: 5 })).toEqual({ retry: true, backoffMs: 30_000, limit: 6 });
  expect(outageMinutes(6)).toBe(18);
  expect(outageMinutes(1)).toBe(1);
});

test("6.6.0: a cdx-authored control record is announced as a notice, a head steer stays verbatim", () => {
  expect(controlText({ text: "child lane x failed", sentAt: "2026-09-13T20:00:00Z", from: "cdx" })).toBe("CDX NOTICE (sent 2026-09-13T20:00:00Z): child lane x failed");
  expect(controlText({ text: "stop and report", sentAt: "2026-09-13T20:00:00Z", from: "head-session" })).toBe("stop and report");
  expect(controlText({ text: "stop and report", sentAt: "2026-09-13T20:00:00Z" })).toBe("stop and report");
});

test("Rank 2: gateEnv prepends local bin to PATH and classifyGateFailure distinguishes setup vs assertion failures", () => {
  const env = gateEnv("/custom/lane/path");
  expect(env.PATH?.startsWith("/custom/lane/path/node_modules/.bin:")).toBe(true);

  // Exit codes 126 and 127 are setup failures only when output indicates shell/execution failure
  expect(classifyGateFailure(127, "sh: line 1: missing-cmd: not found")).toBe("setup");
  expect(classifyGateFailure(126, "cannot execute binary file")).toBe("setup");
  expect(classifyGateFailure(126, "sh: ./run-gate: Permission denied")).toBe("setup");
  expect(classifyGateFailure(127, "No such file or directory")).toBe("setup");
  expect(classifyGateFailure(1, "command not found: tsc")).toBe("setup");
  expect(classifyGateFailure(1, "No such file or directory")).toBe("setup");
  expect(classifyGateFailure(1, "spawn tsc ENOENT")).toBe("setup");

  // Exit codes 126 and 127 with test runner output are assertion failures
  expect(classifyGateFailure(127, "AssertionError: expected status 127 to be 0")).toBe("assertion");
  expect(classifyGateFailure(126, "Tests: 1 failed, 5 passed")).toBe("assertion");

  // Assertion failures with code 1
  expect(classifyGateFailure(1, "AssertionError: expected false to be true")).toBe("assertion");
  expect(classifyGateFailure(1, "Tests: 1 failed, 5 passed")).toBe("assertion");
  expect(classifyGateFailure(1, "Error: 404: not found")).toBe("assertion");
  expect(classifyGateFailure(1, "user not found in database")).toBe("assertion");
});

test("cappedEffort resolves model aliases and clamps Astra to the configured cap", () => {
  const cfg = {
    models: { astra: "gpt-6-astra" },
    effortCaps: { "gpt-6-astra": "medium" },
    efforts: ["low", "medium", "high", "xhigh"],
  };

  // In resume (explicit = false), alias "astra" with high effort clamps to "medium"
  expect(cappedEffort("astra", "high", false, cfg)).toBe("medium");
  expect(cappedEffort("astra", "xhigh", false, cfg)).toBe("medium");
  expect(cappedEffort("astra", "low", false, cfg)).toBe("low");
  expect(cappedEffort("astra", "medium", false, cfg)).toBe("medium");

  // Explicit effort under cap is accepted
  expect(cappedEffort("astra", "low", true, cfg)).toBe("low");
  expect(cappedEffort("astra", "medium", true, cfg)).toBe("medium");

  // Explicit effort above cap fails
  expect(() => cappedEffort("astra", "high", true, cfg)).toThrow("effort high exceeds the cap for astra (max medium)");

  // Canonical model name also respects cap
  expect(cappedEffort("gpt-6-astra", "high", false, cfg)).toBe("medium");

  // Uncapped model returns requested effort
  expect(cappedEffort("gpt-5-codex", "high", true, cfg)).toBe("high");

  // The built-in Astra cap is high: high passes, xhigh fails or clamps
  const builtIn = parseConfig("{}");
  expect(cappedEffort("gpt-6-astra", "high", true, builtIn)).toBe("high");
  expect(cappedEffort("gpt-6-astra", "xhigh", false, builtIn)).toBe("high");
  expect(() => cappedEffort("gpt-6-astra", "xhigh", true, builtIn)).toThrow("exceeds the cap for gpt-6-astra (max high)");
  expect(() => parseConfig('{"effortCaps":{"gpt-6-astra":"xhigh"}}')).toThrow("cannot exceed the built-in cap high");
  expect(parseConfig('{"effortCaps":{"gpt-6-astra":"medium"}}').effortCaps["gpt-6-astra"]).toBe("medium");
});

test("fmtTokens and fmtTokensFull format tokens safely without NaN or literal undefined", () => {
  // Empty or all zero returns "-" when not incomplete
  expect(fmtTokens(undefined)).toBe("-");
  expect(fmtTokens({ input: 0, cached: 0, output: 0 })).toBe("-");
  expect(fmtTokens(undefined, false)).toBe("-");

  // Empty or all zero returns "(incomplete)" when incomplete (P3 8)
  expect(fmtTokens(undefined, true)).toBe("(incomplete)");
  expect(fmtTokens({ input: 0, cached: 0, output: 0 }, true)).toBe("(incomplete)");

  // Cached-only usage is not dropped
  expect(fmtTokens({ input: 0, cached: 50, output: 0 })).toBe("0in/0out");

  // Incomplete flag appends notice
  expect(fmtTokens({ input: 1200, cached: 300, output: 80 }, true)).toBe("1.2kin/80out (incomplete)");
  expect(fmtTokens({ input: 1200, cached: 300, output: 80 }, false)).toBe("1.2kin/80out");

  // fmtTokensFull handles all fields and incomplete flag
  expect(fmtTokensFull({ input: 1500, cached: 500, output: 250 })).toBe("1.5k in (500 cached) / 250 out");
  expect(fmtTokensFull({ input: 50, cached: 0, output: 10 }, true)).toBe("50 in (0 cached) / 10 out (incomplete)");

  // Legacy ledger entries may omit a counter; never print the word undefined
  expect(fmtTokens({ input: 100 } as any)).toBe("100in/0out");
  expect(fmtTokensFull({ input: 100 } as any)).toBe("100 in (0 cached) / 0 out");
});

test("Rank 5: qualifyGeminiResult treats SUCCESS with transport words as success without retrying", async () => {
  const tmpReport = `/tmp/cdx-test-success-${Date.now()}.md`;
  const result = {
    status: "SUCCESS",
    response: "Investigated network error: resolved broken pipe and timeout waiting for response in stream.",
  };
  let ledgerError: string | undefined = "prior-transport-error";
  const qualified = await qualifyGeminiResult({
    lane: "test-lane",
    round: 1,
    result,
    finalAgentResponse: result.response,
    isReview: false,
    turnFailureReason: undefined,
    touchLedger: (patch) => {
      const item: any = { lastResultError: ledgerError };
      patch(item);
      ledgerError = item.lastResultError;
    },
    reportPath: tmpReport,
  });

  expect(qualified.turnFailureReason).toBeUndefined();
  expect(ledgerError).toBeUndefined();
  expect(await Bun.file(tmpReport).text()).toBe(`${result.response}\n`);
  try { unlinkSync(tmpReport); } catch {}
});

test("events selection advances cursor to last record read, marks wake events, and peek leaves cursor", () => {
  const session = "current-head";
  const records = [
    { id: 1, timestamp: "2026-09-15T12:00:00Z", kind: "question", owner: session, message: "q1" },
    { id: 2, timestamp: "2026-09-15T12:01:00Z", kind: "message", owner: session, message: "m1" },
    { id: 3, timestamp: "2026-09-15T12:02:00Z", kind: "started", owner: "other", message: "s1" },
    { id: 4, timestamp: "2026-09-15T12:03:00Z", kind: "terminal", owner: session, message: "t1" },
    { id: 5, timestamp: "2026-09-15T12:04:00Z", kind: "started", owner: "other", message: "s2" },
  ];
  // Three owned events (1, 2, 4). Cursor is at the second owned event (cursor: 2).
  const testState = {
    sequence: 5,
    bindings: {},
    lanes: {},
    sessions: { [session]: { cursor: 2 } },
  };

  // Peek returns event 4, marks wake from WAKE_EVENTS, but leaves cursor at 2
  const peekResult = selectEvents(records, session, testState, { peek: true });
  expect(peekResult.events).toHaveLength(1);
  expect(peekResult.events[0].id).toBe(4);
  expect(peekResult.events[0].wake).toBe(true);
  expect(peekResult.cursor).toBe(2);
  expect(testState.sessions[session].cursor).toBe(2);

  // First call returns exactly one event (id 4), marks wake, advances cursor to last record id read (5, not 4)
  const firstResult = selectEvents(records, session, testState);
  expect(firstResult.events).toHaveLength(1);
  expect(firstResult.events[0].id).toBe(4);
  expect(firstResult.events[0].kind).toBe("terminal");
  expect(firstResult.events[0].wake).toBe(true);
  expect(firstResult.cursor).toBe(5);
  expect(testState.sessions[session].cursor).toBe(5);

  // A second call returns an empty list
  const secondResult = selectEvents(records, session, testState);
  expect(secondResult.events).toEqual([]);
  expect(secondResult.cursor).toBe(5);
  expect(testState.sessions[session].cursor).toBe(5);
});

test("statusLine returns empty string when nothing owned runs, formats shape, and cuts middle items before counts", () => {
  const now = Date.parse("2026-09-15T12:15:00Z");

  // Empty string when caller owns no running lane, job, or open question (not "cdx 0 lanes")
  expect(statusLine({}, {}, 0, undefined, { now })).toBe("");
  expect(statusLine({}, {}, 0, 15, { now })).toBe("");

  // Exact shape matching doc specification
  const ledger = {
    "search-fix": {
      kind: "work", work: { state: "running", cwd: "/work" },
      stage: "gate", stageStartedAt: "2026-09-15T12:12:00Z",
      lastActionAt: "2026-09-15T12:12:00Z",
      ownerSession: "head",
    },
    "api-docs": {
      kind: "work", work: { state: "running", cwd: "/docs" },
      stage: "working",
      lastActionAt: "2026-09-15T12:03:00Z",
      ownerSession: "head",
    },
  } as any;
  const shaped = statusLine(ledger, {}, 1, undefined, {
    now,
    ownsLane: () => true,
    ownsJob: () => true,
  });
  expect(shaped).toBe("cdx 2 lanes · search-fix gate 3m · api-docs working 12m · 1 question");

  // Middle cut: lines exceeding 100 characters drop middle items before counts
  const wideLedger: any = {};
  for (let i = 1; i <= 6; i++) {
    wideLedger[`worker-long-lane-name-${i}`] = {
      kind: "work", work: { state: "running", cwd: `/work/${i}` },
      stage: "working",
      lastActionAt: "2026-09-15T12:10:00Z",
      ownerSession: "head",
    };
  }
  const cut = statusLine(wideLedger, {}, 2, 15, {
    now,
    ownsLane: () => true,
    ownsJob: () => true,
  });
  expect(cut.length).toBeLessThanOrEqual(100);
  expect(cut.startsWith("cdx 6 lanes")).toBe(true);
  expect(cut.endsWith("2 questions · gemini blocked 15m")).toBe(true);
});

test("free text from stdin accepts '-' and empty stdin fails with command usage line", () => {
  const usage = 'usage: cdx send <lane> "<text>"';

  // Regular text is accepted directly
  expect(resolveStdinText("inline steer", "", usage)).toBe("inline steer");

  // Dash with non-empty stdin returns trimmed content
  expect(resolveStdinText("-", "  steer instructions from stdin \n", usage)).toBe("steer instructions from stdin");

  // Dash with empty or whitespace-only stdin fails with the command usage line
  expect(() => resolveStdinText("-", "", usage)).toThrow(usage);
  expect(() => resolveStdinText("-", "   \t\n  ", usage)).toThrow(usage);
});

test("events and status accept their boolean flags at the command line", () => {
  expect(parseArgs(["--json", "--peek"], ["json", "peek"]).bools).toEqual(new Set(["json", "peek"]));
  expect(parseArgs(["--line"], ["json", "all", "brief", "line", "watch", "interval"]).bools).toEqual(new Set(["line"]));
});

test("-- ends the flags so free text may start with dashes", () => {
  const parsed = parseArgs(["--engine", "gpt", "lane", "--", "--model is refused; why?"], ["engine"]);
  expect(parsed.flags.engine).toBe("gpt");
  expect(parsed.rest).toEqual(["lane", "--model is refused; why?"]);
});

test("a 6.x session record migrates to one cursor without replaying history", () => {
  const legacy: any = { sequence: 9, bindings: {}, lanes: {}, sessions: { head: { wake: 7, quiet: 4, lease: { pid: 1, claudePid: 2 }, plugin: { root: "/x" } } } };
  expect(delivery(legacy, "head")).toEqual({ cursor: 7 });
  expect(delivery(legacy, "fresh")).toEqual({ cursor: 0 });
});

// Reset credits: the app-server lists each banked credit with its expiry.
const creditResponse = (expiries: number[], available = expiries.length) => ({
  result: {
    rateLimits: { planType: "pro", primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2_000_000_000 }, secondary: null, spendControlReached: false, rateLimitReachedType: null },
    rateLimitResetCredits: {
      availableCount: available,
      credits: [
        ...expiries.map((expiresAt, index) => ({ id: `c${index}`, status: "available", grantedAt: expiresAt - 30 * 86_400, expiresAt })),
        { id: "used", status: "redeemed", grantedAt: 1, expiresAt: 5 },
      ],
    },
  },
});

test("parseAccountUsage keeps available credit expiries, ascending, and drops redeemed ones", () => {
  const usage = parseAccountUsage(creditResponse([1_800_000_000, 1_700_000_000]));
  expect(usage?.resetCredits).toBe(2);
  expect(usage?.resetCreditExpiresAt).toEqual([1_700_000_000, 1_800_000_000]);
  expect(parseAccountUsage(creditResponse([], 0))?.resetCreditExpiresAt).toEqual([]);
});

test("formatAccountUsage names each credit's expiry", () => {
  const now = Date.UTC(2026, 8, 15, 12);
  const expiresAt = Math.floor(now / 1000) + 19 * 86_400;
  const usage = parseAccountUsage(creditResponse([expiresAt]))!;
  const detail = formatAccountUsage(usage).detail;
  expect(detail).toContain("1 reset credit available, expires");
  expect(describeResetCredits(2, [expiresAt, expiresAt + 86_400], now)).toMatch(/^2 reset credits available, expire .* in 19\.0d and .* in 20\.0d$/);
  expect(describeResetCredits(0, [], now)).toBe("0 reset credits available");
});

test("resetCreditAlerts fires only inside the three-day window before expiry", () => {
  const now = Date.now();
  const snapshotWith = (expiresAt: number[]) => ({
    checkedAt: new Date(now).toISOString(), usedPercent: 10, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86_400,
    planType: "pro", resetCreditsAvailable: expiresAt.length, resetCreditExpiresAt: expiresAt, reached: false,
  });
  const seconds = (days: number) => Math.floor(now / 1000) + Math.round(days * 86_400);
  expect(RESET_CREDIT_ALERT_DAYS).toBe(3);
  expect(resetCreditAlerts([{ name: "codex-1", snapshot: snapshotWith([seconds(19)]) }], now)).toEqual([]);
  expect(resetCreditAlerts([{ name: "codex-1", snapshot: snapshotWith([seconds(-1)]) }], now)).toEqual([]);
  const lines = resetCreditAlerts([
    { name: "codex-1", home: "/Users/x/.codex", snapshot: snapshotWith([seconds(2.5), seconds(19)]) },
    { name: "codex-2", snapshot: snapshotWith([seconds(1), seconds(2)]) },
    { name: "codex-3", snapshot: undefined },
  ], now);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^CRITICAL: codex-1 has an unused reset credit expiring .* in 2\.5d; inspect in the codex TUI \(CODEX_HOME=.*\.codex codex, then \/usage\)$/);
  expect(lines[1]).toMatch(/^CRITICAL: codex-2 has 2 unused reset credits expiring .* in 1\.0d and .* in 2\.0d; inspect/);
});

// Ranking: spend first the account that its reset will forfeit the most from.
const usageNow = Date.parse("2026-09-20T19:00:00Z");
function usageFixture(account: string, usedPercent: number, resetHours: number, burn?: number) {
  const window = { usedPercent, windowDurationMins: 10080, resetsAt: usageNow / 1000 + resetHours * 3600 };
  const checkedAt = new Date(usageNow).toISOString();
  const snapshot = { ...window, checkedAt, planType: "pro", resetCreditsAvailable: 1, reached: usedPercent >= 99, windows: [window] };
  const history = burn === undefined ? [] : [
    { ...window, account, checkedAt: new Date(usageNow - 3600000).toISOString(), usedPercent: usedPercent - burn, rounds: { round: 1000 } },
    { ...window, account, checkedAt, rounds: { round: 21000 } },
  ];
  return { window, history, standing: standingOf({ name: account, home: `/home/${account}` }, snapshot, history, usageNow) };
}

test("expiring capacity leads; projected exhaustion is light only; picks share admission", () => {
  const estate = [usageFixture("later", 25, 144, 0), usageFixture("soon", 90, 1, 1), usageFixture("burning", 80, 2, 15)].map((f) => f.standing);
  expect(rankAccounts(estate, "work", usageNow).map((s) => s.choice.name)).toEqual(["soon", "later", "burning"]);
  const advice = accountAdvice(estate, usageNow);
  for (const demand of ["light", "work", "supervisor"] as const) expect(advice.picks[demand]).toBe(decideAccount(estate, demand, usageNow)?.choice.name ?? null);
  expect(decideAccount([estate[2]], "work", usageNow)).toBeUndefined();
  expect(decideAccount([estate[2]], "light", usageNow)?.choice.name).toBe("burning");
  expect(accountAdvice([usageFixture("thin", 97, 1).standing, estate[0]], usageNow).picks.work).toBe("thin");
});

test("credits redeem only for actual or projected exhaustion", () => {
  const estate = [usageFixture("thin", 97, 1), usageFixture("empty", 100, 1), usageFixture("burning", 80, 2, 15), usageFixture("idle", 50, 2, 0)].map((f) => f.standing);
  expect(Object.fromEntries(accountAdvice(estate, usageNow).resetCredits.map((c) => [c.account, c.redeem])))
    .toEqual({ thin: false, empty: true, burning: true, idle: false });
  expect(adviceLines(estate, usageNow)).toHaveLength(2);
});

test("burn projects the observed window and estimates tokens only from complete deltas", () => {
  const { window, history } = usageFixture("a", 90, 1, 4);
  const project = (rows: Parameters<typeof projectWindow>[3] = history, now = usageNow) => projectWindow("a", window, history[1].checkedAt, rows, now);
  expect(project()).toMatchObject({ burnMethod: "observed", burnPerHour: 4, projectedRemainingAtReset: 6, hoursToExhaustion: null, tokensPerPercent: 5000 });
  expect(project(history.slice(1))).toMatchObject({ burnMethod: "none", burnPerHour: null, projectedRemainingAtReset: null });
  expect(project(history, usageNow + 5 * 3600000).burnMethod).toBe("none");
  expect(project(history.map((r, i) => i ? r : { ...r, resetsAt: r.resetsAt - 3600 })).burnMethod).toBe("none");
  expect(project(history.map((r, i) => i ? r : { ...r, usedPercent: 95 })).burnMethod).toBe("none");
  expect(project(history.map((r, i) => i ? { ...r, rounds: {} } : r)).tokensPerPercent).toBeUndefined();
  expect(project(history.map((r) => ({ ...r, rounds: undefined }))).tokensPerPercent).toBeUndefined();
  expect(project(history.map((r) => ({ ...r, usedPercent: 90 }))).burnPerHour).toBe(0);
});

test("history merges concurrent account probes, deduplicates and caps oldest readings", () => {
  const { history } = usageFixture("a", 50, 2, 1);
  const rows = Array.from({ length: 2050 }, (_, i) => ({ ...history[0], checkedAt: new Date(usageNow - i * 1000).toISOString() }));
  const merged = mergeUsageHistory(rows, [history[1], { ...history[1], account: "b" }]);
  expect(merged).toHaveLength(2048);
  expect(merged.filter((r) => r.account === "a" && r.checkedAt === history[1].checkedAt)).toHaveLength(1);
  expect(merged.at(-1)?.account).toBe("b");
});

test("Gemini shares window columns and shows a quota block instead of its reset", () => {
  const checkedAt = new Date(usageNow).toISOString();
  const windows = geminiWindows({ checkedAt, weekly: { remainingPercent: 66, resetsAt: new Date(usageNow + 86400000).toISOString() }, fiveHour: { remainingPercent: 0, resetsAt: new Date(usageNow + 3600000).toISOString() } });
  const rows = windows.map((w) => projectWindow("gemini", w, checkedAt, [], usageNow));
  rows[1].blockedUntil = usageNow / 1000 + 7200;
  const table = usageTable(rows, usageNow);
  expect(table[1]).toContain("weekly");
  expect(table[2]).toContain("blocked in 2h 0m");
  expect(table[0]).not.toContain("tokens/%");
  expect(TOOLS_BY_NAME.get("usage")!.run({ json: true, totals: true }).argv).toEqual(["usage", "--json", "--totals"]);
});

function costLane(demand: "light" | "work" | "supervisor", tokens: number): Parameters<typeof demandSizing>[1][string] {
  return { engine: "gpt", kind: "work", effort: "high", rounds: 1, reports: [],
    consult: demand === "light" ? true : undefined, supervisor: demand === "supervisor" ? true : undefined,
    work: { state: "done", exitCode: 0, cwd: "/repo" }, roundTokens: { input: tokens, output: 0, cached: 0 },
    createdAt: "created", updatedAt: "updated" };
}

test("default admission agrees with advice after holds and exhaustion", () => {
  const open = usageFixture("default", 96, 1).standing;
  const lane = { ...costLane("work", 100), work: { state: "running" as const, cwd: "/repo" }, pid: 7, roundAccount: { ...open.choice, demand: "work" as const } };
  const held = withAccountHolds([open], { running: lane }, (pid) => pid === 7)[0];
  expect(held.remainingPercent).toBe(1);
  expect(withAccountHolds([open], { running: { ...lane, roundAccount: undefined } }, (pid) => pid === 7)[0].remainingPercent).toBe(1);
  for (const standing of [open, held, usageFixture("default", 100, 1).standing]) {
    const advice = accountAdvice([standing], usageNow);
    for (const demand of ["light", "work", "supervisor"] as const) {
      if (advice.picks[demand] === null) expect(() => chooseAccount([standing], demand, undefined, undefined, usageNow)).toThrow("no account is eligible");
      else expect(chooseAccount([standing], demand, undefined, undefined, usageNow).choice?.name).toBe(advice.picks[demand]!);
    }
  }
});

test("light spends two percent expiring in ten minutes before long runway", () => {
  const estate = [usageFixture("later", 50, 24).standing, usageFixture("soon", 98, 1 / 6).standing];
  expect(chooseAccount(estate, "light", undefined, undefined, usageNow).choice?.name).toBe("soon");
  expect(accountAdvice(estate, usageNow).picks.work).toBe("later");
});

test("history publication failure leaves the old snapshot visible", () => {
  const before = usageFixture("default", 50, 1).standing.snapshot!;
  const after = usageFixture("default", 80, 1).standing.snapshot!;
  const state = { ...before };
  expect(() => publishUsageSnapshot(state, after, undefined, () => { throw new Error("disk full"); })).toThrow("disk full");
  expect(state.usedPercent).toBe(50);
  publishUsageSnapshot(state, after, undefined, () => { expect(state.usedPercent).toBe(50); });
  expect(state.usedPercent).toBe(80);
});

test("Gemini quota evidence survives missing and stale probes", () => {
  const reset = new Date(usageNow + 3600000).toISOString();
  const quota = { blockedUntil: reset, observedAt: new Date(usageNow).toISOString(), lane: "g", round: 1 };
  const state = geminiQuotaState(usageNow, quota, null);
  const rows = geminiUsageRows(undefined, state, [], 0, usageNow);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ window: "5h", available: false, usedPercent: null, remainingPercent: null });
  expect(usageTable(rows, usageNow)[1]).toContain("blocked in 1h 0m");
  const snapshot = { checkedAt: new Date(usageNow - 3600000).toISOString(), weekly: { remainingPercent: 90, resetsAt: reset }, fiveHour: { remainingPercent: 90, resetsAt: reset } };
  expect(geminiUsageRows(snapshot, geminiQuotaState(usageNow, quota, snapshot), [], 0, usageNow)[1].available).toBe(false);
  expect(geminiQuotaState(usageNow + 3600000, quota, snapshot).block).toBeUndefined();
  const fresh = { ...snapshot, checkedAt: new Date(usageNow).toISOString(), fiveHour: { remainingPercent: 4, resetsAt: reset } };
  expect(geminiUsageRows(fresh, geminiQuotaState(usageNow, null, fresh), [], 0, usageNow)[1].available).toBe(false);
});

test("credit alerts survive unusable capacity evidence in JSON and text", () => {
  const original = usageFixture("a", 50, 24).standing;
  const snapshot = { ...original.snapshot!, checkedAt: new Date(usageNow - 3600000).toISOString(), probeFailedAt: new Date(usageNow).toISOString(), resetCreditExpiresAt: [usageNow / 1000 + 86400] };
  const unknown = standingOf(original.choice, snapshot, [], usageNow);
  expect(unknown.snapshot).toBeUndefined();
  expect(accountAdvice([unknown], usageNow).alerts[0]).toContain("unused reset credit");
  expect(adviceLines([unknown], usageNow).join(" ")).toContain("unused reset credit");
  expect(accountAdvice([unknown], usageNow).resetCredits[0].redeem).toBe(false);
});

test("doctor redemption uses exhaustion rather than the 95 percent warning", () => {
  expect(shouldRedeemCredit(usageFixture("warning", 95, 1).standing)).toBe(false);
  expect(shouldRedeemCredit(usageFixture("burning", 80, 2, 15).standing)).toBe(true);
  expect(shouldRedeemCredit(usageFixture("empty", 100, 1).standing)).toBe(true);
  const noCredit = usageFixture("empty", 100, 1).standing;
  noCredit.snapshot!.resetCreditsAvailable = 0;
  expect(shouldRedeemCredit(noCredit)).toBe(false);
});

test("demand sizing uses five complete round costs and observed window conversion", () => {
  const standing = usageFixture("a", 90, 1, 1).standing;
  const ledger = Object.fromEntries([10000, 20000, 30000, 40000, 900000].map((tokens, i) => [`work-${i}`, costLane("work", tokens)]));
  expect(demandSizing(standing, ledger).work).toEqual({ minimumPercent: 1.5, samples: 5, medianTokens: 30000 });
  expect(demandSizing(standing, ledger).supervisor.minimumPercent).toBe(3);
  expect(demandSizing(usageFixture("unknown", 90, 1).standing, ledger).work.minimumPercent).toBe(3);
  const incomplete = { ...ledger, "work-0": { ...ledger["work-0"], tokensIncomplete: true } };
  expect(demandSizing(standing, incomplete).work).toEqual({ minimumPercent: 3, samples: 4, medianTokens: null });
  for (let i = 0; i < 5; i++) ledger[`supervisor-${i}`] = costLane("supervisor", 300000);
  const sized = withAccountHolds([standing], ledger, () => false);
  expect(accountAdvice(sized, usageNow).picks).toEqual({ light: "a", work: "a", supervisor: null });
  expect(() => chooseAccount(sized, "supervisor", undefined, undefined, usageNow)).toThrow("no account is eligible");
  expect(chooseAccount(sized, "supervisor", "a", undefined, usageNow).choice?.name).toBe("a");
  const twoWindows = { ...standing, remainingPercent: 4, projections: [
    { ...standing.projections![0], remainingPercent: 70, tokensPerPercent: 10000 },
    { ...standing.projections![0], window: "5h", remainingPercent: 4, tokensPerPercent: 100000 },
  ] };
  expect(accountAdvice(withAccountHolds([twoWindows], ledger, () => false), usageNow).picks.supervisor).toBe("a");
});

test("receipt admission requires a successful unchanged tree from the current work round", () => {
  const before = { head: "commit-a", tree: "tree-a" };
  const receipt = makeGateReceipt(2, "/repo", "check", 0, "finished", before, before);
  expect(receiptRefusal(receipt, { round: 2, state: "done", exitCode: 0 })).toBeUndefined();
  expect(receiptRefusal(receipt, { round: 2, state: "closed", exitCode: 0 })).toBeUndefined();
  expect(receiptRefusal(receipt, { round: 2, state: "closed", exitCode: 1 })).toContain("did not exit");
  expect(receiptRefusal(undefined, { round: 2, state: "done", exitCode: 0 })).toContain("no content-bound");
  expect(receiptRefusal(receipt, { round: 3, state: "done", exitCode: 0 })).toContain("older");
  expect(receiptRefusal(receipt, { round: 2, state: "running" })).toContain("running");
  for (const after of [{ ...before, tree: "tree-b" }, { ...before, head: "commit-b" }]) {
    const changed = makeGateReceipt(2, "/repo", "check", 0, "finished", before, after);
    expect(receiptRefusal(changed, { round: 2, state: "done", exitCode: 0 })).toBe("tree changed during gate");
  }
  expect(makeGateReceipt(2, "/repo", "check", 1, "finished", before, before).valid).toBe(false);
  expect(makeGateReceipt(2, "/repo", "check", 0, "finished").valid).toBe(false);
  expect(makeGateReceipt(2, "/repo", "check", 0, "finished", before, before, "snapshot failed").valid).toBe(false);
});

test("required gate survives a missing lane gate and isolates shell control commands", () => {
  expect(composeGate("check-all", undefined)).toBe("check-all");
  expect(composeGate(" check-all ", "check-all")).toBe("check-all");
  expect(composeGate(undefined, "spec")).toBe("spec");
  expect(composeGate(undefined, undefined)).toBeUndefined();
  expect(composeGate("check-all", "exit 0")).toBe("(/bin/sh -lc 'check-all') && (/bin/sh -lc 'exit 0')");
  const notices: string[] = [];
  expect(composeGate("check-all", "check-all && extra", (message) => notices.push(message)))
    .toBe("(/bin/sh -lc 'check-all') && (/bin/sh -lc 'extra')");
  expect(notices).toHaveLength(1);
  expect(composeGate("check-all", "check-all &&extra")).toContain("'check-all &&extra'");
  expect(shellQuote("echo 'ok'")).toBe("'echo '\"'\"'ok'\"'\"''");
});

test("a changing gate runs once and names changed paths in its invalid receipt", () => {
  let runs = 0;
  const result = verifyGate(2, "/repo", "check", () => ({ head: "head", tree: String(runs) }), () => {
    runs++;
    return { exitCode: 0, output: "ok", timedOut: false };
  }, () => ["generated.ts", "other.ts"]);
  expect(runs).toBe(1);
  expect(result.receipt.valid).toBe(false);
  expect(result.receipt.reason).toBe("tree changed during gate: generated.ts, other.ts");
  expect(gateAcceptanceFailed(result.gate.exitCode, result.receipt, result.proofRequired)).toBe(true);
});

test("account model admission refuses only explicit catalog exclusions with the model and account named", () => {
  expect(() => requireAccountModel("gpt-5.4", "codex-2", ["gpt-6-astra"]))
    .toThrow('model "gpt-5.4" is not supported by account "codex-2"');
  expect(() => requireAccountModel("gpt-6-astra", "codex-2", undefined)).not.toThrow();
  expect(() => requireAccountModel("gpt-5.4", "codex-2", ["gpt-5.4"])).not.toThrow();
});

test("reportless recovery preserves changed paths, completed actions and transcript evidence under forty lines", () => {
  const events = [
    { method: "item/completed", params: { item: { type: "commandExecution", command: "check > /tmp/check.log", exitCode: 0 } } },
    { event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/tmp/proof.md" } } } },
    { method: "item/started", params: { item: { type: "commandExecution", command: "unfinished" } } },
  ];
  const transcript = events.map((event) => JSON.stringify(event)).join("\n") + '\n{"incomplete":';
  const partial = recoveryPartial(transcript, " M cdx.ts\n?? evidence.json\n", "Keep the admission fix.");
  for (const text of [" M cdx.ts", "?? evidence.json", "Last completed tool action: write_to_file /tmp/proof.md", "/tmp/check.log", "Previous handoff: Keep the admission fix."]) expect(partial).toContain(text);
  expect(partial).not.toContain("unfinished");
  const many = Array.from({ length: 100 }, (_, index) => `/tmp/proof-${index}.md`).join("\n");
  const bounded = recoveryPartial(transcript + "\n" + many, many, "previous\n".repeat(100));
  expect(bounded.split("\n").length).toBeLessThan(40);
  expect(bounded).toContain("more; inspect the transcript");
});

test("job target must be explicit in CLI and native tool", () => {
  expect(() => jobCwd(undefined)).toThrow("requires --cd");
  expect(() => jobCwd(" ")).toThrow("requires --cd");
  expect(jobCwd("/repo/child/..")).toBe("/repo");
  expect(TOOLS_BY_NAME.get("job")!.inputSchema.required).toContain("cd");
  expect(TOOLS_BY_NAME.get("gate-receipt")!.run({ lane: "lane" }).argv).toEqual(["gate-receipt", "lane", "--json"]);
});

test("work directories deduplicate and fix resumes keep the existing scope", () => {
  expect(mergeDirectories(["/one"], ["/two", "/one"])).toEqual(["/one", "/two"]);
  expect(TOOLS_BY_NAME.get("resume")!.run({ lane: "lane", fix: "gate", followUp: "fix failure" }).argv)
    .toEqual(["resume", "lane", "--fix", "gate", "--bg", "-"]);
});

test("worktree reuse needs the exact lane branch, repository and clean files", () => {
  expect(worktreeReuseRefusal("lane/a", "lane/a", true, true)).toBeUndefined();
  expect(worktreeReuseRefusal("lane/a", "lane/b", true, true)).toBeDefined();
  expect(worktreeReuseRefusal("lane/a", "lane/a", false, true)).toBeDefined();
  expect(worktreeReuseRefusal("lane/a", "lane/a", true, false)).toBeDefined();
});

test("cleanup refuses dirty, unmerged or switched worktrees including main", () => {
  expect(cleanupRefusal("lane/a", "lane/a", true, true)).toBeUndefined();
  expect(cleanupRefusal("lane/a", "lane/a", false, true)).toBeDefined();
  expect(cleanupRefusal("lane/a", "lane/a", true, false)).toBeDefined();
  expect(cleanupRefusal("lane/a", "lane/b", true, true)).toBeDefined();
  expect(cleanupRefusal("main", "main", true, true)).toBeDefined();
  expect(cleanupRefusal(undefined, "lane/a", true, true)).toBeDefined();
});

test("completion verdict includes failure reason on one bounded line", () => {
  expect(completionVerdict("done")).toBe("done");
  expect(completionVerdict("failed", "gate failed\ninspect log")).toBe("failed: gate failed inspect log");
  expect(completionVerdict("failed", "x".repeat(500)).length).toBe(240);
});


test("follow-tail recognizes quoted cdx logs without claiming unrelated round-named files", () => {
  expect(blockingCdxCommand('tail -f "/Users/a/.cdx/logs/lane-r1.log"')).toBe("tail -f");
  expect(blockingCdxCommand("tail -F '/Users/a/.cdx/logs/lane-r1.log'")).toBe("tail -f");
  expect(blockingCdxCommand('tail -f "${CDX_HOME}/logs/lane-r1.log"')).toBe("tail -f");
  expect(blockingCdxCommand("tail -f /var/log/import-r1.log")).toBeUndefined();
  expect(blockingCdxCommand('tail -n 20 "/Users/a/.cdx/logs/lane-r1.log"')).toBeUndefined();
});

test("bounded for-loop polling with sleep is denied while finite report batches stay allowed", () => {
  expect(blockingCdxCommand("for n in 1 2 3; do cdx status; sleep 5; done")).toBeDefined();
  expect(blockingCdxCommand("for lane in a b; do cdx report $lane; done")).toBeUndefined();
});


test("non-Git gates retain shell verdicts but never supply content proof", () => {
  const absent = makeGateReceipt(1, "/notes", "test -s report", 0, "finished");
  expect(gateAcceptanceFailed(0, absent, false)).toBe(false);
  expect(receiptRefusal(absent, { round: 1, state: "done", exitCode: 0 })).toBeDefined();
  expect(gateAcceptanceFailed(0, absent, true)).toBe(true);
  expect(gateAcceptanceFailed(1, absent, false)).toBe(true);
  expect(gateAcceptanceFailed(undefined, undefined, false)).toBe(false);
});


test("close can keep an abandoned worktree without selecting cleanup", () => {
  const flags = parseArgs(["lane", "--keep-worktree"], ["keep-worktree", "remove-worktree"]).bools;
  expect(closeKeepsWorktree(flags)).toBe(true);
  expect(closeKeepsWorktree(new Set())).toBe(false);
  expect(closeKeepsWorktree(new Set(["remove-worktree"]))).toBe(false);
  expect(() => closeKeepsWorktree(new Set(["remove-worktree", "keep-worktree"]))).toThrow("cannot be combined");
  const commands = worktreeCleanupCommands({ worktreeRepo: "/repo", worktreePath: "/repo-wt", branch: "lane/fix" });
  expect(commands[0]).toContain("worktree remove '/repo-wt'");
  expect(commands[1]).toContain("merge-base --is-ancestor 'refs/heads/lane/fix' refs/heads/main &&");
  expect(TOOLS_BY_NAME.get("close")!.run({ lane: "lane", keepWorktree: true, note: "abandoned" }))
    .toEqual({ argv: ["close", "lane", "--keep-worktree", "-"], stdin: "abandoned" });
});

test("cleanup uses proven main ancestry when primary HEAD and upstream lack the lane commit", () => {
  const entry = { worktreeRepo: "/repo", worktreePath: "/wt", branch: "lane/fix" };
  const run = (merged: boolean) => {
    let present = true;
    let branchPresent = true;
    let proved = false;
    const git = (cwd: string, args: string[]) => {
      let success = true;
      let stdout = "";
      if (args[0] === "symbolic-ref") stdout = cwd === "/wt" ? "lane/fix" : "unrelated";
      if (args[0] === "merge-base") {
        proved = merged && args[2] === "refs/heads/lane/fix" && args[3] === "refs/heads/main";
        success = proved;
      }
      if (args[0] === "worktree") {
        expect(proved).toBe(true);
        present = false;
      }
      if (args[0] === "branch") {
        success = proved && args[1] === "-D";
        if (success) branchPresent = false;
      }
      return { success, stdout, stderr: "not merged into primary HEAD or upstream" };
    };
    if (merged) removeWorktree(entry, git, () => {});
    else expect(() => removeWorktree(entry, git, () => {})).toThrow("not merged into local main");
    return { present, branchPresent };
  };
  expect(run(true)).toEqual({ present: false, branchPresent: false });
  expect(run(false)).toEqual({ present: true, branchPresent: true });
});

test("gate tree refuses a gitlink outside the lane subdirectory", () => {
  let wroteTree = false;
  const git = (cwd: string, ...args: string[]) => {
    if (args[0] === "ls-files") return cwd === "/repo" ? "160000 abc 0\tvendor/engine" : "100644 def 0\tsource.ts";
    if (args[0] === "write-tree") wroteTree = true;
    return "digest";
  };
  expect(() => gateTreeFromGit("/repo", git)).toThrow("submodules");
  expect(wroteTree).toBe(false);
});

test("legacy directory recovery uses the lane round when the work round is absent", () => {
  const entry = { work: { state: "done" as const, cwd: "/repo" }, rounds: 4 };
  const readSpec = (_lane: string, round: number) => round === 4 ? { additionalDirectories: ["/shared"] } : undefined;
  expect(storedDirectories("old", entry, readSpec)).toEqual(["/shared"]);
  expect(storedDirectories("reviewed", { ...entry, rounds: 5, work: { ...entry.work, round: 4 } }, readSpec)).toEqual(["/shared"]);
  expect(storedDirectories("new", { ...entry, additionalDirectories: ["/stored"] }, () => { throw new Error("should not read spec"); })).toEqual(["/stored"]);
});

test("post-gate round failure invalidates the report and receipt together", () => {
  const tree = { head: "head", tree: "tree" };
  const green = makeGateReceipt(1, "/repo", "check", 0, "finished", tree, tree);
  const failed = finishGateReceipt(green, "failed");
  expect(failed.receipt.valid).toBe(false);
  expect(failed.report).toContain("Receipt invalid");
  expect(failed.report).toContain(failed.receipt.reason!);
  expect(failed.report).not.toContain("Receipt valid");
  const passed = finishGateReceipt(green, "done");
  expect(passed.receipt.valid).toBe(true);
  expect(passed.report).toContain("Receipt valid");
  const red = makeGateReceipt(1, "/repo", "check", 1, "finished", tree, tree);
  expect(finishGateReceipt(red, "failed").receipt.reason).toBe("gate failed");
});


test("finite for batches permit launches and classify only their own loop header", () => {
  expect(blockingCdxCommand('for lane in a b; do cdx spawn $lane --bg "brief"; done')).toBeUndefined();
  expect(blockingCdxCommand('for lane in a b; do cdx report $lane; done; echo "for ((;;))"')).toBeUndefined();
  expect(blockingCdxCommand('for lane in seq other; do cdx report $lane; done')).toBeUndefined();
  expect(blockingCdxCommand('for lane in a b; do cdx status; done')).toBe("poll loop");
});

test("geminiCapacityNotice prints Riyadh and US Pacific clocks and names the peak window", () => {
  // 16:30Z on a September day: 19:30 Riyadh, 09:30 Pacific (daylight time).
  const peak = geminiCapacityNotice(new Date("2026-09-16T16:30:00Z"));
  expect(peak.peak).toBe(true);
  expect(peak.text).toContain("19:30 Riyadh / 09:30 US Pacific");
  expect(peak.text).toContain("daily peak 17:00-21:00 Riyadh (07:00-11:00 US Pacific)");
  expect(peak.text).toContain("quiet window 21:00-12:00 Riyadh (11:00-02:00 US Pacific)");
  // The same wall clock in December: Pacific standard time shifts the window edges by an hour.
  const winter = geminiCapacityNotice(new Date("2026-12-16T16:30:00Z"));
  expect(winter.text).toContain("19:30 Riyadh / 08:30 US Pacific");
  expect(winter.text).toContain("17:00-21:00 Riyadh (06:00-10:00 US Pacific)");
  const midday = geminiCapacityNotice(new Date("2026-09-16T09:30:00Z"));
  expect(midday.peak).toBe(true);
  expect(midday.text).toContain("midday bump 12:00-14:00 Riyadh");
  const quiet = geminiCapacityNotice(new Date("2026-09-17T00:10:00Z"));
  expect(quiet.peak).toBe(false);
  expect(quiet.text).toContain("03:10 Riyadh / 17:10 US Pacific, off-peak");
  expect(quiet.text).toContain("next daily peak is 17:00-21:00 Riyadh");
});

test("parseAgyRetryLine reads agy's in-process retry line and goDurationMs reads Go durations", () => {
  const line = "I0916 20:16:16.265769     208 run.go:389] Run: attempt 2 failed (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server), retrying in 6s";
  expect(parseAgyRetryLine(line)).toEqual({ attempt: 2, reason: "UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server", delay: "6s" });
  expect(parseAgyRetryLine("I0916 20:16:15.051522    1501 http_helpers.go:299] URL: https://example.test")).toBeUndefined();
  expect(goDurationMs("4s")).toBe(4_000);
  expect(goDurationMs("1m30s")).toBe(90_000);
  expect(goDurationMs("250ms")).toBe(250);
});

test("outageText names the retry layer, the wait, and the round's agy retry count", () => {
  const now = Date.parse("2026-09-16T16:40:00Z");
  const agy = outageText({ layer: "agy", since: "2026-09-16T16:39:30Z", attempt: 3, reason: "503 no capacity", nextRetryAt: "2026-09-16T16:40:12Z" }, 5, now);
  expect(agy).toBe("503 no capacity for 30s · agy in-process retry 3 · next retry in 12s · agy retries this round 5");
  const ladder = outageText({ layer: "cdx", since: "2026-09-16T16:30:00Z", attempt: 2, limit: 6, reason: "503 no capacity", nextRetryAt: "2026-09-16T16:39:00Z" }, undefined, now);
  expect(ladder).toBe("503 no capacity for 10m · cdx ladder 2/6 · retry in flight");
});

test("gemini.outageFallbackModel defaults to the 3.8 medium tier, accepts empty, refuses older families", () => {
  expect(parseConfig("{}").gemini?.outageFallbackModel).toBe("gemini-3.8-flash-medium");
  expect(parseConfig(JSON.stringify({ gemini: { outageFallbackModel: "" } })).gemini?.outageFallbackModel).toBe("");
  expect(parseConfig(JSON.stringify({ gemini: { maxRounds: 3 } })).gemini?.outageFallbackModel).toBe("gemini-3.8-flash-medium");
  expect(() => parseConfig(JSON.stringify({ gemini: { outageFallbackModel: "gemini-3.7-flash-high" } }))).toThrow(/3\.8 family/);
  expect(() => parseConfig(JSON.stringify({ gemini: { outageFallbackModel: "gemini-3.1-pro-high" } }))).toThrow(/3\.8 family/);
});

test("spawn roots follow an explicit cd, else a still-present lane directory, else the caller", () => {
  const exists = (path: string) => path === "/wt/old";
  const lane = { work: { cwd: "/wt/old" }, worktreeRepo: "/repo-a", worktreePath: "/wt/old" } as Parameters<typeof spawnRoots>[1];
  expect(spawnRoots("/repo-b", lane, "/elsewhere", exists)).toEqual({ cwd: "/repo-b", worktreeRepo: "/repo-b" });
  expect(spawnRoots("sub", undefined, "/repo-b", exists)).toEqual({ cwd: "/repo-b/sub", worktreeRepo: "/repo-b/sub" });
  expect(spawnRoots(undefined, lane, "/elsewhere", exists)).toEqual({ cwd: "/wt/old", worktreeRepo: "/repo-a" });
  const removed = { ...lane, work: { cwd: "/wt/gone" }, worktreePath: "/wt/gone" } as typeof lane;
  expect(spawnRoots(undefined, removed, "/repo-b", exists)).toEqual({ cwd: "/repo-b", worktreeRepo: "/repo-b" });
  expect(spawnRoots(undefined, undefined, "/repo-b", exists)).toEqual({ cwd: "/repo-b", worktreeRepo: "/repo-b" });
});

test("inside Claude Code a shell cdx command with a native tool is refused by name", () => {
  const native = new Set(["spawn", "status", "close", "gate-receipt"]);
  expect(nativeCdxCommand("cd /repo && bun /Users/mas/code/cdx/cdx.ts spawn x --bg - < /tmp/b.md", native)).toBe("spawn");
  expect(nativeCdxCommand("cdx status --brief", native)).toBe("status");
  expect(nativeCdxCommand("bun cdx.ts gate-receipt lane --json", native)).toBe("gate-receipt");
  expect(nativeCdxCommand("bun cdx.ts brief", native)).toBeUndefined();
  expect(nativeCdxCommand("echo 'cdx spawn' > /tmp/note", native)).toBeUndefined();
  expect(nativeCdxRefusal("spawn")).toContain("mcp__cdx__spawn");
});

test("spawn, consult and review tools require the repository path", () => {
  for (const name of ["spawn", "consult", "review"]) {
    expect(TOOLS_BY_NAME.get(name)!.inputSchema.required).toContain("cd");
  }
});

test("the brief drops finished jobs older than the age window and keeps running ones", () => {
  const now = Date.parse("2026-09-20T00:00:00Z");
  const jobs = {
    old: { log: "-", startedAt: "2026-09-17T00:00:00Z", finishedAt: "2026-09-17T00:10:00Z", state: "failed" as const, exitCode: 1 },
    fresh: { log: "-", startedAt: "2026-09-19T22:00:00Z", finishedAt: "2026-09-19T22:05:00Z", state: "done" as const, exitCode: 0 },
    live: { log: "-", startedAt: "2026-09-16T00:00:00Z", state: "running" as const, pid: process.pid },
  };
  const names = summaryJobs(jobs, 5, 24 * 60 * 60 * 1000, now).map(([name]) => name);
  expect(names).toEqual(["live", "fresh"]);
  expect(summaryJobs(jobs, 5).map(([name]) => name)).toEqual(["live", "fresh", "old"]);
});

test("unchanged rereads are measured once per step and never alert", () => {
  const track = roundTools("/repo", { heartbeatMinutes: 10, failureRepeats: 5, fileEdits: 20 }, () => "first");
  const event = (id: number, state: string) => ({ event: "step_update", step_update: {
    conversation_id: "session", step_index: id, step_type: "tool", state, tool_name: "view_file",
    tool_info: { parameters: { AbsolutePath: "/repo/file.ts" }, output: "2 lines, 77 bytes" },
  } });
  const records: unknown[] = [];
  for (let id = 1; id <= 8; id++) for (const phase of ["ACTIVE", "DONE", "DONE"]) {
    const result = track(event(id, phase), "now")!;
    expect(result.thrash).toBeUndefined();
    if (result.record) records.push(result.record);
  }
  expect(records).toHaveLength(8);
  expect(records[0]).toMatchObject({ toolKind: "read", readFiles: { "/repo/file.ts": "first" }, outputBytes: 77, outputBytesSource: "engine-summary" });
});

test("tool measurements retain bytes and tokens without inventing tool tree hashes", () => {
  const track = roundTools("/repo", { heartbeatMinutes: 10, failureRepeats: 5, fileEdits: 20 }, () => null);
  const event = (state: string) => ({ event: "step_update", step_update: {
    conversation_id: "session", step_index: 1, step_type: "tool", state, tool_name: "write_to_file",
    usage: { input_tokens: 5, cache_read_tokens: 2, output_tokens: 3 },
    tool_info: { parameters: { TargetFile: "/repo/file.ts", CodeContent: "x" }, output: "é" },
  } });
  track(event("ACTIVE"), "start");
  const record = track(event("DONE"), "end")!.record!;
  expect(record).toMatchObject({ toolKind: "edit", outputBytes: 2, treeBefore: null, treeAfter: null, tokenDelta: { input: 5, cached: 2, output: 3 } });
  const line = JSON.stringify(record);
  const end = JSON.stringify({ type: "cdx_round_end", gateReceiptId: "lane:r1" });
  expect(toolLogRecords([JSON.stringify(event("DONE")), line, "broken", end].join("\n"))).toEqual([line, end]);
  const gpt = roundTools("/repo", { heartbeatMinutes: 10, failureRepeats: 5, fileEdits: 20 }, () => null);
  const item = { id: "gpt", type: "commandExecution", command: "check", cwd: "/repo" };
  gpt({ method: "item/started", params: { item } }, "start");
  const measured = gpt({ method: "item/completed", params: { item: { ...item, aggregatedOutput: "ok" } } }, "end")!.record!;
  expect(measured).toMatchObject({ toolKind: "command", outputBytes: 2, treeBefore: null, treeAfter: null });
  expect(measured.tokenDelta).toBeUndefined();
});

test("Gemini resumes are shorter than spawn prompts and carry only changed rules and recovery", () => {
  const rules = [...GEMINI_WORKER_RULES, VERIFICATION_RULE].map((rule) => `- ${rule}`).join("\n");
  const spawn = `Ground rules:\n${rules}\n\nTask:\nFix the parser.`;
  const resumed = resumePrompt("Continue.", rules, promptRules(spawn), "Last action: parser fixed.");
  expect(resumed.length).toBeLessThan(spawn.length);
  expect(promptRules(`Ground rules:\n${rules}\n\nYour previous round ended with this partial report: pending\n\nTask:\nContinue.`)).toBe(rules);
  expect(resumed).toContain("Last action: parser fixed.");
  expect(resumed).not.toContain("Ground rules");
  expect(resumed).not.toContain(GEMINI_WORKER_RULES[0]!);
  const previous = `${rules}\nAllowed edits:\n- a.ts\nForbidden edits:\n- b.ts`;
  const current = `${rules}\nAllowed edits:\n- b.ts\nForbidden edits:\n- a.ts`;
  expect(resumePrompt("Continue.", current, previous)).toContain(`superseding the previous block:\n${current}`);
  expect(resumePrompt("Continue.", rules, undefined)).toContain(VERIFICATION_RULE);
});

test("only structured pending-only partials require an explicit recovery header", () => {
  const start = { type: "item.started", timestamp: "2026-09-21T12:00:00Z", item: { id: "command-1", type: "command_execution", command: "bun test" } };
  const partial = recoveryPartial(JSON.stringify(start), " M parser.ts", "Waiting for tests to finish.");
  const legacy = partial.split("\n").filter((line) => !line.startsWith("Outstanding process:")).join("\n");
  expect(partial).toContain("Outstanding process: bun test (started-at: 2026-09-21T12:00:00Z)");
  for (const followUp of ["Continue.", "Tests succeeded with status 0. Continue.", "Tests have not passed", "Recovery:\n", "Recovery:\nTests exited 0.", "Recovery: tests exited 0.\nWork remains."]) {
    expect(pendingTestsRefusal(partial, followUp)).toContain(" M parser.ts");
  }
  expect(pendingTestsRefusal(partial, "Recovery:\nTests succeeded with status 0.\nFinish the parser.")).toBeUndefined();
  expect(pendingTestsRefusal(legacy, "Continue.")).toBeUndefined();
  expect(pendingTestsRefusal("Waiting for tests to finish.", "Continue.")).toBeUndefined();
  const completed = recoveryPartial([JSON.stringify(start), JSON.stringify({ ...start, type: "item.completed" })].join("\n"), " M parser.ts");
  expect(pendingTestsRefusal(completed, "Continue.")).toBeUndefined();
  expect(pendingTestsRefusal(partial.replace("None recorded.", "/tmp/test-result.log"), "Continue.")).toBeUndefined();
});

test("gate notices name only running lanes sharing the same working tree, including subdirectories", () => {
  const lane = (cwd: string, state = "running") => ({ cwd, kind: "work", work: { cwd, state }, rounds: 1 } as any);
  const ledger = { self: lane("/repo"), sibling: lane("/repo/src"), separate: lane("/other-worktree"), done: lane("/repo", "done"), outside: lane("/not-git") };
  const root = (cwd: string) => cwd.startsWith("/repo") ? "/repo" : cwd === "/other-worktree" ? cwd : undefined;
  expect(sharedTreeLanes("self", "/repo", ledger, root)).toEqual(["sibling"]);
  expect(sharedTreeLanes("outside", "/not-git", ledger, root)).toEqual([]);
});

import { appThreadParams } from "./engines.ts";
import { resumeRefusal, reviewLoopClosed, reviewerForTree, fixReviewPrompt } from "./prompts.ts";
import { geminiAdmission } from "./gemini-usage.ts";
import { landRefusal } from "./worktrees.ts";
import { terminalText } from "./ledger.ts";
import { agentDiscovered, desiredHookEntry, hooksCurrent } from "./doctor.ts";

test("only GPT work receives the compaction trial and every GPT thread sheds unused context", () => {
  const base = { engine: "gpt", mode: "spawn", cwd: "/repo", effort: "medium" } as any;
  const work = appThreadParams(base).config as any;
  expect(work).toMatchObject({ model_auto_compact_token_limit: 150000, tool_output_token_limit: 6000,
    features: { memories: false, plugins: false, apps: false }, skills: { include_instructions: false } });
  expect(work.mcp_servers.context7.enabled).toBe(false);
  for (const patch of [{ reviewDir: "/repo" }, { supervisor: true }]) {
    const options = appThreadParams({ ...base, ...patch }).config as any;
    expect(options.model_auto_compact_token_limit).toBeUndefined();
    expect(options.tool_output_token_limit).toBeUndefined();
  }
  expect(parseConfig('{"tool_output_token_limit":4321}').tool_output_token_limit).toBe(4321);
  expect(() => parseConfig('{"model_auto_compact_token_limit":0}')).toThrow();
  expect(agentDiscovered("Available: cdx-lane-extra", "cdx-lane")).toBe(false);
  expect(agentDiscovered("Available: cdx-lane\ncdx-review", "cdx-lane")).toBe(true);
});

test("resume requires failed evidence at the same HEAD and reviews close after P3 only", () => {
  const entry = { gateReceipt: { head: "head", exitCode: 1 }, reviewTree: { head: "head", tree: "old" }, review: {}, reviewClosed: false } as any;
  expect(resumeRefusal("gate", entry, "head")).toBeUndefined();
  expect(resumeRefusal(undefined, entry, "head")).toContain("fresh lane");
  expect(resumeRefusal("gate", entry, "other")).toContain("HEAD changed");
  expect(resumeRefusal("gate", { ...entry, gateReceipt: { head: "head", exitCode: 0, valid: true } }, "head")).toContain("no failed gate");
  expect(resumeRefusal("review", entry, "head")).toBeUndefined();
  expect(reviewLoopClosed([{ severity: "P3" }])).toBe(true);
  expect(reviewLoopClosed([{ severity: "P2" }, { severity: "P3" }])).toBe(false);
  expect(reviewLoopClosed(undefined)).toBe(false);
  expect(reviewerForTree({ previous: entry }, { head: "head", tree: "old" })).toBe("previous");
  expect(reviewerForTree({ previous: entry }, { head: "head", tree: "new" })).toBeUndefined();
  expect(fixReviewPrompt(entry.reviewTree, { head: "head", tree: "new" }, "P2 overflow")).toContain("git diff old new.\nPrevious findings:\nP2 overflow");
});

test("Gemini admission reserves remaining work across running lanes and queues to reset", () => {
  const now = Date.parse("2026-09-22T00:00:00Z");
  const resetsAt = new Date(now + 3_600_000).toISOString();
  const usage = { fiveHour: { remainingPercent: 15, resetsAt } } as any;
  const busy = { engine: "gemini", kind: "work", work: { state: "running" }, modelCalls: 100, roundTokens: { input: 2_000_000, output: 0, cached: 0 } } as any;
  expect(geminiAdmission(usage, {}, now).queuedUntil).toBeUndefined();
  expect(geminiAdmission(usage, { busy }, now).queuedUntil).toBe(resetsAt);
  expect(geminiAdmission(usage, { busy: { ...busy, queuedUntil: resetsAt } }, now).queuedUntil).toBeUndefined();
  expect(geminiAdmission(usage, { busy }, now + 3_600_001).queuedUntil).toBeUndefined();
});

test("land refuses dirty bases, red receipts, and edits after an interrupted commit", () => {
  const tree = { head: "h", tree: "t" };
  const entry = { engine: "gpt", kind: "work", work: { round: 1, state: "done", exitCode: 0 }, worktreePath: "/lane", worktreeRepo: "/repo", branch: "lane/a",
    gateReceipt: makeGateReceipt(1, "/lane", "check", 0, "now", tree, tree) } as any;
  expect(landRefusal(entry, false, tree)).toBeUndefined();
  expect(landRefusal(entry, true, tree)).toContain("dirty");
  expect(landRefusal({ ...entry, gateReceipt: { ...entry.gateReceipt, exitCode: 1 } }, false, tree)).toBeDefined();
  expect(landRefusal({ ...entry, landingCommit: "committed" }, false, { head: "committed", tree: "t" })).toBeUndefined();
  expect(landRefusal({ ...entry, landingCommit: "committed" }, false, { head: "committed", tree: "unverified" })).toBeDefined();
});

test("terminal events carry small reports and child terminals never wake the head", () => {
  expect(terminalText("done report=/tmp/a", "Outcome\nfile.ts", undefined)).toContain("Outcome\nfile.ts");
  expect(terminalText("done", "界".repeat(4000), undefined)).toBe("done");
  const event = { id: 1, timestamp: "now", kind: "terminal", owner: "head", lane: "claimed", supervisor: "parent", message: "done" };
  expect(eventOwned(event, "lane-head", state)).toBe(false);
  expect(eventOwned({ ...event, supervisor: undefined }, "lane-head", state)).toBe(true);
});


test("doctor treats hooks without the call-cap callback as stale", () => {
  const hooks = desiredHookEntry("bun /cdx.ts");
  expect(hooksCurrent(hooks, "bun /cdx.ts")).toBe(true);
  delete hooks.PostInvocation;
  expect(hooksCurrent(hooks, "bun /cdx.ts")).toBe(false);
});
