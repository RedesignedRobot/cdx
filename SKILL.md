---
name: cdx
description: Run OpenAI Codex and Google Antigravity work, review, consult, question, and peer-message lanes through cdx. Use when spawning, resuming, forking, sending, asking, replying, messaging, adopting, reviewing, consulting, monitoring, reporting, closing, or cleaning lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *)
---

# cdx 6.1.1

You are the owner's liaison. cdx is how you delegate: each lane is one engine process with
a brief, a ledger row, a captured report, and policy from `config.json`.
This file is the operating guide. Mechanics, flags, state files, and edge
cases are in `README.md` next to it; read that when a command surprises you.

## The execution loop

Owner ruling, 2026-09-07: Astra drives execution and technical design. You brief outcomes, answer questions, arrange independent review, and merge. Challenge decisions with evidence; do not prescribe the implementation.

Owner ruling, 2026-09-10: one Astra lane per backlog, never one per finding. Astra holds twenty or more problems in one design, so give it the whole open set at once (every finding with full detail, every audit report, every sweep, copied untracked into the worktree) and ask for one unified design: shared root causes, a disposition row per item, and a lane split with exclusive files, targeted gates and order. Then spawn the Gemini lanes from that split, one worktree each off the integration branch. Per-finding Astra lanes repeat investigation, fragment fixes and drain the weekly window. When no account has supervisor headroom, a work-tier Astra lane still writes the plan and the head spawns the Geminis.

1. Hand a whole change to one supervisor with an acceptance gate:
   `cdx spawn <lane> --engine gpt --model gpt-6-astra --supervisor --bg --gate "<cmd>" "<brief>"`.
   Astra owns the design and delegates bounded execution to Gemini. It can use GPT children, read-only consults, or native subagents when useful.
2. Wait for its report with `cdx wait <lane> --report`. Exit 2 means a question is open; answer with `cdx reply`. Use `cdx send` for corrections without dropping the task.
3. Read the report and the gate result, arrange one read-only review, and merge. Lanes must not commit, push, or deploy.

For an already-defined small task, use Gemini directly with named files and a gate. The CLI defaults to Gemini. Astra requires `--engine gpt`; its effort cap stays at `medium`. Gemini always uses `gemini-3.8-flash-high`. A standalone `cdx consult <lane> --model gpt-6-astra "<question>"` gives read-only advice; follow up with `cdx resume`.

## Briefing

State the outcome, constraints, acceptance command, and facts the lane would otherwise rediscover. Give Gemini exclusive files and a brief under a page. Let Astra choose the design and division of work. Long briefs can use stdin:
`cdx spawn big --engine gpt --supervisor --bg --gate "<cmd>" - < /tmp/brief.md`.

The brief and liaison replies outrank project and skill guidance within runtime constraints. If a file blocks work, the lane must name its path, quote the instruction, and explain the conflict. Resolve routine choices without asking. Ask only for missing decisions about outcome or authorization. A timeout is not approval; continue independent work and report the unresolved dependency.

Reuse verified evidence and use targeted reads with compact output. Every injected brief tells both engines to write tool payloads larger than one screen to a file outside the repository and print only the path and a one-line digest. Skip status checks that change nothing. Keep child updates to one sentence and reports short; end supervisor reports with duplicated investigation or rework observed.

Keep the system lean. Prefer deletion and one test per observable rule. Do not add tests that restate fixtures, prompt wording, or implementation. Owner ruling, 2026-09-07: the suite runs once per batch, as the lane gate after the report. Workers and reviewers never run it, and you merge on the gate result instead of running your own wall.

For changes to cdx itself, use `--gate "bun run check"`. It builds the CLI and runs only the pure ownership and feed parsing tests. The owner deleted the 135 end-to-end tests after a 226-second run. Keep tests free of spawned processes, sleeps, fake engines, and temporary homes, with the whole test run within about two seconds. Do not restore the end-to-end suite. The build checks syntax and bundling, not TypeScript types.

cdx injects these rules before `config.json` rules and the repository's `.cdx-rules.md`. Gemini children and native subagents must not delegate further. Supervisors must join native subagents before reporting; cdx only tracks cdx children. See [README.md](README.md#two-engines) for the enforced limits and their reasons.

## Commands

