// Gemini quota blocks and usage probes.

import { type Engine, type Ledger, laneRunning } from "./ledger.ts";
import {
  color, fail, fmtLocalInstant, fmtUntil, GEMINI_QUOTA_PATH, GEMINI_USAGE_PATH, ROOT, uncoloredChildEnv,
} from "./runtime.ts";
import { parseQuotaResetDelayMs, type RateLimitWindow, recordUsageHistory, withUsageState } from "./usage-store.ts";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

interface GeminiQuotaRecord {
  blockedUntil: string;
  observedAt: string;
  lane: string;
  round: number;
}

export function writeGeminiQuota(record: GeminiQuotaRecord): void {
  mkdirSync(ROOT, { recursive: true });
  const tmp = `${GEMINI_QUOTA_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, GEMINI_QUOTA_PATH);
}

function readGeminiQuota(): GeminiQuotaRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(GEMINI_QUOTA_PATH, "utf8")) as GeminiQuotaRecord;
    return value && typeof value.blockedUntil === "string" && Number.isFinite(Date.parse(value.blockedUntil))
      ? value : undefined;
  } catch {
    return undefined;
  }
}

export function parseQuotaResetIso(text: string, baseTime = Date.now()): string {
  const delayMs = parseQuotaResetDelayMs(text) ?? (30 * 60 * 1000);
  return new Date(baseTime + delayMs).toISOString();
}

function resetMinutesRemaining(iso: string, now = Date.now()): number {
  const diffMs = Date.parse(iso) - now;
  if (diffMs <= 0) return 0;
  return Math.max(1, Math.round(diffMs / 60_000));
}

export interface GeminiQuotaState {
  block?: { resetsAt: string; minutesRemaining: number };
  warnPercent?: number;
  resetsAt?: string;
}

export function geminiQuotaState(now = Date.now(), quota: GeminiQuotaRecord | null = readGeminiQuota() ?? null, snapshot: GeminiUsageSnapshot | null = readGeminiUsageSnapshot() ?? null): GeminiQuotaState {
  if (quota && Date.parse(quota.blockedUntil) > now) {
    return {
      block: {
        resetsAt: quota.blockedUntil,
        minutesRemaining: resetMinutesRemaining(quota.blockedUntil, now),
      },
    };
  }

  if (snapshot) {
    const ageMs = now - Date.parse(snapshot.checkedAt);
    const resetTime = Date.parse(snapshot.fiveHour.resetsAt);
    if (ageMs >= 0 && ageMs < 15 * 60 * 1000 && resetTime > now) {
      if (snapshot.fiveHour.remainingPercent < 5) {
        return {
          block: {
            resetsAt: snapshot.fiveHour.resetsAt,
            minutesRemaining: resetMinutesRemaining(snapshot.fiveHour.resetsAt, now),
          },
        };
      }
      if (snapshot.fiveHour.remainingPercent < 15) {
        return {
          warnPercent: snapshot.fiveHour.remainingPercent,
          resetsAt: snapshot.fiveHour.resetsAt,
        };
      }
    }
  }

  return {};
}

export function requireGeminiQuota(engine: Engine): void {
  if (engine !== "gemini") return;

  const state = geminiQuotaState();
  if (state.block) {
    fail(`gemini five-hour quota exhausted; resets at ${state.block.resetsAt} (in ${state.block.minutesRemaining}m). Wait, or pass --engine gpt.`);
  }

  try { unlinkSync(GEMINI_QUOTA_PATH); } catch { /* ignore */ }

  if (state.warnPercent !== undefined && state.resetsAt) {
    console.error(color.yellow(`cdx: gemini five-hour window at ${state.warnPercent}%, resets at ${state.resetsAt}; fan out with care`));
  }
}

interface GeminiUsageWindow {
  remainingPercent: number;
  resetsAt: string;
}

export interface GeminiUsageSnapshot {
  checkedAt: string;
  weekly: GeminiUsageWindow;
  fiveHour: GeminiUsageWindow;
}

function parseGeminiUsage(text: string): GeminiUsageSnapshot | undefined {
  const rows = text.trim().split("\n").map((line) => line.split("\t"));
  const parse = (label: string): GeminiUsageWindow | undefined => {
    const row = rows.find(([model, window]) => model === "Gemini Models" && window === label);
    if (!row) return undefined;
    const remainingPercent = Number(row[2]?.replace(/%$/, ""));
    const resetsAt = row[3] ?? "";
    if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100 || !resetsAt || !Number.isFinite(Date.parse(resetsAt))) return undefined;
    return { remainingPercent, resetsAt };
  };
  const weekly = parse("Weekly Limit Remaining");
  const fiveHour = parse("Five Hour Limit Remaining");
  return weekly && fiveHour ? { checkedAt: new Date().toISOString(), weekly, fiveHour } : undefined;
}

export function readGeminiUsageSnapshot(): GeminiUsageSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(GEMINI_USAGE_PATH, "utf8")) as GeminiUsageSnapshot;
    return value && typeof value.checkedAt === "string" && typeof value.weekly?.remainingPercent === "number"
      && typeof value.fiveHour?.remainingPercent === "number" ? value : undefined;
  } catch { return undefined; }
}

function writeGeminiUsageSnapshot(snapshot: GeminiUsageSnapshot): void {
  const tmp = `${GEMINI_USAGE_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, GEMINI_USAGE_PATH);
}

