---
name: cdx
description: Run OpenAI Codex CLI work and review lanes through cdx. Use when spawning, resuming, forking, adopting, reviewing, monitoring, reporting, closing, or cleaning Codex lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *)
---

# cdx

Use `cdx` for Codex work commands instead of raw `codex exec`, `codex review`,
`codex resume`, or `codex fork`. cdx records each lane, captures its report,
tracks its state, and applies the policy set in `config.json`. Work lanes
bypass Codex approval and sandbox checks. Review lanes run in fresh, read-only
sessions.

## Commands

```bash
cdx spawn  <lane> [--account NAME] [--effort E] [--cd <dir>] [--worktree <path>] [--bg] [--add-dir <d>]... [--schema <f>] [--image <f>]... [--gate "<cmd>"] [--max-runtime <min>] "<brief>"
cdx resume <lane> [--effort E] [--bg] [--max-runtime <min>] "<follow-up>"
cdx fork   <newLane> <fromLane|sessionId> [--account NAME] [--effort E] [--bg] "<brief>"
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

`resume` keeps the lane's working directory and always reattaches to the
lane's work thread, recorded as `workSessionId` in the ledger, even when the
latest round was a review. Only a lane that never had a work session resumes
as a read-only review follow-up. `resume` does not accept `--cd`, `--json`,
or `--output-last-message`. `resume --effort E` overrides the stored effort
for that round onward; without it the session keeps its own settings. `fork`
branches an existing lane or session and keeps the source session's working
directory, so it does not accept `--cd`; a raw-session-ID fork reads that
directory from the session's rollout file.

`spawn --gate "<cmd>"` stores an acceptance gate on the lane. After a work
round exits 0 with a report, cdx runs the gate with `/bin/sh -lc` in the lane
cwd. Exit 0 appends a `## Gate` section to the report; nonzero fails the
round with `gate failed (exit N)` and still appends the output. Work resumes
rerun the stored gate; reviews never run one. Full gate output lands in
`logs/<lane>-r<n>.gate.log`. The gate is the harness's own verification, so
a worker's optimistic done claim cannot finalize green.

`--max-runtime <min>` (spawn and resume) kills the codex child past the cap
and fails the round with `max runtime exceeded (Nm)`.

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
  to open sessions.
- Use `cdx status` for structured lane blocks with owner, state, timing, tokens,
  and last activity. Running lanes show round and cumulative tokens; each round
  starts with cleared last-activity fields, so `last` never shows the previous
  round's final message. It shows running lanes first, then the 10 newest
  finished ones (`--all` for the rest). Use `cdx tail <lane>` for the rendered event log.
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

cdx passes `model` to Codex for spawn, fork, review, and doctor probe commands.
It accepts only effort values listed in `efforts`. Spawn and review use
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
subagent threads when independent work can run in parallel. Review rules keep
the lane read-only and require a report.

State uses plain files under `$CDX_HOME`: `ledger.json`, `logs/`, `reports/`,
`briefs/`, `specs/`, and `feed.log`. Spawn and intent-based review logs use
JSONL. Resume, fork, and native review logs contain text. Each successful round
must exit with code zero, drain its event log, and produce a nonempty report.

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