```bash
cdx spawn   <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--effort E] [--cd D] [--worktree P] [--bg] [--gate "<cmd>"] [--gate-baseline-check] [--max-runtime MIN] [--add-dir D]... [--schema F] [--image F]... [--account NAME] "<brief>"
cdx resume  <lane> [--effort E] [--bg] [--gate "<cmd>"] [--max-runtime MIN] "<follow-up>"
cdx consult <lane> [--model M] [--effort E] [--cd D] [--bg] [--account NAME] "<question>"
cdx review  <lane> [--engine gpt|gemini] [--model M] [--effort E] [--cd D] [--bg] [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>"]
cdx fork    <new> <lane|sessionId> [--model M] [--effort E] [--bg] [--account NAME] "<brief>"
cdx gate    <lane> ("<cmd>" | --clear)
cdx send    <lane> "<text>"          # steer a running work lane
cdx ask     [--timeout MIN] "<question>"   # inside a lane only
cdx reply   <lane> [--id SEQ] "<answer>"
cdx questions [lane]
cdx wait    <lane|job>... [--timeout SEC] [--json] [--report]   # exit 1 on failure, 2 on an open question
cdx status  [--all] [--json]
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
- `wait` exit 2 means a lane is blocked on a question. Answer it promptly with
  `cdx reply`. An unanswered question times out after 30 minutes. Timeout is
  not approval; the worker reports the unresolved dependency and stops only
  dependent work without guessing, continuing independent authorized work.
- Calling `cdx resume` on an active running lane is refused by the harness;
  wait for the active round to settle before resuming. Failed rounds expose a
  partial report path when no full report exists. `resume` feeds that partial
  back to either engine with an instruction to continue without redoing work.
  Gemini transport errors get five retries with waits of 1 through 5 seconds;
  other errors get no transport retries. Failure notes keep markdown in the file.
- The gate is the verdict. An unchanged tree does not fail a gated round; the
  gate runs and the feed line says `diff=empty` so you can judge. Only
  `--gate-baseline-check` runs the gate on the untouched baseline tree before
  worker startup, including worktrees. A baseline failure stops the round as
  `gate-invalid`.
- Lanes touching the same repository get `--worktree`, or disjoint files in
  one tree with no other writer. Never run a Gemini review against a tree
  another lane is editing; its write protection is detection after the fact.
- Supervisors own only the children they spawned, cannot change a child gate
  through `cdx gate`, `resume --gate`, or respawn (omitting `--gate` on
  supervised respawn preserves the existing gate), and cannot stop your jobs.
  When a supervisor's round ends, its running children are stopped; a supervisor
  that reported while a child ran shows `supervisor ended with running children`.
  `cdx kill <supervisor>` stops the tree.
- A consult lane keeps its name for consults only; spawning work under it is
  refused so its resume stays read-only.
- Events reach only their owning full session id. Another head must run
  `cdx takeover <lane|full-session-id>` before mutating that owner's work.
  A lane target claims that lane and its supervisor children, whoever owned
  them. A session target moves that head's whole group: lanes, jobs, and
  messages. Takeover replays nothing; it prints the owned summary. `adopt`
  over an existing lane needs ownership like any other mutation.
- SessionStart restores owned running and completed work and open questions,
  including after compaction. Close completed lanes when handled. Hooks supply
  quiet updates; the plugin watcher wakes the head for questions and completions.
- With configured accounts, `cdx usage` and launch admission share one decision. Work needs 15% weekly capacity, supervisors 25%, and light turns prefer 5% but can use less; every tier refuses exhausted accounts. Active rounds hold fixed demand against the account during execution: light holds 5%, work holds 15%, and supervisors hold 25%. Admission subtracts active holds from remaining headroom before account selection. Dead runners release their hold during admission while preserving live child holds. Consuming round completion invalidates the account snapshot to force fresh usage probes. Thresholds guide placement; they do not guarantee full completion within quota, and there is no guarantee unknown capacity will finish. `--account` obeys exhaustion eligibility instead of forcing a depleted account. A GPT quota exhaustion failure triggers automatic account failover: cdx starts a fresh round on an available account carrying the brief, round history, and latest report or partial report. If no alternate account is eligible, the lane fails with reset details.
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
Hook and monitor changes need `/reload-plugins` or a restart. Skill edits are live.
Cancel old global-tail monitors or restart their sessions before upgrading.
Version 6 ignores old free-text feed lines; cleanup removes them.

## Browser view

`cdx view [--port N] [--open]` opens a view-only local dashboard at `http://127.0.0.1:7477`. Run it in its own terminal. Ctrl-C stops it. `--open` launches the browser on macOS. Select a lane for live transcripts, rounds, reports, and questions.

The default filter shows running lanes and jobs only. Running, Done, Failed, and All remember the last selection in the browser. All lists running work first, then finished work, each by latest activity. Failed includes invalid gates. Closed and adopted lanes appear only in All. Completed consults appear in Done. Parent names identify children without pulling finished lanes ahead of running work. Expand Feed for recent entries.

Astra/GPT uses violet orbits, Gemini teal scanlines, and jobs amber tickers. Motion shows running state, not progress. Quiet warnings start after five minutes without a lane event. Reduced motion disables animations. The page has no network fonts or runtime dependencies.

The dashboard reads discrete `work` and `review` round records. Version 5 removes flat `state`, `cwd`, and `reviewState` aliases. Keep row elements across SSE updates so one-second polling does not restart animations or drop keyboard focus. Use the active round engine and state for reviews. The work engine can differ. The view omits the model when a review switches engines because the ledger has no model for that review. `/api/state` and lane details expose `engine`, `startedAt`, `lastActivityAt`, `statusGroup`, and lane `stalled`. Job activity includes log modification time. The view never changes ledger state.
