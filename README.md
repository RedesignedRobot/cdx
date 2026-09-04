<div align="center">

# cdx

**Codex and Antigravity execution lanes for Claude Code.**

Claude plans. GPT and Gemini execute. cdx keeps the books.

[![License](https://img.shields.io/github/license/RedesignedRobot/cdx?color=blue)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![Dependencies: zero](https://img.shields.io/badge/dependencies-zero-3fb950)](cdx.ts)
[![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757?logo=claude&logoColor=white)](#claude-code-integration)

<img src="assets/demo.svg" alt="cdx spawning detached workers, checking status, and collecting reports" width="760">

</div>

cdx is a single-file CLI that lets a [Claude Code](https://claude.com/claude-code) session drive [OpenAI Codex CLI](https://github.com/openai/codex) and Google Antigravity CLI workers as detached background lanes. Claude stays the head. It plans, briefs, reviews, and merges. GPT and Gemini do the lane work. cdx records their state, logs, reports, questions, and token use.

Running one worker is easy. Running several in parallel, surviving the parent shell, keeping each session tied to the right task, resuming context, collecting reports, and noticing a silent failure takes bookkeeping. cdx owns it in one place.

## Setup in 60 seconds

You need [Bun](https://bun.sh) and at least one engine. Install and sign in to [Codex CLI](https://github.com/openai/codex) 0.149+ for `--engine gpt`, or install and authorize Google Antigravity CLI (`agy`) for `--engine gemini`. Then:

```bash
git clone https://github.com/RedesignedRobot/cdx.git ~/.claude/skills/cdx && ln -s ~/.claude/skills/cdx/cdx.ts ~/.local/bin/cdx
```

Install or refresh the Antigravity agent files, then verify the configured engines with live round trips:

```bash
cdx doctor --fix
cdx doctor --probe
```

`doctor` checks Codex, Antigravity, account usage, configuration, the guard, the monitor, the ledger, the two Antigravity agent files, the hooks entry state in `hooks.json`, confirmed loaded hooks in agy via `/hooks`, and whether the configured Gemini model is present in `agy models`. `doctor --fix` links the shipped agents into `~/.gemini/config/agents/` and installs the `cdx` entry into `~/.gemini/config/hooks.json`. `doctor --probe` runs one short request through each installed engine. A missing `agy` is a warning unless the config has a `gemini` block. Set `CDX_AGY_CONFIG_HOME` and `CDX_AGY_STATE_HOME` as test overrides for Antigravity configuration and state paths. Cloning into `~/.claude/skills/` makes Claude Code load cdx as a plugin in the next session. The symlink makes `cdx` a normal terminal command. The CLI also works outside Claude Code.

Works on macOS, Linux, and WSL.

## Two engines

Claude uses a three-level delegation ladder. The head plans, briefs, reviews, and merges. GPT through Codex handles the hardest implementation and design lanes. Gemini 3.8 Flash high through Antigravity handles bounded work with a precise brief.

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

`--engine` is optional on spawn, review, and adopt and defaults to `gemini`. `--engine gpt` is explicit. Resume inherits the lane engine. Gemini always runs `gemini-3.8-flash-high`; cdx ignores `--effort` for Gemini with a note. Gemini has no headless fork, so resume it instead.

## Quickstart

```bash
# One worker, wait for the report
cdx spawn fix-flaky-test --engine gemini --cd ~/code/myapp "The test in auth.test.ts fails
intermittently. Find the race, fix it, and prove it with 20 green runs."

# Three workers in parallel, detached, each in its own git worktree
cdx spawn api-docs   --engine gemini --cd ~/code/myapp --worktree ~/code/myapp-docs --bg "Document every public endpoint in openapi.yaml."
cdx spawn dead-code  --engine gemini --cd ~/code/myapp --worktree ~/code/myapp-dead --bg "Find and delete unreachable code. List every deletion."
cdx spawn slow-query --engine gpt --cd ~/code/myapp --worktree ~/code/myapp-perf --bg --effort high "Profile the /search endpoint and fix the N+1."
cdx wait api-docs dead-code slow-query

# Watch a worker think, live
cdx tail -f slow-query

# Correct a running worker without waiting for the round to finish
cdx send slow-query "The slow path is /search/export, not /search."

# Continue a thread with its context intact
cdx resume dead-code "Also remove the now-unused imports."

# Review a worker's diff in a fresh, read-only session
cdx review slow-query-review --engine gemini --cd ~/code/myapp-perf --uncommitted

# Finish
cdx report slow-query
cdx close slow-query "landed in a1b2c3d"
```

## How it works

```mermaid
flowchart LR
    head["Claude Code session<br/><i>the head</i>"] -->|spawn · resume · fork · review| cdx["cdx"]
    head -->|send · reply| cdx
    cdx -.->|detached| w1["Gemini worker<br/><i>lane: api-docs</i>"]
    cdx -.->|detached| w2["GPT worker<br/><i>lane: slow-query</i>"]
    cdx -.->|fresh| w3["GPT or Gemini reviewer"]
    w1 -->|ask| cdx
    w1 --> state[("ledger · logs<br/>reports · briefs")]
    w2 --> state
    w3 --> state
    state -->|feed.log → monitor| head
```

- **One ledger entry per lane**: engine, session ID, working directory, state, rounds, token spend, last activity.
- **Detached lanes** keep running after your shell exits.
- **One engine child per work round**: GPT uses a Codex app-server over stdio. Gemini uses Antigravity stream JSON over stdio and keeps the conversation ID for resume.
- **Reports captured per round**: Both GPT and Gemini work reports capture the final agent message of the turn, not concatenated turn text. Non-success Gemini results write `reports/<lane>-r<n>.partial.md` and never overwrites full reports.
- **Auto-continue**: A Gemini round reporting a transport error (`The stream was interrupted` or `timeout waiting for response`) while agy is alive gets up to two continuation turns in the same conversation. The feed line reports `auto-continue <n>/2`. Status reports `auto-continued <n>x`. A third failure fails the round with note `turn failed after 2 auto-continues: <reason>`.
- **Five-hour quota guard**: A Gemini round ending with `Individual quota reached` writes `~/.cdx/gemini-quota.json` with the parsed reset time (30 minutes when unparsed). `spawn`, `resume`, and `review` refuse Gemini work until it passes and point at `--engine gpt`. Every Gemini round refreshes `usage-gemini.json`; a fresh snapshot blocks under 5% five-hour remaining and warns under 15%. Status, brief, and doctor show the block.
- **Replayed-error detection**: Antigravity can return the previous turn's error verbatim on a resumed conversation even though the new turn finished. When the error equals the lane's last recorded error and the turn produced a final agent message, the round finalizes as success with feed line `ignored replayed agy error: <text>`. Transport errors stay on the auto-continue path.
- **Strict report contract**: a completed work turn needs a qualifying report. Without one, the round fails with `no final report`, and cdx skips the acceptance gate. A Gemini round whose final response is the agy cancellation template ("User initiated cancellation", "Execution stopped per your cancellation request") finalizes failed with note "agy returned its cancellation template as the report; no qualifying report", and the gate does not run.
- **Reviews run in fresh sessions**: Codex enforces read-only access. Gemini reviews return structured output via JSON schema into `reports/<lane>-r<n>.findings.json`. `cdx hook pre-tool` denies file-writing tools during review rounds, and cdx checks the tree before and after the round.
- **Stall detection**: a lane quiet for five minutes writes a feed warning, repeated at most every ten minutes, with an active-again line when events resume.

## Commands

| Command | What it does |
|---|---|
| `cdx spawn <lane> [--engine gpt\|gemini] "<brief>"` | Start a worker in its own lane |
| `cdx resume <lane> "<follow-up>"` | Continue a lane's thread, context intact |
| `cdx gate <lane> "<cmd>"` | Set or replace an inactive lane's acceptance gate |
| `cdx fork <new> <lane> "<brief>"` | Branch a thread into a new lane |
| `cdx send <lane> "<text>"` | Deliver in-turn steers via hooks or queue follow-up turns |
| `cdx ask "<question>"` | Ask the owning head from inside a work lane and wait for its answer |
| `cdx reply <lane> "<answer>"` | Answer the oldest open question from the lane's current round, or select one with `--id` |
| `cdx questions [lane]` | List current-round open questions across all lanes or one lane |
| `cdx msg <target> "<text>"` | Send a feed message to a session prefix or a lane's owning session |
| `cdx inbox` | Print messages addressed to the calling Claude session |
| `cdx review <lane> [--engine gpt\|gemini]` | Review a lane's diff in a fresh session |
| `cdx status` | Show lane state, timing, tokens, steer count, open question, and last activity |
| `cdx usage` | Codex account limits, Gemini limits, and all-time ledger totals |
| `cdx wait <lane\|job>...` | Block until lanes or jobs finish; exit 1 if any failed; `--report` prints the reports too |
| `cdx job <name> "<cmd>"` | Run a shell command detached: one log, one feed line on exit; `wait`, `kill`, and `status` know it |
| `cdx tail <lane>` / `cdx tail -f` | Rendered event log, or live transcripts of every running lane |
| `cdx feed` | Replay recent completion and stall lines from the feed |
| `cdx report <lane>` | Print a lane's final report |
| `cdx kill <lane>` | Stop a running lane: SIGTERM the runner, force-finalize if it hangs |
| `cdx doctor --probe` | Health check with remedies, hooks and model checks, and live engine round-trips |
| `cdx adopt <lane> <sessionId> [--engine gpt\|gemini]` | Record an existing session as a lane |
| `cdx close` · `cdx clean` · `cdx log [--transcript]` · `cdx brief` | Bookkeeping |

<details>
<summary><b>Full flag reference</b></summary>

```
cdx spawn  <lane> [--engine gpt|gemini] [--account NAME] [--effort E] [--cd D] [--worktree P] [--bg] [--add-dir D]... [--schema F] [--image F]... [--gate "<cmd>"] [--gate-baseline-check] [--max-runtime MIN] "<brief>"
cdx resume <lane> [--effort E] [--bg] [--gate "<cmd>"] [--max-runtime MIN] "<follow-up>"
cdx gate   <lane> ("<cmd>" | --clear)
cdx fork   <new> <lane|sessionId> [--account NAME] [--effort E] [--bg] "<brief>"
cdx send   <lane> "<text>"
cdx ask    [--timeout MIN] "<question>"
cdx reply  <lane> [--id SEQ] "<answer>"
cdx questions [lane]
cdx msg    <lane|session-prefix> "<text>"
cdx inbox  [-n N]
cdx review <lane> [--engine gpt|gemini] [--account NAME] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>"]
cdx adopt  <lane> <sessionId> [--engine gpt|gemini] [--account NAME] [--cd D]
cdx status [--all] [--json]
cdx usage  [--json]
cdx wait   <lane>... [--timeout S] [--json] [--report]
cdx tail   <lane> [-n N]
cdx tail   -f [lane]
cdx feed   [-n N]
cdx report <lane> [round]
cdx log    <lane> [round] [--transcript]
cdx kill   <lane> ["note"]
cdx close  <lane> [--remove-worktree] ["note"]
cdx clean  [--days N]
cdx doctor [--fix] [--probe]
cdx brief
```

`review` with a target flag (`--uncommitted`, `--base`, `--commit`) reviews that diff. GPT uses Codex's native reviewer. Gemini receives the equivalent `git diff` instruction. An intent review uses the same adversarial review frame on either engine. A Gemini review of a Gemini lane prints a note asking for explicit attack items. Gemini reviews return structured output through a JSON schema; the report field becomes `reports/<lane>-r<n>.md` and findings land in `reports/<lane>-r<n>.findings.json`. GPT reviews keep the closing fenced JSON findings block, which cdx extracts into `reports/<lane>-r<n>.findings.json`. Both engines start a fresh session. Codex enforces read-only access. For Gemini, `cdx hook pre-tool` denies file-writing tools inside review lanes, and cdx records the tree before launch and fails the round with the first changed path if the reviewer writes anything. The report remains available.

GPT work rounds own one `codex app-server` child. cdx starts it with approval policy `never` and full workspace access. Gemini work rounds own one `agy` child with stream JSON input and output, `gemini-3.8-flash-high`, the configured `cdx-lane` agent, and every lane directory passed through `--add-dir`. cdx removes `CODEX_HOME` from the Gemini environment. It stores the Antigravity `conversation_id` as the lane session ID and passes it through `--conversation` on resume. Each engine writes its raw events to the round JSONL log and stderr to a separate log. `--schema` reaches either engine. `--image` is GPT-only. Gemini always runs `gemini-3.8-flash-high` and `--effort` is ignored with a note. Every tool is available to Gemini lanes because the shipped `cdx-lane` agent file sets no tools allowlist and cdx passes `--dangerously-skip-permissions`. Gemini briefs carry house rules: execute as written, ask via `cdx ask` when a gap changes the outcome (one small question per gap), take the narrowest reading only after the answer times out (recording it under an Assumptions heading), parallelize independent work with subagent threads rather than working them serially, remove debug prints before reporting, and list files changed and commands with exit codes in the report. Any subagent depth cap comes from `config.json` rules appended after built-ins. Both engines also get the rule never to run `cdx spawn`, `resume`, `fork`, `review`, `adopt`, `kill`, or `close` from inside a lane; the harness enforces it by refusing those commands (plus `clean`, `gate`, and `reply`) whenever `CDX_LANE` is set in the environment.

When a round fails, cdx writes the engine error to the lane note and completion feed line.

### Communication channels

`cdx send <lane> "<text>"` appends a control record with the text, send time, and optional sender prefix. GPT steers the active turn when possible and starts a follow-up turn otherwise. `cdx doctor --fix` installs a `cdx` entry into `~/.gemini/config/hooks.json` with PreToolUse and PreInvocation commands. `cdx hook pre-invocation` delivers pending `cdx send` records into the running turn (feed line `steer delivered mode=in-turn`). Without the hook entry, Gemini sends fall back to follow-up turns (`mode=follow-up-turn`). Set `CDX_AGY_CONFIG_HOME` and `CDX_AGY_STATE_HOME` as test overrides for Antigravity configuration and state paths. cdx never consumes a control record before delivery. `send` refuses review lanes.

A worker can run `cdx ask [--timeout MIN] "<question>"`. The runner exports `CDX_LANE`, `CDX_ROUND`, and `CDX_OWNER` to both engines, so `ask` can identify its lane and owner. Gemini workers ask via `cdx ask` when a gap changes the outcome, ask one small question per gap, and take the narrowest reading only after the answer times out, recording it under an Assumptions heading. The command writes `$CDX_HOME/questions/<lane>-r<round>-<seq>.json` with the question, ask time, and `answered: false`. It posts a `QUESTION` line with the lane owner's suffix and polls for an answer. The default and maximum timeout is 30 minutes. A larger value is clamped to 30 and prints a note. `cdx reply <lane> "<answer>"` answers the oldest open question in the lane's current round by default. Add `--id <seq>` to select a specific question. `cdx questions [lane]` lists open questions only from each lane's current round. Round completion and failure close every remaining question from that round with `expired: round ended`, so a later reply cannot match it by default. While a question remains open, `cdx status` shows `waiting on question #<seq>`. On timeout, `ask` exits 0 and tells the worker to take the conservative reading, record the deviation in its report, and continue. A timed-out question does not fail the round.

Claude sessions can run `cdx msg <target> "<text>"`. A target can be an eight-character session prefix or a lane name, which resolves to that lane's owner. The caller must have `CLAUDE_CODE_SESSION_ID`. cdx writes `[cdx] msg to=<target8> from=<caller8>: <text>` to `feed.log`. cdx replaces CR and LF characters with spaces in `msg`, `send`, `ask`, and `reply` text before any feed or control write. User text cannot inject a second record into either line-based file. `cdx inbox [-n N]` reads only the needed tail and prints messages addressed to the caller, newest last. It defaults to the newest 20 messages.

`spawn --gate "<cmd>"` stores an acceptance gate on the lane. After a work round exits 0 with a report, cdx runs the command with `/bin/sh -lc` in the lane cwd. Exit 0 appends a `## Gate` section to the report. A nonzero exit fails the round with `gate failed (exit N)`. Work resumes rerun the stored gate. Reviews never run one. The gate is the harness's own verification, so a worker's optimistic done claim cannot finalize green.

When a work round changes no files, cdx checks whether the lane has a gate. With a gate, the round fails with "gate passed on an unchanged tree: no work landed" and the gate is skipped. Without a gate, the round finalizes done, the report gains a "## Harness note" saying no files changed, the feed line carries `diff=empty`, and status shows "no tree change".

A worktree spawn with `--gate` runs the gate once in the untouched baseline tree before the worker starts. A non-worktree spawn runs this check when you also pass `--gate-baseline-check`. A baseline failure stops the round as `gate-invalid` and identifies the gate command as the defect. A final gate failure that had no baseline check suggests `--gate-baseline-check` for the next run.

`cdx gate <lane> "<cmd>"` sets or replaces the stored gate. `cdx gate <lane> --clear` removes it. Both forms print the old and new value and refuse to change an active lane. `resume --gate "<cmd>"` replaces the stored gate before that work round and keeps it for later resumes.

`resume` inherits the lane engine and rejects `--engine`. It reattaches to the recorded work session even after a review. A GPT lane also reuses its recorded Codex account and home. A Gemini lane resumes with `agy --conversation <sessionId>`. A missing `engine` in an older ledger row means GPT.

`fork` inherits the source lane engine. GPT can fork a lane or a raw Codex session ID. Gemini has no headless fork, so `cdx fork` refuses a Gemini lane and directs the caller to `cdx resume`.

`status` keeps the lane state and cwd tied to the latest work round. A review does not replace either value. When a lane has review history, `status` prints the review outcome and target directory on a separate review line.

`kill` sends SIGTERM to the runner, which reaps its engine child and finalizes the round with a signal note. A runner still silent after 10 seconds gets SIGKILL, and cdx finalizes the ledger with note `killed`. `--max-runtime MIN` uses the same signal sequence on either engine child.

`close --remove-worktree` removes the lane worktree and deletes its branch only when the branch is merged into the repo's HEAD and the worktree is clean; otherwise it refuses with the reason and prints the manual commands.

A brief of `-` reads the brief from stdin (`cdx spawn big-task --engine gemini --bg - < brief.md`), so long prompts with quotes and backticks never fight the shell. Works for spawn, resume, fork, and the review intent. Headless agy expands `/skill-name ...` at the start of a prompt, so a brief may open with a project skill invocation such as `/hyperscale-change ...` when the workspace ships that skill under `.agents/skills`.

`spawn --worktree <path>` creates a git worktree at that path on a new branch `lane/<lane>` from the repo at `--cd` (or the current directory), runs the optional `worktreeSetup` command from config inside it, and runs the lane there. A repository may ship an executable `.cdx-worktree-setup` at its root; `spawn --worktree` runs it after the global `worktreeSetup` command and fails the spawn on nonzero exit. The worktree and branch are recorded in the ledger and shown by `status`; `close` prints the removal commands but never deletes anything itself. This gives each parallel worker exclusive files without sharing a dirty tree.

`wait --json` prints one JSON object per finished lane, in completion order: state, exit code, tokens, report path, note, session ID.

</details>

## Orchestration patterns

**Single lane, report on completion.** Run `cdx spawn` in the foreground from a background shell. The harness prints a summary line plus the full report at exit, so one notification carries everything.

**Fan-out.** Fire each lane with `--bg` (they detach and survive the shell), then one `cdx wait a b c` blocks until the wave lands. Give each lane `--worktree` when they touch the same repo, so no worker sees another's dirty files.

**Watch live.** `cdx tail -f <lane>` streams one worker's transcript and exits with the lane's outcome. `cdx tail -f` shows all running lanes with `[lane]` prefixes and follows new rounds and lanes. Any terminal or agent session can use either form against the shared state, which is how parallel Claude sessions see each other's workers.

**Steer, iterate, or branch.** `send` corrects a running lane via in-turn steering or a follow-up turn. `resume` continues a finished worker with its recorded engine and context. `fork` branches GPT context into a new lane. Gemini has no headless fork.

## Claude Code integration

Installed as a plugin (the clone into `~/.claude/skills/` above), cdx wires itself into the session:

- **No polling.** Lane events and messages append to `$HOME/.cdx/feed.log`; a monitor tails it and Claude Code surfaces new lines as notifications.
- **Session attribution.** Every lane feed event ends with `owner=<session prefix>`, so parallel Claude Code sessions can identify which lane events belong to them.
- **Peer messages.** `cdx msg` addresses a feed line to one session prefix. A matching `msg to=` line is a request from that peer. Other targets remain visible as shared feed information.
- **Session opener.** A SessionStart hook runs `cdx brief`, which prints only running or failed lanes and stays silent when everything is settled.
- **Guard rail.** A PreToolUse hook blocks raw headless Codex and Antigravity work commands and points the caller to `cdx`. Login, model listing, help, update, and version checks remain available.
- **`/cdx` skill.** The playbook that teaches the session the commands and patterns above.

## Configuration

Everything lives under `$CDX_HOME`, default `~/.cdx`. The optional `$CDX_HOME/config.json`:

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

- Existing top-level keys configure GPT. `model` is the Codex model. `efforts` is the GPT `--effort` allowlist. `defaultEffort` applies when the flag is absent.
- `gemini` is optional. Its shown values are the defaults. Gemini always records effort `high`; its effort is not configurable.
- `rules` entries are appended to every injected brief, followed by `.cdx-rules.md` from the lane's working directory when that file exists. This is where house style, tooling mandates, and per-project law live.
- `worktreeSetup` (optional) is a shell command run inside every new `--worktree` before the lane starts, typically a dependency install. A nonzero exit aborts the spawn and leaves the worktree in place for inspection. A repository may ship an executable `.cdx-worktree-setup` at its root; `spawn --worktree` runs it after the global `worktreeSetup` command and fails the spawn on nonzero exit.

### Two accounts, automatic failover

Each account needs its own Codex home. cdx sets `CODEX_HOME` for every Codex process in a lane, which keeps login data and session files tied to that account.

```json
{
  "accounts": {
    "codex-1": "~/.codex",
    "codex-2": "~/.codex-2"
  }
}
```

The first entry is primary. A new GPT spawn or review chooses the first account with capacity. Pass `--account codex-2` to force one. Every command that reopens a GPT lane uses the account and Codex home recorded in its ledger row. A lane never changes account after spawn. Gemini lanes do not take part in Codex account selection and reject `--account`.

A GPT lane fork inherits the parent's account and Codex home, and records both on the new lane. A raw-session-ID fork is GPT-only. GPT adopt and raw-session-ID fork accept `--account` and otherwise use the primary account.

For a pre-upgrade lane whose ledger row has no account data, cdx falls back to the default Codex home and writes that fallback to the feed.

Keep each account name tied to one home. Use a new name when a home path changes so its cached usage cannot belong to the previous login.

Do not swap authentication files inside one Codex home while parallel lanes run. A lane can then resume a session under the wrong login.

If `config.json` is absent, the defaults above apply. Malformed JSON or an inconsistent shape stops the command with a message that names the file.

> [!IMPORTANT]
> Work lanes can edit files and run shell commands without approval. The injected brief forbids commits, pushes, deploys, and extra servers. Codex review lanes use a read-only sandbox. Gemini review lanes deny file-writing tools via lifecycle hooks and check the tree before and after the round. Point cdx only at code you would let either engine edit.

<details>
<summary><b>What the harness injects</b></summary>

Every work brief says that workers must not commit, push, deploy, or start extra long-running servers. It includes the report contract. GPT workers receive rules to use subagents for parallel work and run `cdx ask` when open points change architecture or files. Gemini workers receive Gemini house rules: execute as written, ask via `cdx ask` when a gap changes the outcome, ask one small question per gap, take the narrowest reading only after the answer times out, recording it under an Assumptions heading, parallelize independent work with subagent threads rather than working them serially, remove debug prints before reporting, and list files changed and commands with exit codes in the report. Any subagent depth cap comes from `config.json` rules appended after built-ins. Tool access is not an injected rule; the shipped `cdx-lane` agent file sets no tools allowlist and cdx passes `--dangerously-skip-permissions`. Review lanes receive a read-only rule and an adversarial review frame. cdx appends `config.json` rules after those built-ins, then appends the lane working directory's `.cdx-rules.md`.

Each engine handles its own context. cdx does not set a fixed context size.

</details>

<details>
<summary><b>State layout</b></summary>

```
$CDX_HOME/
  ledger.json    one entry per lane: session, state, rounds, tokens, transcriptPath, notes
  logs/          raw engine events and stderr for each round
  reports/       final report per round
  briefs/        audit trail of every injected prompt
  specs/         the runner inputs recorded for each round
  control/       queued steering records, one JSONL file per round
  questions/     worker questions and their answer or timeout state
  feed.log       newest lane events and peer messages, tailed by the plugin monitor
```

Everything is plain files. `cat` works on all of it. `cdx feed` and `cdx inbox`
read only the tail needed for their requested output. `cdx clean` truncates
`feed.log` to its newest 2000 lines.

</details>

## License

[MIT](LICENSE)
