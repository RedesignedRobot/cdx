import { geminiTokens } from "./tokens.ts";
import { safeText, safeJSON } from "./safe-text.ts";
// Codex protocol helpers, Gemini result and retry policy, and recovery prompts.

import { config } from "./config.ts";
import { type GeminiUsageSnapshot, refreshGeminiUsage, writeGeminiQuota } from "./gemini-usage.ts";
import { feedEvent, type Lane, readLedger, type Spec, type Tokens, withLedger } from "./ledger.ts";
import { logPathOf, logProgress, partialReportPathOf, reportPathOf, specPathOf } from "./reports.ts";
import { HOME, ROOT, singleLine } from "./runtime.ts";
import { isFiniteCount, parseQuotaResetDelayMs } from "./usage-store.ts";
import { roundProgress, toolObservation, type VisibilityConfig } from "./visibility.ts";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const GEMINI_TRANSPORT_RETRIES = 1;

// A 503 is the service, not the stream: the agy process is alive and the
// conversation intact, so waiting costs nothing while an immediate resend
// burns a context load per attempt (study 2026-09-12, retry-metrics). The
// ladder waits out an outage of about a quarter of an hour before giving up.
export const GEMINI_OUTAGE_RETRIES = 6;

const GEMINI_OUTAGE_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];

// agy's own retry loop (4 s, 6 s, 12 s, 25 s, 50 s, server-supplied) has no
// tunables and is bounded only by --print-timeout, so cdx's --max-runtime
// kill has to land first: the print timeout sits this far above the cap.
export const GEMINI_PRINT_TIMEOUT_SLACK_MINS = 5;

// Gemini capacity follows Google's US serving day. The windows come from
// cdx's own logs (265 first-attempt 503s up to 2026-09-16): seven in ten
// landed between 17:00 and 21:00 Riyadh, a second bump 12:00 to 14:00.
export const GEMINI_PEAK_WINDOWS_RIYADH: ReadonlyArray<{ from: number; to: number; label: string }> = [
  { from: 17, to: 21, label: "daily peak" },
  { from: 12, to: 14, label: "midday bump" },
];

const GEMINI_QUIET_WINDOW_RIYADH = { from: 21, to: 12 };

// agy logs each in-process retry as one line; cdx tails the per-round log
// for them so the head sees a 503 burst while agy is still handling it.
const AGY_RETRY_LINE = /Run: attempt (\d+) failed \((.*)\), retrying in (\S+)$/;

// A burst this deep (about 22 s of consecutive 503s) is worth waking the head.
export const AGY_RETRY_WAKE_ATTEMPT = 3;

// Every codex process cdx starts carries these overrides. Native subagents are
// off because lanes fan out through cdx, and the service tier is pinned to
// standard: the ChatGPT app writes `service_tier = "priority"` (Fast mode,
// "1.5x speed, increased usage") into each codex home's config.toml, and a
// lane running at that tier drains the weekly window faster for no gain in
// a background job (usage study 2026-09-16).
export const CODEX_DISABLE_NATIVE_SUBAGENTS = [
  "-c", "agents.enabled=false",
  "-c", 'service_tier="default"',
  "--disable", "multi_agent",
  "--disable", "multi_agent_v2",
];

export function outageMinutes(retries: number): number {
  return Math.round(GEMINI_OUTAGE_BACKOFF_MS.slice(0, retries).reduce((sum, ms) => sum + ms, 0) / 60_000);
}

function zoneClock(now: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hour: read("hour") % 24, minute: read("minute") };
}

