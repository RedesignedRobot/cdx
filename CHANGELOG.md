## 6.1.0

- Removed the 135 end-to-end tests because a 226-second run delayed every cdx gate. Only pure ownership routing and feed parsing tests survive, with no spawned processes, sleeps, fake engines, or temporary homes. `bun run check` still builds the CLI before those tests.

## 6.0.1

- The plugin monitor's `CLAUDE_CODE_SESSION_ID` is a child session id, not the head's. `cdx watch` now resolves the head through `CLAUDE_PID` and the receipt the session hook records for that process, follows a `/clear`, and stands by until the receipt exists. `cdx clean` drops receipts of dead processes.

## 6.0.0

cdx routes native Claude Code events to the owning session before delivery.

- Breaking change: `feed.log` contains structured JSON records. Old free-text lines are ignored and removed by cleanup. One renderer serves the monitor, diagnostics, and dashboard.
- Breaking change: full session ids replace prefix addresses. Foreign lane mutations require explicit `cdx takeover <lane|full-session-id>`. A session target moves the owner's group through a persisted binding; a lane target claims only the named lane and its supervisor children, whoever owned them. Takeover replays nothing and prints the owned summary. `adopt` over an existing lane checks ownership.
- The automatic plugin monitor runs `cdx watch` using `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID`. A process lease prevents duplicate delivery after reload; a second watcher stands by until the holder exits. Wake and quiet delivery have separate durable cursors.
- SessionStart restores owned state, completed lanes awaiting attention, and open questions, including after compact. PostToolBatch and UserPromptSubmit inject quiet events. Native subagent hook calls are skipped; missing identity is rejected.
- The watcher wakes for questions, stalls, final work or review results, job exits, and peer messages. Final events include gate failures. Successful failover and partial report paths remain quiet. Synchronous spawn and reply output is not copied into the feed.
- Scoped brief, questions, feed, inbox, and running-job summaries replace broadcast recovery. `cdx clean` prunes closed lanes regardless of owner. The dashboard retains shared diagnostic access and renders structured events under the journal lock.
- Doctor checks the personal `cdx@skills-dir` plugin path, installed hooks, current session hook receipts, and watcher lease. Hook and monitor changes need `/reload-plugins` or restart; skill edits are live.
- Stop older writers and cancel old global-tail monitors or restart their sessions before rollout. The ledger format remains version 5.

## 5.0.0

cdx 5.0.0 removes legacy aliases, schedules accounts with demand holds, fails over exhausted GPT quotas, and enforces explicit baseline checks.

- Version 5 ledger format writes `{ version: 5, lanes: { ... } }` and `.ledger-version` to reject older writers. The writer migrates 3.x and 4.0 ledgers once on write under lock and rejects legacy shapes thereafter. Public flat `state` and `cwd` aliases are removed from the ledger and view summaries; lanes hold explicit `work` and optional `review` records.
- Status and wait JSON contracts reflect version 5 records. `cdx status --json` remains a name-to-record map. `cdx wait --json` includes discrete `work` and `review` records.
- Pre-4 effort and account fallbacks are removed. Every round spec requires an explicit engine and effort. Incomplete account records fail explicitly. Unattributed migrated lanes use account admission and start a fresh session when the selected home differs from the default home.
- Each configured home has one account name; duplicate homes and relative paths are refused.
- Account doctor `--fix` synchronizes secondary Codex account homes from the primary home. It synchronizes primary `AGENTS.md` directives, shared MCP server definitions and shared config keys in `config.toml`, and `hooks.json` while preserving credentials, auth sessions, and account-specific settings.
- Atomic ledger admission schedules accounts with fixed demand holds. Light rounds hold 5% headroom, work rounds hold 15%, and supervisors hold 25%. Admission subtracts active holds before selecting an account. `--account` obeys exhaustion eligibility instead of forcing a depleted account.
- Admission reconciles dead runners. Crashed runners release their hold during admission while preserving live child holds. Consuming round completion invalidates the account snapshot to force fresh usage probes. Thresholds guide placement; they do not guarantee full completion within quota.
- Automatic GPT quota failover recovers exhausted accounts across work, review, and consult lanes. When Codex hits quota exhaustion, cdx marks the account exhausted with its reset time and starts a fresh round on an eligible alternate account. The recovery prompt transfers the original brief, round history, and the latest report or partial report. If no alternate account is eligible, the lane fails with reset notes.
- Codex account sync refuses literal MCP credentials and hardcoded MCP account-home overrides. Doctor checks environment header references without printing credential values. Unshared TOML values survive sync; formatting may change.
- Baseline gate checks are opt-in only via `--gate-baseline-check` for all spawns, including worktrees. Worktree spawns no longer run baseline checks by default. A failed baseline check stops the round as `gate-invalid` before worker startup.
- The browser dashboard at `assets/view.html` reads `work` and `review` records directly. All flat `state`, `cwd`, and `reviewState` legacy fallbacks are removed.
- From the release review: an exhaustion record overrides the cached usage numbers instead of being overridden by them; account homes compare as configured, so a home is never resolved through symlinks; an empty `{}` ledger is an empty ledger; the version marker is written under the ledger lock; `doctor --fix` waits up to three seconds for a SIGTERMed engine child before reconciling; doctor names the header whose environment reference is unset and never echoes its value.

