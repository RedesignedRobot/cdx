// Codex usage probes, account admission, demand sizing, and reset credits.

import { config } from "./config.ts";
import {
  type AccountChoice, type Demand, feedEvent, type Lane, laneRunning, type Ledger, readLedger, roundEngine,
  type Spec,
} from "./ledger.ts";
import { readJsonLines } from "./reports.ts";
import { failActiveRound } from "./round-state.ts";
import {
  CmdError, color, CONFIG_PATH, displayPath, fail, fmtUntil, HOME, pidAlive, rateLimitResetDate,
  rateLimitWindowName, uncoloredChildEnv, VERSION,
} from "./runtime.ts";
import {
  type AccountUsage, parseAccountUsage, projectWindow, publishUsageSnapshot, type RateLimitWindow,
  readUsageHistory, readUsageSnapshot, recordUsageHistory, type RefreshedUsage, snapshotFromAccountUsage,
  storeUsageSnapshot, type UsageReading, type UsageSnapshot, usageSnapshotFrom, type WindowProjection,
  withUsageState,
} from "./usage-store.ts";

export function requireAccountModel(model: string, account: string, models: string[] | undefined): void {
  if (models && !models.includes(model)) throw new CmdError(`model "${model}" is not supported by account "${account}"`);
}

function configuredAccount(name: string): AccountChoice {
  const accounts = config.accounts;
  if (!accounts || !Object.hasOwn(accounts, name)) {
    const detail = config.accounts ? `unknown account "${name}"; choose one of ${Object.keys(config.accounts).join(", ")}`
      : `--account requires an accounts object in ${CONFIG_PATH}`;
    fail(detail);
  }
  return { name, home: accounts[name]! };
}

export function primaryAccount(forced?: string): AccountChoice | undefined {
  if (forced !== undefined) return configuredAccount(forced);
  const first = config.accounts && Object.entries(config.accounts)[0];
  return first ? { name: first[0], home: first[1] } : undefined;
}

export function laneAccount(lane: Lane): AccountChoice | undefined {
  if (lane.account === undefined && lane.codexHome === undefined) return undefined;
  if (lane.account === undefined || lane.codexHome === undefined) {
    fail("lane account affinity is incomplete; restore its account and Codex home in the ledger before resuming it");
  }
  return { name: lane.account, home: lane.codexHome };
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || `${HOME}/.codex`;
}

export function accountSpec(account?: AccountChoice): Pick<Spec, "account" | "codexHome"> {
  return {
    ...(account ? { account: account.name, codexHome: account.home } : {}),
  };
}

export function rejectPinnedAccountFlag(laneName: string, lane: Lane, requested?: string): void {
  if (requested === undefined) return;
  const pinned = lane.account ? `account "${lane.account}"` : `the default account at ${displayPath(defaultCodexHome())}`;
  fail(`--account is not valid for lane "${laneName}"; lane "${laneName}" is pinned to ${pinned}`);
}

async function readAccountProbe(codexHome?: string): Promise<{ usage?: AccountUsage; models?: string[] }> {
  let proc: any;
  const result: { usage?: AccountUsage; models?: string[] } = {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stderrDrain: Promise<string> | undefined;
  const deadline = Date.now() + 10_000;
  try {
    proc = Bun.spawn(["codex", "app-server"], {
      env: uncoloredChildEnv(codexHome), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    stderrDrain = new Response(proc.stderr).text().catch(() => "");
    const send = (message: object) => {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    };
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "cdx", title: "cdx", version: VERSION } } });

    await Promise.race([
      (async () => {
        let usageDone = false;
        let modelsDone = false;
        let modelId = 3;
        const models: string[] = [];
        const cursors = new Set<string>();
        for await (const message of readJsonLines(proc!.stdout)) {
          if (message.id === 1) {
            if (message.error) return;
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
            send({ id: modelId, method: "model/list", params: { includeHidden: true } });
          } else if (message.id === 2) {
            result.usage = parseAccountUsage(message);
            usageDone = true;
          } else if (message.id === modelId) {
            const page = message.result;
            if (message.error || !Array.isArray(page?.data) || !page.data.every((item: any) => typeof item?.model === "string")) {
              modelsDone = true;
            } else {
              models.push(...page.data.map((item: any) => item.model));
              if (typeof page.nextCursor === "string" && !cursors.has(page.nextCursor)) {
                cursors.add(page.nextCursor);
                send({ id: ++modelId, method: "model/list", params: { includeHidden: true, cursor: page.nextCursor } });
              } else {
                if (page.nextCursor == null) result.models = models;
                modelsDone = true;
              }
            }
          }
          if (usageDone && modelsDone) return;
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          try { proc?.kill("SIGKILL"); } catch { /* already exited */ }
          reject(new Error("usage request timed out"));
        }, Math.max(0, deadline - Date.now()));
      }),
    ]);
    return result;
  } catch {
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    try { proc?.stdin.end(); } catch { /* already closed */ }
    try { proc?.kill("SIGKILL"); } catch { /* already exited */ }
    const cleanupMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (proc && cleanupMs > 0) {
      await Promise.race([
        Promise.allSettled([proc.exited, stderrDrain]),
        Bun.sleep(cleanupMs),
      ]);
    }
  }
}

