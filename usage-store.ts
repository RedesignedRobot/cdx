// Usage snapshots, exhaustion markers, history, and burn projections.

import { config } from "./config.ts";
import { type AccountChoice, lanesUpdatedSince, roundEngine, type Spec, withLedger } from "./ledger.ts";
import { rateLimitWindowName, ROOT, USAGE_PATH } from "./runtime.ts";
import { withLockedJson } from "./store.ts";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function parseQuotaResetDelayMs(text: string): number | undefined {
  const match = /Resets in (?:(?:(\d+)\s*h\s*)?(?:(\d+)\s*m\s*)?(?:(\d+)\s*s)?)/i.exec(text);
  if (!match) return undefined;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;
  if (!match[1] && !match[2] && !match[3]) return undefined;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export function recordCodexExhaustion(spec: Spec, evidence: string): void {
  const account = spec.account && spec.codexHome ? { name: spec.account, home: spec.codexHome } : undefined;
  withUsageState((state) => {
    const previous = usageSnapshotFrom(state, account);
    const now = Date.now();
    const delay = parseQuotaResetDelayMs(evidence);
    const epoch = /["']?resets[_A-Za-z]*["']?\s*[:=]\s*(\d{10,13})/i.exec(evidence)?.[1];
    const explicit = epoch ? Number(epoch) / (epoch.length === 13 ? 1000 : 1) : undefined;
    const blocking = previous?.windows?.filter((window) => window.usedPercent >= 99 && window.resetsAt * 1000 > now);
    const reset = explicit && explicit * 1000 > now ? explicit
      : delay !== undefined ? (now + delay) / 1000
      : blocking?.length ? Math.max(...blocking.map((window) => window.resetsAt))
      : previous?.resetsAt && previous.resetsAt * 1000 > now ? previous.resetsAt
      : (now + 30 * 60_000) / 1000;
    const windowDurationMins = blocking?.[0]?.windowDurationMins ?? previous?.windowDurationMins;
    storeUsageSnapshot(state, {
      windowDurationMins: 0, planType: "unknown", resetCreditsAvailable: 0, ...previous,
      checkedAt: new Date(now).toISOString(), usedPercent: 100, resetsAt: reset, reached: true,
      exhaustedUntil: Math.max(reset, previous?.exhaustedUntil ?? 0),
      exhaustedRecordedAt: new Date(now).toISOString(),
      exhaustedWindowDurationMins: windowDurationMins,
      exhaustedReason: evidence.slice(0, 200),
    }, account);
  });
  withLedger((ledger) => {
    const item = ledger[spec.lane];
    if (item?.rounds === spec.round) item.quotaFailure = evidence.slice(0, 500);
  });
}

export const isFiniteCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface AccountUsage {
  models?: string[];
  planType: string;
  primary: RateLimitWindow;
  secondary?: RateLimitWindow;
  resetCredits: number;
  // Unix seconds, ascending; one entry per banked credit the API listed.
  resetCreditExpiresAt: number[];
  rateLimitReachedType: unknown;
  spendControlReached: boolean;
}

export interface UsageSnapshot {
  models?: string[];
  checkedAt: string;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
  planType: string;
  resetCreditsAvailable: number;
  resetCreditExpiresAt?: number[];
  reached: boolean;
  // Every window the probe returned; the folded fields above keep the most
  // consumed one, the advisor needs the weekly one for its deadline.
  windows?: RateLimitWindow[];
  warnedAt?: string;
  probeFailedAt?: string;
  invalidatedAt?: string;
  exhaustedUntil?: number;
  exhaustedRecordedAt?: string;
  exhaustedWindowDurationMins?: number;
  exhaustedReason?: string;
}

const USAGE_HISTORY_PATH = `${ROOT}/usage-history.json`;

const BURN_HORIZON_MS = 4 * 3_600_000;

const HISTORY_LIMIT = 2048;

export interface UsageReading extends RateLimitWindow {
  account: string;
  checkedAt: string;
  rounds?: Record<string, number>;
}

export function readUsageHistory(): UsageReading[] {
  try {
    const rows = JSON.parse(readFileSync(USAGE_HISTORY_PATH, "utf8"));
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.account === "string" && Number.isFinite(Date.parse(r.checkedAt)) && isRateLimitWindow(r)) : [];
  } catch { return []; }
}

export function mergeUsageHistory(history: UsageReading[], fresh: UsageReading[]): UsageReading[] {
  const rows = new Map(history.concat(fresh).map((r) => [`${r.account}/${r.windowDurationMins}/${r.checkedAt}`, r]));
  return [...rows.values()].sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt)).slice(-HISTORY_LIMIT);
}