## 4.0.0

Astra drives whole changes through one supervisor lane. The liaison briefs outcomes, answers questions, arranges independent review, and merges.

- Supervisors can launch GPT children and read-only consults as well as Gemini children. Astra can use native subagents for bounded work or exploration. Child ownership, gate protection, read-only reviews, and the one-level delegation limit remain. Jobs, fork, adopt, and clean stay with the liaison. Astra's effort cap remains `medium`.
- Shorter prompts encourage follow-through, routine decisions, and targeted verification. The brief and liaison replies outrank project and skill guidance within runtime constraints. A question timeout stops dependent work without treating silence as approval. Duplicate policy and prompt-wording tests are removed.
- Account selection and `cdx usage` share one eligibility decision. Work requires 15% remaining weekly capacity and supervisors 25%. Known eligible accounts come first, then unknown accounts with a warning; otherwise launch is refused. Light turns use a 5% preference and may launch on an exhausted account. `--account` overrides selection, and existing GPT affinity remains pinned.
- Reservations are withdrawn from 4.0.0. Parallel launches may choose the same account; snapshot thresholds do not guarantee completion within quota. Transactional reservations and dead-runner reconciliation are deferred to 4.1. Usage snapshots cache for 30 minutes and failed probes for 5 minutes. All usage mutations now share `.usage.lock`.
- A respawn (`cdx spawn` on an existing lane) keeps the stored gate and working directory unless new ones are passed; before, a respawn without `--gate` dropped the gate and one without `--cd` ran in the caller's directory instead of the lane's worktree. A GPT review of a Gemini lane takes `--model`.
- GPT reviews of Gemini lanes select an account when none is recorded. Gemini reviews preserve a GPT work lane's account. Supervisors cannot replace a child's gate through resume or respawn; respawn without `--gate` runs the stored gate.
- `doctor` checks every configured Codex home against the primary home for matching `AGENTS.md`, matching enabled MCP server definitions, and a valid `hooks.json`. For Codex homes, `--fix` copies directives only and reports manual config or hook repairs.
- The runner separates Gemini report qualification and round finalization. Shared JSONL framing handles unterminated responses and skips null or other non-object values. Fresh work rounds clear the previous report, and migration keeps legacy review failures out of the work outcome.
- The ledger stores `work` and `review` records; public `state` and `cwd` aliases remain. Version 4 reads 3.x ledgers and migrates them on write. Mixed-version writers are unsupported. Resolved effort travels in each round's spec. Importing `cdx.ts` remains inert.

## 3.10.1

Fixes from the 3.10.0 reviews (Astra consult, Gemini hostile review).

- The effort cap reaches Codex on every path. `cdx resume` of a review-only session sends `model_reasoning_effort` on every turn instead of only under an explicit `--effort`; before, a consult recorded at `high` clamped the ledger to `medium` while the session kept running at `high`. Fork clamps the source lane's effort before validating it against `efforts`, so a lane a Gemini review left at `high` forks under an allowlist without `high`. A `defaultEffort` above the cap clamps with a note instead of failing as if it were an explicit flag. A respawn of an existing lane without `--model` keeps the lane's model, so a lane on another model is not judged as Astra and no longer has its model overwritten by the config default. The doctor probe runs at the capped effort. `efforts` must be Codex efforts, closing the hole where an unknown string compared below every cap.
- The built-in `gpt-6-astra` cap is mandatory: config merges over the built-in caps and may lower one or add others, but raising Astra above `medium` is a config error.
- The account advisor trusts less. A snapshot without per-window data (written before 3.10) or with any window past its reset is refreshed before use, and if the probe fails it ranks as unknown rather than treating a five-hour reset as the weekly deadline or a reset window as empty; a reading the last probe could not confirm also ranks unknown, with the reading kept in the text. A lane that starts on an unknown account warns on stderr. The cap refusal names the allowlist problem when no configured effort sits under the cap. Exhaustion is judged across every live window, so an expired five-hour window no longer hides a full weekly one. Headroom compares exact shares (14.6% is short of 15%) and rounds only in the text. The mid-run headroom warning prints with a single account too. `usage --json` reports a missing pick as `null`. Accounts probe in parallel.
- A Gemini review that ends with no agent response and no structured output fails with `agy finished without a report` instead of finishing on the harness note alone.
- `cdx job` reserves the name under the jobs lock with the launcher's pid, so two concurrent launches cannot share a name and a concurrent `wait` never sees a running job without a pid.

