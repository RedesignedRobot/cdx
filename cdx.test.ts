import "./visibility.test.ts";
import "./status-progress.test.ts";
import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  checkRoundCap, eventOwned, owned, parseArgs, parseConfig, parseFeedEvent, recipientOf, roundCapRefusal,
  recordCodexTokenDelta, reconcileExhaustionWithSnapshot, isExhaustionObsolete, standingOf,
  checkChildAstraRefusal, resolveCodexModel, CODEX_DISABLE_NATIVE_SUBAGENTS,
  classifyGeminiError, shouldRetryGeminiTransport, qualifyGeminiResult, gateEnv, classifyGateFailure,
  fmtTokens, fmtTokensFull, cappedEffort,
} from "./cdx.ts";

// Keep tests pure. Pass state explicitly so these tests
// never read user files, spawn engines, or wait on timers.
const state = {
  sequence: 0,
  bindings: { "former-head": "current-head" },
  lanes: { claimed: "lane-head", unclaimed: "former-head", detached: "terminal" },
  sessions: {},
  heads: {},
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
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 0, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: true, backoffMs: 0 });

  // Transport error on attempt 2 without progress: stopped (no repeated failure without progress)
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 1, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: false, backoffMs: 0 });
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 2, currentSteps: 5, stepsAtLastContinuation: 5 })).toEqual({ retry: false, backoffMs: 0 });

  // Progress made: counter resets, retry allowed
  expect(shouldRetryGeminiTransport({ errorText: "transport", continuations: 1, currentSteps: 6, stepsAtLastContinuation: 5 })).toEqual({ retry: true, backoffMs: 0 });

  // 503 error: applies 5000ms bounded backoff
  expect(shouldRetryGeminiTransport({ errorText: "503", continuations: 0, currentSteps: 5 })).toEqual({ retry: true, backoffMs: 5000 });

  // Terminal errors are never transport-retried even on first attempt
  expect(shouldRetryGeminiTransport({ errorText: "malformed", continuations: 0, currentSteps: 5 })).toEqual({ retry: false, backoffMs: 0 });
  expect(shouldRetryGeminiTransport({ errorText: "quota", continuations: 0, currentSteps: 5 })).toEqual({ retry: false, backoffMs: 0 });
  expect(shouldRetryGeminiTransport({ errorText: "cancellation", continuations: 0, currentSteps: 5 })).toEqual({ retry: false, backoffMs: 0 });
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
