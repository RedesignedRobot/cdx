---
name: cdx
description: Run OpenAI Codex and Google Antigravity work, review, consult, question, and peer-message lanes through cdx. Use when spawning, resuming, sending, asking, replying, messaging, adopting, reviewing, consulting, reporting, closing, or cleaning lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *), mcp__cdx__*
---

# cdx 9.2.0

You are the owner's liaison. cdx is how you delegate: each lane is one engine process with
a brief, a ledger row, a captured report, and policy from `config.json`.
This file is the operating guide. Mechanics, flags, state files, and edge
cases are in `README.md` next to it; read that when a command surprises you.

## The execution loop

Owner rulings, 2026-09-07 to 2026-09-23: Astra thinks, Sol executes. The head briefs outcomes, answers questions, arranges independent review, and merges. It challenges decisions with evidence and does not prescribe the implementation.

Use the native tools: `mcp__cdx__spawn` with the brief as a field, `mcp__cdx__reply`, `mcp__cdx__send`, `mcp__cdx__status`, `mcp__cdx__report`, and `mcp__cdx__close`. There is no `mcp__cdx__wait` tool. The head never blocks on a lane (owner ruling 2026-09-15). End your turn after spawning. Completion, questions, stalls, outages, and peer messages arrive as `[cdx]` events: as an automatic prompt when idle, or as context on the next tool result mid-turn. To check in mid-turn, call `mcp__cdx__events` or `mcp__cdx__status`. `cdx wait` stays in the CLI for supervisors and terminal operators; from the head, the mod denies `cdx wait`, `cdx status --watch`, and shell loops polling cdx. If nothing else is pending after a spawn or job, ending the turn is the correct move. Inside Claude Code the mod denies a shell `cdx <subcommand>` that has a native tool (owner ruling 2026-09-17: the head calls cdx natively; the shell form is for lanes and terminals outside Claude Code). The Bash form `bun /Users/mas/code/cdx/cdx.ts ...` stays only for commands without a tool (brief, clean, feed, log, adopt). `mcp__cdx__spawn`, `consult` and `review` require `cd`, the absolute repository path, because the session directory follows the last shell `cd`.

Delegation tree: the head creates Astra lanes; Astra may spawn Sol or Gemini children through its own cdx. Astra never spawns Astra: a child lane can never run gpt-6-astra and falls back to Sol. The refusal is checked on the resolved model (explicit `--model`, alias such as "astra", config default, retained resume), before any account probe or process start. Head-launched Astra stays allowed. Children never delegate. Sol and Astra run at effort medium by default; ask for high on deep design work (owner ruling 2026-09-22). Both are capped at high, so xhigh and max are refused. Gemini lanes always run `--effort high` (spawn, resume, review).

One Astra lane per backlog, never one per finding. Give Astra the whole open set at once (every finding with full detail, every audit report, copied untracked into the worktree) and ask for one unified design: shared root causes, a disposition row per item, and a lane split with exclusive files, targeted gates and order. Then spawn the Sol lanes from that split, one worktree each off the integration branch, with Gemini for any mechanical sweep. When the root cause is already known, skip Astra and brief a Sol lane directly with named files and a gate. When no account has supervisor headroom, a work-tier lane with `--model astra` still writes the plan and the head spawns the workers.

1. Hand a whole change to one supervisor with an acceptance gate using `mcp__cdx__spawn`:
   `lane`: name, `supervisor`: true, `gate`: `<cmd>`, `brief`: `<text>`. The default gpt engine runs a supervisor on Astra.
   The brief is delivered whole through stdin, so quotes and newlines are safe. Astra owns the design and delegates bounded execution to tracked Sol or Gemini child lanes or read-only consults. Native Codex subagents are disabled in every cdx-launched GPT session (owner ruling 2026-09-12). Every child is a tracked cdx lane with its own cost and gate. End your turn after spawning.
2. When a question arrives in a `[cdx]` prompt or context, answer with `mcp__cdx__reply`. Use `mcp__cdx__send` for corrections without dropping the task.
3. When completion arrives, read the report (`mcp__cdx__report`) and gate result, arrange one independent review (`mcp__cdx__review`, Astra by default), then call `mcp__cdx__land` for a managed worktree. Lanes must not commit, push, or deploy.

