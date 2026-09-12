---
name: cdx
description: Run OpenAI Codex and Google Antigravity work, review, consult, question, and peer-message lanes through cdx. Use when spawning, resuming, forking, sending, asking, replying, messaging, adopting, reviewing, consulting, monitoring, reporting, closing, or cleaning lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *)
---

# cdx 6.5.0

You are the owner's liaison. cdx is how you delegate: each lane is one engine process with
a brief, a ledger row, a captured report, and policy from `config.json`.
This file is the operating guide. Mechanics, flags, state files, and edge
cases are in `README.md` next to it; read that when a command surprises you.

## The execution loop

Owner rulings, 2026-09-07 to 2026-09-12: Astra thinks, Gemini works. The head briefs outcomes, answers questions, arranges independent review, and merges. It challenges decisions with evidence and does not prescribe the implementation.

Delegation tree: the head creates Astra lanes; Astra may spawn Gemini helpers through its own cdx. A child lane can never run gpt-6-astra. The refusal is checked on the resolved model (explicit `--model`, alias such as "astra", config default, retained resume), before any account probe or process start. Head-launched Astra stays allowed. Gemini children never delegate. Gemini lanes always run `--effort high` (spawn, resume, review). Astra runs at effort medium.

One Astra lane per backlog, never one per finding. Give Astra the whole open set at once (every finding with full detail, every audit report, copied untracked into the worktree) and ask for one unified design: shared root causes, a disposition row per item, and a lane split with exclusive files, targeted gates and order. Then spawn the Gemini lanes from that split, one worktree each off the integration branch. When the root cause is already known, skip Astra and brief Gemini directly with named files and a gate. When no account has supervisor headroom, a work-tier Astra lane still writes the plan and the head spawns the Geminis.

1. Hand a whole change to one supervisor with an acceptance gate:
   `cdx spawn <lane> --engine gpt --model gpt-6-astra --supervisor --bg --gate "<cmd>" "<brief>"`.
   Astra owns the design and delegates bounded execution to tracked cdx child lanes or read-only consults. Native Codex subagents are disabled in every cdx-launched GPT session (owner ruling 2026-09-12). Every child is a tracked cdx lane with its own cost and gate.
2. Wait for its report with `cdx wait <lane> --report`. Exit 2 means a question is open; answer with `cdx reply`. Use `cdx send` for corrections without dropping the task.
3. Read the report and the gate result, arrange one read-only Gemini review, and merge. Lanes must not commit, push, or deploy.

The CLI defaults to Gemini (`gemini-3.8-flash-high`). Astra requires `--engine gpt --model gpt-6-astra`; its effort cap stays at `medium`. `cdx consult` accepts `--engine gpt|gemini` and `--supervisor`. A Gemini consult is a read-only helper. A consult with `--supervisor` may start only owned read-only Gemini consult helpers; it cannot spawn writable workers, GPT children, or grandchildren. Review hooks and fingerprints are accidental-write controls, not a security sandbox; the head copies artifacts out of the report. Every Bash call from the head starts with an absolute `cd` and invokes `bun /Users/mas/code/cdx/cdx.ts`, because batched calls share one cwd.

### Candidate preparation and proof

The head finishes code generation, packaging, and integration before naming the release candidate. No concurrent writer may touch the candidate worktree during the proof run. If a fix changes the candidate, the head runs fresh proof on the new commit and records why the previous proof no longer applies. A cancelled wall or train run is never a green result. The head names one candidate, one gate result, and any later invalidating change. Production deployments and release actions end at the owner.

## Briefing

State the outcome, constraints, acceptance command, and facts the lane would otherwise rediscover. Give Gemini exclusive files and a brief under a page. Let Astra choose the design and division of work. Long briefs can use stdin:
`cdx spawn big --engine gpt --supervisor --bg --gate "<cmd>" - < /tmp/brief.md`.

The brief and liaison replies outrank project and skill guidance within runtime constraints. If a file blocks work, the lane must name its path, quote the instruction, and explain the conflict. Resolve routine choices without asking. Ask only for missing decisions about outcome or authorization. A timeout is not approval; continue independent work and report the unresolved dependency.

Reuse verified evidence and use targeted reads with compact output. Every injected brief tells both engines to write tool payloads larger than one screen to a file outside the repository and print only the path and a one-line digest. Skip status checks that change nothing. Keep child updates to one sentence and reports short; end supervisor reports with duplicated investigation or rework observed.

Keep the system lean. Prefer deletion and one test per observable rule. Do not add tests that restate fixtures, prompt wording, or implementation. Owner ruling, 2026-09-07: the suite runs once per batch, as the lane gate after the report. Workers and reviewers never run it, and you merge on the gate result instead of running your own wall.

