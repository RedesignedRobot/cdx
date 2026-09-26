import { isScopePermissionAsk, scopeAnswer } from "./brief-contract.ts";
import { geminiOverwrite } from "./cap.ts";
import { safeJSON } from "./safe-text.ts";
// Questions, steering delivery, peer messages, and the Gemini invocation hook.

import {
  callerSession, feedEvent, findLane, inboxEvents, laneRunning, readLedger, renderEvent, requireOwnChild, withLedger,
} from "./ledger.ts";
import { createHash } from "node:crypto";
import { readGeminiUsageSnapshot } from "./gemini-usage.ts";
import { captureRecoveryPartial, logPathOf, controlPathOf, logProgress } from "./reports.ts";
import { CmdError, fail, fmtAge, parseArgs, pidAlive, resolveBrief, ROOT, singleLine } from "./runtime.ts";
import { db, write } from "./store.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const deliveredPathOf = (lane: string, round: number) => `${ROOT}/control/${lane}-r${round}.delivered`;

export function readDeliveredCount(lane: string, round: number): number {
  const path = deliveredPathOf(lane, round);
  try {
    const text = readFileSync(path, "utf8").trim();
    const count = Number(text);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

export function writeDeliveredCount(lane: string, round: number, count: number): void {
  const path = deliveredPathOf(lane, round);
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${count}\n`);
}

// A record cdx wrote itself is announced as a notice, never as a head steer,
// so a supervisor can tell harness facts from instructions.
export function controlText(record: ControlRecord): string {
  return record.from === "cdx" ? `CDX NOTICE (sent ${record.sentAt}): ${record.text}` : record.text;
}

// A child's outage or failure reaches its supervisor through the control
// file, the same path a head steer takes, so the supervisor hears it inside
// its own turn instead of finding out at the next cdx wait. Nothing is
// written when the parent round has ended or stopped taking steers.
export function notifyParent(lane: string, text: string): void {
  const ledger = readLedger();
  const entry = ledger[lane];
  const parent = entry?.parent;
  const parentRound = entry?.parentRound;
  if (!parent || !parentRound) return;
  const parentEntry = ledger[parent];
  if (!parentEntry || !laneRunning(parentEntry) || parentEntry.rounds !== parentRound || parentEntry.steerOpen === false) return;
  const record: ControlRecord = { text: singleLine(text), sentAt: new Date().toISOString(), from: "cdx" };
  write(() => { writeFileSync(controlPathOf(parent, parentRound), `${safeJSON(record)}\n`, { flag: "a" }); });
}

export interface ControlRecord {
  text: string;
  sentAt: string;
  from?: string;
}

// Commands

export interface QuestionRecord {
  lane: string;
  round: number;
  seq: number;
  question: string;
  askedAt: string;
  answered: boolean;
  owner?: string;
  answer?: string;
  answeredAt?: string;
  timedOutAt?: string;
  expiredAt?: string;
  status?: "expired: round ended";
}

function readQuestion(lane: string, seq: number): QuestionRecord | undefined {
  const row = db().query<{ data: string }, [string, number]>("SELECT data FROM questions WHERE lane = ? AND seq = ?").get(lane, seq);
  return row ? JSON.parse(row.data) : undefined;
}

// Questions oldest first, for one lane or all.
export function readQuestions(lane?: string): QuestionRecord[] {
  const rows = lane
    ? db().query<{ data: string }, [string]>("SELECT data FROM questions WHERE lane = ?").all(lane)
    : db().query<{ data: string }, []>("SELECT data FROM questions").all();
  return rows.map((row) => JSON.parse(row.data) as QuestionRecord).sort((left, right) => Date.parse(left.askedAt) - Date.parse(right.askedAt));
}

export function storeQuestion(record: QuestionRecord): void {
  db().query("INSERT OR REPLACE INTO questions (lane, seq, round, data) VALUES (?, ?, ?, ?)").run(record.lane, record.seq, record.round, JSON.stringify(record));
}

export function questionOpen(record: QuestionRecord): boolean {
  return !record.answered && !record.timedOutAt && !record.expiredAt;
}

export function expireRoundQuestions(lane: string, round: number): void {
  const expiredAt = new Date().toISOString();
  write(() => {
    for (const record of readQuestions(lane)) {
      if (record.round !== round || !questionOpen(record)) continue;
      record.expiredAt = expiredAt;
      record.status = "expired: round ended";
      storeQuestion(record);
    }
  });
}

export async function sendCommand(argv: string[]): Promise<void> {
  const [lane, ...parts] = argv;
  const usage = 'usage: cdx send <lane> "<text>"';
  const rawText = parts.length === 1 && parts[0] === "-" ? "-" : parts.join(" ");
  const textArg = await resolveBrief(rawText, usage);
  const text = textArg ? singleLine(textArg) : "";
  if (!lane || !text) fail(usage);
  const record: ControlRecord = {
    text,
    sentAt: new Date().toISOString(),
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { from: process.env.CLAUDE_CODE_SESSION_ID } : {}),
  };
  requireOwnChild(lane, readLedger()[lane]);
  const entry = withLedger((ledger) => {
    const current = ledger[lane];
    requireOwnChild(lane, current);
    if (!current) throw new CmdError(`unknown lane "${lane}" (cdx status lists lanes)`);
    if (!laneRunning(current) || !pidAlive(current.pid)) throw new CmdError(`lane "${lane}" is not running`);
    if (current.steerOpen === false) throw new CmdError(`lane "${lane}" is finishing and no longer accepts steering`);
    writeFileSync(controlPathOf(lane, current.rounds), `${safeJSON(record)}\n`, { flag: "a" });
    return current;
  });
  console.log(`cdx: lane=${lane} round=${entry.rounds} steer queued`);
}

export async function askCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["timeout"]);
  const question = singleLine(parsed.rest.join(" "));
  if (!question) fail('usage: cdx ask [--timeout <min>] "<question>"');
  const lane = process.env.CDX_LANE?.trim();
  const round = Number(process.env.CDX_ROUND);
  const owner = process.env.CDX_OWNER?.trim();
  if (!lane || !Number.isInteger(round) || round < 1) {
    fail("cdx ask must run inside a cdx work lane with CDX_LANE and CDX_ROUND set");
  }
  const requestedTimeout = Number(parsed.flags.timeout ?? 30);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) fail("--timeout must be a positive number of minutes");
  const timeoutMinutes = Math.min(requestedTimeout, 30);
  if (requestedTimeout > 30) console.error(`cdx: --timeout ${requestedTimeout}m exceeds the 30m limit; using 30m`);
  // The scope policy answers "may I edit outside my files" so the head never sees it.
  const policy = findLane(lane)?.scopePolicy;
  const autoAnswer = policy && policy !== "ask" && isScopePermissionAsk(question) ? scopeAnswer(policy) : undefined;
  const created = write(() => {
    const seq = readQuestions(lane).reduce((highest, item) => Math.max(highest, item.seq), 0) + 1;
    const askedAt = new Date().toISOString();
    const record: QuestionRecord = {
      lane,
      round,
      seq,
      question,
      askedAt,
      answered: autoAnswer !== undefined,
      ...(autoAnswer ? { answer: autoAnswer, answeredAt: askedAt } : {}),
      ...(owner ? { owner } : {}),
    };
    storeQuestion(record);
    return record;
  });
  if (autoAnswer) {
    logProgress(lane, round, `answered question=${lane}:r${round}:q${created.seq} from scope policy ${policy}`);
    console.log(autoAnswer);
    return;
  }
  feedEvent("question", `[cdx] lane=${lane} round=${round} QUESTION #${created.seq}: ${question} (answer with: cdx reply ${lane} "<answer>")`, owner, { lane, round });
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (Date.now() < deadline) {
    const current = readQuestion(lane, created.seq);
    if (current?.answered) {
      console.log(current.answer ?? "");
      return;
    }
    if (current?.expiredAt) {
      console.log("cdx ask expired because the round ended. Take the conservative reading, record the deviation in the lane report, and continue.");
      return;
    }
    await Bun.sleep(Math.min(1000, Math.max(10, deadline - Date.now())));
  }
  const outcome = write(() => {
    const current = readQuestion(lane, created.seq) ?? created;
    if (current.answered) return current;
    current.timedOutAt = new Date().toISOString();
    storeQuestion(current);
    return current;
  });
  if (outcome.answered) {
    console.log(outcome.answer ?? "");
    return;
  }
  console.log("cdx ask timed out. No approval was received. Continue independent authorized work and report the unresolved dependency; do not guess a required answer.");
}

export async function replyCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["id"]);
  const [lane, ...parts] = parsed.rest;
  const usage = 'usage: cdx reply <lane> [--id <seq>] "<answer>"';
  const rawAnswer = parts.length === 1 && parts[0] === "-" ? "-" : parts.join(" ");
  const answerArg = await resolveBrief(rawAnswer, usage);
  const answer = answerArg ? singleLine(answerArg) : "";
  if (!lane || !answer) fail(usage);
  const requestedId = parsed.flags.id === undefined ? undefined : Number(parsed.flags.id);
  if (requestedId !== undefined && (!Number.isInteger(requestedId) || requestedId < 1)) fail("--id must be a positive integer");
  requireOwnChild(lane, readLedger()[lane]);
  const answered = withLedger((ledger) => {
    requireOwnChild(lane, ledger[lane]);
    const currentRound = ledger[lane]?.rounds;
    if (!currentRound) throw new CmdError(`unknown lane "${lane}" (cdx status lists lanes)`);
    const open = readQuestions(lane).filter((record) => record.round === currentRound && questionOpen(record));
    const current = requestedId === undefined ? open[0] : open.find((record) => record.seq === requestedId);
    if (!current) throw new CmdError(requestedId === undefined
      ? `lane "${lane}" has no open questions`
      : `lane "${lane}" has no open question #${requestedId}`);
    current.answered = true;
    current.answer = answer;
    current.answeredAt = new Date().toISOString();
    storeQuestion(current);
    return current;
  });
  logProgress(lane, answered.round, `answered question=${lane}:r${answered.round}:q${answered.seq} answer=${answer}`);
  console.log(`cdx: answered lane=${lane} question #${answered.seq}`);
}