export async function refreshGeminiUsage(): Promise<GeminiUsageSnapshot | undefined> {
  const agy = Bun.which("agy");
  if (!agy) return undefined;
  const proc = Bun.spawn([agy, "--print=/usage", "--output-format", "text"], {
    env: uncoloredChildEnv(), stdout: "pipe", stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const timeout = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, 10_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, stdout]);
    await stderr;
    if (exitCode !== 0) return undefined;
    const snapshot = parseGeminiUsage(text);
    if (snapshot) {
      withUsageState(() => {
        recordUsageHistory("gemini", geminiWindows(snapshot), snapshot.checkedAt);
        writeGeminiUsageSnapshot(snapshot);
      });
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}

// Gemini standing in the same shape as a Codex account line ("weekly window
// 11% used, resets ..."), so the two engines read alike in every report.
export function formatGeminiStanding(snapshot: GeminiUsageSnapshot): { detail: string; usedPercent: number } {
  const window = (label: string, usage: GeminiUsageWindow) =>
    `${label} window ${100 - usage.remainingPercent}% used (${usage.remainingPercent}% left), resets ${formatGeminiReset(usage.resetsAt)}`;
  return {
    detail: `${window("weekly", snapshot.weekly)}, ${window("five-hour", snapshot.fiveHour)}`,
    usedPercent: Math.max(100 - snapshot.weekly.remainingPercent, 100 - snapshot.fiveHour.remainingPercent),
  };
}

function formatGeminiReset(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${fmtLocalInstant(ms)} ${fmtUntil(ms / 1000)}` : iso;
}

export function geminiWindows(snapshot: GeminiUsageSnapshot): RateLimitWindow[] {
  return [snapshot.weekly, snapshot.fiveHour].map((window, index) => ({
    usedPercent: 100 - window.remainingPercent, resetsAt: Date.parse(window.resetsAt) / 1000, windowDurationMins: index === 0 ? 10080 : 300,
  }));
}

// Audit calibration: 0.8M uncached input plus output per five-hour point.
// Without live samples, 610.9M / 49,873 calls gives about 12,250 tokens per call.
export function geminiAdmission(snapshot: GeminiUsageSnapshot | undefined, ledger: Ledger, now = Date.now(), exclude?: string): { queuedUntil?: string; projectedPercent: number } {
  if (!snapshot || Date.parse(snapshot.fiveHour.resetsAt) <= now) return { projectedPercent: 0 };
  const running = Object.entries(ledger).filter(([name, item]) => name !== exclude && laneRunning(item) && !item.queuedUntil && (item.kind === "review" ? item.reviewEngine ?? item.engine : item.engine) === "gemini");
  const rates = running.flatMap(([, item]) => item.modelCalls && item.roundTokens
    ? [(item.roundTokens.input - item.roundTokens.cached + item.roundTokens.output) / item.modelCalls] : []);
  const perCall = rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 12_250;
  const projectedTokens = 250 * perCall + running.reduce((sum, [, item]) => {
    const rate = item.modelCalls && item.roundTokens ? (item.roundTokens.input - item.roundTokens.cached + item.roundTokens.output) / item.modelCalls : perCall;
    return sum + Math.max(0, 250 - (item.modelCalls ?? 0)) * rate;
  }, 0);
  const projectedPercent = projectedTokens / 800_000;
  return { projectedPercent, ...(projectedPercent + 10 > snapshot.fiveHour.remainingPercent ? { queuedUntil: snapshot.fiveHour.resetsAt } : {}) };
}