## 3.10.0

- Account advisor. A new gpt spawn, review, or consult picks the Codex account by deadline and headroom: among accounts with enough weekly-window headroom for the lane's demand (consult/review 5%, work 15%, supervisor 25%), the one whose window resets soonest goes first, since unspent share is lost at reset; equal deadlines prefer the fuller account. Accounts short of headroom rank next (fullest first, with a mid-run limit warning), unknown usage after them, exhausted windows last. The spawn output names the account and the reason. `cdx usage` and `cdx doctor` print the same spend order with each account's remaining share, reset time, and the pace per day that would empty it before reset; `usage --json` carries an `advice` object. Usage snapshots now keep every rate-limit window so the weekly deadline survives a busy five-hour window.
- Effort caps. `effortCaps` in config maps a model id to its highest effort; the built-in value caps `gpt-6-astra` at `medium`, so Astra runs `low` or `medium` only. Spawn, resume, fork, review, and consult refuse an explicit `--effort` above the cap after alias resolution; an inherited effort above it (a lane recorded before the cap, or a Gemini review round that stored `high` on a gpt lane) clamps to the cap with a note.
- `gpt-6-astra` is the built-in default model; `gpt-5.6-sol` is retired from the docs (a raw id still works on `--model`).

## 3.9.0

- Opens `cdx view` on running lanes and jobs. Running, Done, Failed, and All filters persist across reloads. Running work stays first, with recent activity first within running and finished groups. Closed and adopted lanes stay in All.
- Adds violet Astra/GPT orbits, teal Gemini scanlines, amber job tickers, new-round entrances, transcript reveals, and five-minute quiet warnings. Reduced motion disables animations. Rows persist across live updates.
- Adds active round engines, status groups, start and activity timestamps, and quiet flags to the view API. Keeps the one-second SSE poll, loopback-only access checks, and credential redaction.

## 3.8.0

- Adds `cdx view [--port N] [--open]`, a local, view-only browser dashboard for lanes, jobs, feed entries, reports, questions, and live round transcripts. It listens on 127.0.0.1:7477 until Ctrl-C. The page follows disk changes over SSE and redacts credentials before sending text to the browser.

## 3.7.1

