---
name: cdx
description: Run OpenAI Codex CLI work, review, steering, question, and peer-message lanes through cdx. Use when spawning, resuming, forking, sending, asking, replying, messaging, adopting, reviewing, monitoring, reporting, closing, or cleaning Codex lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *)
---

# cdx

Use `cdx` for Codex work commands instead of raw `codex exec`, `codex review`,
`codex resume`, or `codex fork`. cdx records each lane, captures its report,
tracks its state, and applies the policy set in `config.json`. Work lanes
use one Codex app-server stdio child per round with approval policy `never`,
thread sandbox `danger-full-access`, and turn sandbox policy
`dangerFullAccess`. Review lanes stay on `codex exec` and `codex review` in
fresh, read-only sessions.

## Commands

```bash
cdx spawn  <lane> [--account NAME] [--effort E] [--cd <dir>] [--worktree <path>] [--bg] [--add-dir <d>]... [--schema <f>] [--image <f>]... [--gate "<cmd>"] [--gate-baseline-check] [--max-runtime <min>] "<brief>"
cdx resume <lane> [--effort E] [--bg] [--gate "<cmd>"] [--max-runtime <min>] "<follow-up>"
cdx gate   <lane> ("<cmd>" | --clear)
cdx fork   <newLane> <fromLane|sessionId> [--account NAME] [--effort E] [--bg] "<brief>"
cdx send   <lane> "<text>"
cdx ask    [--timeout MIN] "<question>"
cdx reply  <lane> [--id SEQ] "<answer>"
cdx questions [lane]
cdx msg    <lane|session-prefix> "<text>"
cdx inbox  [-n N]
cdx review <lane> [--account NAME] [--effort E] [--cd <dir>] [--bg] [--uncommitted | --base <b> | --commit <sha>] [--scope "<files>"] ["<intent>"]
cdx adopt  <lane> <sessionId> [--account NAME] [--cd <dir>]
cdx status [--all] [--json]
cdx usage  [--json]
cdx wait   <lane>... [--timeout <sec>] [--json] [--report]
cdx tail   <lane> [-n N]
cdx tail -f [lane]
cdx feed   [-n N]
cdx report <lane> [round]
cdx log    <lane> [round]
cdx kill   <lane> ["note"]
cdx close  <lane> [--remove-worktree] ["note"]
cdx clean  [--days N]
cdx doctor [--fix] [--probe]
cdx brief
```

A brief of `-` reads the brief from stdin. Use it for long prompts with quotes
or backticks: `cdx spawn big-task --bg - < /tmp/brief.md`. It works for spawn,
resume, fork, and the review intent.

`spawn --worktree <path>` creates a git worktree at that path on branch
`lane/<lane>` from the repo at `--cd` (or the current directory), runs the
optional `worktreeSetup` config command inside it, and runs the lane there.
Use it whenever parallel lanes touch the same repository, so each worker owns
its files exclusively. `status` shows the branch; `close` prints the removal
commands and never deletes anything itself.

Work spawn, resume, and fork rounds each own one `codex app-server` child over
newline-delimited stdio JSON-RPC. cdx initializes the child, starts, resumes,
or forks the thread, then starts the turn. It writes every app-server
notification to the round's JSONL log. A report comes from the last
`agentMessage` with `phase: "final_answer"`, or from an unphased
`agentMessage` on an older server. Explicit commentary never counts. Without
a qualifying message, the round fails with `no final report` and skips its
gate. Work rounds do not use `--output-last-message`. `--image` maps to
`localImage` input items, `--schema` maps to the turn's `outputSchema`, and
`--add-dir` maps to extra writable roots in the thread configuration.