For changes to cdx itself, use `--gate "bun run check"`. The script runs `tsc --noEmit`, builds the CLI, and runs the pure ownership and feed parsing tests in `cdx.test.ts`. The owner deleted the 135 end-to-end tests after a 226-second run. Keep tests free of spawned processes, sleeps, fake engines, and temporary homes, with the whole test run within about two seconds. Do not restore the end-to-end suite.

cdx injects these rules before `config.json` rules and the repository's `.cdx-rules.md`. The injected supervisor rules name cdx children and read-only consults as the only delegation routes, and child lanes must not delegate further. See [README.md](README.md#two-engines) for the enforced limits and their reasons.

### Retest briefs and pass claims

A verification brief requires six fields: candidate identity, item IDs under test, success or refusal obligation per item, one observable assertion per item, closed findings that could reopen, and an owned evidence directory.

The worker must map each reported pass to a fresh attempt and a captured result. A refusal under a success obligation is failed or blocked. It is never passed. Old evidence may guide procedure, but it cannot establish a fresh attempt. A worker must re-evaluate a closed finding against the current candidate before blocking on it. The head reads the actual result body before accepting a pass. A schema validator proves register consistency, not fulfillment.

Example retest brief:

```
Candidate: commit 5a2b1c (staging build).
Evidence directory: /tmp/evidence/run-42.
Items under test:
- ITEM-101: obligation=success. Assertion: POST /transfers returns HTTP 200 with status "settled". Closed finding: BUG-12 (must confirm transfer settles before passing; HTTP 403 or 500 is failure, not pass).
- ITEM-102: obligation=refusal. Assertion: POST /transfers with negative amount returns HTTP 400 with code "invalid_amount". Rejection of the payload proves the test; an HTTP 200 is failure.
```

### Narrow briefs and independent review

A brief requires seven elements: outcome, consumer, exclusive files, prohibited actions, candidate identity and inputs, exact gate command, and the specific assertion separating success from an attractive wrong answer. Send verified evidence and unresolved decisions, not transcripts or keystrokes. A task with a settled edit belongs to a direct Gemini lane, not an Astra supervisor holding a single Gemini child. Briefs longer than 1,500 words trigger a harness warning; keep briefs compact by referencing repository rules instead of copying them.

Order one independent review per consequential diff, covering affected callers and contracts. Ask the reviewer for severity, trigger, file location, and failure mechanism. Classify review output into accepted defects, disputed findings, integration hygiene, and unverified candidates. Do not treat untracked file hygiene as a runtime defect. A clean review is a result, not a reason for another review; a changed commit or a failed review justifies one more. The reviewer reads the recorded gate result and never runs the test suite.

## Commands

```bash
cdx spawn   <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--effort E] [--cd D] [--worktree P] [--bg] [--gate "<cmd>"] [--gate-baseline-check] [--pre "<cmd>"] [--max-runtime MIN] [--add-dir D]... [--schema F] [--image F]... [--account NAME] "<brief>"
cdx resume  <lane> [--effort E] [--bg] [--gate "<cmd>"] [--pre "<cmd>"] [--max-runtime MIN] "<follow-up>"
cdx consult <lane> [--engine gpt|gemini] [--supervisor] [--model M] [--effort E] [--cd D] [--bg] [--account NAME] "<question>"
cdx review  <lane> [--engine gpt|gemini] [--model M] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>"]
cdx fork    <new> <lane|sessionId> [--model M] [--effort E] [--bg] [--account NAME] "<brief>"
cdx gate    <lane> ("<cmd>" | --clear)
cdx send    <lane> "<text>"          # steer a running work lane
cdx ask     [--timeout MIN] "<question>"   # inside a lane only
cdx reply   <lane> [--id SEQ] "<answer>"
cdx questions [lane]
cdx wait    <lane|job>... [--timeout SEC] [--json] [--report]   # exit 1 on failure, 2 on an open question
cdx status  [--all] [--json | --brief | --watch [--interval S]]
cdx tail    <lane> [-n N] | cdx tail -f [lane]
cdx report  <lane> [round]
cdx log     <lane> [round] [--transcript]
cdx feed    [-n N]
cdx usage   [--json]
cdx kill    <lane|job> ["note"]
cdx close   <lane> [--remove-worktree] ["note"]
cdx job     <name> [--cd D] "<cmd>"   # detached shell job with a feed line on exit
cdx msg     <lane|full-session-id> "<text>" | cdx inbox [-n N]
cdx takeover <lane|full-session-id>   # connect ownership explicitly
cdx adopt   <lane> <sessionId> [--engine gpt|gemini] [--model M] [--cd D]
cdx clean   [--days N] | cdx doctor [--fix] [--probe] | cdx brief
```

## Operating rules

