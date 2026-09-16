import "./visibility.test.ts";
import "./status-progress.test.ts";
import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  checkRoundCap, eventOwned, owned, parseArgs, parseConfig, parseFeedEvent, recipientOf, roundCapRefusal,
  recordCodexTokenDelta, reconcileExhaustionWithSnapshot, isExhaustionObsolete, standingOf,
  parseAccountUsage, formatAccountUsage, describeResetCredits, resetCreditAlerts, rankAccounts, forfeitRate, adviceLines, RESET_CREDIT_ALERT_DAYS,
  checkChildAstraRefusal, resolveCodexModel, CODEX_DISABLE_NATIVE_SUBAGENTS,
  classifyGeminiError, shouldRetryGeminiTransport, qualifyGeminiResult, gateEnv, classifyGateFailure,
  fmtTokens, fmtTokensFull, cappedEffort, controlText, outageMinutes, GEMINI_OUTAGE_RETRIES,
  selectEvents, statusLine, resolveStdinText, delivery,
} from "./cdx.ts";

import { finishGateReceipt, gateTreeFromGit, storedDirectories, closeKeepsWorktree, worktreeCleanupCommands, removeWorktree, makeGateReceipt, gateAcceptanceFailed, receiptRefusal, composeGate, shellQuote, completionVerdict, jobCwd, mergeDirectories, worktreeReuseRefusal, cleanupRefusal } from "./cdx.ts";
import { blockingCdxCommand } from "./guard.ts";
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

  // Native subagent disabling flags are passed to GPT sessions
  expect(CODEX_DISABLE_NATIVE_SUBAGENTS).toEqual([
    "-c", "agents.enabled=false",
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

test("cappedEffort resolves model aliases and clamps Astra to medium cap", () => {
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

test("tokensIncomplete is a per-round flag isolated from prior lane tokensIncomplete", () => {
  const round1Tokens = { input: 100, cached: 0, output: 20 };
  const round2Tokens = { input: 200, cached: 50, output: 40 };

  const round1Record = { round: 1, tokensIncomplete: true };
  const round2Record = { round: 2, tokensIncomplete: undefined };
  const laneRecord = { tokensIncomplete: true };

  // Round 1 displays (incomplete)
  expect(fmtTokens(round1Tokens, round1Record.tokensIncomplete)).toBe("100in/20out (incomplete)");

  // Round 2 displays clean without (incomplete) despite laneRecord.tokensIncomplete
  expect(fmtTokens(round2Tokens, round2Record.tokensIncomplete)).toBe("200in/40out");

  // Lane total displays (incomplete) because round 1 was incomplete
  expect(fmtTokens({ input: 300, cached: 50, output: 60 }, laneRecord.tokensIncomplete)).toBe("300in/60out (incomplete)");
});

test("usage token accumulation safely handles missing counters without NaN", () => {
  const totals = { input: 0, cached: 0, output: 0 };
  const legacyTokens = { input: 100 } as any;
  totals.input += legacyTokens.input ?? 0;
  totals.cached += legacyTokens.cached ?? 0;
  totals.output += legacyTokens.output ?? 0;
  expect(totals).toEqual({ input: 100, cached: 0, output: 0 });
  expect(Number.isNaN(totals.cached)).toBe(false);
  expect(Number.isNaN(totals.output)).toBe(false);
});

test("cdx usage --json row carries incomplete flag reflecting ledger state", () => {
  const ledgerTotalsWithIncomplete = { lanes: 2, tokens: { input: 500, cached: 100, output: 50 }, incomplete: true };
  const rowIncomplete = {
    account: "work-account",
    lanes: ledgerTotalsWithIncomplete.lanes,
    ledgerTokens: ledgerTotalsWithIncomplete.tokens,
    incomplete: Boolean(ledgerTotalsWithIncomplete.incomplete),
  };
  expect(rowIncomplete.incomplete).toBe(true);

  const ledgerTotalsClean = { lanes: 1, tokens: { input: 200, cached: 50, output: 20 }, incomplete: false };
  const rowClean = {
    account: "clean-account",
    lanes: ledgerTotalsClean.lanes,
    ledgerTokens: ledgerTotalsClean.tokens,
    incomplete: Boolean(ledgerTotalsClean.incomplete),
  };
  expect(rowClean.incomplete).toBe(false);
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
  expect(lines[0]).toMatch(/^CRITICAL: codex-1 has an unused reset credit expiring .* in 2\.5d; redeem before then in the codex TUI \(CODEX_HOME=.*\.codex codex, then \/usage\)$/);
  expect(lines[1]).toMatch(/^CRITICAL: codex-2 has 2 unused reset credits expiring .* in 1\.0d and .* in 2\.0d; redeem/);
});

// Ranking: spend first the account that its reset will forfeit the most from.
test("rankAccounts orders by forfeit rate above the risk line, then deadline, then fullness", () => {
  const now = Date.now();
  const standingWith = (name: string, usedPercent: number, daysToReset: number) => standingOf(
    { name, home: `/home/${name}` },
    {
      checkedAt: new Date(now).toISOString(), usedPercent, windowDurationMins: 10080,
      resetsAt: Math.floor(now / 1000) + Math.round(daysToReset * 86_400), planType: "pro", resetCreditsAvailable: 0, reached: false,
      windows: [{ usedPercent, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + Math.round(daysToReset * 86_400) }],
    },
  );
  // The live estate on 2026-09-15: a nearly dry account resetting soonest no
  // longer leads a work lane; the fullest account with the shortest runway does.
  const estate = [standingWith("codex-1", 97, 3.6), standingWith("codex-2", 43, 5.1), standingWith("codex-3", 27, 5.1), standingWith("codex-4", 28, 5.1)];
  expect(rankAccounts(estate, "work", now).map((s) => s.choice.name)).toEqual(["codex-3", "codex-4", "codex-2", "codex-1"]);
  expect(Math.round(forfeitRate(estate[0], "work", now))).toBe(0);
  expect(Math.round(forfeitRate(estate[2], "work", now))).toBe(14);
  // Half a window resetting within the hour outranks a full window with six days.
  const urgent = [standingWith("slow", 0, 6), standingWith("soon", 50, 0.04)];
  expect(rankAccounts(urgent, "work", now).map((s) => s.choice.name)).toEqual(["soon", "slow"]);
  // A nearly dry account resetting within the hour does not: the one-day floor.
  const dry = [standingWith("slow", 0, 6), standingWith("dry", 95, 0.04)];
  expect(rankAccounts(dry, "work", now).map((s) => s.choice.name)).toEqual(["slow", "dry"]);
  // Equal rates: earlier deadline first, then fuller.
  const tie = [standingWith("later", 50, 5), standingWith("earlier", 50, 5 - 0.001), standingWith("fuller-later", 49, 5)];
  expect(rankAccounts(tie, "work", now).map((s) => s.choice.name)).toEqual(["earlier", "fuller-later", "later"]);
});

test("adviceLines lists banked credits and tells a thin account to redeem", () => {
  const now = Date.now();
  const at = Math.floor(now / 1000);
  const standingWith = (name: string, usedPercent: number, credits: number[]) => standingOf(
    { name, home: `/home/${name}` },
    {
      checkedAt: new Date(now).toISOString(), usedPercent, windowDurationMins: 10080, resetsAt: at + 4 * 86_400, planType: "pro",
      resetCreditsAvailable: credits.length, resetCreditExpiresAt: credits, reached: false,
      windows: [{ usedPercent, windowDurationMins: 10080, resetsAt: at + 4 * 86_400 }],
    },
  );
  // codex-1 sits exactly on the 3% risk line: nothing spendable, so redeem.
  const lines = adviceLines([standingWith("codex-1", 97, [at + 19 * 86_400]), standingWith("codex-2", 40, [at + 20 * 86_400, at + 21 * 86_400]), standingWith("codex-3", 30, [])], now);
  expect(lines[0]).toMatch(/^advice: spend codex-3 .*, then codex-2 .*, then codex-1/);
  expect(lines[2]).toMatch(/^  reset credits: codex-1 1 reset credit, expires .*; codex-2 2 reset credits, expire .* and .*; redeem one on codex-1 now for a full window/);
  expect(adviceLines([standingWith("codex-3", 30, [])], now)).toHaveLength(2);
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
  expect(shellQuote("echo 'ok'")).toBe("'echo '\"'\"'ok'\"'\"''");
});

test("job target must be explicit in CLI and native tool", () => {
  expect(() => jobCwd(undefined)).toThrow("requires --cd");
  expect(() => jobCwd(" ")).toThrow("requires --cd");
  expect(jobCwd("/repo/child/..")).toBe("/repo");
  expect(TOOLS_BY_NAME.get("job")!.inputSchema.required).toContain("cd");
  expect(TOOLS_BY_NAME.get("gate-receipt")!.run({ lane: "lane" }).argv).toEqual(["gate-receipt", "lane", "--json"]);
});

test("resume unions directories and passes repeated add-dir flags", () => {
  expect(mergeDirectories(["/one"], ["/two", "/one"])).toEqual(["/one", "/two"]);
  expect(mergeDirectories()).toEqual([]);
  const parsed = parseArgs(["lane", "--add-dir", "/one", "--add-dir", "/two", "continue"], ["add-dir"]);
  expect(parsed.lists["add-dir"]).toEqual(["/one", "/two"]);
  expect(TOOLS_BY_NAME.get("resume")!.run({ lane: "lane", followUp: "continue", addDirs: ["/one", "/two"] }).argv)
    .toEqual(["resume", "lane", "--add-dir", "/one", "--add-dir", "/two", "--bg", "-"]);
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
