## 7.9.0

- Shared safe-text policy redacts protocol logs, gate and job output, reports, question and ledger text, native results, and terminal/browser output before persistence or display.
- Gate failures retain the first diagnostic and typed cause before the output tail; a changing tree invalidates the receipt with named paths and never triggers an automatic rerun.
- Native tool output is capped at 20 KB with the full safe text retained under the cdx logs directory.
- Identical Gemini reads collapse in cdx transcripts and measurements without waking the head; provider context reuse remains outside cdx.
- Standing rules are shorter, workers cannot delegate, timeouts grant no approval, and the lane agent leaves verification to the gate.
- Native commands fall back to the plugin directory only after a missing-cwd lookup before launch; errors after launch never retry.
- Removed the fork CLI, native tool, dispatch, and unused review-exec mode; removed the TUI demo, PNG encoder, animation, and redundant fixture tests.

## 7.7.3

- The repeated-read alert is deleted. Two threshold bumps did not stop it: Gemini lanes and reviews reread files as routine, review lanes take no steers, and each alert cost the head a turn. Reads stay measured in cdx_tool records. Failed-command and edit-loop alerts are unchanged.

## 7.7.2

- The repeated-read alert fires on the sixth identical read. Gemini lanes reread a file three times as routine, so the third-read alert from 7.7.1 still woke the head five times in one hour with nothing to act on.

## 7.7.1

- The repeated-read alert fires on the third identical read of an unchanged file, not the second. Every lane on 2026-09-21 tripped it during its opening reads, and each false alert woke the head for nothing.

## 7.7.0

- Owner ruling 2026-09-21: agents are not boxed. Consult and review lanes run with full access on both engines (Codex `danger-full-access`, so Astra has shell writes and network; Gemini consults use the full lane agent). The Gemini pre-tool denial of write tools in review lanes is deleted.
- A review of either engine still fails its round when the before-and-after tree check finds a change. Consults have no tree check, so a consult can write a map or notes, and a commit by the head in the same checkout no longer fails it (both mapping consults on 2026-09-21 failed that way with `review modified the tree: .`).
- Unchanged: supervisors drive only their own children, Astra never spawns Astra, review and consult lanes take no steers.

## 7.4.9

- Gemini standing reads like a Codex account line. `cdx usage` prints `gemini: pro plan, weekly window 17% used (83% left), resets Wed 23 Sep 09:51 in 3.3d, five-hour window 40% used (60% left), resets ...` with the snapshot age, `cdx doctor` prints the same detail, and every Gemini spawn prints `cdx: gemini for this lane: <standing> (checked 4m ago)` from the cached snapshot before the capacity notice. The round finish event carries `gemini=83% weekly left/60% five-hour left` after a fresh agy probe, so the feed shows what each round cost.
- Version alignment: 7.4.9.

## 7.4.8

- Deleted session directory: when the head removed the worktree it stood in, every native tool call threw inside the hook and Claude Code reported "no tool.call hook answered". The hook now reruns the command from the plugin root when the session directory is gone.

## 7.4.3

- `mcp__cdx__gate-receipt` was registered but the tool.call hook listed the tools by hand and missed it, so the call failed with "no tool.call hook answered". The hook now matches every name in the tool table.

## 7.4.2

- Native only inside Claude Code: a Bash call that runs a cdx subcommand with a native tool (spawn, status, close, job and the rest of the table) is denied with the tool name. The native tool keeps the result in the transcript and runs in the session directory; the shell form remains for lanes and terminals outside Claude Code. Commands without a tool (brief, clean, feed, log, adopt) still run from the shell.
- The native spawn, consult and review tools require `cd`, an absolute repository path. The session directory follows the head's last shell `cd`, so a probe spawned without `cd` right after a shell visit to ~/code/cdx was cut from there; the tool no longer guesses. `job` already required it for the same reason.
- Version alignment: 7.4.2.

## 7.4.1

