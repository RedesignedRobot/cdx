// Pure duration estimates and overrun notices. The caller owns scheduling.
import { CmdError } from "./runtime.ts";

export function expectMinutes(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new CmdError("--expect must be a positive number of minutes");
  return minutes;
}

export function historyMinutes(records: { startedAt?: string; finishedAt?: string }[], fallback: number): number {
  const values = records.filter(({ startedAt, finishedAt }) => Number.isFinite(Date.parse(startedAt ?? "")) && Number.isFinite(Date.parse(finishedAt ?? "")))
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!)).slice(0, 20)
    .map(({ startedAt, finishedAt }) => Date.parse(finishedAt ?? "") - Date.parse(startedAt ?? ""))
    .filter((ms) => Number.isFinite(ms) && ms > 0).map((ms) => ms / 60_000).sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)]! : fallback;
}

export function overrunNotice(startedAt: string, expectedMinutes: number, now: number, lastActivity?: string, lastLog?: string, lastActivityAt?: string): string | undefined {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || !Number.isFinite(expectedMinutes) || expectedMinutes <= 0 || now - started < expectedMinutes * 60_000) return;
  const elapsed = Math.floor((now - started) / 60_000);
  const activity = lastActivity ? ` lastActivity=${lastActivity.replace(/[\r\n]/g, " ").slice(0, 120)}` : "";
  const activityTime = lastActivityAt && Number.isFinite(Date.parse(lastActivityAt))
    ? ` lastActivityAt=${lastActivityAt} age=${Math.max(0, Math.floor((now - Date.parse(lastActivityAt)) / 60_000))}m` : "";
  const log = lastLog ? ` log=${lastLog.replace(/[\r\n]/g, " ")}` : "";
  return `expected ${expectedMinutes}m, elapsed ${elapsed}m;${activity}${activityTime}${log}`;
}

export function markOverrun(record: { overrunSent?: boolean }, startedAt: string, expectedMinutes: number, now: number,
  lastActivity?: string, lastLog?: string, lastActivityAt?: string): string | undefined {
  if (record.overrunSent) return;
  const notice = overrunNotice(startedAt, expectedMinutes, now, lastActivity, lastLog, lastActivityAt);
  if (notice) record.overrunSent = true;
  return notice;
}