`resume` keeps the lane's working directory and always reattaches to the
lane's work thread, recorded as `workSessionId` in the ledger, even when the
latest round was a review. Only a lane that never had a work session resumes
as a read-only review follow-up. `resume` does not accept `--cd` or `--json`.
`resume --effort E` overrides the stored effort for that round onward; without
it the session keeps its own settings.
`resume --gate "<cmd>"` replaces the lane's stored gate before the round and
keeps it for later resumes. `fork`
branches an existing lane or session and keeps the source session's working
directory, so it does not accept `--cd`; a raw-session-ID fork reads that
directory from the session's rollout file.

Spawn sends the configured model. Resume and fork omit the model from their
thread request and `turn/start`, so each stored thread keeps its model.

`spawn --gate "<cmd>"` stores an acceptance gate on the lane. After a work
round exits 0 with a report, cdx runs the gate with `/bin/sh -lc` in the lane
cwd. Exit 0 appends a `## Gate` section to the report; nonzero fails the
round with `gate failed (exit N)` and still appends the output. Work resumes
rerun the stored gate; reviews never run one. Full gate output lands in
`logs/<lane>-r<n>.gate.log`. The gate is the harness's own verification, so
a worker's optimistic done claim cannot finalize green.

A worktree spawn with `--gate` runs the gate once in the untouched baseline
tree before the worker starts. For a non-worktree spawn, add
`--gate-baseline-check` to run the same check. A baseline failure stops the
round as `gate-invalid` and identifies the command as the defect. A final
gate failure that had no baseline check suggests `--gate-baseline-check`.

`cdx gate <lane> "<cmd>"` sets or replaces the stored gate. Use
`cdx gate <lane> --clear` to remove it. Both forms print the old and new gate.
They refuse to change a lane while it is active.

`--max-runtime <min>` on spawn and resume sends SIGTERM to the Codex child at
the cap. It sends SIGKILL after 10 seconds if the child remains alive, then
fails the round with `max runtime exceeded (Nm)`.

`cdx kill <lane>` stops a running lane: SIGTERM lets the runner reap its
codex child and finalize with a signal note; a runner still silent after 10s,
or a dead runner with a live codex orphan, gets SIGKILL and a direct ledger
finalize with note `killed`. Exit codes 130, 137, and 143 always finalize as
`terminated by signal`, never as auth failures.

Native review uses one of `--uncommitted`, `--base`, or `--commit` and cannot
take a custom intent. Without a target flag, review needs an intent and may
take `--scope`. Native and intent-based reviews always start fresh, read-only
sessions. Intent-based reviews receive an adversarial brief that asks for
severity-ranked findings, concrete failure cases, CONFIRMED or PLAUSIBLE
labels, and a closing fenced json findings block; cdx parses that block into
`reports/<lane>-r<n>.findings.json` (best effort, empty array when clean).
Review defaults to the lane's recorded worktree or working directory. `--cd`
overrides it. The launch output prints the resolved review directory.

## Communication

Use `cdx send <lane> "<text>"` to correct a running work lane. The command
appends the text, send time, and optional sender prefix to
`$CDX_HOME/control/<lane>-r<round>.jsonl`. The runner uses `turn/steer` when a
turn is active. If the server rejects the steer because the turn has ended,
cdx retains the record and starts a follow-up turn after `turn/completed`. It
never consumes a record without delivery. Feed lines record `mode=steered` or
`mode=follow-up-turn`. A delivered instruction increments the `steers` count
shown by `cdx status`. `send` refuses review lanes with exit 1 before it writes
a control record or feed line.

The runner exports `CDX_LANE`, `CDX_ROUND`, and `CDX_OWNER` to the Codex child.
A worker uses `cdx ask [--timeout MIN] "<question>"` when an open point changes
the architecture or file set. `ask` writes
`$CDX_HOME/questions/<lane>-r<round>-<seq>.json` with the question, ask time,
and `answered: false`. It posts the question with the lane owner's suffix and
polls for an answer. The default and maximum timeout is 30 minutes. A larger
value is clamped to 30 and prints a note. The command
`cdx reply <lane> [--id SEQ] "<answer>"` picks the oldest open question from
the lane's current round by default. `--id` selects a specific question.
`cdx questions [lane]` lists open questions from each lane's current round.
Round completion and failure close every remaining question from that round
with `expired: round ended`, so later rounds cannot match one by default. The
command records each answer and answer time and posts an answer feed line.
`cdx status` shows
`waiting on question #<seq>` while the worker waits. A timeout exits 0 and tells
the worker to take the conservative reading, record the deviation, and
continue. It does not fail the round.