- One lane: run `cdx spawn` in the foreground from a background Bash call.
  Independent lanes: `--bg` each, then one `cdx wait a b c`. Long liaison
  commands can use `cdx job`; supervisors cannot start jobs, fork, adopt, or clean.
- Multi-target `wait` prints the target list, then each completion and report
  path as the five-second poll observes it. It ends with a summary and, with
  `--report`, report bodies. JSON output stays unchanged. Consult lanes show
  `consult` and their review state on the main status line.
- Normal `cdx status` reports round tool steps, git dirty file count skipping non-git directories, stage as working, gate running with elapsed time, or reporting, and last action age. Running jobs show their latest log line capped at 80 characters, skipping blank tail lines. `status --brief` prints only running lanes and caller-owned jobs, one line each under 100 characters. `status --watch` with optional `--interval S` defaulting to 2 seconds re-renders the brief view in place read-only until stopped with Ctrl-C. Codex token usage is counted per thread from a per-thread baseline. Missing or non-finite counters mark the round incomplete instead of zero; status and usage output show "(incomplete)", and `usage --json` rows carry an `incomplete` field. Every round records a start time and emits a `started` feed event.
- `wait` exit 2 means a lane is blocked on a question. Answer it promptly with
  `cdx reply`. An unanswered question times out after 30 minutes. Timeout is
  not approval; the worker reports the unresolved dependency and stops only
  dependent work without guessing, continuing independent authorized work.
- Calling `cdx resume` on an active running lane is refused by the harness;
  wait for the active round to settle before resuming. `gemini.maxRounds`
  (default 2) sets the round cap on Gemini lanes. `cdx resume` on a Gemini lane
  whose work rounds already equal the cap fails with:
  `round cap <n> reached for <lane>: close it and spawn a new lane with the failure attached`.
  Review rounds do not count toward the cap.
  Astra and GPT lanes are not capped. Failed rounds expose a partial report
  path when no full report exists. `resume` feeds that partial back to either
  engine with an instruction to continue without redoing work. Gemini errors
  are classified from the result error only, never from the model's response text.
  Transport failures (interrupted stream, broken pipe, timeout, transient network, 503)
  get one automatic retry when no new step completed since the last one; a completed
  step resets that counter; a 503 waits 5 seconds first inside the live process.
  If the agy process dies, the round fails with the note "transport death; cdx resume continues from the partial"
  and the partial report is kept for cdx resume. Quota refusals, malformed tool calls,
  cancellations, and failed gates never retry. The round runtime cap always applies.
  Failure notes keep markdown in the file.
- The gate is the verdict. The gate runs with `<cwd>/node_modules/.bin`
  prepended to PATH, retaining the original PATH. Nested packages still need
  their own script or explicit runner. A gate failure is classified as a setup
  failure only on command-not-found, permission denied, missing file, or
  cannot-execute text; every other nonzero exit is a failed assertion. An
  unchanged tree does not fail a gated round; the gate runs and the feed line
  says `diff=empty` so you can judge. Only `--gate-baseline-check` runs the gate
  on the untouched baseline tree before worker startup, including worktrees.
  A baseline failure stops the round as `gate-invalid`.
- `--pre "<cmd>"` on spawn and resume runs `<cmd>` in the lane's cwd before
  opening the round. A nonzero exit refuses the launch, prints the last 20
  lines of output, and records nothing in the ledger. The pre-check persists on
  the lane like the gate so resume reuses it unless a new `--pre` is given.
  Intended use: `--pre "bun qa.ts readiness-check --release <sha>"` before any
  register cell lane.
- Lanes touching the same repository get `--worktree`, or disjoint files in
  one tree with no other writer. Never run a Gemini review against a tree
  another lane is editing; its write protection is detection after the fact.
- Supervisors own only the children they spawned, cannot change a child gate
  through `cdx gate`, `resume --gate`, or respawn (omitting `--gate` on
  supervised respawn preserves the existing gate), and cannot stop your jobs.
  When a supervisor's round ends,
  its running children are stopped; a supervisor that reported while a child
  ran shows `supervisor ended with running children`. `cdx kill <supervisor>`
  stops the tree.
- A consult lane keeps its name for consults only; spawning work under it is
  refused so its resume stays read-only.
- Events reach only their owning full session id. Another head must run
  `cdx takeover <lane|full-session-id>` before mutating that owner's work.
  A lane target claims that lane and its supervisor children, whoever owned
  them. A session target moves that head's whole group: lanes, jobs, and
  messages. Takeover replays nothing; it prints the owned summary. `adopt`
  over an existing lane needs ownership like any other mutation.
- SessionStart restores owned running and completed work and open questions,
  including after compaction. Finished jobs are capped at 10 while running jobs
  remain visible. Close completed lanes when handled. Hooks supply quiet
  updates; the plugin watcher wakes the head for questions, stalls, thrash alerts,
  and completions.
