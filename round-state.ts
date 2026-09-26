// Failed-round reconciliation and stopping lanes or their children.

import { killJob, readJobs } from "./jobs.ts";
import {
  activeStateOf, feedEvent, type Lane, laneRunning, readLane, readLedger, requireOwnChild, roundEngine,
  roundNoteOf, roundReportOf, supervisorLane, withLedger, workCwdOf,
} from "./ledger.ts";
import { expireRoundQuestions } from "./questions.ts";
import { availableReportPath, captureRecoveryPartial, logPathOf, logProgress } from "./reports.ts";
import { CmdError, color, coloredState, completionVerdict, fail, pidAlive, singleLine } from "./runtime.ts";
import { invalidateAccountUsage } from "./usage-store.ts";

export function failActiveRound(lane: string, item: Lane, note: string): void {
  captureRecoveryPartial(lane, item.rounds, item.kind === "review" ? item.review!.cwd : workCwdOf(item));
  if (roundEngine(item) === "gpt") invalidateAccountUsage(item.roundAccount);
  item.switchingAccount = undefined;
  item.outageFallbackPending = undefined;
  item.outage = undefined;
  const now = new Date().toISOString();
  const report = availableReportPath(lane, item.rounds);
  if (report?.endsWith(".partial.md")) note = `${singleLine(note)}; partial report=${report}`;
  if (item.kind === "review") {
    item.review!.report = report;
    item.review!.state = "failed";
    item.review!.note = note;
    item.review!.updatedAt = now;
  } else {
    item.work.report = report;
    item.work.state = "failed";
    item.work.note = note;
    item.work.updatedAt = now;
  }
  item.pid = undefined;
  item.codexPid = undefined;
  item.updatedAt = now;
  expireRoundQuestions(lane, item.rounds);
}

// SIGTERM first: the runner's reap handler kills its codex child and finalizes
// the round itself (signal note, feed line). Only a runner that fails to
// finalize within 10s, or a dead runner with a live codex orphan, gets the
// force path: SIGKILL what remains and finalize the ledger here.
export async function killCommand(argv: string[]) {
  const [lane, note] = argv;
  if (!lane) fail('usage: cdx kill <lane|job> ["note"]');
  if (!readLedger()[lane]) {
    const job = readJobs()[lane];
    if (job) {
      if (supervisorLane()) fail(`supervisor ${supervisorLane()} may not stop jobs; jobs belong to the liaison`);
      await killJob(lane, job, note);
      return;
    }
  }
  const entry = readLane(lane);
  requireOwnChild(lane, entry);
  if (!laneRunning(entry)) fail(`lane "${lane}" is not running (latest ${entry.kind} state ${activeStateOf(entry)})`);
  await killLane(lane, entry, note);
  if (entry.supervisor) await killChildren(lane, note ? `${note} (supervisor ${lane} killed)` : `supervisor ${lane} killed`);
}

// Stopping a supervisor takes its running children with it; nothing else
// would ever collect them. Every child gets its turn: one whose processes
// already died is reported and left to cdx doctor, never a reason to skip
// the rest. Returns the names of the children that were running.
export async function killChildren(supervisor: string, note: string): Promise<string[]> {
  const children = Object.entries(readLedger()).filter(([, item]) => item.parent === supervisor && laneRunning(item));
  const names: string[] = [];
  for (const [child, item] of children) {
    names.push(child);
    console.log(`cdx: lane=${color.magenta(child)} is a child of ${supervisor}; stopping it too`);
    try { await killLane(child, item, note); }
    catch (error) {
      if (!(error instanceof CmdError)) throw error;
      console.error(color.yellow(`cdx: ${error.message}`));
    }
  }
  return names;
}

async function killLane(lane: string, entry: Lane, note?: string) {
  captureRecoveryPartial(lane, entry.rounds, entry.kind === "review" ? entry.review!.cwd : workCwdOf(entry), true);
  logProgress(lane, entry.rounds, `kill requested reason=${note ?? "caller requested stop"} partial=${availableReportPath(lane, entry.rounds) ?? "unavailable"}`);
  const runnerAlive = pidAlive(entry.pid);
  if (!runnerAlive && !pidAlive(entry.codexPid)) {
    throw new CmdError(`lane "${lane}" is marked running but its runner and codex child are both dead; run cdx doctor --fix`);
  }
  if (runnerAlive) {
    try { process.kill(entry.pid!, "SIGTERM"); } catch { /* exited between check and kill */ }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = readLedger()[lane];
      if (current && !laneRunning(current)) {
        if (note) {
          withLedger((ledger) => {
            const item = ledger[lane];
            if (item) {
              if (item.kind === "review") item.review!.note = item.review!.note ? `${item.review!.note}; ${note}` : note;
              else item.work.note = item.work.note ? `${item.work.note}; ${note}` : note;
              item.updatedAt = new Date().toISOString();
            }
          });
        }
        console.log(`cdx: lane=${color.magenta(lane)} stopped; runner finalized ${current.kind} state=${coloredState(activeStateOf(current))}${roundNoteOf(current) ? ` note=${roundNoteOf(current)}` : ""}`);
        return;
      }
      await Bun.sleep(250);
    }
  }
  const current = readLedger()[lane] ?? entry;
  for (const pid of [current.codexPid, current.pid]) {
    if (pidAlive(pid)) { try { process.kill(pid!, "SIGKILL"); } catch { /* exited between check and kill */ } }
  }
  const finalized = withLedger((ledger) => {
    const item = ledger[lane]!;
    failActiveRound(lane, item, note ? `killed: ${note}` : "killed");
    if (item.kind === "review") item.review!.exitCode = undefined;
    else item.work.exitCode = undefined;
    return item;
  });
  feedEvent("terminal", `[cdx] lane=${lane} round=${finalized.rounds} kind=${finalized.kind} state=failed note=${roundNoteOf(finalized)} report=${roundReportOf(finalized) ?? "-"} log=${logPathOf(lane, finalized.rounds, true)} gateExit=not-run verdict=${JSON.stringify(completionVerdict("failed", roundNoteOf(finalized)))}`, finalized.ownerSession, { lane, round: finalized.rounds });
  console.log(`cdx: lane=${color.magenta(lane)} killed; ${finalized.kind} state=${coloredState("failed")} note=${roundNoteOf(finalized)}`);
}