// The longest returned window supplies weekly headroom on subscription plans.
function weeklyWindow(snapshot: UsageSnapshot): RateLimitWindow | undefined {
  const windows = snapshot.windows ?? [];
  if (windows.length === 0) return undefined;
  return windows.reduce((longest, window) => window.windowDurationMins > longest.windowDurationMins ? window : longest);
}

export function reconcileExhaustionWithSnapshot(
  previous: UsageSnapshot | undefined,
  fresh: UsageSnapshot,
  probeStartedAt: number,
): Partial<UsageSnapshot> {
  if (!previous?.exhaustedUntil || previous.exhaustedUntil * 1000 <= Date.now()) {
    return {};
  }
  const recordedAtMs = previous.exhaustedRecordedAt ? Date.parse(previous.exhaustedRecordedAt) : Number.NaN;
  // A later refusal wins a racing earlier probe
  if (Number.isFinite(recordedAtMs) && recordedAtMs >= probeStartedAt) {
    return {
      exhaustedUntil: previous.exhaustedUntil,
      exhaustedRecordedAt: previous.exhaustedRecordedAt,
      exhaustedWindowDurationMins: previous.exhaustedWindowDurationMins,
      exhaustedReason: previous.exhaustedReason,
    };
  }
  // Probe is newer than recorded refusal
  const windows = fresh.windows ?? [];
  const anyReached = fresh.reached || windows.some((w) => w.usedPercent >= 99);
  if (previous.exhaustedWindowDurationMins !== undefined) {
    const match = windows.find((w) => w.windowDurationMins === previous.exhaustedWindowDurationMins);
    if (match) {
      if (match.usedPercent >= 99) {
        return {
          exhaustedUntil: Math.max(previous.exhaustedUntil, match.resetsAt),
          exhaustedRecordedAt: previous.exhaustedRecordedAt,
          exhaustedWindowDurationMins: previous.exhaustedWindowDurationMins,
          exhaustedReason: previous.exhaustedReason,
        };
      }
      if (!anyReached) {
        return {};
      }
      return {
        exhaustedUntil: previous.exhaustedUntil,
        exhaustedRecordedAt: previous.exhaustedRecordedAt,
        exhaustedWindowDurationMins: previous.exhaustedWindowDurationMins,
        exhaustedReason: previous.exhaustedReason,
      };
    }
    // Window duration was not in fresh probe windows; preserve marker as a different active window
    return {
      exhaustedUntil: previous.exhaustedUntil,
      exhaustedRecordedAt: previous.exhaustedRecordedAt,
      exhaustedWindowDurationMins: previous.exhaustedWindowDurationMins,
      exhaustedReason: previous.exhaustedReason,
    };
  }
  // Legacy marker without exhaustedWindowDurationMins:
  if (anyReached) {
    return {
      exhaustedUntil: previous.exhaustedUntil,
      exhaustedRecordedAt: previous.exhaustedRecordedAt,
      exhaustedReason: previous.exhaustedReason,
    };
  }
  const weekly = weeklyWindow(fresh);
  if (weekly && weekly.usedPercent < 99) {
    return {};
  }
  return {
    exhaustedUntil: previous.exhaustedUntil,
    exhaustedRecordedAt: previous.exhaustedRecordedAt,
    exhaustedReason: previous.exhaustedReason,
  };
}

