# cdx

Codex execution lanes for Claude Code.

cdx is a single-file CLI that lets a Claude Code session drive [OpenAI Codex CLI](https://github.com/openai/codex) workers as parallel, detached background lanes. Claude stays the head: it briefs workers, watches their progress, reviews their output, and integrates the results. Codex does the execution. cdx is the contract between the two.

It is also a Claude Code plugin. Installed as one, lane completions stream back into the Claude session as notifications, a session opener shows any live or failed lanes, and a hook blocks raw Codex work commands.

## Why

Running one Codex command from an agent is easy. Running six of them in parallel, surviving the parent shell, knowing which session ID belongs to which task, resuming a thread with its context intact, getting the final report without scraping a transcript, and noticing when a worker died silently is not. cdx owns that bookkeeping in one place:

- One ledger entry per lane: session ID, working directory, state, rounds, token spend, last activity.
- Detached background lanes that keep running after the shell exits.
- Reports captured per round, from `--output-last-message` where the CLI supports it and salvaged from the transcript where it does not.
- Success requires three gates: exit code zero, a drained event log, and a nonempty report. A clean exit without a report is a failure, not a success.
- Reviews run in fresh sessions with a sandbox-enforced read-only policy, so the author never grades itself and the reviewer cannot edit.

## Requirements

- [Bun](https://bun.sh) (cdx is a single TypeScript file with no package dependencies)
- [Codex CLI](https://github.com/openai/codex) 0.149 or newer, logged in (`codex login`)
- Claude Code, if you want the plugin integration (monitor, hooks, skill)
- macOS, Linux, or WSL. The monitor and doctor use `touch`, `tail`, and `pgrep`.

## Install

```bash
git clone https://github.com/RedesignedRobot/cdx.git ~/.claude/skills/cdx
ln -s ~/.claude/skills/cdx/cdx.ts ~/.local/bin/cdx
cdx doctor --probe
```

Cloning into `~/.claude/skills/` makes Claude Code pick it up as a skills-directory plugin automatically. The `/cdx` skill, lane-completion monitor, and hooks load in the next session. The symlink makes `cdx` a normal terminal command. Skip it if you only call the script by path. The hooks run the plugin copy of `cdx.ts`, so they do not depend on the symlink.

`cdx doctor` checks the Codex binary, login status, model setting, guard file, monitor process, and ledger. It prints a remedy for failed checks. `--probe` additionally runs a real `codex exec` round-trip.

## Quickstart

```bash
# One worker, wait for the report
cdx spawn fix-flaky-test --cd ~/code/myapp "The test in auth.test.ts fails
intermittently. Find the race, fix it, and prove it with 20 green runs."

# Three workers in parallel, detached
cdx spawn api-docs   --cd ~/code/myapp --bg "Document every public endpoint in openapi.yaml."
cdx spawn dead-code  --cd ~/code/myapp --bg "Find and delete unreachable code. List every deletion."
cdx spawn slow-query --cd ~/code/myapp --bg --effort high "Profile the /search endpoint and fix the N+1."
cdx wait api-docs dead-code slow-query

# Check on things
cdx status          # table: state, tokens, idle time, last action per lane
cdx tail slow-query # rendered event log of the latest round

# Continue a thread with its context intact
cdx resume dead-code "Also remove the now-unused imports."

# Review a worker's diff in a fresh, read-only session
cdx review slow-query --uncommitted

# Finish
cdx report slow-query
cdx close slow-query "landed in a1b2c3d"
```

## Commands

```
cdx spawn  <lane> [--effort E] [--cd D] [--bg] [--add-dir D]... [--schema F] [--image F]... "<brief>"
cdx resume <lane> [--bg] "<follow-up>"        continue a lane's thread, context intact
cdx fork   <new> <lane|sessionId> [--effort E] [--bg] "<brief>"   branch a thread into a new lane
cdx review <lane> [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>"]
cdx adopt  <lane> <sessionId> [--cd D]        register an existing codex session as a lane
cdx status [--all] [--json]                   running lanes, then last 10 finished; --all for full history
cdx wait   <lane>... [--timeout S]            block until lanes finish; exit 1 if any failed
cdx tail   <lane> [-n N]                      human-rendered tail of the latest round
cdx tail -f [lane]                            live transcript; omit lane for all running lanes
cdx report <lane> [round]                     print a lane's report
cdx log    <lane> [round]                     print the log path
cdx close  <lane> ["note"]                    mark closed with an outcome note
cdx clean  [--days N]                         prune closed lanes older than N days
cdx doctor [--fix] [--probe]                  health check with remedies; --probe runs a live round-trip
cdx brief                                     running/failed lanes only; silent when all settled
```

`review` with a target flag (`--uncommitted`, `--base`, `--commit`) uses Codex's native reviewer on the diff. `review` with an intent string instead runs an adversarial exec-based review: severity-ranked findings, each marked CONFIRMED or PLAUSIBLE. Both are fresh sessions, both sandbox-enforced read-only.

## Orchestration patterns

**Single lane, report on completion.** Run `cdx spawn` in the foreground from a background shell. The harness prints a summary line plus the full report at exit, so one notification carries everything.

**Fan-out.** Fire each lane with `--bg` (they detach and survive the shell), then one `cdx wait a b c` blocks until the wave lands.

**Watch live.** `cdx tail -f <lane>` streams one worker's transcript and exits with the lane's outcome. `cdx tail -f` shows all running lanes with `[lane]` prefixes and follows new rounds and lanes. Any terminal or agent session can use either form against the shared state, which is how parallel Claude sessions see each other's workers.

**No polling.** With the plugin installed, every lane completion appends a line to the feed that the monitor tails, and Claude Code surfaces it as a notification. `cdx wait` is only for deliberately blocking on a wave. A running lane also writes a feed warning after five quiet minutes, repeats it no more than once every ten minutes, and writes an active-again line when events resume.

**Iterate or branch.** `resume` continues a worker with everything it already knows. `fork` branches that knowledge into a new lane when you want two directions explored from the same starting point. A fork keeps the source session's working directory.

## Configuration

Everything lives under `$CDX_HOME`, which defaults to `~/.cdx`. The optional `$CDX_HOME/config.json` has this shape and these defaults:

```json
{
  "model": "gpt-5.6-sol",
  "efforts": ["low", "medium", "high"],
  "defaultEffort": "medium",
  "rules": []
}
```

- `model` is passed to Codex for spawn, fork, review, and doctor probe commands.
- `efforts` lists the accepted values for `--effort`. cdx rejects any other value and names the config file in the error.
- `defaultEffort` applies to spawn and review when `--effort` is absent. Fork keeps the source lane's effort while it remains allowed. Raw session ID forks and adopted lanes use `defaultEffort`. If a stored source effort is no longer allowed, pass an allowed `--effort`. Resume keeps the lane's stored effort.
- `rules` entries are appended to every injected brief. cdx then appends `.cdx-rules.md` from the lane's working directory when that file exists.

If `config.json` is absent, cdx uses the values shown above. Malformed JSON, wrong value types, an empty effort list, or a `defaultEffort` absent from `efforts` stops the command with a message that names the file.

## What the harness injects

Every work brief says that workers must not commit, push, deploy, or start extra long-running servers. It includes the report contract and asks workers to use subagent threads when independent work can run in parallel. Review lanes receive a read-only rule and an adversarial review frame. cdx appends `config.json` rules after those built-ins, then appends the lane working directory's `.cdx-rules.md`.

Work lanes pass Codex's `--dangerously-bypass-approvals-and-sandbox` flag. The prompt policy is the only commit, push, and deploy restriction for those lanes. Review lanes use a read-only sandbox and disable approval prompts.

The Codex CLI handles context compaction. cdx does not set a fixed context size or override the CLI's compaction limit.

## Plugin hooks

The lane monitor tails `$HOME/.cdx/feed.log`. Each finalized lane writes one line there when `CDX_HOME` uses its default. The SessionStart hook runs the plugin copy of `cdx.ts brief`, which prints only running or failed lanes.

The Bun guard strips single-quoted and double-quoted command segments before it checks for raw Codex calls. It blocks `codex` followed by `e`, `exec`, `review`, `resume`, `fork`, `cloud`, or `apply` as a command word and points the caller to `cdx`. Login, logout, `--version`, features, debug, other Codex commands, quoted mentions, and `cdx` commands pass through.

## State layout

```
$CDX_HOME/
  ledger.json    one entry per lane: session, state, rounds, tokens, notes
  logs/          JSONL event streams (spawn, exec review) and text transcripts (resume, fork)
  reports/       final report per round
  briefs/        audit trail of every injected prompt
  specs/         the exact codex invocation each round ran
  feed.log       one line per lane completion, tailed by the plugin monitor
```

Everything is plain files. `cat` works on all of it.

## License

MIT