The CLI defaults to the gpt engine. Work lanes run the config `model`, `gpt-6-sol`. Head-launched review, consult and `--supervisor` lanes run `thinkerModel`, `gpt-6-astra`. `--model astra` or `--model sol` overrides either. Use `--engine gemini --effort high` (`gemini-3.8-flash-high`) for mechanical sweeps: renames, bumps, doc sweeps, test fixes with a named cause. A review records its model as `reviewModel`; the lane's `model` stays the work model. If `cdx doctor` fails `codex models`, run `codex update`, then `codex debug models`. `cdx consult` accepts `--engine gpt|gemini` and `--supervisor`. A Gemini consult is a read-only helper. A consult with `--supervisor` may start only owned read-only Gemini consult helpers; it cannot spawn writable workers, GPT children, or grandchildren. Review hooks and fingerprints are accidental-write controls, not a security sandbox; the head copies artifacts out of the report. Every Bash call from the head starts with an absolute `cd` and invokes `bun /Users/mas/code/cdx/cdx.ts`, because batched calls share one cwd.

### Candidate preparation and proof

The head finishes code generation, packaging, and integration before naming the release candidate. No concurrent writer may touch the candidate worktree during the proof run. If a fix changes the candidate, the head runs fresh proof on the new commit and records why the previous proof no longer applies. A cancelled wall or train run is never a green result. The head names one candidate, one gate result, and any later invalidating change. Production deployments and release actions end at the owner.

## Briefing

State the outcome, constraints, acceptance command, and facts the lane would otherwise rediscover. Give Sol and Gemini workers exclusive files and a brief under a page. Let Astra choose the design and division of work. Free-text commands accept `-` to read stdin:
`cdx spawn big --supervisor --bg --gate "<cmd>" - < /tmp/brief.md`.

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

A brief requires seven elements: outcome, consumer, exclusive files, prohibited actions, candidate identity and inputs, exact gate command, and the specific assertion separating success from an attractive wrong answer. Send verified evidence and unresolved decisions, not transcripts or keystrokes. A task with a settled edit belongs to a direct Sol lane, or Gemini for a mechanical sweep, not an Astra supervisor holding a single child. Briefs longer than 1,500 words trigger a harness warning; keep briefs compact by referencing repository rules instead of copying them.

Order one independent review per consequential diff, covering affected callers and contracts. Ask the reviewer for severity, trigger, file location, and failure mechanism. Classify review output into accepted defects, disputed findings, integration hygiene, and unverified candidates. Do not treat untracked file hygiene as a runtime defect. A clean review is a result, not a reason for another review; a changed commit or a failed review justifies one more. The reviewer reads the recorded gate result and never runs the test suite.

## Gate and lifecycle playbook

Before spawning, put the repository's mandatory checks in `.cdx-gate` in its primary checkout. cdx runs that baseline at the parent and uses lane-specific gates for children. `--gate-baseline-check` only diagnoses an already broken checkout and runs the gate twice; leave it off for ordinary work. Gates must leave source bytes unchanged. After completion and independent review, read `cdx gate-receipt <lane> --json`. Use native `land` to commit, merge, push and remove only the tree it proves. Ledger v5 remains readable; old rows without a receipt need a fresh gated work round.

Start jobs with `cdx job <name> --cd /absolute/repo "<command>"`; the native job tool requires `cd`. End the head turn and use the completion event's verdict, report, log and gate exit. Read the report once to review it. Keep finite status, question and tail reads for diagnosis. Do not poll with sleep chains, shell loops, follow-tail or watch commands.

Resume only with `--fix gate|review` for failed evidence at the same HEAD. New scope needs a fresh lane seeded from the report. Fix resumes preserve directories and gate commands. A respawn can reuse an existing clean worktree on the expected lane branch in the same repository. After landing, `cdx close <lane>` removes the clean worktree and branch only when the branch is merged into local `main`. `--remove-worktree` remains accepted. Dirty, switched or unmerged worktrees refuse default cleanup. To abandon a lane, use `cdx close <lane> --keep-worktree` or native `keepWorktree: true`; it closes only the ledger entry and prints manual cleanup commands. Do not combine it with `--remove-worktree`. Default cleanup checks ancestry against local main before deleting the branch with `-D`, independent of primary HEAD or upstream.