export function isExhaustionObsolete(snapshot: UsageSnapshot, now = Date.now()): boolean {
  if (!snapshot.exhaustedUntil || snapshot.exhaustedUntil * 1000 <= now) return false;
  const checkedAtMs = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs === 0) return false;

  const windows = snapshot.windows ?? [];
  const anyReached = snapshot.reached || windows.some((w) => w.usedPercent >= 99);
  if (anyReached) return false;

  if (snapshot.exhaustedRecordedAt) {
    const recordedAtMs = Date.parse(snapshot.exhaustedRecordedAt);
    if (Number.isFinite(recordedAtMs) && recordedAtMs >= checkedAtMs) {
      return false;
    }
    if (snapshot.exhaustedWindowDurationMins !== undefined) {
      const match = windows.find((w) => w.windowDurationMins === snapshot.exhaustedWindowDurationMins);
      if (match) {
        return match.usedPercent < 99;
      }
      return false;
    }
  }

  const weekly = weeklyWindow(snapshot);
  if (weekly && weekly.usedPercent < 99 && weekly.resetsAt * 1000 > now) {
    return true;
  }
  return false;
}

function usageFeedWarning(snapshot: UsageSnapshot, account?: AccountChoice): string {
  const credit = snapshot.resetCreditsAvailable > 0 ? ", reset credit available" : "";
  const owner = account ? `usage for account ${account.name}` : "usage";
  return `[cdx] WARNING: OpenAI Codex ${owner} ${snapshot.usedPercent}% consumed (${rateLimitWindowName(snapshot.windowDurationMins)} window, resets ${rateLimitResetDate(snapshot.resetsAt)})${credit}`;
}

export async function refreshUsageSnapshot(options: { warnFeed?: boolean; account?: AccountChoice; ownerSession?: string } = {}): Promise<RefreshedUsage | undefined> {
  const probeStartedAt = Date.now();
  const probe = await readAccountProbe(options.account?.home);
  const usage = probe.usage ? { ...probe.usage, models: probe.models } : undefined;
  if (!usage) {
    // Negative-cache the failure so a hung app-server does not cost every
    // subsequent launch a fresh probe timeout (accountSnapshot honors this
    // marker for 5 minutes).
    withUsageState((state) => {
      const previous = usageSnapshotFrom(state, options.account);
      storeUsageSnapshot(state, {
        checkedAt: new Date(0).toISOString(),
        usedPercent: 0,
        windowDurationMins: 0,
        resetsAt: 0,
        planType: "unknown",
        resetCreditsAvailable: 0,
        reached: false,
        ...previous,
        ...(previous?.invalidatedAt ? { checkedAt: new Date(0).toISOString(), invalidatedAt: undefined } : {}),
        probeFailedAt: new Date().toISOString(),
      }, options.account);
    });
    return undefined;
  }
  const fresh = snapshotFromAccountUsage(usage);
  const stored = withUsageState((state) => {
    const previous = usageSnapshotFrom(state, options.account);
    const previousIsNewer = previous && (Date.parse(previous.checkedAt) > Date.parse(fresh.checkedAt) || Date.parse(previous.invalidatedAt ?? "") >= probeStartedAt);
    const reconciled = reconcileExhaustionWithSnapshot(previous, fresh, probeStartedAt);
    let snapshot = previousIsNewer ? previous : {
      ...fresh,
      ...reconciled,
      ...(previous?.warnedAt ? { warnedAt: previous.warnedAt } : {}),
    };
    if (options.warnFeed && snapshotReached(snapshot)) {
      const warnedAt = snapshot.warnedAt ? Date.parse(snapshot.warnedAt) : Number.NaN;
      if (!Number.isFinite(warnedAt) || Date.now() - warnedAt >= 3_600_000) {
        snapshot = { ...snapshot, warnedAt: new Date().toISOString() };
        feedEvent("account", usageFeedWarning(snapshot, options.account), options.ownerSession);
      }
    }
    return publishUsageSnapshot(state, snapshot, options.account, () => recordUsageHistory(options.account?.name ?? "default", fresh.windows ?? [fresh], fresh.checkedAt));
  });
  return { usage, snapshot: stored };
}

export function warnCachedUsageBeforeLaunch(account?: AccountChoice) {
  warnExpiringResetCredits();
  const snapshot = readUsageSnapshot(account);
  if (!snapshot || !snapshotReached(snapshot)) return;
  const checkedAt = Date.parse(snapshot.checkedAt);
  const age = Date.now() - checkedAt;
  if (!Number.isFinite(checkedAt) || age < 0 || age >= 6 * 60 * 60 * 1000) return;
  const owner = account ? `account ${account.name} usage` : "usage";
  console.error(color.red(`cdx: WARNING: OpenAI Codex ${owner} ${snapshot.usedPercent}% consumed; resets ${rateLimitResetDate(snapshot.resetsAt)}`));
}