- Spawn directory: the native tools ran every cdx command in the plugin root, so `mcp__cdx__spawn` with `worktree` and no `cd` cut the worktree from ~/code/cdx instead of the head's repository. Tool commands now run in the session directory, and `cd` resolves against it.
- Stale worktree source: a respawn under a closed lane name kept the old `worktreeRepo` even with `--cd`, and failed with "cwd does not exist" without it once the worktree was removed. `spawnRoots` now takes an explicit `--cd` outright, keeps a reused lane's directory and repository only while that directory exists, and falls back to the caller's directory. Two lanes cut from the wrong repository on 2026-09-17 motivated both fixes.
- Version alignment: cdx.ts VERSION, package.json and plugin.json align to 7.4.1.

## 7.4.0

- Gemini 503 visibility: cdx passes `--log-file logs/<lane>-r<n>.agy.log` to agy and tails it, so agy's in-process retries (which used to be invisible until the round ended) appear in the ledger, in `cdx status` as an `outage` line (`503 no capacity for 30s · agy in-process retry 3 · next retry in 12s · agy retries this round 5`), and on the feed as `progress` events. A burst of three or more consecutive attempts wakes the head once with an `outage` event; an `active` event follows when Gemini answers again. The cdx ladder writes the same state (`cdx ladder 2/6`).
- False outages: a 503 or interrupted stream that came back after cdx itself stopped agy (max runtime, `cdx kill`, quota abort) no longer starts the ladder or wakes the head as an outage. Two lanes on 2026-09-16 were reported as "503 outage" when the cause was the 40-minute runtime cap.
- Print timeout race: agy's `--print-timeout` now sits five minutes above `--max-runtime`, so cdx's own cap ends a round, never agy's timer (which returned a partial with exit 0).
- Quota abort: an `Individual quota reached` retry seen in the agy log stops the round at once, writes the quota block, and emits an `account` event, instead of letting agy retry a spent five-hour window until the runtime cap.
- Capacity fallback: when the 503 ladder runs out on the policy model, one automatic round continues the same conversation on `gemini.outageFallbackModel` (default `gemini-3.8-flash-medium`; empty disables; anything outside the 3.8 family is refused by config validation). The round is announced as `capacity fallback`, shows `model=... (capacity fallback)` in status, does not count against `maxRounds`, and the next resume returns to the policy model.
- Capacity notice: every Gemini launch prints the time in Riyadh and US Pacific and whether it falls in the daily 503 peak (17:00-21:00 Riyadh, 07:00-11:00 US Pacific) or the midday bump, with the quiet window as the recommended time. The same line is part of outage wakes and of `cdx doctor`. Windows come from the 265 first-attempt 503s in cdx's logs.
- Progress digest fix: `steps=0(+0)` for a whole round. The ledger throttle dropped unforced patches while forced token writes (one per step) kept resetting it, so the step counter never landed and the 503 ladder never saw progress. Throttled patches now queue and ride the next write; the runner flushes before finalize.
- `cdx doctor` names the outage fallback model.
- Version alignment: cdx.ts VERSION, package.json and plugin.json align to 7.4.0.

## 7.3.0

- Prompt budget: Claude Code refuses a plugin's `$.prompt.submit` after 50 in one session. The mod used to put the events back and retry every two-second poll, logging each refusal into the transcript forever. Now a budget refusal ends submitting for the session, logs one notice, keeps the events for the next tool result or typed prompt, puts each fresh wake into the prompt box as a Tab suggestion, and prefixes the status line with `wakes off`. Any other refusal is retried after the coalesce window and logged once per message.
- Wake coalescing: an idle head's wake events are held 15 seconds and sent as one prompt, so a burst of lane completions costs one prompt instead of one per poll.
- Version alignment: cdx.ts VERSION, package.json and plugin.json align to 7.3.0.

## 7.2.0

- Never block, enforced: the mod's Bash hook denies `cdx wait`, `cdx status --watch`, and `while`/`until` loops around any cdx command from the head and its subagents, with guidance to end the turn and let the `[cdx]` event wake it, or to call `mcp__cdx__status` / `mcp__cdx__events` for a check now. Lanes keep `cdx wait` (they run outside the session).
- Spawn `--bg` and `job` output no longer tell the head to wait; they say to end the turn. Inside a lane (`CDX_LANE` set) the same lines still point at `cdx wait`.
- Version alignment: cdx.ts VERSION, package.json and plugin.json align to 7.2.0.

## 7.1.0