export function questionsCommand(argv: string[]): void {
  const [lane, extra] = argv;
  if (extra) fail("usage: cdx questions [lane]");
  const ledger = readLedger();
  if (lane && !ledger[lane]) fail(`unknown lane "${lane}" (cdx status lists lanes)`);
  const open = readQuestions(lane).filter((record) => questionOpen(record) && ledger[record.lane]?.rounds === record.round);
  if (open.length === 0) {
    console.log(lane ? `cdx: lane=${lane} has no open questions` : "cdx: no open questions");
    return;
  }
  for (const record of open) {
    console.log(`${record.lane} r${record.round} QUESTION #${record.seq} asked ${fmtAge(record.askedAt)} ago: ${record.question}`);
  }
}

export async function msgCommand(argv: string[]): Promise<void> {
  const [target, ...parts] = argv;
  const usage = 'usage: cdx msg <target> "<text>"';
  const rawMessage = parts.length === 1 && parts[0] === "-" ? "-" : parts.join(" ");
  const messageArg = await resolveBrief(rawMessage, usage);
  const message = messageArg ? singleLine(messageArg) : "";
  if (!target || !message) fail(usage);
  const caller = process.env.CDX_LANE?.trim() || callerSession();
  if (caller === "terminal") fail("cdx msg needs a Claude session or a lane");
  // A lane name addresses the head, the one owner of every lane.
  const recipient = findLane(target) ? undefined : target;
  if (recipient !== undefined && recipient.length <= 8) fail("message target must be a lane name or full session id");
  feedEvent("message", message, caller, { ...(recipient ? { recipient } : {}), from: caller });
  console.log(`cdx: message sent to=${recipient ?? "head"} from=${caller}`);
}