interface ReachedAccount { choice: AccountChoice; snapshot: UsageSnapshot }

export interface AccountSelection { choice?: AccountChoice; skipped: ReachedAccount[]; pick?: AccountStanding; demand?: Demand }

// Active lanes reserve 3%; sparse sizing evidence uses the same fallback.
export const HEADROOM_PERCENT: Record<Demand, number> = { light: 3, work: 3, supervisor: 3 };

// A usage reading serves this long before the next launch probes again.
const USAGE_CACHE_MS = 30 * 60 * 1000;

const DEMAND_LABEL: Record<Demand, string> = { light: "consult/review", work: "work", supervisor: "supervisor" };

interface AccountStanding {
  choice: AccountChoice;
  snapshot?: UsageSnapshot;
  creditSnapshot?: UsageSnapshot;
  sizing?: Record<Demand, { minimumPercent: number; samples: number; medianTokens: number | null }>;
  // The longest window the probe returned, weekly on ChatGPT plans. Its reset
  // is the deadline: whatever is unspent then is lost.
  weekly?: RateLimitWindow;
  remainingPercent: number;
  projections?: WindowProjection[];
  heldPercent?: number;
  reached: boolean;
  reason: string;
}

// A snapshot stops being evidence once any of its windows has reset: the
// percentages belong to the old window.
function snapshotExpired(snapshot: UsageSnapshot): boolean {
  const now = Date.now();
  return (snapshot.windows ?? [snapshot]).some((window) => window.resetsAt * 1000 <= now);
}

function unknownStanding(choice: AccountChoice, reason: string): AccountStanding {
  return { choice, remainingPercent: 0, reached: false, reason: `usage unknown: ${reason}` };
}

export function standingOf(choice: AccountChoice, snapshot: UsageSnapshot | undefined, history: UsageReading[] = [], now = Date.now()): AccountStanding {
  const unknown = (reason: string): AccountStanding => ({ ...unknownStanding(choice, reason), creditSnapshot: snapshot });
  if (snapshot?.exhaustedUntil && snapshot.exhaustedUntil * 1000 > now && !isExhaustionObsolete(snapshot, now)) return {
    choice, snapshot, reached: true, remainingPercent: 0,
    reason: `quota exhausted; resets ${new Date(snapshot.exhaustedUntil * 1000).toISOString()}`,
  };
  if (snapshot?.invalidatedAt) return unknown("consuming round ended; refresh required");
  if (!snapshot || snapshot.planType === "unknown") return unknown("probe failed; codex login?");
  const weekly = weeklyWindow(snapshot);
  if (!weekly) return unknown("snapshot has no quota windows; run cdx usage");
  if (weekly.resetsAt * 1000 <= now) return unknown("window reset; probe failed");
  // A reading older than the cache window that the last probe could not
  // confirm is history, not headroom. A fresh reading survives a failed
  // probe: it would not have been probed at all.
  const probeFailedAt = snapshot.probeFailedAt ? Date.parse(snapshot.probeFailedAt) : Number.NaN;
  if (probeFailedAt > Date.parse(snapshot.checkedAt) && !snapshotFresh(snapshot, USAGE_CACHE_MS, now)) {
    return unknown(`probe failed; last reading ${((now - Date.parse(snapshot.checkedAt)) / 3_600_000).toFixed(1)}h ago said ${Math.round(100 - weekly.usedPercent)}% left`);
  }
  const live = (snapshot.windows ?? [snapshot]).filter((window) => window.resetsAt * 1000 > now);
  const reached = snapshotReached(snapshot, now) || live.some((window) => window.usedPercent >= 99);
  // Exact share for decisions; the text rounds.
  const projections = live.map((w) => projectWindow(choice.name, w, snapshot.checkedAt, history, now));
  const remainingPercent = Math.min(...projections.map((w) => w.remainingPercent));
  const base = { choice, snapshot, weekly, projections, remainingPercent, reached };
  const limiting = projections.find((w) => w.hoursToExhaustion !== null);
  const deadline = Math.min(...live.map((w) => w.resetsAt));
  const burn = projections.find((w) => w.resetsAt === deadline)!;
  return { ...base, reason: reached ? "hold; quota exhausted" : limiting
    ? `light only; exhausts in ${limiting.hoursToExhaustion!.toFixed(1)}h`
    : `${Math.round(remainingPercent)}% left, reset ${fmtUntil(deadline, now)}, burn ${burn.burnPerHour === null ? "unknown" : `${burn.burnPerHour.toFixed(1)}%/h`}, at reset ${burn.projectedRemainingAtReset === null ? "unknown" : `${burn.projectedRemainingAtReset.toFixed(1)}%`}` };
}