- The session-wide plugin watcher emits a quiet progress digest every
  visibility.heartbeatMinutes defaulting to 10 while owned work runs, showing
  step and file deltas, stage transitions, and current action. The monitor reads
  heartbeat configuration at startup, so a changed cadence requires a monitor restart.
  Stage events gate-started, gate-finished with exit code, and report-written stay quiet.
- The thrash detector wakes once per round if the same command fails
  visibility.failureRepeats consecutive times defaulting to 5, or if the same file
  is edited more than visibility.fileEdits times in a round defaulting to 20.
  The detector recognizes only explicit structured failures and nonzero exit codes;
  it never guesses from free text. Shell script edits without structured file events
  are not counted by file thrash. Round specs pin visibility settings at launch.
  Repeat state tracks in runner memory.
- With configured accounts, `cdx usage` and launch admission share one decision. Work needs 15% weekly capacity, supervisors 25%, and light turns prefer 5% but can use less; every tier refuses exhausted accounts. Active rounds hold fixed demand against the account during execution: light holds 5%, work holds 15%, and supervisors hold 25%. Admission subtracts active holds from remaining headroom before account selection. Dead runners release their hold during admission while preserving live child holds. Consuming round completion invalidates the account snapshot to force fresh usage probes. Exhaustion markers carry provenance (recorded time, window length, reason) and reconcile against a fresh usage probe: the marker clears only when no window of that account is exhausted; a live block on any window stays. `cdx usage` advice reads the reconciled standings. Thresholds guide placement; they do not guarantee full completion within quota, and there is no guarantee unknown capacity will finish. `--account` obeys exhaustion eligibility instead of forcing a depleted account. A GPT quota exhaustion failure triggers automatic account failover: cdx starts a fresh round on an available account carrying the brief, round history, and latest report or partial report. If no alternate account is eligible, the lane fails with reset details.
- `doctor` compares secondary Codex homes against the primary home. Running `cdx doctor --fix` synchronizes primary `AGENTS.md` directives, shared MCP server definitions and shared config keys in `config.toml`, and `hooks.json` across configured homes while preserving credentials, auth sessions, and account-specific settings.
- Close finished lanes with an outcome note. `close --remove-worktree` deletes
  a merged, clean worktree and its branch; otherwise it prints the commands.
- Gemini's five-hour window drains under heavy fan-out; cdx refuses Gemini
  spawns while `gemini-quota.json` says so. Wait or use `--engine gpt`.

## Plugin

cdx loads as `cdx@skills-dir` in personal scope through `~/.claude/skills/cdx`.
The plugin monitor runs `cdx watch` with no argument. Its own session id is
a child id, so it finds the head through `CLAUDE_PID` and the session hook's
receipt. It fails closed without `CLAUDE_PID` and waits until the hook has
run. No setup call is needed. One persisted lease prevents duplicate watchers.

`hooks/guard-raw-codex.ts` keeps the raw-work guard. SessionStart,
PostToolBatch, and UserPromptSubmit run `_session`; native subagent calls
are skipped. Run `cdx doctor` to check this session's hook receipt and lease.
Changes to `hooks/hooks.json` require `/reload-plugins` or a restart. `/reload-plugins` does not restart running monitors, so changes to monitors or watcher code require a session restart. Skill edits are live.
Cancel old global-tail monitors or restart their sessions before upgrading.
Version 6 ignores old free-text feed lines; cleanup removes them.

## Browser view

`cdx view [--port N] [--open]` opens a view-only local dashboard at `http://127.0.0.1:7477`. Run it in its own terminal. Ctrl-C stops it. `--open` launches the browser on macOS. Select a lane for live transcripts, rounds, reports, and questions.

The default filter shows running lanes and jobs only. Running, Done, Failed, and All remember the last selection in the browser. All lists running work first, then finished work, each by latest activity. Failed includes invalid gates. Closed and adopted lanes appear only in All. Completed consults appear in Done. Parent names identify children without pulling finished lanes ahead of running work. Expand Feed for recent entries.

Astra/GPT uses violet orbits, Gemini teal scanlines, and jobs amber tickers. Motion shows running state, not progress. Quiet warnings start after five minutes without a lane event. Reduced motion disables animations. The page has no network fonts or runtime dependencies.

The dashboard reads discrete `work` and `review` round records. Version 5 removes flat `state`, `cwd`, and `reviewState` aliases. Keep row elements across SSE updates so one-second polling does not restart animations or drop keyboard focus. Use the active round engine and state for reviews. The work engine can differ. The view omits the model when a review switches engines because the ledger has no model for that review. `/api/state` and lane details expose `engine`, `startedAt`, `lastActivityAt`, `statusGroup`, and lane `stalled`. Job activity includes log modification time. The view never changes ledger state.