function clockText(hour: number, minute = 0): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Gemini capacity notice, always in both clocks: Riyadh (the owner's) and
// US Pacific (Google's serving day). Riyadh has no daylight saving, so the
// window edges convert with the whole-hour offset between the two clocks now.
export function geminiCapacityNotice(now = new Date()): { peak: boolean; text: string } {
  const riyadh = zoneClock(now, "Asia/Riyadh");
  const pacific = zoneClock(now, "America/Los_Angeles");
  const offset = (riyadh.hour - pacific.hour + 24) % 24;
  const toPacific = (hour: number) => (hour - offset + 24) % 24;
  const window = (from: number, to: number) => `${clockText(from)}-${clockText(to)} Riyadh (${clockText(toPacific(from))}-${clockText(toPacific(to))} US Pacific)`;
  const clocks = `${clockText(riyadh.hour, riyadh.minute)} Riyadh / ${clockText(pacific.hour, pacific.minute)} US Pacific`;
  const quiet = `quiet window ${window(GEMINI_QUIET_WINDOW_RIYADH.from, GEMINI_QUIET_WINDOW_RIYADH.to)}`;
  const hit = GEMINI_PEAK_WINDOWS_RIYADH.find(({ from, to }) => riyadh.hour >= from && riyadh.hour < to);
  const main = GEMINI_PEAK_WINDOWS_RIYADH[0]!;
  if (hit) {
    return {
      peak: true,
      text: `gemini capacity: ${clocks} is inside the ${hit.label} ${window(hit.from, hit.to)} when Google answers 503 no-capacity most often; agy retries in-process and cdx ladders on top, expect a slower round; ${quiet}`,
    };
  }
  return {
    peak: false,
    text: `gemini capacity: ${clocks}, off-peak; the next ${main.label} is ${window(main.from, main.to)}; ${quiet}`,
  };
}

export function parseAgyRetryLine(line: string): { attempt: number; reason: string; delay: string } | undefined {
  const match = AGY_RETRY_LINE.exec(line.trimEnd());
  return match ? { attempt: Number(match[1]), reason: match[2]!, delay: match[3]! } : undefined;
}

// agy prints Go durations ("4s", "1m30s", "250ms").
export function goDurationMs(text: string): number {
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  let total = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(match[1]) * units[match[2]!]!;
  return total;
}

export function shortGeminiReason(reason: string): string {
  const kind = classifyGeminiError(reason);
  if (kind === "503") return "503 no capacity";
  if (kind === "quota") return "429 quota";
  if (kind === "transport") return "transport";
  return singleLine(reason).slice(0, 60);
}

export function geminiTranscriptPath(conversationId: string): string {
  return `${HOME}/.gemini/antigravity-cli/brain/${conversationId}/.system_generated/logs/transcript_full.jsonl`;
}

const SESSION_UUID = /^[0-9a-f-]{36}$/i;

interface RolloutSessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  source?: unknown;
}

function rolloutDateDirs(sessionsRoot: string, startedAt: Date): string[] {
  const dirs: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(startedAt);
    date.setDate(date.getDate() + offset);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dirs.push(`${sessionsRoot}/${year}/${month}/${day}`);
  }
  return dirs;
}

function readRolloutSessionMeta(path: string): RolloutSessionMeta | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < 1_048_576) {
      const chunk = Buffer.alloc(4096);
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (count === 0) break;
      const newline = chunk.subarray(0, count).indexOf(10);
      chunks.push(chunk.subarray(0, newline >= 0 ? newline : count));
      length += newline >= 0 ? newline : count;
      if (newline >= 0) break;
    }
    const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      type?: string;
      payload?: Partial<RolloutSessionMeta>;
    };
    const meta = event.type === "session_meta" ? event.payload : undefined;
    if (!meta || typeof meta.id !== "string" || !SESSION_UUID.test(meta.id)
      || typeof meta.timestamp !== "string" || typeof meta.cwd !== "string") return undefined;
    return meta as RolloutSessionMeta;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function resolveSessionIdFromRollouts(spec: Spec, roundStartedAt?: string): string | undefined {
  if (!roundStartedAt) return undefined;
  const startedMs = Date.parse(roundStartedAt);
  if (!Number.isFinite(startedMs)) return undefined;
  const codexHome = spec.codexHome || process.env.CODEX_HOME || `${HOME}/.codex`;
  const candidates: Array<{ id: string; distance: number; topLevel: boolean }> = [];
  for (const dir of rolloutDateDirs(`${codexHome}/sessions`, new Date(startedMs))) {
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!/^rollout-.*-[0-9a-f-]{36}\.jsonl$/i.test(file)) continue;
      const meta = readRolloutSessionMeta(`${dir}/${file}`);
      if (!meta) continue;
      let cwdMatches = meta.cwd === spec.cwd;
      try { cwdMatches ||= realpathSync(meta.cwd) === realpathSync(spec.cwd); } catch { /* compare the stored paths only */ }
      if (!cwdMatches) continue;
      const timestampMs = Date.parse(meta.timestamp);
      if (!Number.isFinite(timestampMs) || timestampMs < startedMs - 5000 || timestampMs > startedMs + 60_000) continue;
      candidates.push({
        id: meta.id,
        distance: Math.abs(timestampMs - startedMs),
        topLevel: meta.source === "exec",
      });
    }
  }
  const topLevel = candidates.filter((candidate) => candidate.topLevel);
  const matches = topLevel.length > 0 ? topLevel : candidates;
  matches.sort((left, right) => left.distance - right.distance);
  return matches[0]?.id;
}