export function exhausting(standing: AccountStanding): boolean {
  return standing.projections?.some((w) => w.hoursToExhaustion !== null) ?? false;
}

function standingTier(standing: AccountStanding, demand: Demand): number {
  if (standing.reached) return 3;
  if (!standing.snapshot) return 2;
  return !exhausting(standing) && accountEligible(standing, demand) ? 0 : 1;
}

export function rankAccounts(standings: AccountStanding[], demand: Demand, now = Date.now()): AccountStanding[] {
  return standings.map((standing, index) => ({ standing, index })).sort((a, b) => {
    const tier = standingTier(a.standing, demand);
    const tierDelta = tier - standingTier(b.standing, demand);
    if (tierDelta !== 0) return tierDelta;
    if (tier === 0) {
      const deadlineOf = (s: AccountStanding) => s.projections
        ? Math.min(...s.projections.filter((w) => w.resetsAt * 1000 > now && (w.projectedRemainingAtReset === null || w.projectedRemainingAtReset > 0)).map((w) => w.resetsAt))
        : s.weekly?.resetsAt ?? Infinity;
      const deadline = deadlineOf(a.standing) - deadlineOf(b.standing);
      if (!Number.isNaN(deadline) && deadline !== 0) return deadline;
      return b.standing.remainingPercent - a.standing.remainingPercent;
    }
    if (tier === 1) return b.standing.remainingPercent - a.standing.remainingPercent;
    if (tier === 3) return (a.standing.snapshot?.exhaustedUntil ?? a.standing.snapshot?.resetsAt ?? Infinity) - (b.standing.snapshot?.exhaustedUntil ?? b.standing.snapshot?.resetsAt ?? Infinity);
    return a.index - b.index;
  }).map(({ standing }) => standing);
}

// Eligibility is shared by launch and usage advice. Unknown evidence is a
// fallback after sufficient known capacity; light turns admit with warnings.
function accountEligible(standing: AccountStanding, demand: Demand): boolean {
  if (standing.reached || (demand !== "light" && exhausting(standing))) return false;
  if (!standing.snapshot) return true;
  if (demand === "light") return standing.remainingPercent > 0;
  return standing.projections?.length
    ? standing.projections.every((w) => w.remainingPercent - (standing.heldPercent ?? 0) >= requiredPercent(standing, demand, w))
    : standing.remainingPercent >= requiredPercent(standing, demand);
}

export function decideAccount(standings: AccountStanding[], demand: Demand, now = Date.now()): AccountStanding | undefined {
  return rankAccounts(standings.filter((standing) => accountEligible(standing, demand)), demand, now)[0];
}

// A cached snapshot serves for 30 minutes unless a window has reset or it
// predates per-window storage; after a failed refresh the stale copy stays
// on disk and standingOf decides how much of it to trust.
async function accountSnapshot(choice: AccountChoice): Promise<UsageSnapshot | undefined> {
  const cached = readUsageSnapshot(choice);
  const usable = Boolean(cached && !cached.invalidatedAt && snapshotFresh(cached, USAGE_CACHE_MS) && cached.windows !== undefined && !snapshotExpired(cached));
  if (usable || (cached && !cached.invalidatedAt && probeFailedRecently(cached))) return cached;
  const refreshed = await refreshUsageSnapshot({ account: choice });
  // A failed refresh writes its marker beside the old reading; read it back
  // so the standing sees the failure.
  return refreshed?.snapshot ?? readUsageSnapshot(choice);
}

export function accountChoices(): AccountChoice[] {
  return Object.entries(config.accounts ?? { default: process.env.CODEX_HOME ?? `${HOME}/.codex` }).map(([name, home]) => ({ name, home }));
}

export async function accountStandings(): Promise<AccountStanding[]> {
  const standings = await Promise.all(accountChoices().map(async (choice) => {
    return standingOf(choice, await accountSnapshot(choice), readUsageHistory());
  }));
  return withAccountHolds(standings, readLedger());
}

