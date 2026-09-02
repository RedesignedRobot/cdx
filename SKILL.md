---
name: cdx
description: Run OpenAI Codex and Google Antigravity work, review, question, and peer-message lanes through cdx. Use when spawning, resuming, forking, sending, asking, replying, messaging, adopting, reviewing, monitoring, reporting, closing, or cleaning lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *)
---

# cdx

Use `cdx` for headless Codex and Antigravity work. cdx records each lane,
captures its report, tracks its state, and applies the policy in `config.json`.
`--engine` is optional on spawn, review, and adopt and defaults to `gemini`.
`--engine gpt` is explicit. Resume inherits the lane engine.

## Which engine

```text
gemini is the default; gpt is explicit.
gemini:
+ near-unlimited quota, fast, good on bounded briefs (investigate, read, search, audit, review, test, small scoped builds)
- weaker adversarial self-doubt, needs a precise brief with named files and acceptance checks
gpt:
+ strongest code and judgment on hard multi-file work, design-heavy lanes
- slow (20-30 min lanes), scarce weekly budget, burns fast
gemini is the default engine for execution. Tell it exactly what to do and a lane finishes in about nine minutes, against forty to fifty for gpt. Judgment calls, discovery, design analysis, and open questions stay with gpt or the head.
gemini: one outcome per lane, brief under a page, fan out many lanes in parallel.
gpt: one big brief for sweeping multi-file work.
```

The Claude head plans, briefs, reviews, and merges. GPT through Codex is level
one for the hardest implementation and design work. Gemini 3.8 Flash high
through Antigravity is level two for bounded investigation, review, tests, and
small builds. Gemini always uses `gemini-3.8-flash-high`. Its effort is not
configurable.

### Gemini operating rules

- Asks via cdx ask when a gap changes the outcome, one small question per gap, and takes the narrowest reading only after the answer times out, recording it under an Assumptions heading.
- Never delegates.
- Brief under a page with named files and acceptance checks.
- One outcome per lane.
- Fan out many lanes with `--bg` and one `cdx wait`.
- Gate every build lane.
- Reviews of gemini work carry explicit attack items.
- A gemini review of a gemini lane is allowed but weaker than a different reviewer.

## Commands

```bash
cdx spawn  <lane> [--engine gpt|gemini] [--account NAME] [--effort E] [--cd <dir>] [--worktree <path>] [--bg] [--add-dir <d>]... [--schema <f>] [--image <f>]... [--gate "<cmd>"] [--gate-baseline-check] [--max-runtime <min>] "<brief>"
cdx resume <lane> [--effort E] [--bg] [--gate "<cmd>"] [--max-runtime <min>] "<follow-up>"
cdx gate   <lane> ("<cmd>" | --clear)
cdx fork   <newLane> <fromLane|sessionId> [--account NAME] [--effort E] [--bg] "<brief>"
cdx send   <lane> "<text>"
cdx ask    [--timeout MIN] "<question>"
cdx reply  <lane> [--id SEQ] "<answer>"
cdx questions [lane]
cdx msg    <lane|session-prefix> "<text>"
cdx inbox  [-n N]
cdx review <lane> [--engine gpt|gemini] [--account NAME] [--effort E] [--cd <dir>] [--bg] [--uncommitted | --base <b> | --commit <sha>] [--scope "<files>"] ["<intent>"]
cdx adopt  <lane> <sessionId> [--engine gpt|gemini] [--account NAME] [--cd <dir>]
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
or backticks: `cdx spawn big-task --engine gemini --bg - < /tmp/brief.md`. It works for spawn,
resume, fork, and the review intent.

`spawn --worktree <path>` creates a git worktree at that path on branch
`lane/<lane>` from the repo at `--cd` (or the current directory), runs the
optional `worktreeSetup` config command and the repository's
`.cdx-worktree-setup` hook inside it (see Configuration), and runs the lane
there. Use it whenever parallel lanes touch the same
repository, so each worker owns its files exclusively. `status` shows the
branch; `close` prints the removal commands and never deletes anything itself.

GPT work rounds own one `codex app-server` child over stdio JSON-RPC. Gemini
work rounds own one `agy` child with stream JSON input and output. cdx launches
Gemini with `gemini-3.8-flash-high`, the configured work agent, and every lane
directory passed through `--add-dir`. It removes `CODEX_HOME` from the Gemini
environment. Each engine writes raw events to the round JSONL log and stderr
to a separate log. GPT reports come from the final app-server agent message.
Gemini reports come from the response in the last `result` event. `--schema`
reaches both engines. `--image` works only with GPT.

`resume` keeps the lane's working directory and engine. It rejects `--engine`.
GPT reattaches to the recorded work thread and account. Gemini passes the
recorded conversation ID to `agy --conversation`. A ledger row without an
engine means GPT. `resume` does not accept `--cd` or `--json`. GPT accepts an
effort override. Gemini ignores it with a note and records effort `high`.
`resume --gate "<cmd>"` replaces the lane's stored gate before the round and
keeps it for later resumes. `fork` inherits a source lane's engine. GPT can
fork a lane or a raw Codex session ID. A raw session ID fork is GPT-only.
Gemini has no headless fork, so use `cdx resume` for a Gemini lane.

`spawn --gate "<cmd>"` stores an acceptance gate on the lane. After a work
round exits 0 with a report, cdx runs the gate with `/bin/sh -lc` in the lane
cwd. Exit 0 appends a `## Gate` section to the report; nonzero fails the
round with `gate failed (exit N)` and still appends the output. Work resumes
rerun the stored gate; reviews never run one. Full gate output lands in
`logs/<lane>-r<n>.gate.log`. The gate is the harness's own verification, so
a worker's optimistic done claim cannot finalize green.