## Commands

Every command taking free text accepts `-` to read from stdin: `spawn`, `resume`, `consult`, `review` (intent), `send`, `reply`, `msg`, `job`, and `close`.

```bash
cdx spawn   <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--effort E] [--cd D] [--worktree P] [--bg] [--gate "<cmd>"] [--gate-baseline-check] [--pre "<cmd>"] [--max-runtime MIN] [--add-dir D]... [--schema F] [--image F]... [--account NAME] ("<brief>" | -)
cdx resume  <lane> --fix gate|review [--effort E] [--bg] [--max-runtime MIN] ("<fix instructions>" | -)
cdx consult <lane> [--engine gpt|gemini] [--supervisor] [--model M] [--effort E] [--cd D] [--bg] [--account NAME] ("<question>" | -)
cdx review  <lane> [--engine gpt|gemini] [--model M] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>" | -]
cdx gate    <lane> ("<cmd>" | --clear)
cdx gate-receipt <lane> [--json]
cdx send    <lane> ("<text>" | -)          # steer a running work lane
cdx ask     [--timeout MIN] "<question>"   # inside a lane: liaison
cdx ask     --cd /repo "<question>"       # synchronous Gemini, no lane
cdx land    <lane>
cdx reply   <lane> [--id SEQ] ("<answer>" | -)
cdx questions [lane]
cdx events  [--json] [--peek]              # unread feed events; --peek leaves cursor unadvanced
cdx wait    <lane|job>... [--timeout SEC] [--json] [--report]   # exit 1 on failure, 2 on an open question
cdx status  [--all] [--json | --brief | --line | --watch [--interval S]]
cdx tail    <lane> [-n N] | cdx tail -f [lane]
cdx report  <lane> [round]
cdx log     <lane> [round] [--transcript]
cdx feed    [-n N]
cdx usage   [--json]
cdx kill    <lane|job> ["note"]
cdx close   <lane> [--remove-worktree | --keep-worktree] ["note" | -]
cdx job     <name> --cd D ("<cmd>" | -)   # detached shell job with a feed line on exit
cdx msg     <lane|full-session-id> ("<text>" | -) | cdx inbox [-n N]
cdx takeover <lane|full-session-id>   # connect ownership explicitly
cdx adopt   <lane> <sessionId> [--engine gpt|gemini] [--model M] [--cd D]
cdx clean   [--days N] | cdx doctor [--fix] [--probe] | cdx brief
```

## Operating rules

- One lane: run `mcp__cdx__spawn` (or `cdx spawn ... --bg`).
  Independent lanes: spawn each in background, then let completion events wake the turn. Long liaison
  commands can use `cdx job` (or `mcp__cdx__job`); supervisors cannot start jobs, adopt, or clean.
- Multi-target `wait` in the CLI prints the target list, then each completion and report
  path as the five-second poll observes it. It ends with a summary and, with
  `--report`, report bodies. JSON output stays unchanged. Consult lanes show
  `consult` and their review state on the main status line.
- Normal `cdx status` reports round tool steps, git dirty file count skipping non-git directories, stage as working, gate running with elapsed time, or reporting, and last action age. Running jobs show their latest log line capped at 80 characters, skipping blank tail lines. `status --brief` prints only running lanes and caller-owned jobs, one line each under 100 characters. `status --line` renders at most 100 characters for the UI status slot. `status --watch` with optional `--interval S` defaulting to 2 seconds re-renders the brief view in place read-only until stopped with Ctrl-C. Codex token usage is counted per thread from a per-thread baseline. Missing or non-finite counters mark the round incomplete instead of zero; status and usage output show "(incomplete)", and `usage --json` rows carry an `incomplete` field. Every round records a start time and emits a `started` feed event.
- A question event means a lane is blocked. Answer it promptly with
  `mcp__cdx__reply` (or `cdx reply`). An unanswered question times out after 30 minutes. Timeout is
  not approval; the worker reports the unresolved dependency and stops only
  dependent work without guessing, continuing independent authorized work.
