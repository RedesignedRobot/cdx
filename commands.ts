// CLI help, command restrictions, and dispatch.

import { primaryAccount } from "./accounts.ts";
import {
  config, ENGINE_PICKER, engineOf, modelAliases, modelOf, requireEngineBinary, resolveEffort,
} from "./config.ts";
import { doctorCommand } from "./doctor.ts";
import { geminiTranscriptPath } from "./engines.ts";
import { gateCommand, gateReceiptCommand } from "./gates.ts";
import { jobCommand, readJobs, runJob } from "./jobs.ts";
import {
  codeQuestionCommand, cleanCommand, consultCommand, resumeCommand, reviewCommand, spawnCommand,
} from "./lane-commands.ts";
import {
  callerOwnership, laneRunning, readLane, readLedger, requireOwnChild, supervisorLane, validLane, withLedger,
} from "./ledger.ts";
import {
  askCommand, hookCommand, inboxCommand, msgCommand, questionsCommand, replyCommand, sendCommand,
} from "./questions.ts";
import {
  followAll, followLane, latestRoundLog, logPathOf, renderTail, reportPathOf, toolLogRecords,
} from "./reports.ts";
import { killCommand } from "./round-state.ts";
import { runRound } from "./runner.ts";
import { CONFIG_PATH, fail, parseArgs, pidAlive, resolveBrief, singleLine } from "./runtime.ts";
import { briefCommand, eventsCommand, feedCommand } from "./session-commands.ts";
import { migrateCommand } from "./migrate.ts";
import { statusCommand, tailView, targetView, usageCommand, waitCommand } from "./status.ts";
import { renderView, tuiEnabled } from "./tui.ts";
import { viewCommand } from "./view.ts";
import { contextCommand } from "./context.ts";
import { landCommand, closeKeepsWorktree, removeWorktree, worktreeCleanupCommands } from "./worktrees.ts";
import { existsSync, readFileSync } from "node:fs";

const USAGE = `cdx tracks Codex and Gemini execution lanes
cdx policy: model ${config.model}${modelAliases() ? ` (aliases ${modelAliases()})` : ""}; efforts ${config.efforts.join(", ")}; default effort ${config.defaultEffort}; set in ${CONFIG_PATH}

Engines:
${ENGINE_PICKER}

  land <lane> | land --batch <lane>...     Gate the merge result once, fast-forward the base, push, remove worktrees and branches, close
  spawn  <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--account NAME] [--effort E] [--cd D] [--worktree P] [--bg] [--add-dir D]... [--schema F] [--image F]... [--gate CMD] [--gate-baseline-check] [--max-runtime MIN] "<brief>"
  resume <lane> --fix gate|review [--effort E] [--bg] [--max-runtime MIN] "<fix instructions>"
  review <lane> [--engine gpt|gemini] [--model M] [--account NAME] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "files"] ["<intent>"]
  consult <lane> [--model M] [--account NAME] [--effort E] [--cd D] [--bg] "<question>"  # read-only advisor
  context <repo> [--model M]             # build the repo's context digest for HEAD with one read-only consult
  adopt  <lane> <sessionId> [--engine gpt|gemini] [--model M] [--account NAME] [--cd D]

  --model M picks a Codex model for a gpt lane: an alias from config.models or a raw id.
  --supervisor (gpt only) lets the lane drive GPT or Gemini children and consults
  through cdx, one level deep; killing the supervisor kills its children.
  send   <lane> "<text>"  # steer the active work turn, or start an idle follow-up turn
  ask    [--timeout MIN] "<question>"  # inside a lane: liaison
  ask    --cd /repo "<question>"       # head: synchronous Gemini
  reply  <lane> [--id SEQ] "<answer>"  questions [lane]
  msg    <lane|full-session-id> "<text>"  inbox [-n N]
  events [--json] [--peek] # unread feed events; the newest active Claude session is the head
  lanes [status options]   Live lane table with CDX_TUI=1 on a terminal
  status [--all | --json | --brief | --line | --watch [--interval S]]
  wait <lane>... [--timeout S] [--json] [--report]
  usage  [--json] [--totals] # quota windows, observed burn, account picks
  usage  --line            # weekly windows from stored snapshots, for status lines
  tail   <lane> [-n N]    tail -f [lane]           # -f: live transcript; no lane = all running lanes
  view   [--port N] [--open] # local browser view; Ctrl-C stops it
  feed   [-n N]           # replay recent completion/stall lines
  report <lane> [round]    log <lane> [round]
  gate-receipt <lane> [--json] # content proof for the latest work round
  gate   <lane> "<cmd>" | gate <lane> --clear
  kill   <lane> ["note"]  # SIGTERM the runner; force-finalize if it hangs
  close  <lane> [--remove-worktree | --keep-worktree] ["note"]       clean [--days N]
  job    <name> --cd D "<cmd>"  # background shell job: one log, a feed line on exit; wait/kill/status know it
  job                     # list jobs
  doctor [--fix] [--probe] [--days N]
  migrate                 # one-shot import of the 9.x JSON state into state/cdx.db
  brief                   # makes this session the head; lanes, completed work awaiting attention, and open questions

--bg detaches the lane (survives the parent shell); combine with "cdx wait" for
one blocking call over many lanes. Foreground lanes print the report on exit.
--worktree P creates a git worktree at P on branch lane/<lane> from the repo at
--cd (or the current directory) and runs the lane there. A "-" brief reads stdin.
--gate CMD runs after a green work round (sh -lc, lane cwd); a nonzero exit
fails the round. Work resumes rerun the lane's stored gate; reviews never do.
Only --gate-baseline-check runs the gate before worker startup, including worktrees. A baseline failure is gate-invalid.
--max-runtime MIN kills the round past the cap and marks it failed.`;