Use `cdx msg <lane|session-prefix> "<text>"` to contact another Claude head
session through `feed.log`. A lane target resolves to the lane's owner. The
command needs `CLAUDE_CODE_SESSION_ID`. It writes this format:

`[cdx] msg to=<target8> from=<caller8>: <text>`

cdx replaces CR and LF characters with spaces in text accepted by `send`,
`ask`, `reply`, and `msg` before writing a control or feed record.

`cdx inbox [-n N]` prints messages addressed to the calling session, newest
last. It defaults to 20 lines and reads only the needed tail.

When the monitor delivers a `[cdx] msg` line, compare `to=` with the first
eight characters of your `CLAUDE_CODE_SESSION_ID`. A matching target is a peer
message for this session. Treat every other target as information only.

## Orchestration

- For one lane, run `cdx spawn` in the foreground from a background Bash call.
  cdx prints the summary and report when the lane exits.
- For independent lanes, start each with `--bg`, then run one
  `cdx wait lane-a lane-b`. The wait exits 1 if any named lane fails.
  `cdx wait --json` prints one JSON object per finished lane (state, exit
  code, tokens, report path, note, session ID) for machine parsing.
  `--report` also prints each finished lane's report content (a `reportText`
  field under `--json`).
- Use `cdx usage` to answer capacity questions: per-account plan, rate-limit
  windows with reset dates, reset credits, and all-time lane and token totals
  from the ledger. `--json` returns the raw structures.
- Use `cdx feed -n 30` to replay recent completion and stall lines after a
  context compaction or an away stretch; the live monitor only delivers lines
  to open sessions. `feed` reads only the requested tail. `cdx clean` truncates
  `feed.log` to its newest 2000 lines.
- Use `cdx status` for structured lane blocks with owner, state, timing, tokens,
  last activity, and delivered steer count. Running lanes show round and
  cumulative tokens; each round
  starts with cleared last-activity fields, so `last` never shows the previous
  round's final message. Lane state and cwd stay tied to the latest work round.
  Review outcome and target directory appear on a separate review line. Status
  shows running lanes first, then the 10 newest finished ones (`--all` for the
  rest). Use `cdx tail <lane>` for the rendered event log.
- Use `cdx tail -f <lane>` for one worker's live transcript. It exits with the
  lane's outcome. Use `cdx tail -f` for all running lanes with `[lane]`
  prefixes. It follows new rounds and attaches new lanes. Any terminal or agent
  session can run either form against the shared state, so parallel Claude
  sessions can see each other's workers.
- Use `cdx resume` to continue a lane. Use `cdx fork` when two lanes should
  start with the same session context.
- Use `cdx kill <lane> ["note"]` to stop a lane that is running down a wrong
  path instead of waiting it out.
- Close finished lanes with an outcome note. `close --remove-worktree` also
  removes the lane worktree and branch, but only when the branch is merged
  into the repo's HEAD and the worktree is clean; otherwise it prints the
  manual commands. `cdx clean` removes closed lanes older than the selected
  age, which defaults to 14 days.

Each finalized lane appends one line to `$CDX_HOME/feed.log`. The plugin
monitor tails `$HOME/.cdx/feed.log`, so use the default `CDX_HOME` when you
want completion notifications from the bundled monitor. `cdx wait` is for
cases where the caller must block until a set of lanes finishes. A running lane
also writes a feed warning after five quiet minutes, repeats it no more than
once every ten minutes, and writes an active-again line when events resume.