When a work round changes no files, cdx checks whether the lane has a gate.
With a gate, the round fails with "gate passed on an unchanged tree: no work landed"
and the gate is skipped. Without a gate, the round finalizes done, the report
gets a "## Harness note" saying no files changed, the feed line carries
`diff=empty`, and status shows "no tree change".

A worktree spawn with `--gate` runs the gate once in the untouched baseline
tree before the worker starts. For a non-worktree spawn, add
`--gate-baseline-check` to run the same check. A baseline failure stops the
round as `gate-invalid` and identifies the command as the defect. A final
gate failure that had no baseline check suggests `--gate-baseline-check`.

`cdx gate <lane> "<cmd>"` sets or replaces the stored gate. Use
`cdx gate <lane> --clear` to remove it. Both forms print the old and new gate.
They refuse to change a lane while it is active.

`--max-runtime <min>` on spawn and resume sends SIGTERM to the engine child at
the cap. It sends SIGKILL after 10 seconds if the child remains alive, then
fails the round with `max runtime exceeded (Nm)`.

`cdx kill <lane>` stops a running lane. SIGTERM lets the runner reap its
engine child and finalize with a signal note. A runner still silent after 10s,
or a dead runner with a live engine orphan, gets SIGKILL and a direct ledger
finalize with note `killed`. Exit codes 130, 137, and 143 always finalize as
`terminated by signal`, never as auth failures.

A review uses one of `--uncommitted`, `--base`, or `--commit`, or takes a custom
intent with optional `--scope`. GPT target reviews use Codex's native reviewer.
Gemini receives an equivalent `git diff` instruction. A gemini review of a
gemini lane prints a note asking for explicit attack items. Both engines receive the
same findings contract, and cdx extracts its fenced JSON block into
`reports/<lane>-r<n>.findings.json`. Codex enforces read-only access. For
Gemini, cdx compares the repository tree before and after the round. A changed
path fails the review, but cdx keeps the report.

## Communication

Use `cdx send <lane> "<text>"` to correct a running work lane. The command
appends the text, send time, and optional sender prefix to
`$CDX_HOME/control/<lane>-r<round>.jsonl`. GPT uses `turn/steer` while a turn is
active and starts a follow-up turn otherwise. Antigravity cannot steer
mid-turn, so every Gemini control becomes a new stdin user turn. Its feed line
records `mode=follow-up-turn`. cdx never consumes a record without delivery.
`send` refuses review lanes before it writes a record.

The runner exports `CDX_LANE`, `CDX_ROUND`, and `CDX_OWNER` to both engines.
While `CDX_LANE` is set, cdx refuses `spawn`, `resume`, `fork`, `review`,
`adopt`, `kill`, `close`, `clean`, `gate`, and `reply` with the message
`lane workers cannot drive the harness`; a worker that wants to test the
harness does it through `cdx.test.ts` under a temporary `CDX_HOME`.
Inspection commands (`status`, `tail`, `report`, `log`, `feed`, `usage`,
`questions`, `inbox`, `msg`, `brief`, `doctor`) and `ask` stay available.
A worker uses `cdx ask [--timeout MIN] "<question>"` when an open point changes
the architecture or file set. Gemini workers ask via `cdx ask` when a gap changes
the outcome, ask one small question per gap, and take the narrowest reading only
after the answer times out, recording it under an Assumptions heading. `ask` writes
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
- Use `cdx usage` to answer capacity questions. It shows Codex account windows,
  Gemini weekly and five-hour remaining percentages, reset times, and all-time
  ledger totals. `--json` returns both snapshots.
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

