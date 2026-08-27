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
cdx spawn  <lane> [--effort E] [--cd <dir>] [--bg] [--add-dir <d>]... [--schema <f>] [--image <f>]... "<brief>"
cdx resume <lane> [--bg] "<follow-up>"
cdx fork   <newLane> <fromLane|sessionId> [--effort E] [--bg] "<brief>"
cdx review <lane> [--effort E] [--cd <dir>] [--bg] [--uncommitted | --base <b> | --commit <sha>] [--scope "<files>"] ["<intent>"]
cdx adopt  <lane> <sessionId> [--cd <dir>]
cdx status [--json]
cdx wait   <lane>... [--timeout <sec>]
cdx tail   <lane> [-n N]
cdx tail -f [lane]
cdx report <lane> [round]
cdx log    <lane> [round]
cdx close  <lane> ["note"]
cdx clean  [--days N]
cdx doctor [--fix] [--probe]
cdx brief
```

`resume` keeps the lane's session and working directory. It does not accept
`--cd`, `--json`, or `--output-last-message`. `fork` branches an existing lane
or session and keeps the source session's working directory, so it does not
accept `--cd`.

Native review uses one of `--uncommitted`, `--base`, or `--commit` and cannot
take a custom intent. Without a target flag, review needs an intent and may
take `--scope`. Native and intent-based reviews always start fresh, read-only
sessions. Intent-based reviews receive an adversarial brief that asks for
severity-ranked findings, concrete failure cases, and CONFIRMED or PLAUSIBLE
labels.

## Orchestration

- For one lane, run `cdx spawn` in the foreground from a background Bash call.
  cdx prints the summary and report when the lane exits.
- For independent lanes, start each with `--bg`, then run one
  `cdx wait lane-a lane-b`. The wait exits 1 if any named lane fails.
- Use `cdx status` for lane state, tokens, idle time, and the last action. Use
  `cdx tail <lane>` for the rendered event log.
- Use `cdx tail -f <lane>` for one worker's live transcript. It exits with the
  lane's outcome. Use `cdx tail -f` for all running lanes with `[lane]`
  prefixes. It follows new rounds and attaches new lanes. Any terminal or agent
  session can run either form against the shared state, so parallel Claude
  sessions can see each other's workers.
- Use `cdx resume` to continue a lane. Use `cdx fork` when two lanes should
  start with the same session context.
- Close finished lanes with an outcome note. `cdx clean` removes closed lanes
  older than the selected age, which defaults to 14 days.

Each finalized lane appends one line to `$CDX_HOME/feed.log`. The plugin
monitor tails `$HOME/.cdx/feed.log`, so use the default `CDX_HOME` when you
want completion notifications from the bundled monitor. `cdx wait` is for
cases where the caller must block until a set of lanes finishes. A running lane
also writes a feed warning after five quiet minutes, repeats it no more than
once every ten minutes, and writes an active-again line when events resume.

## Configuration

cdx stores state under `$CDX_HOME`, which defaults to `~/.cdx`. The optional
`$CDX_HOME/config.json` has this shape and these defaults:

```json
{
  "model": "gpt-5.6-sol",
  "efforts": ["low", "medium", "high"],
  "defaultEffort": "medium",
  "rules": []
}
```

cdx passes `model` to Codex for spawn, fork, review, and doctor probe commands.
It accepts only effort values listed in `efforts`. Spawn and review use
`defaultEffort` when `--effort` is absent. Fork keeps the source lane's effort
when that effort remains allowed. A raw session ID fork and an adopted lane use
`defaultEffort`. If a stored source effort is no longer allowed, pass an
allowed `--effort`. Resume keeps the lane's stored effort. A malformed config
fails with a message that names the config file.

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