export interface AppInput {
  type: "text" | "localImage";
  text?: string;
  path?: string;
}

export interface AppTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: Array<Record<string, unknown>>;
  error?: { message?: string } | null;
}

export function inputText(text: string): AppInput {
  return { type: "text", text };
}

// Lanes keep only codegraph. Codex 0.156 rejects an override for a server the
// account does not define (no transport), so cdx disables what config.toml names.
const LANE_MCP_SERVERS = new Set(["codegraph"]);

export function configuredMcpServers(configText: string): string[] {
  const parsed = Bun.TOML.parse(configText) as { mcp_servers?: Record<string, unknown> };
  return Object.keys(parsed.mcp_servers ?? {});
}

function unusedMcpServers(codexHome: string): Record<string, { enabled: false }> {
  const configPath = `${codexHome}/config.toml`;
  const names = existsSync(configPath) ? configuredMcpServers(readFileSync(configPath, "utf8")) : [];
  return Object.fromEntries(names.filter((name) => !LANE_MCP_SERVERS.has(name)).map((name) => [name, { enabled: false }]));
}

export function appThreadParams(spec: Spec): Record<string, unknown> {
  const configOverrides: Record<string, unknown> = {
    agents: { enabled: false },
    features: { multi_agent: false, multi_agent_v2: false, memories: false, plugins: false, apps: false },
    memories: { use_memories: false, generate_memories: false },
    skills: { include_instructions: false },
    mcp_servers: unusedMcpServers(spec.codexHome || process.env.CODEX_HOME || `${HOME}/.codex`),
    service_tier: "default",
  };
  if (!spec.reviewDir && !spec.supervisor) {
    configOverrides.model_auto_compact_token_limit = spec.model_auto_compact_token_limit ?? 150_000;
    configOverrides.tool_output_token_limit = spec.tool_output_token_limit ?? 6_000;
  }
  if (spec.additionalDirectories?.length) {
    configOverrides.sandbox_workspace_write = { writable_roots: spec.additionalDirectories };
  }
  return {
    ...(spec.mode === "spawn" ? { model: spec.model ?? config.model } : {}),
    cwd: spec.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    config: configOverrides,
  };
}