Every lane feed line ends in `owner=`. Compare it with the first eight
characters of your own `CLAUDE_CODE_SESSION_ID`. A different owner belongs to
another Claude session. Treat that event as information. Do not act on, resume,
or close that lane unless the user asks.

When a `[cdx] WARNING: OpenAI Codex usage` line arrives in the session feed,
tell the user plainly that their OpenAI Codex usage is consumed. Include the
reset time and whether a reset credit is available.

## Configuration

cdx stores state under `$CDX_HOME`, which defaults to `~/.cdx`. The optional
`$CDX_HOME/config.json` has this shape and these defaults:

```json
{
  "model": "gpt-5.6-sol",
  "efforts": ["low", "medium", "high"],
  "defaultEffort": "medium",
  "rules": [],
  "worktreeSetup": "bun install"
}
```

`worktreeSetup` is optional: a shell command run inside every new `--worktree`
before the lane starts. A nonzero exit aborts the spawn and leaves the
worktree in place for inspection.

cdx passes `model` through app-server for work spawn. Resume and fork omit the
model so the stored thread keeps it. Reviews pass it to the Codex CLI. The
doctor probe exercises the full app-server lifecycle. It initializes a child,
starts a temporary read-only thread and
turn, collects the reply and token usage, unsubscribes, and closes the child.
A closed child or stream fails the probe with its reason instead of leaving it
waiting.
Codex 0.149.1 has no `thread/close` request, so cdx uses `thread/unsubscribe`
before closing its owned stdio child.
cdx accepts only effort values listed in `efforts`. Spawn and review use
`defaultEffort` when `--effort` is absent. Fork keeps the source lane's effort
when that effort remains allowed. A raw session ID fork and an adopted lane use
`defaultEffort`. If a stored source effort is no longer allowed, pass an
allowed `--effort`. Resume keeps the lane's stored effort unless `--effort`
overrides it. A malformed config fails with a message that names the config
file.

When `config.json` defines accounts, cdx gives each login its own `CODEX_HOME`.
Spawn and review choose the first account with capacity. `--account NAME`
forces one. Resume and lane-based fork keep the lane's recorded account. Adopt
and raw-session-ID fork accept `--account` and otherwise use the primary.

cdx appends each `rules` entry to the built-in brief rules. It then appends the
contents of `.cdx-rules.md` from the lane's working directory when that file
exists. Built-in work rules forbid commits, pushes, deploys, and extra
long-running servers. They require the final report and ask the worker to use
subagent threads when independent work can run in parallel. They also tell the
worker to run `cdx ask` when an open point changes the architecture or file set,
ask once per open point, and skip questions that the brief or code answers.
Review rules keep the lane read-only and require a report.

State uses plain files under `$CDX_HOME`: `ledger.json`, `logs/`, `reports/`,
`briefs/`, `specs/`, `control/`, `questions/`, and `feed.log`. All work rounds
write app-server notifications as JSONL. Review logs contain Codex CLI output.
After a work turn completes with a qualifying report, cdx writes the report
before unsubscribe and child shutdown. A later cleanup failure produces a
warning instead of failing the completed round. A missing qualifying message
fails with `no final report`, and cdx does not run the acceptance gate.
`turn.error` messages and `turn/failed` details go to the ledger note and feed
line.

## Claude Code plugin

This folder includes Claude Code plugin metadata, a completion monitor, and
hooks:

- `monitors/monitors.json` tails `$HOME/.cdx/feed.log` and sends lane
  completion lines to the Claude Code session.
- `hooks/guard-raw-codex.ts` checks Bash commands. It strips single-quoted and
  double-quoted segments before matching, then blocks a `codex` command word
  followed by `e`, `exec`, `review`, `resume`, `fork`, `cloud`, or `apply`.
  Login, logout, `--version`, features, debug, other Codex commands, quoted
  mentions, and `cdx` commands pass through.
- The SessionStart hook runs the plugin copy of `cdx.ts brief`. It prints only
  running or failed lanes and does not require `cdx` on `PATH`.