export function cachedAccountStandings(ledger = readLedger()): AccountStanding[] {
  return withAccountHolds(accountChoices().map((choice) => {
    return standingOf(choice, readUsageSnapshot(choice), readUsageHistory());
  }), ledger);
}

interface AccountAdvice {
  order: string[];
  picks: Record<Demand, string | null>;
  accounts: Array<{ account: string; remainingPercent: number; reached: boolean; resetsAt?: number; projections?: WindowProjection[]; heldPercent: number; sizing?: AccountStanding["sizing"]; reason: string }>;
  resetCredits: Array<{ account: string; count: number; expiresAt: number[]; redeem: boolean }>;
  alerts: string[];
}

export function shouldRedeemCredit(standing: AccountStanding): boolean {
  return ((standing.creditSnapshot ?? standing.snapshot)?.resetCreditsAvailable ?? 0) > 0 && (standing.reached || exhausting(standing));
}

// Redeem only for exhaustion, observed or already reached.
function resetCreditStandings(standings: AccountStanding[]): AccountAdvice["resetCredits"] {
  return standings
    .filter((standing) => ((standing.creditSnapshot ?? standing.snapshot)?.resetCreditsAvailable ?? 0) > 0)
    .map((standing) => ({
      account: standing.choice.name,
      count: (standing.creditSnapshot ?? standing.snapshot)!.resetCreditsAvailable,
      expiresAt: (standing.creditSnapshot ?? standing.snapshot)!.resetCreditExpiresAt ?? [],
      redeem: shouldRedeemCredit(standing),
    }));
}

export function accountAdvice(standings: AccountStanding[], now = Date.now()): AccountAdvice {
  const ranked = rankAccounts(standings, "work", now);
  const pickFor = (demand: Demand) => decideAccount(standings, demand, now)?.choice.name ?? null;
  return {
    order: ranked.map((standing) => standing.choice.name),
    picks: { light: pickFor("light"), work: pickFor("work"), supervisor: pickFor("supervisor") },
    accounts: ranked.map((standing) => ({
      account: standing.choice.name,
      remainingPercent: standing.remainingPercent,
      reached: standing.reached,
      ...(standing.weekly ? { resetsAt: standing.weekly.resetsAt } : {}),
      projections: standing.projections, heldPercent: standing.heldPercent ?? 0, sizing: standing.sizing,
      reason: standing.reason,
    })),
    resetCredits: resetCreditStandings(standings),
    alerts: resetCreditAlerts(standings.map((standing) => ({ name: standing.choice.name, home: standing.choice.home, snapshot: standing.creditSnapshot ?? standing.snapshot })), now),
  };
}

export function adviceLines(standings: AccountStanding[], now = Date.now()): string[] {
  if (standings.length === 0) return [];
  const advice = accountAdvice(standings, now);
  const lines = [`picks: ${Object.entries(advice.picks).map(([demand, name]) => `${demand} ${name ?? "none"}`).join(" | ")}`];
  const notes = standings.flatMap((s) => {
    const credit = advice.resetCredits.find((c) => c.account === s.choice.name)?.redeem;
    const note = s.reached ? "hold; quota exhausted" : exhausting(s) ? "light only; projected exhaustion before reset"
      : !s.snapshot ? s.reason : s.heldPercent ? `${s.heldPercent}% held by running lanes` : "";
    return note || credit ? [`${s.choice.name}: ${note}${credit ? "; redeem one reset credit" : ""}.`] : [];
  });
  notes.push(...advice.alerts);
  if (notes.length) lines.push(notes.join(" "));
  return lines;
}

function snapshotFresh(snapshot: UsageSnapshot | undefined, maxAgeMs: number, now = Date.now()): boolean {
  if (!snapshot) return false;
  const checkedAt = Date.parse(snapshot.checkedAt);
  const age = now - checkedAt;
  return Number.isFinite(checkedAt) && age >= 0 && age < maxAgeMs;
}

// A cached reached=true snapshot stops being true the moment its window
// resets; without this check a post-reset account is skipped for up to the
// full cache TTL.
function snapshotReached(snapshot: UsageSnapshot, now = Date.now()): boolean {
  return snapshot.reached && snapshot.resetsAt * 1000 > now;
}

function probeFailedRecently(snapshot: UsageSnapshot | undefined): boolean {
  if (!snapshot?.probeFailedAt) return false;
  const failedAt = Date.parse(snapshot.probeFailedAt);
  return Number.isFinite(failedAt) && Date.now() - failedAt < 5 * 60 * 1000;
}