When Gemini usage is requested, report both the weekly and five-hour remaining
percentages and their reset times.

## Configuration

cdx stores state under `$CDX_HOME`, which defaults to `~/.cdx`. The optional
`$CDX_HOME/config.json` has this shape and these defaults:

```json
{
  "model": "gpt-5.6-sol",
  "efforts": ["low", "medium", "high"],
  "defaultEffort": "medium",
  "rules": [],
  "worktreeSetup": "bun install",
  "gemini": {
    "model": "gemini-3.8-flash-high",
    "agent": "cdx-lane",
    "reviewAgent": "cdx-review"
  }
}
```

`worktreeSetup` is optional: a shell command run inside every new `--worktree`
before the lane starts. A nonzero exit aborts the spawn and leaves the
worktree in place for inspection. A repository may ship an executable
`.cdx-worktree-setup` at its root; `spawn --worktree` runs it after the global
`worktreeSetup` command and fails the spawn on nonzero exit.

Existing top-level model and effort keys configure GPT. The optional `gemini`
object accepts only `model`, `agent`, and `reviewAgent`; the shown values are
its defaults. Gemini always runs the configured model at high reasoning and
records effort `high`. cdx ignores a Gemini `--effort` flag with a note. A
malformed config fails with a message that names the config file.

`cdx doctor` reports both binaries, Antigravity usage, and both shipped agent
files. `doctor --fix` links those agents into
`~/.gemini/config/agents/<name>/agent.md`. `doctor --probe` runs a short live
request through each installed engine. A missing `agy` is a warning unless the
config has a `gemini` object.

When `config.json` defines accounts, cdx gives each Codex login its own
`CODEX_HOME`. New GPT spawn and review lanes choose the first account with
capacity. Their `--account NAME` flag forces one. A lane never changes account
after spawn. Gemini does not use Codex account selection and rejects
`--account`.
GPT lane forks inherit the account. GPT adopt and raw-session-ID fork accept
`--account` and otherwise use the primary account. A pre-upgrade lane without
account data falls back to the default Codex home and writes a feed note.

cdx appends each `rules` entry to the built-in brief rules. It then appends the
contents of `.cdx-rules.md` from the lane's working directory when that file
exists. Built-in work rules forbid commits, pushes, deploys, and extra
long-running servers. They require the final report. GPT workers receive rules
to use subagents for parallel work and run `cdx ask` when open points change
architecture or files. Gemini house rules require the worker to execute as
written, ask via `cdx ask` when a gap changes the outcome (one small question
per gap), and take the narrowest reading only after the answer times out,
recording it under an Assumptions heading. Gemini workers never spawn subagents,
avoid web tools, remove debug prints before reporting, and list files changed
and commands with exit codes in the report. The web tool ban lives in the brief
because agy ignores the agent file tool allowlist.
Review rules forbid writes and require a report. The harness also checks a
Gemini review's tree before and after the round.

State uses plain files under `$CDX_HOME`: `ledger.json`, `logs/`, `reports/`,
`briefs/`, `specs/`, `control/`, `questions/`, and `feed.log`. Both engines
write raw round events as JSONL and stderr to separate logs.
After a work turn completes with a qualifying report, cdx writes the report
before unsubscribe and child shutdown. A later cleanup failure produces a
warning instead of failing the completed round. A missing qualifying message
fails with `no final report`, and cdx does not run the acceptance gate.
A Gemini round whose final response is the agy cancellation template ("User
initiated cancellation", "Execution stopped per your cancellation request")
finalizes failed with note "agy returned its cancellation template as the
report; no qualifying report", and the gate does not run.
Engine errors go to the ledger note and feed line.

## Claude Code plugin

This folder includes Claude Code plugin metadata, a completion monitor, and
hooks:

- `monitors/monitors.json` tails `$HOME/.cdx/feed.log` and sends lane
  completion lines to the Claude Code session.
- `hooks/guard-raw-codex.ts` blocks raw headless Codex and Antigravity work
  commands. Codex login and version checks pass through. Antigravity model
  listing, help, update, and version checks pass through.
- The SessionStart hook runs the plugin copy of `cdx.ts brief`. It prints only
  running or failed lanes and does not require `cdx` on `PATH`.