- Resume requires `--fix gate|review`, failed evidence, a work conversation and the same HEAD. New scope needs a fresh lane seeded from the report. Gemini work rounds retain their configured round cap. A live round cannot resume. Partial reports preserve work after quota, transport and runtime failures; start a fresh lane when no gate or review failure authorizes resume.
- Gemini retries a transport failure once and capacity outages through its six-step backoff, then may use one configured fallback round. Quota refusals and cancellations do not retry. A gate failure gets one automatic fix turn. Do not intervene while that turn is running.
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
  the lane like the gate; a fix resume cannot replace it.
  Intended use: `--pre "bun qa.ts readiness-check --release <sha>"` before any
  register cell lane.
- Lanes touching the same repository get `--worktree`, or disjoint files in
  one tree with no other writer. Never run a review against a tree
  another lane is editing; its write protection is detection after the fact.
- Supervisors own only the children they spawned, cannot change a child gate
  through `cdx gate`, `resume --gate`, or respawn (omitting `--gate` on
  supervised respawn preserves the existing gate), and cannot stop your jobs.
  When a supervisor's round ends,
  its running children are stopped; a supervisor that reported while a child
  ran shows `supervisor ended with running children`. `cdx kill <supervisor>`
  stops the tree.
- A consult lane keeps its name for consults only; spawning work under it is
  refused; follow-up questions use a fresh consult.
- Events reach only their owning full session id. Another head must run
  `cdx takeover <lane|full-session-id>` before mutating that owner's work.
  A lane target claims that lane and its supervisor children, whoever owned
  them. A session target moves that head's whole group: lanes, jobs, and
  messages. Takeover replays nothing; it prints the owned summary. `adopt`
  over an existing lane needs ownership like any other mutation.
- Session start restores owned running and completed work and open questions.
  Finished jobs are capped at 10 while running jobs remain visible. Close completed lanes when handled.
  The mod wakes the head for questions, stalls, thrash alerts, 503 outages, and completions.
- The thrash detector wakes once per round if the same command fails
  visibility.failureRepeats consecutive times defaulting to 5, or if the same file
  is edited more than visibility.fileEdits times in a round defaulting to 20.
  The detector recognizes only explicit structured failures and nonzero exit codes;
  it never guesses from free text. Shell script edits without structured file events
  are not counted by file thrash. Round specs pin visibility settings at launch.
  Repeat state tracks in runner memory.
- With configured accounts, `cdx usage` and launch admission share one decision. The risk line is 3% weekly capacity for every lane kind; every tier refuses exhausted accounts. Above the line, the account with the highest forfeit rate (share above the line per day until its reset) is spent first, then the earlier reset, then the fuller account. Each account line names its banked reset credits and their expiries; a credit within three days of expiry prints a red CRITICAL line in usage, doctor, and every GPT launch, and the advice says which thin account to redeem one on. Active rounds hold 3% against the account during execution. Admission subtracts active holds from remaining headroom before account selection. Dead runners release their hold during admission while preserving live child holds. Consuming round completion invalidates the account snapshot to force fresh usage probes. Exhaustion markers carry provenance (recorded time, window length, reason) and reconcile against a fresh usage probe: the marker clears only when no window of that account is exhausted; a live block on any window stays. `cdx usage` advice reads the reconciled standings. Thresholds guide placement; they do not guarantee full completion within quota, and there is no guarantee unknown capacity will finish. `--account` obeys exhaustion eligibility instead of forcing a depleted account. A GPT quota exhaustion failure triggers automatic account failover: cdx starts a fresh round on an available account carrying the brief, round history, and latest report or partial report. If no alternate account is eligible, the lane fails with reset details.
- `doctor` compares secondary Codex homes against the primary home. Running `cdx doctor --fix` synchronizes primary `AGENTS.md` directives, shared MCP server definitions and shared config keys in `config.toml`, and `hooks.json` across configured homes while preserving credentials, auth sessions, and account-specific settings.
- Close finished lanes with an outcome note. `close --remove-worktree` deletes
  a merged, clean worktree and its branch; otherwise it refuses. Use
  `close --keep-worktree` to close without cleanup and print manual commands.
