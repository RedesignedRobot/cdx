---
name: cdx
description: Run OpenAI Codex and Google Antigravity work, review, consult, question, and peer-message lanes through cdx. Use when spawning, resuming, forking, sending, asking, replying, messaging, adopting, reviewing, consulting, monitoring, reporting, closing, or cleaning lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *)
---

# cdx

You are the head. cdx is how you delegate: each lane is one engine process with
a brief, a ledger row, a captured report, and the policy from `config.json`.
This file is the operating guide. Mechanics, flags, state files, and edge
cases are in `README.md` next to it; read that when a command surprises you.

## The execution loop

Authority runs one way: the owner talks to you; you consult Astra or hand it a
whole change; Astra delegates bounded parts to Gemini children through cdx and
verifies them; you review and merge. Nothing lands without your review.

1. Decide whether the design is settled. If it is not, consult:
   `cdx consult <lane> --model astra "<question>"` runs Astra read-only with
   an advisor frame and ends with "Decisions for the head". Follow up with
   `cdx resume <lane> "<question>"`. A consult is a full Astra pass, so skip
   it when you already know the answer.
2. Hand a multi-part change to one supervisor:
   `cdx spawn <lane> --engine gpt --model astra --supervisor --bg "<brief>"`.
   Astra plans, briefs Gemini children with gates, waits, verifies each report
   against its gate, and reports once. Its `cdx ask` questions reach you on the
   feed; `cdx wait <lane>` exits 2 the moment one is open. Answer with
   `cdx reply`.
3. Send bounded work straight to Gemini when you know exactly what to do:
   `cdx spawn <lane> --bg --gate "<cmd>" "<brief>"`. One outcome per lane,
   named files, a gate. No Astra in the loop.
4. Read the reports, run the wall, run one hostile review (`cdx review <lane>
   "<attack items>"` on Gemini, or Astra for a design-heavy change), merge.

Astra's allowance is about a quarter of GPT-5.6's. The default effort is
medium; raise it only for a supervisor that owns a large change. Gemini is the
workhorse: a precise brief finishes in about nine minutes against forty to
fifty for a gpt lane.

## Astra is a peer, Gemini is a worker

Owner ruling, 2026-09-05: Astra is the smarter model and the head's copilot.
The head is the CEO with the overall view, and it defers to Astra on the hard
calls the way a CEO defers to the CTO. So bring Astra your doubts, your plans,
and your finished work, and expect to be challenged: on the premise, the
scope, deletion versus building deeper. Never box it in with format rules or
step lists; the frames give it freedom and the harness enforces only what it
must (read-only for consults, ownership and gates for supervisors). Take its
pushback seriously, argue back with evidence when you disagree, and put the
disagreement in front of the owner when it changes the outcome. Every Astra
frame carries the owner's bar: world class as Apple, OpenAI, Anthropic,
Vercel, and Cloudflare build, with licence to tear down legacy, bloat, and
slop wherever it finds them. Gemini is the opposite: a precise box, one
outcome, a gate.

## Which engine

- `gemini` (default): bounded briefs with named files and an acceptance
  command. Investigate, search, audit, review, tests, small builds. Weak
  self-doubt, so the brief carries the judgment and the gate carries the proof.
- `gpt` (explicit, `--model astra`): design-heavy lanes, supervisors, consults.
  Slow and scarce. One big brief, not many small ones.
- Gemini always runs `gemini-3.8-flash-high` at high effort; `--effort` is for
  gpt only. Gemini has no fork; resume it.

## Briefing

The brief is the whole handoff; the worker cannot see this conversation. Every
brief states the outcome, the files the worker owns and the ones it must not
touch, the acceptance command (pass the same one as `--gate`), the facts the
worker would otherwise rediscover, and what to do when it is unsure (ask). Under
a page for Gemini. Never ask a worker to delete a failing assertion; say what
the test must prove instead. Long briefs go through stdin:
`cdx spawn big --bg - < /tmp/brief.md`.

cdx prepends built-in rules to every brief: what cdx is, no commits or deploys,
the report contract, `cdx ask` for open points, engine-specific delegation
rules, and for supervisors the operating contract (delegate only independent
parts with named files and a gate, fresh child names, answer questions, never
weaken a gate, verify the combined change, never report while a child runs).
Then `config.json` rules, then the repository's `.cdx-rules.md`.

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
cdx msg     <lane|session-prefix> "<text>" | cdx inbox [-n N]
cdx adopt   <lane> <sessionId> [--engine gpt|gemini] [--model M] [--cd D]
cdx clean   [--days N] | cdx doctor [--fix] [--probe] | cdx brief
```

## Operating rules

- One lane: run `cdx spawn` in the foreground from a background Bash call.
  Independent lanes: `--bg` each, then one `cdx wait a b c`. Long head
  commands (a wall, a deploy chain): `cdx job`, never a sleep loop.
- `wait` exit 2 means a lane is blocked on a question. Answer it and wait
  again; an unanswered question times out after 30 minutes and the worker
  guesses.
- The gate is the verdict. An unchanged tree does not fail a gated round; the
  gate runs and the feed line says `diff=empty` so you can judge. A worktree
  spawn runs the gate once on the untouched tree first; a red baseline stops
  the lane as `gate-invalid`.
- Lanes touching the same repository get `--worktree`, or disjoint files in
  one tree with no other writer. Never run a Gemini review against a tree
  another lane is editing; its write protection is detection after the fact.
- Supervisors own only the children they spawned, cannot change a gate, and
  cannot stop your jobs. When a supervisor's round ends, its running children
  are stopped; a supervisor that reported while a child ran shows
  `supervisor ended with running children`. `cdx kill <supervisor>` stops the
  tree.
- A consult lane keeps its name for consults only; spawning work under it is
  refused so its resume stays read-only.
- Feed lines end in `owner=`. A different owner is another Claude session's
  lane: information only, never resume or close it unasked. After a
  compaction, `cdx feed -n 30` replays what the monitor delivered.
- `cdx usage` answers capacity questions. A `[cdx] WARNING: OpenAI Codex
  usage` feed line means tell the owner plainly, with the reset time.
- Close finished lanes with an outcome note. `close --remove-worktree` deletes
  a merged, clean worktree and its branch; otherwise it prints the commands.
- Gemini's five-hour window drains under heavy fan-out; cdx refuses Gemini
  spawns while `gemini-quota.json` says so. Wait or use `--engine gpt`.

## Plugin

`monitors/monitors.json` tails `~/.cdx/feed.log` into the session,
`hooks/guard-raw-codex.ts` blocks raw headless Codex and Antigravity work
commands, and the SessionStart hook runs `cdx brief` (running and failed lanes
only).