export function isCodexQuotaFailure(text: string): boolean {
  return /rate[ _-]?limit|quota[ _-]?(?:exceeded|exhausted)|insufficient_quota|usage[ _-]?limit|you(?:'ve| have) hit.*limit|too many requests|\b429\b/i.test(text);
}

export function recoveryPrompt(spec: Spec, entry: Lane): string {
  const history: string[] = [];
  let latestEvidence = "";
  for (let round = 1; round <= entry.rounds; round++) {
    let account = "default";
    try { account = JSON.parse(readFileSync(specPathOf(spec.lane, round), "utf8")).account ?? account; } catch { /* no saved spec */ }
    const report = [reportPathOf(spec.lane, round), partialReportPathOf(spec.lane, round)].find((path) => existsSync(path) && readFileSync(path, "utf8").trim());
    history.push(`round ${round}: account=${account}; ${report ?? "no report"}; log=${logPathOf(spec.lane, round, existsSync(logPathOf(spec.lane, round, true)))}`);
    if (report) latestEvidence = readFileSync(report, "utf8").slice(-30_000);
  }
  let original = "";
  try { original = readFileSync(`${ROOT}/briefs/${spec.lane}-r1.md`, "utf8"); } catch { /* initial launch */ }
  const task = spec.taskPrompt ?? spec.prompt;
  return [
    task, original && original !== task ? `Original brief:
${original}` : "",
    "Continue in a fresh session after an account switch. Reuse verified evidence, inspect the current tree, and finish the authorized outcome.",
    `Round history:
${history.join("\n")}`,
    entry.quotaFailure ? `Previous round stopped: ${entry.quotaFailure}` : "",
    latestEvidence ? `Last report or partial:
${latestEvidence}` : "No report survived; use the round logs and current tree.",
  ].filter(Boolean).join("\n\n");
}

export function freshAccountSpec(spec: Spec, entry: Lane, prompt: string): void {
  const readOnly = entry.kind === "review" || Boolean(entry.consult);
  spec.mode = "spawn";
  spec.sourceThreadId = undefined;
  spec.prompt = prompt;
  if (readOnly) {
    spec.reviewDir = spec.cwd;
    spec.gate = undefined;
  }

  withLedger((ledger) => {
    const item = ledger[spec.lane]!;
    item.sessionId = undefined;
    if (item.kind === "work") item.workSessionId = undefined;
  });
}

// The stock message opens with one of these sentences on its own line; a
// real report opens with its own heading, so only the first line decides,
// and it must be the sentence, not a heading that quotes it.
function isAgyCancellationTemplate(text: string | undefined): boolean {
  if (!text || typeof text !== "string") return false;
  const firstLine = (text.trim().split("\n", 1)[0] ?? "").trim().replace(/\.$/, "");
  return firstLine === "User initiated cancellation"
    || firstLine === "Execution stopped per your cancellation request"
    || firstLine.startsWith("An execution step was interrupted by the user");
}

export function extractFinalAgentResponse(responses: Map<string, { stepIndex: string; num: number; text: string }>): string | undefined {
  if (responses.size === 0) return undefined;
  const sorted = [...responses.values()].sort((a, b) => {
    return Number.isFinite(a.num) && Number.isFinite(b.num) ? a.num - b.num : 0;
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    const text = sorted[i].text.trim();
    if (text) return text;
  }
  return undefined;
}

type GeminiErrorKind = "transport" | "503" | "quota" | "malformed" | "cancellation" | "other";

export function classifyGeminiError(text: string | undefined): GeminiErrorKind {
  if (!text || typeof text !== "string") return "other";
  const trimmed = text.trim();
  if (trimmed === "transport" || trimmed === "503" || trimmed === "quota" || trimmed === "malformed" || trimmed === "cancellation" || trimmed === "other") {
    return trimmed as GeminiErrorKind;
  }
  if (isAgyCancellationTemplate(trimmed) || /user initiated cancellation|cancelled by user/i.test(trimmed)) {
    return "cancellation";
  }
  if (/Individual quota reached/i.test(trimmed) || /quota[ _-]?(?:exceeded|exhausted)|rate[ _-]?limit|\b429\b/i.test(trimmed)) {
    return "quota";
  }
  if (/malformed (?:function|tool)[ _]?call|invalid (?:function|tool)[ _]?call|schema violation/i.test(trimmed)) {
    return "malformed";
  }
  if (/\b503\b|service unavailable/i.test(trimmed)) {
    return "503";
  }
  if (
    /stream was interrupted|interrupted stream/i.test(trimmed)
    || /timeout waiting for response|ETIMEDOUT|timed? ?out/i.test(trimmed)
    || /broken pipe|EPIPE/i.test(trimmed)
    || /ECONNRESET|fetch failed|network error|socket hang up/i.test(trimmed)
  ) {
    return "transport";
  }
  return "other";
}

export function shouldRetryGeminiTransport(
  options: { errorText: string; continuations: number; currentSteps: number; stepsAtLastContinuation?: number },
): { retry: boolean; backoffMs: number; limit: number } {
  const error = options.errorText ?? "";
  const kind = classifyGeminiError(error);
  if (kind !== "transport" && kind !== "503") {
    return { retry: false, backoffMs: 0, limit: 0 };
  }
  const hasProgress = options.stepsAtLastContinuation !== undefined && options.currentSteps > options.stepsAtLastContinuation;
  const effectiveContinuations = hasProgress ? 0 : options.continuations;
  const limit = kind === "503" ? GEMINI_OUTAGE_RETRIES : GEMINI_TRANSPORT_RETRIES;
  if (effectiveContinuations >= limit) {
    return { retry: false, backoffMs: 0, limit };
  }
  const backoffMs = kind === "503" ? GEMINI_OUTAGE_BACKOFF_MS[Math.min(effectiveContinuations, GEMINI_OUTAGE_BACKOFF_MS.length - 1)]! : 0;
  return { retry: true, backoffMs, limit };
}

export async function qualifyGeminiResult({ lane, round, ownerSession, result, finalAgentResponse, isReview, turnFailureReason, touchLedger, reportPath }: {
  lane: string; round: number; ownerSession?: string; result: any; finalAgentResponse?: string; isReview: boolean;
  turnFailureReason?: string;
  touchLedger: (patch: (item: Lane) => void, force?: boolean) => void;
  reportPath: string;
}): Promise<{ turnFailureReason?: string }> {
  const rawError = result.error?.message ?? result.error;
  const errorText = typeof rawError === "string" ? rawError : typeof rawError === "object" && rawError ? JSON.stringify(rawError) : "";
  const effectiveError = errorText.trim();
  const recordedError = effectiveError.slice(0, 300);

  const errorKind = classifyGeminiError(effectiveError);
  const isTransportError = errorKind === "transport" || errorKind === "503";
  const previousResultError = result.status !== "SUCCESS" && !isTransportError ? readLedger()[lane]?.lastResultError : undefined;
  const isVerbatimReplay = Boolean(!isTransportError && previousResultError && effectiveError === previousResultError);

  let treatedAsReplay = false;
  let success = result.status === "SUCCESS";

  if (!success) {
    if (isVerbatimReplay && finalAgentResponse) {
      treatedAsReplay = true;
      success = true;
    } else {
      const quotaCandidate = /Individual quota reached/i.test(effectiveError) ? effectiveError : undefined;
      if (quotaCandidate) {
        let usageSnapshot: GeminiUsageSnapshot | undefined;
        try { usageSnapshot = await refreshGeminiUsage(); } catch {}
        if (usageSnapshot && usageSnapshot.fiveHour.remainingPercent >= 5) {
          if (finalAgentResponse) {
            treatedAsReplay = true;
            success = true;
          } else {
            touchLedger((item) => { item.lastResultError = recordedError; }, true);
            turnFailureReason = `agy reported quota exhausted but usage shows ${usageSnapshot.fiveHour.remainingPercent}% five-hour remaining; no block written`;
          }
        } else {
          touchLedger((item) => { item.lastResultError = recordedError; }, true);
          const delayMs = parseQuotaResetDelayMs(quotaCandidate);
          const observedAt = new Date().toISOString();
          const blockedUntil = new Date(Date.now() + (delayMs ?? (30 * 60 * 1000))).toISOString();
          writeGeminiQuota({ blockedUntil, observedAt, lane, round });
          turnFailureReason = `gemini five-hour quota exhausted; resets at ${blockedUntil}; resume this lane after the reset`;
          const resetDetail = delayMs !== undefined ? `resets at ${blockedUntil}` : "reset time unknown; assuming 30m";
          feedEvent("account", `[cdx] lane=${lane} round=${round} gemini quota exhausted; ${resetDetail}`, ownerSession, { lane, round });
        }
      } else {
        touchLedger((item) => { item.lastResultError = recordedError; }, true);
        turnFailureReason ??= isTransportError ? (errorKind === "503" ? "gemini service unavailable (503)" : "gemini transport interrupted")
          : errorText.trim() ? singleLine(errorText).slice(0, 200)
          : `gemini result status ${result.status ?? "ERROR"}`;
      }
    }
  }

  if (success) {
    if (result.status === "SUCCESS") {
      touchLedger((item) => {
        delete item.lastResultError;
      }, true);
    }
    if (treatedAsReplay) {
      logProgress(lane, round, `ignored replayed agy error: ${singleLine(effectiveError).slice(0, 80)}`);
    }
    const qualified = qualifyGeminiReport(result, finalAgentResponse, isReview);
    if (qualified.report !== undefined) writeFileSync(reportPath, safeText(qualified.report));
    if (qualified.findings !== undefined) {
      writeFileSync(`${ROOT}/reports/${lane}-r${round}.findings.json`, `${safeJSON({ findings: qualified.findings }, 2)}\n`);
    }
    turnFailureReason = qualified.failureReason ?? turnFailureReason;
  } else {
    const response = typeof result.response === "string" ? result.response.trim() : "";
    const partial = finalAgentResponse || response;
    if (partial) {
      writeFileSync(partialReportPathOf(lane, round), safeText(`${partial}\n`));
      feedEvent("partial", `[cdx] lane=${lane} round=${round} partial report=${partialReportPathOf(lane, round)}`, ownerSession, { lane, round });
    }
  }
  return { turnFailureReason };
}

function qualifyGeminiReport(result: { structured_output?: any; response?: unknown }, finalAgentResponse: string | undefined, isReview: boolean): { report?: string; findings?: unknown[]; failureReason?: string } {
  const structured = result.structured_output;
  const hasStructuredReport = isReview && structured && typeof structured === "object" && !Array.isArray(structured) && typeof structured.report === "string";
  const raw = hasStructuredReport ? structured.report : finalAgentResponse || (typeof result.response === "string" ? result.response.trim() : "");
  const report = hasStructuredReport ? `${raw.trim()}\n` : isReview ? `${raw}\n\n## Harness note\n\nStructured output was missing.\n` : raw ? `${raw}\n` : undefined;
  const failureReason = isReview && !hasStructuredReport && !raw
    ? "agy finished without a report or structured output"
    : isAgyCancellationTemplate(raw) ? "agy returned its cancellation template as the report; no qualifying report" : undefined;
  return { report, failureReason, ...(hasStructuredReport && Array.isArray(structured.findings) ? { findings: structured.findings } : {}) };
}

export interface CodexThreadUsage {
  baseline?: Tokens;
  previous: Tokens;
}

export function recordCodexTokenDelta(
  threads: Map<string, CodexThreadUsage>,
  threadId: string,
  tokenUsage?: { last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null; total?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null } | null,
): Tokens | null {
  if (!tokenUsage || !tokenUsage.last || !tokenUsage.total) return null;
  const { last, total } = tokenUsage;
  const totalInput = total.inputTokens;
  const totalCached = total.cachedInputTokens;
  const totalOutput = total.outputTokens;
  const lastInput = last.inputTokens;
  const lastCached = last.cachedInputTokens;
  const lastOutput = last.outputTokens;
  if (
    !isFiniteCount(totalInput) || !isFiniteCount(totalCached) || !isFiniteCount(totalOutput) ||
    !isFiniteCount(lastInput) || !isFiniteCount(lastCached) || !isFiniteCount(lastOutput)
  ) {
    return null;
  }
  let usage = threads.get(threadId);
  if (!usage) {
    const baseline: Tokens = {
      input: Math.max(0, totalInput - lastInput),
      cached: Math.max(0, totalCached - lastCached),
      output: Math.max(0, totalOutput - lastOutput),
    };
    usage = { baseline, previous: { input: 0, cached: 0, output: 0 } };
    threads.set(threadId, usage);
  }
  const baseline = usage.baseline ?? { input: 0, cached: 0, output: 0 };
  const current: Tokens = {
    input: Math.max(0, totalInput - baseline.input),
    cached: Math.max(0, totalCached - baseline.cached),
    output: Math.max(0, totalOutput - baseline.output),
  };
  const delta: Tokens = {
    input: Math.max(0, current.input - usage.previous.input),
    cached: Math.max(0, current.cached - usage.previous.cached),
    output: Math.max(0, current.output - usage.previous.output),
  };
  usage.previous = { ...current };
  return delta;
}

function canonicalHash(value: unknown): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}

// Engine events remain the source for arguments and output. Only derived measurements
// go into cdx_tool, once per completed identity, beside those original events.
export function codegraphRoot(cwd: string, exists: (path: string) => boolean = existsSync): string | undefined {
  let path = resolve(cwd);
  for (;;) {
    if (exists(`${path}/.codegraph`)) return path;
    // A nested checkout must not borrow its parent's index.
    if (exists(`${path}/.git`) || dirname(path) === path) return;
    path = dirname(path);
  }
}

export function roundTools(cwd: string, limits: VisibilityConfig, fileHash: (path: string) => string | null, gate?: string, indexedRoot = codegraphRoot) {
  const progress = roundProgress(cwd, limits, gate, indexedRoot);
  const reads = new Map<string, number>();
  const starts = new Map<string, { kind: string; argumentHash: string; readFiles: Record<string, string | null> }>();
  const completed = new Set<string>();
  let warned = false;
  return (event: any, timestamp: string) => {
    const observation = toolObservation(event);
    if (!observation) return;
    const count = progress(observation);
    const step = event.step_update;
    const item = event.params?.item ?? event.item;
    let args = step?.tool_info?.parameters ?? item?.arguments ?? (observation.command !== undefined
      ? { command: observation.command, cwd: item?.cwd ?? cwd } : item?.changes ?? { query: item?.query, path: item?.path });
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* hash the literal */ } }
    const name = step?.tool_name ?? step?.tool_info?.name ?? item?.tool ?? item?.type ?? "tool";
    const kind = observation.command !== undefined ? "command" : /^(view_file|read_file|read)$/i.test(name) ? "read"
      : observation.files.length ? "edit" : name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    if (kind === "command" && step) {
      const { CommandLine, command, cmd, Cwd, cwd: argCwd, ...rest } = args ?? {};
      args = { ...rest, command: CommandLine ?? command ?? cmd, cwd: resolve(cwd, Cwd ?? argCwd ?? ".") };
    }
    if (kind === "read" && args && typeof args === "object") {
      const { AbsolutePath, TargetFile, file_path, absolute_path, path, StartLine, EndLine, start_line, end_line, ...rest } = args;
      const file = AbsolutePath ?? TargetFile ?? file_path ?? absolute_path ?? path;
      args = { ...rest, ...(typeof file === "string" ? { path: resolve(cwd, file) } : {}),
        startLine: StartLine ?? start_line ?? rest.startLine, endLine: EndLine ?? end_line ?? rest.endLine };
    }
    const id = observation.id;
    if (id && completed.has(id)) return { ...count, record: undefined };
    const start = id ? starts.get(id) : undefined;
    if (!observation.completed && start) return { ...count, record: undefined };
    const path = kind === "read" ? args?.path : undefined;
    const readPaths = start ? Object.keys(start.readFiles) : typeof path === "string" ? [resolve(cwd, path)] : [];
    const readFiles = Object.fromEntries(readPaths.map((path) => [path, fileHash(path)]));
    const sample = { kind, argumentHash: canonicalHash(args), readFiles };
    if (!observation.completed) {
      if (id) starts.set(id, sample);
      return { ...count, record: undefined };
    }
    if (id) { completed.add(id); starts.delete(id); }
    const before = start ?? sample;
    const output = step?.tool_info?.output ?? item?.aggregatedOutput ?? item?.aggregated_output ?? item?.result ?? item?.output;
    const summaryBytes = before.kind === "read" && step && typeof output === "string" ? /^\d+ lines?, ([\d,]+) bytes$/.exec(output.trim())?.[1] : undefined;
    const usage = step?.usage;
    const tokenDelta = geminiTokens(usage);
    const record = { type: "cdx_tool", id, timestamp, toolKind: before.kind, argumentHash: before.argumentHash,
      codegraphCalls: count.codegraphCalls, codeSearchesBeforeGraph: count.codeSearchesBeforeGraph,
      ...(Object.keys(before.readFiles).length ? { readFiles: before.readFiles } : {}),
      step: step?.step_index, failed: observation.failed === true,
      ...(before.kind === "read" ? { readRange: { start: args?.startLine ?? 1, end: args?.endLine ?? null } } : {}),
      modelVisibleOutputBytes: summaryBytes === undefined && output != null ? Buffer.byteLength(typeof output === "string" ? output : JSON.stringify(output)) : null,
      outputBytes: summaryBytes !== undefined ? Number(summaryBytes.replaceAll(",", ""))
        : output == null ? null : Buffer.byteLength(typeof output === "string" ? output : JSON.stringify(output)),
      outputBytesSource: summaryBytes !== undefined ? "engine-summary" : output == null ? "unavailable" : "captured-output",
      ...(start && canonicalHash(readFiles) !== canonicalHash(start.readFiles) ? { readFilesAfter: readFiles } : {}),
      treeBefore: null, treeAfter: null,
      ...(tokenDelta ? { tokenDelta } : {}), inputObservedBefore: Boolean(start) };
    // Collapse only successful, stable Gemini reads; measurements retain original byte counts.
    if (step && before.kind === "read" && observation.failed !== true && output != null
      && Object.keys(readFiles).length && Object.values(readFiles).every((hash) => hash !== null)
      && canonicalHash(readFiles) === canonicalHash(before.readFiles)) {
      const key = canonicalHash([before.argumentHash, readFiles]);
      const previous = reads.get(key);
      if (previous !== undefined) {
        step.tool_info.output = `unchanged since step ${previous}`;
        Object.assign(record, { reusedFromStep: previous, storedOutputBytes: Buffer.byteLength(step.tool_info.output) });
      } else reads.set(key, step.step_index ?? count.steps);
    }
    // Repeated reads never alert the head; failed commands and edit loops still do.
    const reason = count.thrash;
    const thrash = !warned ? reason : undefined;
    if (thrash) warned = true;
    return { ...count, record, thrash };
  };
}