- Reset credit expiry: `cdx usage` and `cdx doctor` name each banked reset credit's expiry next to the count, read from the app-server's `rateLimitResetCredits.credits[]` (status, grantedAt, expiresAt); cached snapshots keep the expiries.
- Critical alert: an unused reset credit within three days of expiry prints a red `CRITICAL` line at the top of `cdx usage`, in `cdx doctor`, and to stderr on every GPT launch (spawn, resume, fork, review, consult). `usage --json` carries the same lines under `alerts`.
- Reset credit advice: a `reset credits` advice line lists what each account holds and says to redeem one on an account that is exhausted or under the risk line. `usage --json` adds `advice.resetCredits`.
- Account ranking: among accounts above the 3% risk line, the spend order and the per-demand picks now follow the forfeit rate (share above the line per day until reset, floored at one day) instead of the earliest reset alone, so a nearly dry account resetting soonest no longer leads a work lane. Ties keep the earlier reset, then the fuller account. `usage --json` accounts carry `forfeitRate`.
- Docs: README and SKILL.md state the 3% risk line and 3% holds from the 2026-09-11 ruling instead of the retired 5/15/25 thresholds.
- Version alignment: cdx.ts VERSION, package.json and plugin.json align to 7.1.0.

## 7.0.0

- Breaking change: removed background monitor process (cdx watch), watcher leases, CLAUDE_PID lookup, session hook receipts, and classic hook entries. Deleted monitors/ directory and hooks/guard-raw-codex.ts.
- Breaking change: replaced external process monitors with native Claude Code function hooks. The mod configuration in hooks/hooks.json declares modules: ["./register.ts"] and executes directly inside the Claude Code runtime using the engine interface $.
- Breaking change: function hooks require the feature flag CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 set in ~/.claude/settings.json env or exported in the environment.
- Registered native tools: registered 21 first-party MCP tools with the mcp__cdx__ prefix (spawn, resume, consult, review, fork, events, send, reply, questions, status, report, tail, close, kill, gate, job, msg, inbox, usage, takeover, doctor). There is no wait tool; the head never blocks on a lane (owner ruling 2026-09-15).
- Registered slash command: registered /lanes in Claude Code (no arguments runs cdx status; arguments pass through to the cdx CLI). The /cdx command remains the user skill that loads SKILL.md.
- Buffered event delivery: pending owned events accumulate in memory. When the session is idle, wake events drain as an automatic prompt starting with [cdx]. When a turn is active, pending events drain and attach as additional context under [cdx] events after the next non-subagent tool call (when not denied) or on user prompt submission.
- Status line and toasts: polls cdx events --json every 2 seconds. Every fifth poll updates the Claude Code status line ($.ui.status) via cdx status --line. Emits 8-second toast notifications ($.ui.toast) for wake events when a render surface exists.
- New command cdx events [--json] [--peek]: reads unread owned feed events for the caller session and advances the cursor to the last record id. The --peek flag returns events without advancing the cursor. Generates inline progress events when the heartbeat interval is due.
- Status line cdx status --line: formats a single line of at most 100 characters showing active lanes, stages, elapsed times, running jobs, open questions, and Gemini quota blocks. Outputs an empty string when the caller owns no active work.
- Stdin support across free-text commands: every command taking free text accepts - to stream text from stdin (spawn, resume, consult, review intent, fork, send, reply, msg, job, and close). An empty stdin fails with command usage.
- Doctor checks: replaced monitor lease and receipt checks with verification that ~/.claude/skills/cdx resolves to the repository, hooks/hooks.json declares modules: ["./register.ts"] with no classic hooks, the caller session has polled within 15 seconds, and CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 is configured.
- Early access API: Claude Code function hooks are early access and subject to change. Vendored type definitions in hooks/types/claude-code.d.ts state their source Claude Code version on line 1 (2.1.270).
- Version alignment: runtime VERSION in cdx.ts, package.json, and plugin.json align to 7.0.0.

## 6.6.0

