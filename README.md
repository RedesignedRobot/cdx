<div align="center">

# cdx

**A native Claude Code plugin that runs OpenAI Codex and Google Antigravity as execution lanes.**

Claude is the head. Astra drives. Gemini executes. cdx keeps the books and wakes the head when a lane needs it.

[![Claude Code native plugin](https://img.shields.io/badge/Claude_Code-native_plugin-d97757?logo=claude&logoColor=white)](#native-in-claude-code)
[![Function hooks](https://img.shields.io/badge/function_hooks-21_tools-d97757)](#registered-tools)
[![Version](https://img.shields.io/badge/version-7.0.0-blue)](CHANGELOG.md)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![Dependencies: zero](https://img.shields.io/badge/dependencies-zero-3fb950)](cdx.ts)
[![License](https://img.shields.io/github/license/RedesignedRobot/cdx?color=blue)](LICENSE)

<img src="assets/demo.svg" alt="cdx spawning detached workers, checking status, and collecting reports" width="760">

</div>

cdx is a [Claude Code](https://claude.com/claude-code) plugin and a standalone CLI for [OpenAI Codex](https://github.com/openai/codex) and Google Antigravity lanes. Claude Code is the owner's liaison. It briefs an outcome to one Astra supervisor, answers questions, arranges independent review, and merges. Astra owns design and implementation and delegates bounded work to Gemini. cdx records lane state, reports, questions, logs, and token use.

## Native in Claude Code

cdx 7.0 runs inside Claude Code as a [function hooks](#claude-code-integration) module, not as a shell wrapper. When a session starts, the mod registers 21 tools under `mcp__cdx__`, the `/lanes` command, a status line, and a two-second poll of the event feed. The head spawns a lane with one tool call and ends its turn. Nothing blocks. cdx wakes the head when the lane finishes, asks a question, stalls, or hits an outage.

```mermaid
sequenceDiagram
    participant Head as Claude Code head
    participant Mod as cdx mod (in-process)
    participant CLI as cdx CLI
    participant Lane as Codex or Antigravity lane
    Head->>Mod: mcp__cdx__spawn { lane, brief }
    Mod->>CLI: cdx spawn --bg -
    CLI->>Lane: detached round starts
    Note over Head: turn ends, nothing waits
    loop every 2 s
        Mod->>CLI: cdx events --json
    end
    Lane-->>CLI: question, report, stall, 503
    CLI-->>Mod: wake event
    Mod-->>Head: [cdx] prompt when idle, tool context mid-turn
    Head->>Mod: mcp__cdx__reply, report, close
```

| In the session | What it does |
|---|---|
| `mcp__cdx__spawn`, `resume`, `review`, `consult`, `fork` | Start work. The brief travels as a tool field, never through the shell. |
| `mcp__cdx__reply`, `send`, `msg` | Answer a question, steer a running lane, message a peer session. |
| `mcp__cdx__status`, `events`, `report`, `tail`, `questions`, `usage` | Check in without waiting. |
| `mcp__cdx__close`, `kill`, `gate`, `job`, `takeover`, `doctor` | Finish, stop, gate, run detached jobs, claim work, diagnose. |
| `[cdx]` prompts and toasts | Wake events arrive as a prompt when the head is idle and as context on the next tool result mid-turn. |
| `/lanes` | Lane status, or any read-only cdx command, from the prompt. |
| Status line | Running lanes, open questions, and quota, refreshed every ten seconds. |

There is no wait tool by design. The CLI keeps `cdx wait` for Astra, Gemini, and people at a terminal.

## Setup in 60 seconds

You need [Bun](https://bun.sh) and at least one engine. Install and sign in to [Codex CLI](https://github.com/openai/codex) 0.149+ for `--engine gpt`, or install and authorize Google Antigravity CLI (`agy`) for `--engine gemini`. Then install cdx 7.0.0:

```bash
git clone https://github.com/RedesignedRobot/cdx.git ~/.claude/skills/cdx && ln -s ~/.claude/skills/cdx/cdx.ts ~/.local/bin/cdx
```

Install or refresh the Antigravity agent files, then verify the configured engines with live round trips:

```bash
cdx doctor --fix
cdx doctor --probe
```

`doctor` checks engine binaries, login and usage, configuration, function hooks, mod polling, and stale ledger entries. For Antigravity it also checks agent files, loaded hooks, and model availability. `--fix` installs the shipped Antigravity agents and hooks and repairs stale rounds. `--probe` runs a short request through each installed engine. Missing `agy` is a warning unless the config enables Gemini.

Every configured Codex home must match the primary home's `AGENTS.md`, complete MCP definitions, and `hooks.json`. Sync removes extra secondary MCP definitions and shared keys absent from primary. The first configured account is primary; without an accounts map, doctor uses `CODEX_HOME` or `~/.codex`. Running `cdx doctor --fix` synchronizes primary `AGENTS.md` directives, shared MCP server definitions and shared config keys in `config.toml`, and `hooks.json` across configured homes while preserving credentials, auth sessions, and account-specific settings.

Cloning into `~/.claude/skills/` loads the plugin in the next Claude Code session. The symlink also makes cdx available as a terminal command.

Works on macOS, Linux, and WSL.

## Browser view

Run `cdx view` in its own terminal, then open `http://127.0.0.1:7477`. Use `cdx view --open` on macOS to open the browser, or `--port N` to choose a port. Ctrl-C stops the server. Journal reads take the event lock without changing stored state.

The page opens on running lanes and jobs. Running, Done, Failed, and All filters remember your choice across reloads. All keeps running work first, then finished work. Each group sorts by recent activity. Failed includes invalid gates; closed and adopted lanes appear only in All. Parent names stay on each row without changing the order. Expand Feed for the latest 200 entries. The dashboard reads discrete `work` and `review` round records directly, without flat state or cwd fallbacks.

Select a lane for its owner, elapsed time, questions, reports, and live transcript. Pick a round to inspect earlier output. Escape closes the details. Logs follow new output until you scroll up.

Violet orbits mark Astra/GPT, teal scanlines mark Gemini, and amber tickers mark jobs. These show running state, not measured progress. A lane with no events for five minutes gets a quiet warning. New rounds enter once; new transcript lines fade in. The page respects reduced motion, works offline, and follows the system light or dark theme. It uses system fonts and no dependencies.

## Two engines

`--engine` is optional on spawn, review, and adopt and defaults to `gemini`. `--engine gpt` is explicit. Resume inherits the lane engine. Gemini always runs `gemini-3.8-flash-high`; cdx ignores `--effort` for Gemini with a note. Gemini has no headless fork, so resume it instead. A Gemini lane gets a 90-minute `--max-runtime` unless the flag says otherwise (`gemini.maxRuntimeMins` in the config); Codex lanes have no default cap.

`--model M` picks the Codex model for a gpt lane: an alias from the `models` config map (`astra` for `gpt-6-astra`, say) or a raw model id. The lane keeps its model across resume, fork, and review, and status shows it. The built-in `gpt-6-astra` effort cap at `medium` stays. A child lane can never run `gpt-6-astra`. The refusal is checked on the resolved model (explicit `--model`, alias such as `astra`, config default, retained resume), before any account probe or process start. Head-launched Astra stays allowed.

`--supervisor` lets a GPT lane drive its own children through spawn, resume, review, consult, send, reply, kill, and close. Gemini is the default child engine; GPT children and read-only consults are also available. Native Codex subagents are disabled in every cdx-launched GPT session (owner ruling 2026-09-12). Every child is a tracked cdx lane with its own cost and gate.

Limits retained in 7.0.0:

- Supervisors drive only their own children so they cannot disturb another task. Ending a supervisor round stops running children; reporting with a running child fails the round.
- Nested supervisors are refused to keep delegation one level deep. Child lanes are instructed not to delegate further; the Codex depth hook remains in place.
- Child gates cannot change through `gate`, `resume --gate`, or respawn because they define acceptance. Omitting `--gate` on a supervised respawn preserves and runs the stored gate.
- Codex reviews use a read-only sandbox. Gemini reviews fail if the tree changes, so review only a quiet tree.
- Jobs stay with the liaison because they can outlive a lane. Fork, adopt, and clean also stay there because they can affect unrelated history or shared artifacts.
- Lanes are instructed not to commit, push, or deploy because the liaison integrates after review. Review hooks and fingerprints are accidental-write controls, not a security sandbox against arbitrary shell access.

## Quickstart

```bash
# Default path for a whole change
cdx spawn search-fix --engine gpt --model gpt-6-astra --supervisor --bg \
  --cd ~/code/myapp --gate "bun run check" "Fix the search timeout and verify the affected flows."
cdx wait search-fix --report

# A bounded task can go directly to Gemini
cdx spawn fix-flaky-test --engine gemini --cd ~/code/myapp "The test in auth.test.ts fails
intermittently. Find the race, fix it, and add a deterministic regression test."

# Three workers in parallel, detached, each in its own git worktree
cdx spawn api-docs   --engine gemini --cd ~/code/myapp --worktree ~/code/myapp-docs --bg "Document every public endpoint in openapi.yaml."
cdx spawn dead-code  --engine gemini --cd ~/code/myapp --worktree ~/code/myapp-dead --bg "Find and delete unreachable code. List every deletion."
cdx spawn slow-query --engine gpt --cd ~/code/myapp --worktree ~/code/myapp-perf --bg "Profile the /search endpoint and fix the N+1."
cdx wait api-docs dead-code slow-query

# Follow a worker thinking, live
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
    head["Claude Code head"] -->|"mcp__cdx__* tools"| mod["cdx mod<br/>(function hooks)"]
    mod -->|argv and stdin| cdx["cdx CLI"]
    cdx -->|supervisor lane| astra["Astra driver"]
    astra -->|delegate and verify| cdx
    cdx -->|bounded tasks| children["Gemini or GPT children"]
    children -->|reports and questions| cdx
    cdx -->|"feed, polled every 2 s"| mod
    mod -->|"[cdx] prompt or tool context"| head
```


- Each lane has discrete `work` and `review` round records. Version 5 writes `{ version: 5, lanes: { ... } }` and `.ledger-version` to reject older writers. The writer migrates 3.x and 4.0 ledgers once on write under lock and rejects legacy shapes thereafter. Flat `state` and `cwd` aliases are removed from the ledger and view summaries. A new round clears its predecessor's report and note.
- The runner handles engine events, qualifies Gemini results, and finalizes reports and gates. Shared JSONL framing handles unterminated responses and skips non-object values. Effort is pinned in the round spec; every round spec requires an explicit engine and effort, and pre-4 effort and account fallbacks are removed. Resuming a live round is refused.
- Usage mutations share one `.usage.lock` transaction so parallel probes preserve each other's account snapshots. Codex token usage is counted per thread from a per-thread baseline. Missing or non-finite counters mark the round "incomplete" instead of counting as zero; status and usage output show "(incomplete)", and `usage --json` rows carry an `incomplete` field. Every round records a start time and emits a `started` feed event.
- Detached lanes: Detached lanes keep running after your shell exits.
- One engine child per work round: GPT uses a Codex app-server over stdio. Gemini uses Antigravity stream JSON over stdio and keeps the conversation ID for resume.
- Reports captured per round: Both GPT and Gemini work reports capture the final agent message of the turn, not concatenated turn text. Non-success Gemini results preserve the last agent response in `reports/<lane>-r<n>.partial.md` and never overwrite full reports. Transport error text does not replace captured partial work. Failed rounds expose that path in their ledger record and terminal feed when no full report exists. Failure notes contain the reason and partial path, not the report markdown.
- Gemini retry policy: Errors are classified from the result error only, never from the model's response text. Transport failures (interrupted stream, broken pipe, timeout, transient network) get one automatic retry when no new step completed since the last one; a completed step resets that counter. A 503 is treated as a service outage, not a stream fault: the live process is kept and cdx retries up to six times with waits of 30 s, 1, 2, 4, 5 and 5 minutes (about 18 minutes of patience), resetting the ladder when a step completes. The first 503 emits a wake event of kind `outage` to the owning session and a `CDX NOTICE` control record to the supervising lane if the failing lane is a child, so neither resumes or respawns a lane that is only waiting. If the outage outlasts the ladder the round fails with `gemini 503 outage outlasted 6 auto-retries (~18 min); when Gemini answers again run cdx resume <lane>, the partial report is kept`. If the agy process dies, the round fails with the note "transport death; cdx resume continues from the partial" and the partial report is kept for cdx resume. Quota refusals, malformed tool calls, cancellations, and failed gates never retry. The round runtime cap always applies.
- Five-hour quota guard: A Gemini round ending with `Individual quota reached` writes `~/.cdx/gemini-quota.json` with the parsed reset time (30 minutes when unparsed). `spawn`, `resume`, and `review` refuse Gemini work until it passes and point at `--engine gpt`. Every Gemini round refreshes `usage-gemini.json`; a fresh snapshot blocks under 5% five-hour remaining and warns under 15%. Status, brief, and doctor show the block.
- Replayed-error detection: Antigravity can return the previous turn's error verbatim on a resumed conversation even though the new turn finished. When the error equals the lane's last recorded error and the turn produced a final agent message, the round finalizes as success with feed line `ignored replayed agy error: <text>`. Transport errors stay on the transport retry path.
- Strict report contract: A completed work turn needs a qualifying report. Without one, the round fails with `no final report`, and cdx skips the acceptance gate. A Gemini round whose final response is the agy cancellation template ("User initiated cancellation", "Execution stopped per your cancellation request") finalizes failed with note "agy returned its cancellation template as the report; no qualifying report", and the gate does not run.
- Reviews run in fresh sessions: Codex enforces a read-only sandbox. Gemini reviews return structured output via JSON schema into `reports/<lane>-r<n>.findings.json`. cdx compares the tree before and after the round and fails if any file changed.
- Stall detection: A lane quiet for five minutes writes a feed warning, repeated at most every ten minutes, with an active-again line when events resume.

## Commands

| Command | What it does |
|---|---|
| `cdx spawn <lane> [--engine gpt\|gemini] [--model M] [--supervisor] "<brief>"` | Start a worker in its own lane |
| `cdx resume <lane> "<follow-up>"` | Continue a lane's thread, context intact |
| `cdx gate <lane> "<cmd>"` | Set or replace an inactive lane's acceptance gate |
| `cdx fork <new> <lane> "<brief>"` | Branch a thread into a new lane |
| `cdx send <lane> "<text>"` | Deliver in-turn steers via hooks or queue follow-up turns |
| `cdx ask "<question>"` | Ask the owning liaison from inside a work lane and wait for its answer |
| `cdx reply <lane> "<answer>"` | Answer the oldest open question from the lane's current round, or select one with `--id` |
| `cdx questions [lane]` | List current-round open questions across all lanes or one lane |
| `cdx events` | Read pending owned feed events without advancing the cursor (`--peek`) or advance the delivery cursor |
| `cdx msg <target> "<text>"` | Send a feed message to a full session id or a lane's owning session |
| `cdx inbox` | Print messages addressed to the calling Claude session |
| `cdx review <lane> [--engine gpt\|gemini]` | Review a lane's diff in a fresh session |
| `cdx consult <lane> [--engine gpt\|gemini] [--supervisor]` | Run a read-only advisory consult or supervisor helper |
| `cdx status` | Show lane state, tool steps, dirty file count, stage, timing, and last action; `--line` renders a 100-character status line |
| `cdx usage` | Codex account limits, which account to spend next and why, Gemini limits, and all-time ledger totals |
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
cdx spawn  <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--account NAME] [--effort E] [--cd D] [--worktree P] [--bg] [--add-dir D]... [--schema F] [--image F]... [--gate "<cmd>"] [--gate-baseline-check] [--pre "<cmd>"] [--max-runtime MIN] ("<brief>" | -)
cdx resume <lane> [--effort E] [--bg] [--gate "<cmd>"] [--pre "<cmd>"] [--max-runtime MIN] ("<follow-up>" | -)
cdx gate   <lane> ("<cmd>" | --clear)
cdx fork   <new> <lane|sessionId> [--model M] [--account NAME] [--effort E] [--bg] ("<brief>" | -)
cdx send   <lane> ("<text>" | -)
cdx ask    [--timeout MIN] "<question>"
cdx reply  <lane> [--id SEQ] ("<answer>" | -)
cdx questions [lane]
cdx events [--json] [--peek]
cdx msg    <lane|full-session-id> ("<text>" | -)
cdx inbox  [-n N]
cdx takeover <lane|full-session-id>
cdx review <lane> [--engine gpt|gemini] [--model M] [--account NAME] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>" | -]
cdx consult <lane> [--engine gpt|gemini] [--supervisor] [--model M] [--account NAME] [--effort E] [--cd D] [--bg] ("<question>" | -)
cdx adopt  <lane> <sessionId> [--engine gpt|gemini] [--model M] [--account NAME] [--cd D]
cdx view [--port N] [--open]
cdx status [--all] [--json | --brief | --line | --watch [--interval S]]
cdx usage  [--json]
cdx wait   <lane>... [--timeout S] [--json] [--report]
cdx tail   <lane> [-n N]
cdx tail   -f [lane]
cdx feed   [-n N]
cdx report <lane> [round]
cdx log    <lane> [round] [--transcript]
cdx kill   <lane> ["note"]
cdx close  <lane> [--remove-worktree] ["note" | -]
cdx job    <name> [--cd D] ("<cmd>" | -)
cdx clean  [--days N]
cdx doctor [--fix] [--probe]
cdx brief
```

`review` with a target flag (`--uncommitted`, `--base`, `--commit`) reviews that diff. GPT uses Codex's native reviewer. Gemini receives the equivalent `git diff` instruction. An intent review uses the same adversarial review frame on either engine. A Gemini review of a Gemini lane prints a note asking for explicit attack items. Gemini reviews return structured output through a JSON schema; the report field becomes `reports/<lane>-r<n>.md` and findings land in `reports/<lane>-r<n>.findings.json`. GPT reviews keep the closing fenced JSON findings block, which cdx extracts into `reports/<lane>-r<n>.findings.json`. Both engines start a fresh session. Codex enforces read-only access. For Gemini, `cdx hook pre-tool` denies file-writing tools inside review lanes, and cdx records the tree before launch and fails the round with the first changed path if the reviewer writes anything. The report remains available.

`cdx consult` accepts `--engine gpt|gemini` and `--supervisor`. A Gemini consult is a read-only helper. A consult with `--supervisor` may start only owned read-only Gemini consult helpers; it cannot spawn writable workers, GPT children, or grandchildren.

GPT work rounds own one `codex app-server` child. cdx starts it with approval policy `never` and full workspace access. Gemini work rounds own one `agy` child with stream JSON input and output, `gemini-3.8-flash-high`, the configured `cdx-lane` agent, and every lane directory passed through `--add-dir`. cdx removes `CODEX_HOME` from the Gemini environment. It stores the Antigravity `conversation_id` as the lane session ID and passes it through `--conversation` on resume. Each engine writes its raw events to the round JSONL log and stderr to a separate log. `--schema` reaches either engine. `--image` is GPT-only. Gemini always runs `gemini-3.8-flash-high` and `--effort` does not change its effort. Every tool is available to Gemini lanes because the shipped `cdx-lane` agent file sets no tools allowlist and cdx passes `--dangerously-skip-permissions`. cdx pins the Gemini model and agent name into the round spec at launch, so the detached runner (which starts without the config file) runs what the liaison configured. The brief rules are described under Configuration. Plain workers cannot drive other lanes. A GPT supervisor can drive its own children and cannot create another supervisor.

When a round fails, cdx writes the engine error to the lane note and completion feed line.

### Communication channels

`cdx send <lane> "<text>"` appends a control record with the text, send time, and optional sender session id. GPT steers the active turn when possible and starts a follow-up turn otherwise. `cdx doctor --fix` installs a `cdx` entry into `~/.gemini/config/hooks.json` with PreToolUse and PreInvocation commands. `cdx hook pre-invocation` delivers pending `cdx send` records into the running turn (feed line `steer delivered mode=in-turn`). Without the hook entry, Gemini sends fall back to follow-up turns (`mode=follow-up-turn`). cdx never consumes a control record before delivery. `send` refuses review lanes.

A worker can run `cdx ask [--timeout MIN] "<question>"`. The runner exports `CDX_LANE`, `CDX_ROUND`, and `CDX_OWNER` to both engines, so `ask` can identify its lane and owner. Brief and liaison replies govern project and skill guidance within runtime constraints; if paused, workers identify the exact conflicting instruction. Workers make reasonable assumptions for reversible work, and ask through `cdx ask` only for missing decisions about outcome or authorization. The command writes `$CDX_HOME/questions/<lane>-r<round>-<seq>.json` with the question, ask time, and `answered: false`. It posts a `QUESTION` line with the lane owner's full session id and polls for an answer. The default and maximum timeout is 30 minutes. A larger value is clamped to 30 and prints a note. `cdx reply <lane> "<answer>"` answers the oldest open question in the lane's current round by default. Add `--id <seq>` to select a specific question. `cdx questions [lane]` lists open questions only from each lane's current round. Round completion and failure close every remaining question from that round with `expired: round ended`, so a later reply cannot match it by default. While a question remains open, `cdx status` shows `waiting on question #<seq>`. On timeout, `ask` exits 0. Timeout is not approval; the worker reports the unresolved dependency and stops only the work that depends on it, continuing independent authorized work without guessing. A timed-out question does not fail the round.

Claude sessions can run `cdx msg <lane|full-session-id> "<text>"`. A lane resolves to its owning head through the persisted takeover binding. Recipient and sender ids are stored as fields in a structured event. Message text never determines routing. Eight-character addresses are rejected. `cdx inbox [-n N]` prints only messages addressed to the caller, newest last, with a default of 20. `msg`, `send`, `ask`, and `reply` replace CR and LF with spaces before writing records.

`spawn --gate "<cmd>"` stores an acceptance gate on the lane. After a work round exits 0 with a report, cdx runs the command with `/bin/sh -lc` in the lane cwd. The gate runs with `<cwd>/node_modules/.bin` prepended to PATH, retaining the original PATH. Nested packages still need their own script or explicit runner. A gate failure is classified as a setup failure only on command-not-found, permission denied, missing file, or cannot-execute text; every other nonzero exit is a failed assertion. Exit 0 appends a `## Gate` section to the report. A nonzero exit fails the round with `gate setup failed (exit N)` or `gate assertion failed (exit N)`. Work resumes rerun the stored gate. Reviews never run one. The gate is the harness's own verification, so a worker's optimistic done claim cannot finalize green.

When a work round changes no files, the gate still decides: cdx runs it as usual, the report gains a "## Harness note" saying no files changed, the feed line carries `diff=empty`, and status shows "no tree change". An unchanged tree is evidence for the liaison, not a verdict; a verification-only resume or a supervisor whose children worked in their own worktrees legitimately changes nothing.

Only `--gate-baseline-check` runs the gate on the untouched baseline tree before worker startup, including worktrees. Worktree spawns do not run baseline checks by default. A baseline failure stops the round as `gate-invalid` and identifies the gate command as the defect. A final gate failure that had no baseline check suggests `--gate-baseline-check` for the next run.

`cdx gate <lane> "<cmd>"` sets or replaces the stored gate. `cdx gate <lane> --clear` removes it. Both forms print the old and new value and refuse to change an active lane. A supervisor cannot change a child's gate through `cdx gate`, `resume --gate`, or `spawn`; the gate is the liaison's acceptance check. Omitting `--gate` on a supervised respawn preserves the existing gate. `resume --gate "<cmd>"` replaces the stored gate before that work round and keeps it for later resumes.

`spawn --pre "<cmd>"` and `resume --pre "<cmd>"` run the command in the lane's cwd before opening the round. A nonzero exit refuses the launch, prints the last 20 lines of its output, and records nothing in the ledger. The pre-check is stored on the lane like the gate so resume reuses it unless a new `--pre` is given. Intended use: `--pre "bun qa.ts readiness-check --release <sha>"` before any register cell lane.

`resume` inherits the lane engine and rejects `--engine`. It reattaches to the recorded work session even after a review. Calling `cdx resume` on an active running lane is refused by the harness; wait for the active round to settle before resuming. Resume on a Gemini lane whose work rounds already equal the `gemini.maxRounds` cap (default 2) fails with: `round cap <n> reached for <lane>: close it and spawn a new lane with the failure attached`. Review rounds do not count toward the cap. Astra and GPT lanes are not capped. A GPT lane prefers its recorded account while eligible. If admission selects another home, cdx starts a fresh session with the task and prior evidence. A Gemini lane resumes with `agy --conversation <sessionId>`. When the previous round failed and has a nonempty partial report, `resume` includes its contents and path before the follow-up, with an instruction to continue without redoing completed work. This applies to both engines and still requires a recorded session. One-time migration assigns GPT to older rows with no engine.

`fork` inherits the source lane engine and model. GPT can fork a lane or a raw Codex session ID; a raw-session fork takes `--model` and applies it to the forked thread's turns. Gemini has no headless fork, so `cdx fork` refuses a Gemini lane and directs the caller to `cdx resume`.

`status` reports lane progress, outcome, and directory from its work record. Active lanes show round tool steps, git dirty file count skipping non-git directories, stage as working, gate running with elapsed time, or reporting, and last action age. Running jobs display their final non-empty log line capped at 80 characters, skipping blank tail lines. A review does not replace work outcome. When a lane has review history, `status` prints the review outcome on a separate review line. Consult lanes use their review record for the main state, timing, and report, with `consult` as the role. `status --brief` prints only running lanes and caller-owned jobs, formatted as one line each under 100 characters. `status --line` renders at most 100 characters for the UI status slot, showing owned running lanes, jobs, open questions, and Gemini quota blocks. It outputs an empty string when the caller owns no active work. `status --watch [--interval S]` re-renders the brief view in place read-only until stopped with Ctrl-C, using a default interval of 2 seconds. `--json` cannot combine with `--brief`, `--line`, or `--watch`. `status --json` emits a name-to-record map.

`kill` sends SIGTERM to the runner, which reaps its engine child and finalizes the round with a signal note. A runner still silent after 10 seconds gets SIGKILL, and cdx finalizes the ledger with note `killed`. `--max-runtime MIN` uses the same signal sequence on either engine child.

`close --remove-worktree` removes the lane worktree and deletes its branch only when the branch is merged into the repo's HEAD and the worktree is clean; otherwise it refuses with the reason and prints the manual commands.

A brief of `-` reads the brief from stdin (`cdx spawn big-task --engine gemini --bg - < brief.md`), so long prompts with quotes and backticks never fight the shell. Every command taking free text accepts `-` to read from stdin: `spawn`, `resume`, `consult`, `review` (intent), `fork`, `send`, `reply`, `msg`, `job`, and `close`. An empty stdin fails with the command's usage line. Headless agy expands `/skill-name ...` at the start of a prompt, so a brief may open with a project skill invocation such as `/hyperscale-change ...` when the workspace ships that skill under `.agents/skills`.

`spawn --worktree <path>` creates a git worktree at that path on a new branch `lane/<lane>` from the repo at `--cd` (or the current directory), runs the optional `worktreeSetup` command from config inside it, and runs the lane there. A repository may ship an executable `.cdx-worktree-setup` at its root; `spawn --worktree` runs it after the global `worktreeSetup` command and fails the spawn on nonzero exit. The worktree and branch are recorded in the ledger and shown by `status`; `close` prints the removal commands but never deletes anything itself. This gives each parallel worker exclusive files without sharing a dirty tree.

For multiple targets, text-mode `wait` names the targets at the start and prints each completion with its name, state, and report path as the existing five-second poll observes it. Jobs use their log path. After all targets finish, it prints a summary, then report bodies when `--report` is set. A question still returns exit 2 immediately; a timeout names unfinished targets. Single-target report output stays immediate.

`wait --json` prints one JSON object per finished lane, in completion order: `work` and `review` records, roundState, exit code, tokens, report path, note, session ID.

</details>

## Orchestration patterns

**Single lane, report on completion.** Run `cdx spawn` in the foreground from a background shell. The harness prints a summary line plus the full report at exit, so one notification carries everything.

**Fan-out.** Fire each lane with `--bg` (they detach and survive the shell), then one `cdx wait a b c` blocks until the wave lands. `wait` exits 1 when any lane failed and exits 2 the moment a waited lane asks a question, printing the question and the `cdx reply` to answer it, so neither side idles for the 30-minute ask timeout. Give each lane `--worktree` when they touch the same repo, so no worker sees another's dirty files.

**Follow live.** `cdx tail -f <lane>` streams one worker's transcript and exits with the lane's outcome. `cdx tail -f` shows all running lanes with `[lane]` prefixes and follows new rounds and lanes. Any terminal or agent session can use either form against the shared state, which is how parallel Claude sessions see each other's workers.

**Steer, iterate, or branch.** `send` corrects a running lane via in-turn steering or a follow-up turn. `resume` continues a finished worker with its recorded engine and context. `fork` branches GPT context into a new lane. Gemini has no headless fork.

**Consult when the design is open.** `cdx consult design --engine gpt --model astra "<question>"` runs a read-only Codex lane framed as a senior advisor to the caller (either the Astra driver or the owner's liaison) with full freedom to challenge the premise, scope, and technical direction: ranked recommendation, rejected alternatives, evidence from the tree, and a closing "Decisions for the caller" list. `cdx consult helper --engine gemini "<question>"` runs a read-only Gemini helper. Adding `--supervisor` lets the consult start owned read-only Gemini helpers only. `cdx resume design "<follow-up>"` keeps the conversation going, still read-only. Status shows it as `consult`. A consult lane needs a fresh name and can never be respawned as a work lane, so its resume stays read-only. Skip the consult when the caller already has a settled design.

**Supervisor tree.** `cdx spawn plan --engine gpt --model astra --supervisor "<brief>"` hands one Codex lane a multi-part change. It briefs bounded parts to Gemini children with `cdx spawn --bg`, waits with `cdx wait --report`, reviews with `cdx review`, and reports once. The liaison sees the children under `parent=plan` in `cdx status` and kills the whole tree with `cdx kill plan`.

**Retest briefs and pass claims.** A verification brief requires candidate identity, item IDs under test, success or refusal obligation per item, one observable assertion per item, currently closed findings that could reopen, and an owned evidence directory. The completion report maps each pass to the new attempt and captured result. A refusal under a success obligation is failed or blocked, never passed. Old evidence may guide procedure, but it cannot establish a fresh attempt. Re-evaluate a closed finding against the current candidate before blocking on it. The liaison reads the actual result body before accepting a pass; schema validation proves register consistency, not fulfillment. Example:

```
Candidate: commit 5a2b1c (staging build).
Evidence directory: /tmp/evidence/run-42.
Items under test:
- ITEM-101: obligation=success. Assertion: POST /transfers returns HTTP 200 with status "settled". Closed finding: BUG-12 (must confirm transfer settles before passing; HTTP 403 or 500 is failure, not pass).
- ITEM-102: obligation=refusal. Assertion: POST /transfers with negative amount returns HTTP 400 with code "invalid_amount". Rejection of the payload proves the test; an HTTP 200 is failure.
```

**Candidate preparation and proof.** The liaison finishes generation, packaging, and integration before naming the release candidate. No concurrent writer may touch the worktree during the proof run. If a fix changes the candidate, run fresh proof on the new commit and record why the previous proof no longer applies. A cancelled wall is not a green result. The liaison names one candidate, one gate result, and any later invalidating change. Production actions end at the owner.

**Narrow briefs and one review.** A brief needs the outcome, consumer, exclusive files, prohibited actions, candidate and inputs, exact gate, and the specific assertion separating success from an attractive wrong answer. Send evidence and unresolved decisions, not transcripts or keystrokes. A lane with a settled edit is Gemini work, not an Astra supervisor holding one Gemini child. Briefs longer than 1,500 words trigger a harness warning. Conduct one independent review per consequential diff, covering affected callers and contracts. Ask for severity, trigger, file location, and failure mechanism. Separate accepted defects, disputed findings, integration hygiene, and unverified candidates. A clean review is a result, not a reason for another review; a changed commit or a failed review justifies one more. The reviewer reads the recorded gate result and never runs the test suite.

## Claude Code integration

cdx 7.0.0 integrates natively with Claude Code through a function hooks mod.
The mod loads from `~/.claude/skills/cdx` with configuration in `hooks/hooks.json` specifying `modules: ["./register.ts"]`.
Classic process hooks and polling side channels are removed in favor of in-process execution.
The mod runs inside the Claude Code runtime and communicates with cdx through `$.process.run`.

### Enable function hooks

Function hooks are an early access feature in Claude Code.
Enable them by adding the flag to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

You can also export `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your shell environment before launching Claude Code.

### Registered tools

The mod registers 21 native tools under the prefix `mcp__cdx__`:

| Tool | Required | Optional | Description |
|---|---|---|---|
| `mcp__cdx__spawn` | `lane, brief` | `engine, model, supervisor, cd, worktree, gate, pre, effort, maxRuntime, account, addDirs, schema, images` | Spawn a new lane with a brief. The brief passes via stdin using `--bg -`. Quotes and newlines remain intact. Completion arrives as a `[cdx]` event. |
| `mcp__cdx__resume` | `lane, followUp` | `effort, gate, pre, maxRuntime` | Resume a finished or stopped lane with a follow-up instruction via `--bg -`. |
| `mcp__cdx__consult` | `lane, question` | `engine, supervisor, model, effort, cd, account` | Start a read-only consultation lane via `--bg -`. |
| `mcp__cdx__review` | `lane` | `engine, model, effort, cd, uncommitted, base, commit, scope, intent` | Start an independent code review lane via `--bg`. Intent passes via stdin with `-` when provided. |
| `mcp__cdx__fork` | `lane, source, brief` | `model, effort, account` | Fork an existing lane into a new branch lane via `--bg -`. |
| `mcp__cdx__events` | (none) | (none) | Every owned event not yet delivered: the mod's buffer, then the feed (`events --json`). |
| `mcp__cdx__send` | `lane, text` | (none) | Deliver steering instructions to a running lane via stdin (`send <lane> -`). |
| `mcp__cdx__reply` | `lane, answer` | `id` | Answer an open question asked by a lane via stdin (`reply <lane> [--id N] -`). |
| `mcp__cdx__questions` | (none) | `lane` | List open questions across all lanes or for a specific lane. |
| `mcp__cdx__status` | (none) | `all` | Show active lane status (`status [--all]`). |
| `mcp__cdx__report` | `lane` | (none) | Read the final report written by a finished lane. |
| `mcp__cdx__tail` | `lane` | `lines` | Inspect latest execution log lines (`tail <lane> [-n N]`). |
| `mcp__cdx__close` | `lane` | `note` | Close a completed lane. Note passes via stdin with `-` when provided. |
| `mcp__cdx__kill` | `lane` | (none) | Terminate a running lane process immediately. |
| `mcp__cdx__gate` | `lane` | `cmd, clear` | Set or clear the verification gate command for a lane. |
| `mcp__cdx__job` | `name, cmd` | `cd` | Launch a detached background job command via stdin (`job <name> [--cd D] -`). |
| `mcp__cdx__msg` | `target, text` | (none) | Send a notification message via stdin (`msg <target> -`). |
| `mcp__cdx__inbox` | (none) | `lines` | Read incoming messages sent to this session (`inbox [-n N]`). |
| `mcp__cdx__usage` | (none) | (none) | Report token consumption and rate limit windows. |
| `mcp__cdx__takeover` | `target` | (none) | Claim ownership of a lane or session. |
| `mcp__cdx__doctor` | (none) | `fix, probe` | Diagnose plugin installation, engine accounts, and background workers. Timeout is 120 seconds. |

### Never block

Owner ruling, 2026-09-15: the head never blocks on a lane.
There is no `mcp__cdx__wait` tool.
The head spawns a lane, keeps working or ends its turn, and the mod wakes it when events occur.
`cdx wait` stays in the CLI for Astra, Gemini, and terminal operators.
Mid-turn checks use `mcp__cdx__events` or `mcp__cdx__status`.

### Slash command

The mod registers the `/lanes` slash command in Claude Code.
Running `/lanes` without arguments displays current lane status.
Running `/lanes <args>` passes the arguments directly to the cdx CLI.
The `/cdx` slash command remains the user skill that loads `SKILL.md`.

### Status line and toasts

The mod starts a background timer polling `cdx events --json` every 2 seconds.
Every fifth poll (every 10 seconds), it runs `cdx status --line` and updates `$.ui.status`.
When all work finishes and no questions remain, the status line clears.
For each new event marked `wake: true`, the mod displays an 8-second toast notification through `$.ui.toast`.
When running in headless mode (`surface === null`), UI status, toasts, and UI logs are skipped while background polling, prompt submission, and context attachment proceed.

### Event delivery

Events flow into Claude Code through two delivery paths:
- Idle wake: when no turn is running and the pending buffer contains at least one wake event, the mod drains the buffer into `$.prompt.submit`. The prompt starts with `[cdx]` followed by the event lines.
- Mid-turn context: when a turn is active, pending events stay buffered. After each non-subagent tool call completes without a denial, the mod drains the buffer into additional context under `[cdx] events`. User prompt submissions also receive pending buffered events as context.
Subagent tool calls never drain events.

### Doctor checks

`cdx doctor` verifies the function hooks mod:
- Confirms `~/.claude/skills/cdx` resolves to the current repository root.
- Verifies `hooks/hooks.json` declares `modules: ["./register.ts"]` and no classic hook definitions.
- Verifies the calling session has polled within 15 seconds. If stale, doctor warns to verify `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in `~/.claude/settings.json` env and run `/reload-plugins`.
- Warns when `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is missing from the environment and settings.

### Early access notes

The Claude Code function hooks API is early access.
Vendored type definitions in `hooks/types/claude-code.d.ts` name their source version on line 1 (`Claude Code 2.1.270`).

### Ownership and takeover

Full session ids determine ownership. Directories, session titles, and id prefixes do not. `resume`, `send`, `reply`, `gate`, `close`, `kill`, review, and replacement of an existing lane refuse a caller from another head. Supervisors retain the owning head and may mutate only their own children. Inherited `CDX_OWNER=terminal` stays terminal even if the environment also contains a Claude session id.

A new Claude session must explicitly run `cdx takeover <lane|full-session-id>` before driving another head's work. A lane target claims that lane and its existing supervisor children, whether they were terminal-owned or owned by another head; future children inherit the claim, and the previous owner keeps everything else. A session target moves that head's whole group, including jobs and peer messages, through a persisted binding that redirects already-running producers without changing their saved specs. The previous head then loses mutation authority and delivery. Reusing the same full session id reconnects without takeover. A fork or a new session never claims work automatically. Terminal jobs cannot be claimed by lane.

Takeover replays no history. It sets the caller's delivery cursor to the latest event and prints the owned summary: lanes awaiting attention, open questions, and jobs. `cdx feed` and `cdx inbox` show earlier scoped events on demand. `cdx adopt` still imports an engine session; adopting over an existing lane needs ownership of that lane like any other mutation.

`brief`, `questions`, `feed`, `inbox`, and running-job summaries are scoped to the caller. An ordinary terminal sees terminal-owned work through those readers. The explicit dashboard and status remain shared diagnostic views.

### Journal and rollout

`feed.log` contains JSON records with monotonic ids, timestamps, event kinds, full owner or recipient ids, lane and round or job identity, and message text. Old free-text lines are ignored by every reader and removed by `cdx clean`. They are not guessed into ownership. `sessions.json` stores the sequence, takeover bindings, and session delivery cursors. Journal append, cursor updates, and cleanup use the same event lock. Cleanup keeps the latest 2000 records plus records pending for connected sessions. An inactive session can therefore retain older records.

Cursor acknowledgement follows stdout emission. A crash between those steps can replay an event; Claude provides no durable delivery acknowledgment. Compaction recovery reads the ledger and open questions even if a notification was already emitted.

Before rollout, stop older cdx writers and restart Claude Code sessions after setting `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The lane ledger remains version 5.

Verify the mod with `cdx doctor`. Start work in a session, leave the head idle, and have a worker ask a question. The session receives an automatic `[cdx]` prompt. Verify that foreign mutations fail, then explicitly take over with `cdx takeover` and confirm future events route to the new head.

## Configuration

Everything lives under `$CDX_HOME`, default `~/.cdx`. The optional `$CDX_HOME/config.json`:

```json
{
  "model": "gpt-6-astra",
  "models": { "astra": "gpt-6-astra" },
  "efforts": ["low", "medium"],
  "defaultEffort": "medium",
  "effortCaps": { "gpt-6-astra": "medium" },
  "rules": [],
  "worktreeSetup": "bun install",
  "gemini": {
    "model": "gemini-3.8-flash-high",
    "agent": "cdx-lane",
    "reviewAgent": "cdx-review",
    "maxRounds": 2
  },
  "visibility": {
    "heartbeatMinutes": 10,
    "failureRepeats": 5,
    "fileEdits": 20
  }
}
```

That is a working example, not the built-in defaults. Without a config file cdx uses model `gpt-6-astra`, efforts `low`, `medium`, `high` with `medium` as the default, the Astra cap below, no aliases (so `--model astra` needs the `models` entry above), no rules, and the Gemini and visibility values shown.

- Existing top-level keys configure GPT. `model` is the default Codex model. `models` maps `--model` aliases to model ids (optional; a raw id always works). `efforts` is the GPT `--effort` allowlist. `defaultEffort` applies when the flag is absent.
- `effortCaps` maps a Codex model id to the highest effort it may run at, checked on spawn, resume, fork, review, consult, and the doctor probe after alias resolution. The built-in value caps `gpt-6-astra` at `medium`, so Astra runs `low` or `medium` only; an explicit `--effort high` or `xhigh` fails with the allowed list. Any other source above the cap (the config `defaultEffort`, a lane recorded before the cap, a Gemini review round that stored `high` on a gpt lane) clamps to the cap with a note, and the clamped value travels with every turn, including `codex exec resume` of a review-only session. Config may add caps for other models or lower a built-in cap; raising `gpt-6-astra` above `medium` is a config error. `efforts` must stay within `minimal`, `low`, `medium`, `high`, `xhigh`.
- `gemini` is optional. Its shown values are the defaults. `gemini.maxRounds` sets the round cap for Gemini lanes, default 2. `cdx resume` on a Gemini lane whose work rounds already equal the cap fails with: `round cap <n> reached for <lane>: close it and spawn a new lane with the failure attached`. Review rounds do not count toward the cap. Astra and GPT lanes are not capped. cdx pins the model and agent into each round spec at launch. Gemini always records effort `high`; its effort is not configurable.
- `visibility` is optional. Its shown values are the defaults. `heartbeatMinutes` must be a positive finite number defaulting to 10; it sets the interval for quiet progress digests when owned work runs. `failureRepeats` must be a positive integer defaulting to 5; it sets consecutive identical command failures before a thrash wake. `fileEdits` must be a positive integer defaulting to 20; it sets the maximum edits to the same file in a round before a thrash wake.
- `rules` entries are appended to every injected brief, followed by `.cdx-rules.md` from the lane's working directory when that file exists. This is where house style, tooling mandates, and per-project law live.
- `worktreeSetup` (optional) is a shell command run inside every new `--worktree` before the lane starts, typically a dependency install. A nonzero exit aborts the spawn and leaves the worktree in place for inspection. A repository may ship an executable `.cdx-worktree-setup` at its root; `spawn --worktree` runs it after the global `worktreeSetup` command and fails the spawn on nonzero exit.

### Accounts: earliest reset first, with headroom

Each account needs its own Codex home. cdx sets `CODEX_HOME` for each Codex process so login data and session files stay tied to that account. Log a new home in with `CODEX_HOME=~/.codex-3 codex login`, then add it here.

```json
{
  "accounts": {
    "codex-1": "~/.codex",
    "codex-2": "~/.codex-2",
    "codex-3": "~/.codex-3"
  }
}
```

With an accounts map, `cdx usage` and launch admission share one decision:

1. The risk line is 3% remaining weekly capacity for every lane kind (owner ruling 2026-09-11); it is a placement hint, and only exhaustion refuses. Among accounts above the line, spend first the one with the highest forfeit rate: the share above the risk line divided by the days until its reset (floored at one day), which is what waiting loses per day. Equal rates go to the earlier reset, then the fuller account.
2. Active rounds hold 3% against their assigned account during execution. Admission subtracts active holds before evaluating remaining headroom.
3. Dead runner release: admission reconciles crashed runners and releases their holds while preserving live child holds.
4. Consuming round completion invalidates the account usage snapshot, forcing fresh probes on subsequent rounds.
5. `--account NAME` obeys exhaustion eligibility instead of forcing a depleted account. If the specified account is exhausted or lacks required headroom, admission rejects the launch.
6. Automatic GPT quota failover recovers exhausted accounts across work, review, and consult rounds. When Codex hits quota exhaustion, the runner marks the account exhausted with its reset time and starts a fresh round on an eligible alternate account. The recovery prompt transfers the original brief, round history, and latest report or partial report. If no alternate account is eligible, the lane fails with reset details.

Snapshot thresholds and demand holds guide placement and concurrency control. They do not guarantee full completion within quota, and there is no guarantee unknown capacity will finish.

Usage readings cache for 30 minutes unless a window has reset or the reading lacks per-window data. Failed probes cache for 5 minutes. A failed probe with no usable reading leaves capacity unknown. Exhaustion markers carry provenance (recorded time, window length, reason) and reconcile against fresh usage probes; a marker clears only when no window of that account is exhausted, while a live block on any window stays. `cdx usage` advice reads the reconciled standings.

`usage --json` includes `advice.picks`, account `remainingPercent`, reset times, `forfeitRate`, and reasons, plus `advice.resetCredits` (count, expiries, whether to redeem) and `alerts`. Text output also shows the daily pace that would spend the remaining weekly share before reset.

Reset credits: each account line names every banked credit's expiry (the app-server grants them for 30 days). The advice adds a `reset credits` line and tells you to redeem one on an account that is exhausted or under the risk line, since a credit restores a full window instead of waiting for the reset. A credit inside three days of expiry prints a red `CRITICAL` line at the top of `cdx usage`, in `cdx doctor`, and on every GPT launch until it is redeemed or gone; cdx cannot redeem it, the codex TUI `/usage` on that home can.

A GPT review of a Gemini lane selects an account when it has no affinity. A Gemini review preserves the GPT work account. Gemini work rejects `--account`. Tracked lane forks can start a fresh session on another eligible home. Raw-session forks require the source home from `--account` or the primary home to be eligible because cdx has no saved brief or reports for that session. Adopts record `--account` or the primary home without consuming quota. Incomplete account records fail explicitly; migrated rows without affinity pass admission.

Shared config keys are `model`, `personality`, `service_tier`, `model_reasoning_effort`, `features`, `agents`, and `mcp_servers`. Sync preserves unshared values but may reformat TOML. It refuses malformed TOML, inline MCP credentials, and hardcoded MCP `env.CODEX_HOME`. Store HTTP credentials through `env_http_headers` or `bearer_token_env_var`; doctor checks that referenced variables are set without printing values. cdx passes its environment to the selected account process.

Stop older cdx runners before the first 5.0 write; mixed-version ledger writers are unsupported.

Keep each account name tied to one home. Use a new name when a home path changes so its cached usage cannot belong to the previous login.

Do not swap authentication files inside one Codex home while parallel lanes run. A lane can then resume a session under the wrong login.

If `config.json` is absent, the defaults above apply. Malformed JSON or an inconsistent shape stops the command with a message that names the file.

> [!IMPORTANT]
> Work lanes can edit files and run shell commands without approval. The injected brief forbids commits, pushes, deploys, and extra servers. Codex review lanes use a read-only sandbox. Gemini review lanes are enforced by before-and-after tree checks. Point cdx only at code you would let either engine edit.

<details>
<summary><b>What the harness injects</b></summary>

cdx injects the role, report contract, and engine rules. Every injected brief tells the engine to write tool payloads larger than one screen to a file outside the repository and print only the path and a one-line digest. These built-in rules are followed by `config.json` rules and `.cdx-rules.md`. Astra resolves routine choices, follows steering, and carries authorized work through verification. It may delegate useful bounded work or exploration. Gemini executes a precise assignment without further delegation.

The brief and liaison replies outrank project and skill guidance within runtime constraints. A blocking instruction must be named and quoted. Questions are for missing decisions that affect outcome or authorization; timeout is not approval. Workers continue independent work and report unresolved dependencies.

Reports name the outcome, changed files, and remaining risks. The test suite runs once per lane, as the gate after the report; workers, supervisors, and reviewers do not run it. Remove duplicated and implementation-mirroring tests.

Each engine handles its own context. cdx does not set a fixed context size.

</details>

<details>
<summary><b>State layout</b></summary>

```
$CDX_HOME/
  ledger.json    version 5 envelope with lanes, work/review records, sessions, tokens, and account holds; lanes track roundSteps, stage, stageStartedAt, and lastActionAt
  .ledger-version rejects older writers after the first migration
  logs/          raw engine events and stderr for each round
  reports/       final report per round
  briefs/        audit trail of every injected prompt
  specs/         the runner inputs recorded for each round
  control/       queued steering records, one JSONL file per round
  questions/     worker questions and their answer or timeout state
  feed.log       structured lane events and peer messages
  sessions.json  ownership bindings, session delivery cursors, and event sequence
```

Everything is plain files. `cdx feed` and `cdx inbox` render scoped events. `cdx clean` retains the latest 2000 records and undelivered records for connected sessions.

</details>

## Testing

`bun run check` is the acceptance gate for changes to cdx. It type-checks the CLI and the hooks module, builds the CLI, and runs every test file:

```bash
tsc --noEmit && tsc -p hooks --noEmit && bun build cdx.ts --target=bun --outfile=/tmp/cdx-check.js && bun test
```

The tests cover ownership routing, feed parsing, flag parsing, the delivery buffer, and the tool definitions without spawning processes, sleeping, using fake engines, or creating temporary homes. Keep the run within about two seconds. After a change to `hooks/`, also run `claude plugin validate .` and one headless smoke with `claude -p ... --debug-file <path>`, then grep the log for `hook failed` and `refused`.

The owner removed the 135 end-to-end tests after a run took 226 seconds. Process lifecycle, engine integration, question timeouts, gate execution, and browser behavior no longer have automated end-to-end coverage. Do not rebuild that suite. The lane gate runs once after the report; workers and reviewers reuse its result.

## License

[MIT](LICENSE)