export function chooseAccount(standings: AccountStanding[], demand: Demand, forced?: string, preferred?: AccountChoice, now = Date.now()): AccountSelection {
  if (forced !== undefined && !standings.some((standing) => standing.choice.name === forced)) configuredAccount(forced);
  const pinned = standings.find((standing) => standing.choice.name === (forced ?? preferred?.name) && accountEligible(standing, forced !== undefined ? "light" : demand));
  const pick = pinned ?? (forced === undefined ? decideAccount(standings, demand, now) : undefined);
  if (!pick) {
    const detail = standings.map((standing) => `${standing.choice.name}: ${standing.reason}`).join("; ");
    throw new CmdError(`no account is eligible for a ${DEMAND_LABEL[demand]} lane (${detail}); wait for a reset or use gemini`);
  }
  return { choice: pick.choice, skipped: standings.filter((s) => s.reached && s.snapshot).map((s) => ({ choice: s.choice, snapshot: s.snapshot! })), pick, demand };
}

export function reconcileAccountHolds(ledger: Ledger): void {
  for (const [name, lane] of Object.entries(ledger)) {
    if (laneRunning(lane) && !pidAlive(lane.pid) && !pidAlive(lane.codexPid)) {
      failActiveRound(name, lane, "runner and engine exited; account hold released");
    }
  }
}

export function demandSizing(standing: AccountStanding, ledger: Ledger): NonNullable<AccountStanding["sizing"]> {
  const costs: Record<Demand, number[]> = { light: [], work: [], supervisor: [] };
  for (const lane of Object.values(ledger)) {
    const record = lane.kind === "review" ? lane.review : lane.work;
    if (roundEngine(lane) !== "gpt" || !record || !["done", "closed"].includes(record.state) || record.exitCode !== 0
      || record.tokensIncomplete || lane.tokensIncomplete || !lane.roundTokens) continue;
    const { input, output } = lane.roundTokens;
    if (![input, output].every((n) => Number.isFinite(n) && n >= 0) || input + output === 0) continue;
    const demand = lane.roundAccount?.demand ?? (lane.kind === "review" || lane.consult ? "light" : lane.supervisor ? "supervisor" : "work");
    costs[demand].push(input + output);
  }
  const size = (demand: Demand) => {
    const sorted = costs[demand].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    const medianTokens = sorted.length >= 5 ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
    const minimumPercent = demand === "light" ? 0 : medianTokens === null ? 3
      : Math.max(...(standing.projections?.length ? standing.projections.map((w) => w.tokensPerPercent && w.tokensPerPercent > 0 ? medianTokens / w.tokensPerPercent : 3) : [3]));
    return { minimumPercent, samples: sorted.length, medianTokens };
  };
  return { light: size("light"), work: size("work"), supervisor: size("supervisor") };
}

function requiredPercent(standing: AccountStanding, demand: Demand, window?: WindowProjection): number {
  if (window) {
    const median = standing.sizing?.[demand].medianTokens;
    return median != null && window.tokensPerPercent && window.tokensPerPercent > 0 ? median / window.tokensPerPercent : 3;
  }
  return standing.sizing?.[demand].minimumPercent ?? HEADROOM_PERCENT[demand];
}

export function withAccountHolds(standings: AccountStanding[], ledger: Ledger, alive = pidAlive): AccountStanding[] {
  return standings.map((standing) => {
    const held = Object.values(ledger).filter((lane) => laneRunning(lane)
      && (alive(lane.pid) || alive(lane.codexPid))
      && (lane.roundAccount?.home === standing.choice.home || (standing.choice.name === "default" && roundEngine(lane) === "gpt"
        && !lane.roundAccount && !lane.account && !lane.codexHome)))
      .reduce((total, lane) => total + HEADROOM_PERCENT[lane.roundAccount?.demand ?? "work"], 0);
    return { ...standing, sizing: demandSizing(standing, ledger), heldPercent: held, projections: standing.projections?.map((w) => ({ ...w, heldPercent: held })), remainingPercent: Math.max(0, standing.remainingPercent - held),
      reason: held ? `${standing.reason}; ${held}% held by active rounds` : standing.reason };
  });
}