const REFUSED_INSIDE_LANE = new Set([
  "spawn", "resume", "review", "consult", "context", "adopt", "land",
  "kill", "close", "clean", "gate", "reply", "job", "migrate",
]);

// A supervisor drives its children with these; each mutation checks ownership.
const SUPERVISOR_COMMANDS = new Set(["spawn", "resume", "review", "consult", "kill", "close", "gate", "reply"]);

export async function dispatch(command: string | undefined, argv: string[]) {
  if (process.env.CDX_LANE && command && REFUSED_INSIDE_LANE.has(command)) {
    const supervisor = supervisorLane();
    if (supervisor && !SUPERVISOR_COMMANDS.has(command)) {
      fail(`supervisor ${supervisor} may run ${[...SUPERVISOR_COMMANDS].join(", ")} on its children; command "${command}" refused`);
    }
    if (!supervisor) fail(`lane workers cannot drive the harness (command "${command}" refused inside lane ${process.env.CDX_LANE}); use cdx ask for anything you need from the liaison`);
  }
switch (command) {
  case "events": await eventsCommand(argv); break;
  case "migrate": migrateCommand(argv); break;
  case "spawn": await spawnCommand(argv); break;
  case "review": await reviewCommand(argv); break;
  case "consult": await consultCommand(argv); break;
  case "context": await contextCommand(argv); break;
  case "resume": await resumeCommand(argv); break;
  case "send": await sendCommand(argv); break;
  case "ask": await (process.env.CDX_LANE ? askCommand(argv) : codeQuestionCommand(argv)); break;
  case "reply": await replyCommand(argv); break;
  case "questions": questionsCommand(argv); break;
  case "msg": await msgCommand(argv); break;
  case "inbox": inboxCommand(argv); break;
  case "hook": await hookCommand(argv); break;
  case "_run": {
    const [lane, round] = argv;
    if (!lane || !round) fail("internal: _run <lane> <round>");
    process.exit(await runRound(lane, Number(round)));
  }
  case "adopt": {
    const parsed = parseArgs(argv, ["engine", "cd", "account", "model"]);
    const engine = engineOf(parsed, "adopt");
    const model = modelOf(parsed, engine);
    const [lane, sessionId] = parsed.rest;
    if (!lane || !sessionId) fail("usage: cdx adopt <lane> <sessionId> [--engine gpt|gemini] [--cd <dir>]");
    validLane(lane);
    requireEngineBinary(engine);
    if (engine === "gemini" && parsed.flags.account !== undefined) fail("--account is not supported for gemini");
    const account = engine === "gpt" ? primaryAccount(parsed.flags.account) : undefined;
    const owner = callerOwnership();
    const now = new Date().toISOString();
    withLedger((ledger) => {
      requireOwnChild(lane, ledger[lane]);
      ledger[lane] = {
        engine,
        ...(model ? { model } : {}),
        ...(account ? { account: account.name, codexHome: account.home } : {}),
        ...owner,
        sessionId, workSessionId: sessionId, work: { state: "adopted", cwd: parsed.flags.cd ?? process.cwd(), updatedAt: now }, effort: resolveEffort(engine, model),
        kind: "work", rounds: ledger[lane]?.rounds ?? 0, workRounds: ledger[lane]?.workRounds ?? ledger[lane]?.rounds ?? 0,
        reports: ledger[lane]?.reports ?? [], createdAt: ledger[lane]?.createdAt ?? now, updatedAt: now,
      };
    });
    console.log(`cdx: adopted lane=${lane} session=${sessionId}`);
    break;
  }
  case "view": viewCommand(argv); break;
  case "status": await statusCommand(argv); break;
  case "lanes": await statusCommand(tuiEnabled() && argv.length === 0 ? ["--watch"] : argv); break;
  case "job": await jobCommand(argv); break;
  case "_job": {
    if (!argv[0]) fail("internal: _job <name>");
    process.exit(await runJob(argv[0]));
  }
  case "gate": gateCommand(argv); break;
  case "gate-receipt": gateReceiptCommand(argv); break;
  case "usage": await usageCommand(argv); break;
  case "wait": await waitCommand(argv); break;
  case "feed": feedCommand(argv); break;
  case "tail": {
    const parsed = parseArgs(argv, ["n", "follow"]);
    const [lane] = parsed.rest;
    const count = Number(parsed.flags.n ?? 30);
    if (tuiEnabled() && (!Number.isInteger(count) || count < 1)) fail("-n must be a positive integer");
    if (tuiEnabled() && parsed.bools.has("follow")) { await tailView(lane, count); break; }
    const job = lane && !readLedger()[lane] ? readJobs()[lane] : undefined;
    if (job && tuiEnabled()) {
      console.log(renderView(targetView([lane!], "tail", count), undefined, 0, Number.MAX_SAFE_INTEGER));
      break;
    }
    if (parsed.bools.has("follow")) {
      await (lane ? followLane(lane) : followAll());
      break;
    }
    if (!lane) fail("usage: cdx tail <lane> [-n <lines>] | cdx tail -f [lane]");
    console.log(tuiEnabled() ? renderView(targetView([lane], "tail", count), undefined, 0, Number.MAX_SAFE_INTEGER) : renderTail(latestRoundLog(lane), count));
    break;
  }
  case "report": {
    const [lane, roundArg] = argv;
    if (!lane) fail("usage: cdx report <lane> [round]");
    const entry = readLane(lane);
    const path = roundArg ? reportPathOf(lane, Number(roundArg)) : entry.reports.at(-1);
    if (!path || !existsSync(path)) fail(`no report for lane "${lane}"`);
    console.log(readFileSync(path, "utf8"));
    break;
  }
  case "log": {
    const parsed = parseArgs(argv, ["transcript", "tools"]);
    const [lane, roundArg] = parsed.rest;
    if (!lane) fail("usage: cdx log <lane> [round] [--transcript | --tools]");
    const entry = readLane(lane);
    if (parsed.bools.has("tools")) {
      if (parsed.bools.has("transcript")) fail("choose --tools or --transcript");
      const path = roundArg ? logPathOf(lane, Number(roundArg), true) : latestRoundLog(lane);
      if (!existsSync(path)) fail(`no log for lane "${lane}"`);
      for (const line of toolLogRecords(readFileSync(path, "utf8"))) console.log(line);
      break;
    }
    if (parsed.bools.has("transcript")) {
      let transcriptPath = entry.transcriptPath;
      if (roundArg) {
        const roundNum = Number(roundArg);
        const roundLog = logPathOf(lane, roundNum, true);
        if (existsSync(roundLog)) {
          const rawLog = readFileSync(roundLog, "utf8");
          for (const line of rawLog.split("\n")) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (typeof event.conversation_id === "string" && event.conversation_id) {
                transcriptPath = geminiTranscriptPath(event.conversation_id);
                break;
              }
            } catch { /* continue scanning */ }
          }
        }
      }
      if (!transcriptPath || !existsSync(transcriptPath)) {
        fail(`no transcript for lane "${lane}"`);
      }
      const raw = readFileSync(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const content = typeof record.content === "string"
            ? record.content
            : record.content != null
            ? JSON.stringify(record.content)
            : "";
          const preview = singleLine(content).slice(0, 200);
          console.log(`#${record.step_index} ${record.type} ${record.status}${preview ? ` ${preview}` : ""}`);
        } catch { /* skip invalid lines */ }
      }
      break;
    }
    if (roundArg) {
      for (const json of [true, false]) {
        const path = logPathOf(lane, Number(roundArg), json);
        if (existsSync(path)) { console.log(path); process.exit(0); }
      }
      fail(`no log for lane "${lane}" round ${roundArg}`);
    }
    console.log(latestRoundLog(lane));
    break;
  }
  case "land": landCommand(argv); break;
  case "close": {
    const parsed = parseArgs(argv, ["remove-worktree", "keep-worktree"]);
    const keepWorktree = closeKeepsWorktree(parsed.bools);
    const usage = 'usage: cdx close <lane> [--remove-worktree | --keep-worktree] ["note" | -]';
    const [lane, noteArg] = parsed.rest;
    if (!lane) fail(usage);
    const note = await resolveBrief(noteArg, usage);
    const entry = readLane(lane);
    requireOwnChild(lane, entry);
    if (laneRunning(entry) && (pidAlive(entry.pid) || pidAlive(entry.codexPid))) fail(`lane "${lane}" is running; kill it first`);
    if (!keepWorktree && entry.worktreePath && existsSync(entry.worktreePath)) removeWorktree(entry);
    withLedger((ledger) => {
      const item = ledger[lane]!;
      requireOwnChild(lane, item);
      item.work.state = "closed";
      if (note) item.work.note = note;
      item.updatedAt = new Date().toISOString();
    });
    console.log(`cdx: closed lane=${lane}`);
    if (keepWorktree) for (const command of worktreeCleanupCommands(entry)) console.log(command);
    break;
  }
  case "kill": await killCommand(argv); break;
  case "clean": cleanCommand(argv); break;
  case "doctor": await doctorCommand(argv); break;
  case "brief": briefCommand(); break;
  case "help": case "--help": case "-h": case undefined: console.log(USAGE); break;
  default:
    fail(`unknown command "${command}"\n${USAGE}`);
}
}