export function inboxCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["n"]);
  if (parsed.rest.length) fail("usage: cdx inbox [-n <lines>]");
  const limit = Number(parsed.flags.n ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail("-n must be a positive integer");
  const messages = inboxEvents(callerSession(), limit).map(renderEvent);
  console.log(messages.length ? messages.join("\n") : "cdx: inbox empty");
}

export async function hookCommand(argv: string[]): Promise<void> {
  const [subcommand] = argv;
  const isPreTool = subcommand === "pre-tool";
  const passThrough = (): never => {
    console.log(isPreTool ? JSON.stringify({ decision: "allow" }) : "{}");
    process.exit(0);
  };
  try {
    const rawStdin = await Bun.stdin.text();
    let input: any;
    try {
      input = JSON.parse(rawStdin);
    } catch {
      passThrough();
    }
    const lane = process.env.CDX_LANE;
    if (!lane || typeof input !== "object" || input === null) {
      return passThrough();
    }

    const round = Number(process.env.CDX_ROUND);
    const entry = readLedger()[lane];
    if (!entry || entry.rounds !== round || !laneRunning(entry)) return passThrough();
    if (subcommand === "post-invocation") {
      const policy = invocationPolicy(entry.modelCalls ?? 0);
      if (policy.terminationBehavior) {
        captureRecoveryPartial(lane, round, entry.kind === "review" ? entry.review!.cwd : entry.work.cwd);
        withLedger((ledger) => { ledger[lane]!.callLimitHit = true; });
      }
      console.log(JSON.stringify(policy));
      return;
    }
    if (subcommand === "pre-tool") {
      const call = input.toolCall;
      const overwrite = geminiOverwrite(call, process.env);
      if (overwrite) { console.log(JSON.stringify({ decision: "allow", overwrite })); return; }
      if (/^(view_file|read_file|read)$/.test(call?.name ?? "")) {
        const args = call.args ?? {};
        const file = args.AbsolutePath ?? args.TargetFile ?? args.file_path ?? args.path;
        if (typeof file === "string") {
          const path = resolve(entry.kind === "review" ? entry.review!.cwd : entry.work.cwd, file);
          const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
          const records = readFileSync(logPathOf(lane, round, true), "utf8").split("\n").flatMap((line) => {
            if (!line.includes('"cdx_tool"')) return [];
            try { return [JSON.parse(line)]; } catch { return []; }
          });
          const reason = unchangedRead(records, path, hash, args.StartLine ?? args.start_line, args.EndLine ?? args.end_line);
          if (reason) { console.log(JSON.stringify({ decision: "deny", reason })); return; }
        }
      }
      return passThrough();
    }

    if (subcommand === "pre-invocation") {
      const ledger = readLedger();
      const entry = ledger[lane];
      if (!entry) return passThrough();
      const currentRound = process.env.CDX_ROUND;
      const isReview = entry.kind === "review" || (entry.review?.state === "running" && currentRound !== undefined && String(entry.review?.round) === String(currentRound));
      if (entry.kind !== "work" && !isReview) {
        console.log("{}");
        return;
      }
      const round = Number(currentRound ?? entry.rounds);
      if (!Number.isFinite(round) || round < 1) {
        console.log("{}");
        return;
      }

      const injectSteps: Array<{ userMessage: string }> = [];
      withLedger((ledger) => {
        const item = ledger[lane]!;
        item.modelCalls = (item.modelCalls ?? 0) + 1;
        injectSteps.push(...(invocationPolicy(item.modelCalls).injectSteps ?? []));
        const snapshot = readGeminiUsageSnapshot();
        if (!item.quotaWrapSent && snapshot && Date.parse(snapshot.fiveHour.resetsAt) > Date.now() && snapshot.fiveHour.remainingPercent < 10) {
          item.quotaWrapSent = true;
          injectSteps.push({ userMessage: "Gemini quota is below 10 percent. Stop editing and write your partial handoff report now." });
        }
      });
      withLedger((led) => {
        const item = led[lane];
        if (!item) return;
        const path = controlPathOf(lane, round);
        if (!existsSync(path)) return;
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
        const delivered = readDeliveredCount(lane, round);
        if (delivered >= lines.length) return;

        let newlyDelivered = 0;
        for (let i = delivered; i < lines.length; i++) {
          const line = lines[i]!;
          let record: ControlRecord;
          try {
            record = JSON.parse(line) as ControlRecord;
          } catch {
            continue;
          }
          if (typeof record.text !== "string" || !record.text.trim()) continue;
          injectSteps.push({
            userMessage: record.from === "cdx" ? controlText(record) : `HEAD STEER (sent ${record.sentAt}): ${record.text}`,
          });
          newlyDelivered += 1;
          const flat = singleLine(record.text);
          logProgress(lane, round, `steer delivered mode=in-turn: ${flat.slice(0, 120)}`);
        }
        writeDeliveredCount(lane, round, lines.length);
        if (newlyDelivered > 0) {
          item.steers = (item.steers ?? 0) + newlyDelivered;
          item.updatedAt = new Date().toISOString();
        }
      });

      if (injectSteps.length === 0) {
        console.log("{}");
      } else {
        console.log(JSON.stringify({ injectSteps }));
      }
      return;
    }

    passThrough();
  } catch {
    passThrough();
  }
}

export function unchangedRead(records: any[], path: string, hash: string, start = 1, end = Number.MAX_SAFE_INTEGER): string | undefined {
  for (const record of records) {
    if (record.type !== "cdx_tool" || record.toolKind !== "read" || record.failed || record.readFiles?.[path] !== hash || (record.readFilesAfter && record.readFilesAfter[path] !== hash)) continue;
    const range = record.readRange;
    if (!range || start < (range.start ?? 1) || end > (range.end ?? Number.MAX_SAFE_INTEGER)) continue;
    return `unchanged since step ${record.step ?? record.id}; content is already in context`;
  }
}

export function invocationPolicy(calls: number): { injectSteps?: Array<{ userMessage: string }>; terminationBehavior?: string } {
  if (calls >= 250) return { terminationBehavior: "terminate" };
  return calls === 240 ? { injectSteps: [{ userMessage: "Ten calls remain in this round. Stop editing and write a handoff report now, with completed work, remaining work, and evidence paths." }] } : {};
}