- Gemini's five-hour window drains under heavy fan-out; cdx refuses Gemini
  spawns while `gemini-quota.json` says so. Wait or drop `--engine gemini`.

## Claude Code integration

cdx loads as a native mod through `~/.claude/skills/cdx`.
`hooks/hooks.json` declares `modules: ["./register.ts"]`.
The integration requires `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` in `~/.claude/settings.json`.
The mod registers native `mcp__cdx__*` tools directly inside Claude Code runtime.
The `/lanes` command opens a live Pane with per-lane details and recent transcript lines. `/lanes <args>` forwards arguments to cdx. The live band above the prompt shows running lanes and jobs on terminal and desktop. Use the Pane on mobile or VS Code.
The `/cdx` command remains the skill that loads this document.
The mod polls events and the lane snapshot in one cdx call every 2 seconds. The band and status line show round elapsed time and the current action. Progress events stay out of the head's context but remain available through `mcp__cdx__events`. Actionable wake events become prompts when idle (held 15 seconds so a burst costs one prompt) and context mid-turn. Claude Code allows a plugin 50 prompts per session; once spent, the status line reads `wakes off`, actionable events still land on the next tool result or typed prompt, fresh wakes appear as a Tab suggestion in the prompt box, and a new session restores wakes.
Run `cdx doctor` to verify that the mod is polling and live.

## Browser view

`cdx view [--port N] [--open]` opens a view-only local dashboard at `http://127.0.0.1:7477`. Run it in its own terminal. Ctrl-C stops it. `--open` launches the browser on macOS. Select a lane for live transcripts, rounds, reports, and questions.

The default filter shows running lanes and jobs only. Running, Done, Failed, and All remember the last selection in the browser. All lists running work first, then finished work, each by latest activity. Failed includes invalid gates. Closed and adopted lanes appear only in All. Completed consults appear in Done. Parent names identify children without pulling finished lanes ahead of running work. Expand Feed for recent entries.

GPT uses violet orbits, Gemini teal scanlines, and jobs amber tickers. Motion shows running state, not progress. Quiet warnings start after five minutes without a lane event. Reduced motion disables animations. The page has no network fonts or runtime dependencies.

The dashboard reads discrete `work` and `review` round records. Version 5 removes flat `state`, `cwd`, and `reviewState` aliases. Keep row elements across SSE updates so one-second polling does not restart animations or drop keyboard focus. Use the active round engine and state for reviews. The work engine can differ. The view omits the model when a review switches engines. `/api/state` and lane details expose `engine`, `startedAt`, `lastActivityAt`, `statusGroup`, and lane `stalled`. Job activity includes log modification time. The view never changes ledger state.

Native tool output above 20 KB is retained under the cdx logs directory with bounded excerpts and a path; full safe output stays at the named path. Secret-shaped text is redacted before persistence and presentation. The pre-tool hook denies covered reads when the file has not changed. A moving owned path invalidates the gate receipt. Only a failed exit may receive one automatic repair turn and gate rerun. The terminal uses a small text mark without demo graphics.

## Operating rules

A work lane runs one typecheck and each touched spec once for mutation proof. The lane gate owns the suite and wall. A red gate gets one automatic repair turn before a terminal event; the head does not start a second repair while that turn runs.

Use `doctor --fix` after updating. It installs isolated Codex lane homes and real Gemini agent files without changing open engine sessions. Reload the Claude plugin for native `land` and `ask`. Missing agents or hooks refuse a Gemini launch. Gemini rounds queue when projected burn exceeds available quota and stop at 250 calls with a handoff.

Order one review per HEAD and tree. Reuse its report; after fixes, re-review only the fix diff against its prior findings. P3-only findings close the loop. GPT reviews accept `send` and publish per-call usage. Child terminals stay with the supervisor, which reports the combined outcome to the head.

`ask` from the head is a synchronous read-only Gemini question and requires a repository path. It creates no lane and requires macOS sandbox-exec. Native required fields must be nonempty; nonzero command exits are tool errors. `land` refuses dirty bases, red receipts and edits made after the receipt. Resolve merge conflicts in the base checkout and retry; never bypass a stale receipt.