export function announceAccountSelection(lane: string, selection: AccountSelection) {
  warnExpiringResetCredits();
  if (!selection.choice) return;
  const { pick, demand } = selection;
  if (pick && demand) {
    // The reason line explains a choice; one account is no choice. The
    // headroom warning stands on its own.
    if (Object.keys(config.accounts ?? {}).length > 1) console.log(`cdx: account=${color.bold(pick.choice.name)} for ${DEMAND_LABEL[demand]} lane: ${pick.reason}`);
    if (!pick.snapshot) {
      console.error(color.yellow(`cdx: WARNING: ${pick.choice.name} ${pick.reason}; ${lane} starts on it unverified`));
    } else if (demand === "light" && pick.remainingPercent < HEADROOM_PERCENT.light) {
      console.error(color.yellow(`cdx: WARNING: ${pick.choice.name} has ${Math.round(pick.remainingPercent)}% free capacity; ${lane} may hit the limit mid-run`));
    }
  }
  if (selection.skipped.length === 0) return;
  for (const { choice, snapshot } of selection.skipped) {
    const message = `[cdx] account ${choice.name} consumed (resets ${rateLimitResetDate(snapshot.exhaustedUntil ?? snapshot.resetsAt)}); ${lane} using ${selection.choice.name}`;
    console.error(color.yellow(message.replace(/^\[cdx\]/, "cdx:")));
  }
}

// An unused credit is money on the table; alert this many days before it lapses.
export const RESET_CREDIT_ALERT_DAYS = 3;

export function describeResetCredits(count: number, expiresAt: number[] = [], now = Date.now()): string {
  const label = count === 1 ? "reset credit" : "reset credits";
  if (count === 0 || expiresAt.length === 0) return `${count} ${label} available`;
  const expiries = expiresAt.map((at) => `${rateLimitResetDate(at)} ${fmtUntil(at, now)}`);
  return `${count} ${label} available, ${count === 1 ? "expires" : "expire"} ${expiries.join(" and ")}`;
}

function expiringResetCredits(snapshot: UsageSnapshot | undefined, now = Date.now()): number[] {
  const cutoff = now + RESET_CREDIT_ALERT_DAYS * 86_400_000;
  return (snapshot?.resetCreditExpiresAt ?? []).filter((at) => at * 1000 > now && at * 1000 <= cutoff);
}

// One line per account holding a credit inside the alert window; printed
// unconditionally by usage, doctor, and every GPT launch so it cannot be missed.
export function resetCreditAlerts(accounts: Array<{ name: string; home?: string; snapshot?: UsageSnapshot }>, now = Date.now()): string[] {
  return accounts.flatMap(({ name, home, snapshot }) => {
    const expiring = expiringResetCredits(snapshot, now);
    if (expiring.length === 0) return [];
    const count = expiring.length === 1 ? "an unused reset credit" : `${expiring.length} unused reset credits`;
    const when = expiring.map((at) => `${rateLimitResetDate(at)} ${fmtUntil(at, now)}`).join(" and ");
    const where = home ? `CODEX_HOME=${displayPath(home)} codex` : "codex";
    return [`CRITICAL: ${name} has ${count} expiring ${when}; inspect in the codex TUI (${where}, then /usage)`];
  });
}

export function configuredAccountSnapshots(): Array<{ name: string; home?: string; snapshot?: UsageSnapshot }> {
  if (!config.accounts) return [{ name: "codex", snapshot: readUsageSnapshot() }];
  return Object.entries(config.accounts).map(([name, home]) => ({ name, home, snapshot: readUsageSnapshot({ name, home }) }));
}

let resetCreditsWarned = false;

// Launch paths call this from more than one hook; one print per process.
function warnExpiringResetCredits(): void {
  if (resetCreditsWarned) return;
  resetCreditsWarned = true;
  for (const line of resetCreditAlerts(configuredAccountSnapshots())) console.error(color.red(`cdx: ${line}`));
}

export function formatAccountUsage(usage: AccountUsage): { detail: string; usedPercent: number } {
  const windows = [usage.primary, ...(usage.secondary ? [usage.secondary] : [])];
  const detail = windows.map((window) =>
    `${rateLimitWindowName(window.windowDurationMins)} window ${window.usedPercent}% used, resets ${rateLimitResetDate(window.resetsAt)}`
  ).join(", ");
  return {
    detail: `${usage.planType.toLowerCase()} plan, ${detail} (${describeResetCredits(usage.resetCredits, usage.resetCreditExpiresAt)})`,
    usedPercent: Math.max(...windows.map((window) => window.usedPercent)),
  };
}