- Astra prompts opened up, per the owner's ruling that Astra is the head's copilot and must never be boxed: the consult frame grants full freedom to challenge the premise, scope, and head, and drops its format rules; gpt workers and supervisors get a challenge rule (the brief is the head's best understanding, not an order; disagree through `cdx ask` and in the report). Every Astra frame (consult, supervisor, gpt worker, gpt review) carries the owner's standard: world class as Apple, OpenAI, Anthropic, Vercel, and Cloudflare build, tear down legacy patterns, delete test bloat, code bloat, and AI slop. Gemini's contract stays strict. SKILL.md states the peer relationship.

## 3.7.0

Shipped after GPT-6 Astra audited cdx 3.6.0 through `cdx consult` and reproduced nine defects in supervisor mode.

- One ownership policy. A supervisor may mutate only lanes it spawned: `send`, `reply`, `spawn` on an existing name, `resume`, `review`, `kill`, and `close` all check it, `gate` is refused to supervisors outright, and `kill` refuses jobs from inside a supervisor. A supervisor's identity is verified against the ledger on every call (running supervisor round, matching round number), so a stale shell has no authority. Children record `parentRound`.
- Supervisor lifecycle. When a supervisor round ends for any reason, the runner stops every child still running (continuing past dead ones) and a round that reported with children running fails with `supervisor ended with running children`. A respawn of a supervisor's name without `--supervisor` is a plain lane again.
- `cdx wait` exits 2 the moment a waited lane asks a question, printing the question and the reply command (`--json` emits one object per question).
- Gates decide. An unchanged tree no longer fails a gated round or skips the gate; the gate runs, the report notes that no files changed, and the feed line carries `diff=empty`.
- Consult lanes need a fresh name and cannot be respawned as work lanes, so their resume stays read-only.
- The detached Gemini runner runs the configured model and agent: both are pinned into the round spec at launch.
- A raw-session `fork --model` now reaches the forked thread's turns.
- Prompts rewritten for GPT-6 Astra and Gemini: every built-in rule names its mechanism; workers, Gemini workers, supervisors, reviewers, and consults each get their own contract; native subagents are off for Gemini workers and supervisors and conditional for GPT workers; review findings carry severity definitions and a failure scenario; the shipped agent files match. SKILL.md is now a short operating guide and README holds the reference.
- `killLane` throws instead of exiting so cascades continue; ownership checks run before the ledger lock so a refusal never leaves the lock behind. package.json and plugin.json versions track the CLI.

## 3.6.0

- Adds `cdx consult <lane> [--model M] [--effort E] [--cd D] [--bg] "<question>"`: a read-only gpt lane framed as the head's advisor (ranked recommendation, rejected alternatives, evidence from the tree, pushback on a wrong premise, a closing "Decisions for the head" list) instead of the adversarial review frame. It runs through the read-only exec path, records `consult` on the lane, shows as `consult` in status, and `cdx resume <lane>` continues the conversation read-only. Refused inside lanes.
- Review rounds on a new gpt lane now record the lane model.

## 3.5.0

- Adds a Codex model picker. `spawn`, `fork`, `review`, and `adopt` take `--model M` for gpt lanes, where M is an alias from the new `models` config key (`{ "astra": "gpt-6-astra" }`) or a raw model id. The lane records its model; resume, fork, and review of an existing lane keep it; status, the launch line, and `cdx help` show it. The `efforts` allowlist may now include `xhigh` for GPT-6 Astra.
- Adds supervisor lanes. `spawn --supervisor --engine gpt` gives one Codex lane the right to `spawn`, `resume`, `review`, `kill`, `close`, `gate`, and `reply` gemini child lanes through cdx, one level deep. cdx exports `CDX_SUPERVISOR` only to that lane, strips it from every child, refuses `--engine gpt` and `--supervisor` from inside a supervisor, refuses commands against lanes that are not its children, records `parent` on each child, routes child feed lines to the supervisor's owner session, and kills running children when the supervisor is killed. Supervisor briefs get delegation rules instead of the worker ban.
- The detached runner no longer inherits `CDX_LANE` from the shell that launched it.

## 3.4.0

- Adds `cdx job <name> [--cd D] "<cmd>"`: a detached background shell command beside the lanes (a test wall, a deploy chain, a long gate). One log at `logs/job-<name>.log`, one record in `jobs.json`, and one feed line `[cdx] job=<name> state=done|failed exit=N in=<duration> log=<path>` the plugin monitor delivers on exit, so a head never polls a summary file from a sleep loop. `cdx job` with no arguments lists jobs; `cdx wait` and `cdx kill` accept job names; `status` and `brief` show running jobs. Workers cannot start jobs.
- Shares one locked JSON writer between the ledger and the jobs file.

## 3.3.0

- Guards the Gemini five-hour window: a round that ends with `Individual quota reached` writes `~/.cdx/gemini-quota.json` with the parsed reset time (30 minutes when unparsed), and `spawn`, `resume`, and `review` refuse Gemini work until it passes. Status, brief, and doctor show the block.
- Refreshes `usage-gemini.json` after every Gemini round. A snapshot under 15 minutes old with a future reset blocks under 5% five-hour remaining and warns on stderr under 15%.
- Detects Antigravity's replayed errors: a resumed conversation can return the previous turn's error verbatim while the new turn finished. When the error matches the lane's last recorded error and the turn produced a final agent message, the round finalizes as success with feed line `ignored replayed agy error`. Transport errors stay on the auto-continue path. A quota error is also checked against live usage before any block is written.
- Validates `--add-dir`, `--image`, and `--schema` before creating a worktree so a bad flag never strands one.

## 3.2.0

- Retries transport errors 'The stream was interrupted' and 'timeout waiting for response' within a budget of two continuations per Gemini round.
- Writes non-success Gemini results to `reports/<lane>-r<n>.partial.md` without overwriting full reports.
- Captures work lane reports from the last non-empty `agent_response` step instead of concatenating turn messages.
- Installs `cdx hook pre-tool` to deny review writes and `cdx hook pre-invocation` to inject in-turn steers via `~/.gemini/config/hooks.json`.
- Emits structured review findings to `reports/<lane>-r<n>.findings.json` from `--json-schema`.
- Adds `cdx log <lane> [round] --transcript` to render Antigravity conversation transcripts from `transcriptPath`.
- Runs `cdx doctor` checks for the `hooks.json` entry, confirmed `/hooks` loading in agy, and configured model presence in `agy models`.
- Grants Gemini lanes tool access to web, browser, subagents, and MCP via the unconstrained agent file and `--dangerously-skip-permissions`.