- Gemini 503 handling: a 503 is a service outage, not a stream fault. The live agy process is kept and cdx retries up to six times with waits of 30 s, 1, 2, 4, 5 and 5 minutes; a completed step restarts the ladder. Other transport faults keep the single immediate retry from 6.5.0. The continue prompt tells the model the service recovered and not to redo finished work.
- New wake event kind `outage`, emitted once per round at the first 503, so the head learns at once that the lane is waiting rather than dead. The plugin watcher needs a session restart to deliver the new kind; the quiet `auto-continue k/6 wait=Ns` lines still arrive through hooks meanwhile.
- Supervisor notices: when a child lane hits a 503 outage, and when a child round ends failed or gate-invalid, cdx appends a `CDX NOTICE` control record to the supervisor's current round, delivered like a head steer, so the supervisor reacts inside its own turn instead of at its next cdx wait. Nothing is written once the parent round has ended or closed steering. Head steers are still delivered verbatim.
- A round that outlasts the ladder fails with `gemini 503 outage outlasted 6 auto-retries (~18 min); when Gemini answers again run cdx resume <lane>, the partial report is kept`.
- Version alignment: cdx.ts VERSION, package.json and plugin.json align to 6.6.0.

## 6.4.0

- Normal cdx status displays round tool steps, git dirty file count skipping non-git directories, stage as working, gate running with elapsed time, or reporting, and last action age.
- Running jobs display their latest non-empty log line capped at 80 characters, skipping blank tail lines.
- cdx status --brief prints only running lanes and caller-owned jobs, one line each under 100 characters.
- cdx status --watch with optional --interval S defaulting to 2 seconds re-renders the brief view in place read-only until stopped with Ctrl-C.
- Session-wide plugin watch emits one quiet progress digest every visibility.heartbeatMinutes defaulting to 10 while owned work runs. Each line reports step and dirty file deltas, stage transitions, and current action.
- The monitor reads heartbeat configuration at startup, so changed cadence needs a monitor restart.
- Stage transitions gate-started, gate-finished with exit code, and report-written emit quiet events.
- Thrash detector wakes the liaison once per round if the same command fails visibility.failureRepeats consecutive times defaulting to 5, or if the same file is edited more than visibility.fileEdits times in a round defaulting to 20. The detector recognizes only explicit structured failures and nonzero exit codes; it never guesses from free text. Shell script edits without structured file events are not counted by file thrash.
- Round specs pin visibility settings at launch. Runner memory tracks tool observations and repetition state per round.
- Lane ledger records add fields roundSteps, stage, stageStartedAt, and lastActionAt.
- SessionStart caps finished jobs at 10 while including running jobs, nonclosed lanes awaiting attention, and open questions.
- New visibility configuration object supports heartbeatMinutes as a positive finite number, failureRepeats as a positive integer, and fileEdits as a positive integer.
- Version alignment: cdx.ts runtime VERSION, package.json, and plugin.json align to 6.4.0.
- Zero new runtime dependencies. Updating watcher code requires restarting the Claude Code session.

## 6.2.0

- Round cap: new config key `gemini.maxRounds` defaults to 2. `cdx resume` on a Gemini lane whose work rounds already equal the cap fails with: `round cap <n> reached for <lane>: close it and spawn a new lane with the failure attached`. Review rounds do not count toward the cap. Astra and GPT lanes are not capped.
- Pre-check: new flag `--pre "<cmd>"` on spawn and resume runs the command in the lane's cwd before opening the round. A nonzero exit refuses the launch, prints the last 20 lines of output, and records nothing in the ledger. The pre-check persists on the lane like the gate so resume reuses it unless a new `--pre` is given. Intended use: `--pre "bun qa.ts readiness-check --release <sha>"` before any register cell lane.

## 6.1.1

- Gemini transport interruptions get five continuation retries with waits of 1, 2, 3, 4, and 5 seconds. Stops and runtime limits prevent another continuation after the wait.
- Failed rounds expose partial report paths in the ledger and terminal feed. Resume includes the previous failed round's partial report for either engine and tells it to continue without redoing completed work.
- Gemini failure notes contain the error reason and partial report path, without report markdown. Transport errors no longer overwrite captured partial work.
- Every injected brief tells the engine to save tool payloads larger than one screen outside the repository and print only the path and a one-line digest.
- Consult status uses its review state, timing, and report on the main consult line instead of showing adopted work.
- Multi-target wait prints the target list and completion lines, then a summary and requested report bodies. JSON output stays unchanged.

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