export function recordUsageHistory(account: string, windows: RateLimitWindow[], checkedAt: string): void {
  const rounds: Record<string, number> = {};
  let complete = true;
  for (const [name, lane] of Object.entries(lanesUpdatedSince(new Date(Date.parse(checkedAt) - BURN_HORIZON_MS).toISOString()))) {
    if (roundEngine(lane) === "claude") continue;
    if ((roundEngine(lane) === "gemini" ? "gemini" : lane.roundAccount?.name ?? lane.account ?? "default") !== account) continue;
    if (!lane.roundStartedAt || Date.parse(lane.updatedAt) < Date.parse(checkedAt) - BURN_HORIZON_MS) continue;
    const tokens = lane.roundTokens;
    if (lane.tokensIncomplete || !tokens || ![tokens.input, tokens.output].every(Number.isFinite)) { complete = false; continue; }
    rounds[`${name}/${lane.roundStartedAt}`] = tokens.input + tokens.output - (roundEngine(lane) === "gemini" ? tokens.cached : 0);
  }
  const merged = mergeUsageHistory(readUsageHistory(), windows.map((w) => ({ ...w, account, checkedAt, ...(complete ? { rounds } : {}) })));
  const tmp = `${USAGE_HISTORY_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged));
  renameSync(tmp, USAGE_HISTORY_PATH);
}

export function projectWindow(account: string, window: RateLimitWindow, checkedAt: string, history: UsageReading[], now = Date.now()) {
  const remainingPercent = Math.max(0, 100 - window.usedPercent);
  const hoursToReset = Math.max(0, (window.resetsAt * 1000 - now) / 3_600_000);
  const rows = history.filter((r) => r.account === account && r.windowDurationMins === window.windowDurationMins
    && r.resetsAt === window.resetsAt && Date.parse(r.checkedAt) >= now - BURN_HORIZON_MS
    && Date.parse(r.checkedAt) <= Date.parse(checkedAt) && Date.parse(r.checkedAt) <= now)
    .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  // A credit or corrected reading starts a new observation segment.
  let start = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].usedPercent < rows[i - 1].usedPercent) start = i;
  const sample = rows.slice(start), first = sample[0], last = sample.at(-1);
  const hours = first && last ? (Date.parse(last.checkedAt) - Date.parse(first.checkedAt)) / 3_600_000 : 0;
  const observed = hours > 0 && hoursToReset > 0 && last?.checkedAt === checkedAt;
  const burnPerHour = observed ? (last!.usedPercent - first!.usedPercent) / hours : null;
  const elapsed = Math.max(0, (now - Date.parse(checkedAt)) / 3_600_000);
  const exhaustion = burnPerHour && burnPerHour > 0 ? Math.max(0, remainingPercent / burnPerHour - elapsed) : null;
  let tokensPerPercent: number | undefined;
  const delta = first && last ? last.usedPercent - first.usedPercent : 0;
  if (observed && delta > 0 && sample.every((r) => r.rounds && Object.values(r.rounds).every((n) => Number.isFinite(n) && n >= 0))) {
    let tokens = 0, valid = true;
    for (let i = 1; i < sample.length; i++) {
      const before = sample[i - 1].rounds!, after = sample[i].rounds!;
      if (Object.entries(before).some(([key, value]) => after[key] === undefined || after[key] < value)) valid = false;
      for (const [key, value] of Object.entries(after)) tokens += value - (before[key] ?? 0);
    }
    if (valid && tokens > 0) tokensPerPercent = Math.round(tokens / delta);
  }
  return { account, window: rateLimitWindowName(window.windowDurationMins), usedPercent: window.usedPercent,
    remainingPercent, resetsAt: window.resetsAt, checkedAt, hoursToReset, burnPerHour,
    projectedRemainingAtReset: burnPerHour === null ? null : Math.max(0, remainingPercent - burnPerHour * (hoursToReset + elapsed)),
    hoursToExhaustion: exhaustion !== null && exhaustion < hoursToReset ? exhaustion : null,
    burnMethod: observed ? "observed" : "none", historyWindow: { horizonHours: 4, samples: sample.length, from: first?.checkedAt ?? null, to: last?.checkedAt ?? null },
    ...(tokensPerPercent !== undefined ? { tokensPerPercent, estimatedRemainingTokens: Math.round(tokensPerPercent * remainingPercent) } : {}),
    heldPercent: 0, blockedUntil: null as number | null,
    available: hoursToReset > 0, reason: hoursToReset > 0 ? "spend normally" : "usage unknown; window reset" };
}

export type WindowProjection = ReturnType<typeof projectWindow>;

export interface RefreshedUsage {
  usage: AccountUsage;
  snapshot: UsageSnapshot;
}

function isRateLimitWindow(value: unknown): value is RateLimitWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return typeof window.usedPercent === "number"
    && typeof window.windowDurationMins === "number"
    && typeof window.resetsAt === "number";
}

// The app-server lists every credit with a status and an expiry; only the
// available ones can still be redeemed.
function resetCreditExpiries(credits: unknown): number[] {
  if (!Array.isArray(credits)) return [];
  return credits
    .filter((credit): credit is { status: string; expiresAt: number } => Boolean(credit) && typeof credit === "object"
      && (credit as Record<string, unknown>).status === "available"
      && typeof (credit as Record<string, unknown>).expiresAt === "number")
    .map((credit) => credit.expiresAt)
    .sort((a, b) => a - b);
}

export function parseAccountUsage(response: unknown): AccountUsage | undefined {
  if (!response || typeof response !== "object") return undefined;
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const limits = (result as { rateLimits?: unknown }).rateLimits;
  const credits = (result as { rateLimitResetCredits?: unknown }).rateLimitResetCredits;
  if (!limits || typeof limits !== "object" || !credits || typeof credits !== "object") return undefined;
  const value = limits as Record<string, unknown>;
  const availableCount = (credits as Record<string, unknown>).availableCount;
  if (typeof value.planType !== "string" || !isRateLimitWindow(value.primary)
    || (value.secondary != null && !isRateLimitWindow(value.secondary))
    || typeof availableCount !== "number") return undefined;
  return {
    planType: value.planType,
    primary: value.primary,
    secondary: value.secondary == null ? undefined : value.secondary as RateLimitWindow,
    resetCredits: availableCount,
    resetCreditExpiresAt: resetCreditExpiries((credits as Record<string, unknown>).credits),
    rateLimitReachedType: value.rateLimitReachedType,
    spendControlReached: value.spendControlReached === true,
  };
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.checkedAt === "string"
    && typeof snapshot.usedPercent === "number"
    && typeof snapshot.windowDurationMins === "number"
    && typeof snapshot.resetsAt === "number"
    && typeof snapshot.planType === "string"
    && typeof snapshot.resetCreditsAvailable === "number"
    && typeof snapshot.reached === "boolean"
    && (snapshot.models === undefined || (Array.isArray(snapshot.models) && snapshot.models.every((model) => typeof model === "string")))
    && (snapshot.warnedAt === undefined || typeof snapshot.warnedAt === "string")
    && (snapshot.probeFailedAt === undefined || typeof snapshot.probeFailedAt === "string")
    && (snapshot.resetCreditExpiresAt === undefined || (Array.isArray(snapshot.resetCreditExpiresAt) && snapshot.resetCreditExpiresAt.every((at) => typeof at === "number")))
    && (snapshot.windows === undefined || (Array.isArray(snapshot.windows) && snapshot.windows.every(isRateLimitWindow)));
}

type UsageState = Record<string, any>;

function readUsageState(): UsageState {
  try {
    const value = JSON.parse(readFileSync(USAGE_PATH, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function usageSnapshotFrom(state: UsageState, account?: AccountChoice): UsageSnapshot | undefined {
  const snapshot = account && (account.name !== "default" || state.accounts) ? state.accounts?.[account.name] : state;
  return isUsageSnapshot(snapshot) ? snapshot : undefined;
}

export function readUsageSnapshot(account?: AccountChoice): UsageSnapshot | undefined {
  return usageSnapshotFrom(readUsageState(), account);
}

export function storeUsageSnapshot(state: UsageState, snapshot: UsageSnapshot, account?: AccountChoice): void {
  if (account?.name === "default" && !config.accounts) account = undefined;
  const accounts = account && state.accounts && typeof state.accounts === "object" && !Array.isArray(state.accounts)
    ? Object.fromEntries(Object.entries(state.accounts).filter((entry) => isUsageSnapshot(entry[1]))) : {};
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, account ? { accounts: { ...accounts, [account.name]: snapshot } } : snapshot);
}

// Every usage mutation reads and merges under the store's write lock,
// including warning deduplication and failed probes.
export function withUsageState<T>(mutate: (state: UsageState) => T): T {
  return withLockedJson(USAGE_PATH, readUsageState, mutate);
}

// Called under the store's write lock. A failed history write cannot publish the snapshot.
export function publishUsageSnapshot(state: UsageState, snapshot: UsageSnapshot, account: AccountChoice | undefined, publishHistory: () => void): UsageSnapshot {
  publishHistory();
  storeUsageSnapshot(state, snapshot, account);
  return snapshot;
}

export function snapshotFromAccountUsage(usage: AccountUsage): UsageSnapshot {
  const windows = [usage.primary, ...(usage.secondary ? [usage.secondary] : [])];
  const window = windows.reduce((selected, candidate) => {
    if (candidate.usedPercent > selected.usedPercent) return candidate;
    if (candidate.usedPercent === selected.usedPercent && candidate.resetsAt > selected.resetsAt) return candidate;
    return selected;
  });
  return {
    checkedAt: new Date().toISOString(),
    ...(usage.models ? { models: usage.models } : {}),
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
    planType: usage.planType,
    resetCreditsAvailable: usage.resetCredits,
    resetCreditExpiresAt: usage.resetCreditExpiresAt,
    reached: window.usedPercent >= 99 || usage.rateLimitReachedType != null || usage.spendControlReached,
    windows,
  };
}

export function invalidateAccountUsage(account?: AccountChoice): void {
  // Single-account configurations still invalidate the default snapshot.
  withUsageState((state) => {
    const previous = usageSnapshotFrom(state, account);
    if (previous) storeUsageSnapshot(state, { ...previous, invalidatedAt: new Date().toISOString() }, account);
  });
}
