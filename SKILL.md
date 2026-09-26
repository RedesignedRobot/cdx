---
name: cdx
description: Run OpenAI Codex, Google Antigravity and Claude panel lanes through cdx. Use when spawning, resuming, sending, asking, replying, messaging, reviewing, consulting, paneling, grading screenshots, landing, reporting, closing, or cleaning lanes from Claude Code.
allowed-tools: Bash(cdx *), Bash(${CLAUDE_SKILL_DIR}/cdx.ts *), mcp__cdx__*
---

# cdx 10.0.1

You are the owner's liaison. cdx is how you delegate: each lane is one engine process with a brief, a row in `~/.cdx/state/cdx.db`, a captured report, and policy from `config.json`. This file is the playbook. Flags, state and edge cases are in `README.md` next to it; read it when a command surprises you.

## The loop

1. Brief one lane with `mcp__cdx__spawn` (contract below) and end your turn. The head never blocks on a lane (owner ruling 2026-09-15): there is no wait tool, and the mod denies `cdx wait`, `cdx status --watch`, `cdx tail -f`, and shell loops or sleep chains that poll cdx.
2. Events arrive as a `[cdx]` prompt when you are idle, or as context on the next tool result mid-turn. Only actionable kinds reach you: question, stalled, terminal, job-exit, message, thrash, overrun, outage, panel. A terminal event is at most five lines: the verdict and report path, then evidence. Open the report with `mcp__cdx__report` only when the digest leaves a decision open.
3. Answer a question with `mcp__cdx__reply`; steer a running lane with `mcp__cdx__send`. An unanswered question times out after 30 minutes, and timeout is not approval.
4. For a consequential change, order one independent review, then `mcp__cdx__land`.

Call cdx through the native `mcp__cdx__*` tools; the mod denies a shell `cdx <subcommand>` that has one (owner ruling 2026-09-17). Commands without a tool (brief, clean, feed, log, migrate, context, shots) run as `bun /Users/mas/code/cdx/cdx.ts ...`, and every Bash call starts with an absolute `cd`. `spawn`, `consult`, `review` and `panel` require `cd`, the absolute repository path.

The head is the session, among those that polled within 30 s, that most recently drove cdx (spawn, resume, send, review, consult, reply, land, or `cdx brief --head`). The mod claims the head when you start an interactive session, so a fresh session takes the wakes from an older idle one; a headless `claude -p` never claims by starting, and with no driver events wait. Other sessions get only messages addressed to their full session id and read the rest with `cdx feed`. After the second compaction the mod blocks the next Stop once, after the settings Stop hooks ran: update the run's `BATCH.md`, push the owner "roll session", end the turn.

## Routing

- Sol direct is the default in every repo. A change with named files and a gate is one Sol work lane: `mcp__cdx__spawn` without `supervisor`.
- A supervisor (Astra) is only for declared fan-out: `supervisor: true` requires two or more child file sets under `## Children`. One file set is a Sol lane.
- Gemini is for read-only work: consults, reviews, pre-reads and crawls. A Gemini work lane runs with a warning; do not brief one.
- Head-launched reviews, consults and supervisors run Astra (`thinkerModel`). A child never runs Astra. `model: "astra"` or `"sol"` overrides. Caps: Astra medium, Sol high; Gemini always runs high.
- Design choices and ship calls go to `mcp__cdx__panel`, not a single consult.
- `mcp__cdx__usage` with `totals` shows, per engine role and repo, how many lanes went green on round 1 and landed. Check it before changing a routing habit.

## Brief contract

cdx refuses a work spawn (a respawn too; resume, consult and review are exempt) unless the brief has four nonempty sections, at any heading level, and a gate from `gate` or the repo's `.cdx-gate`:

- `## Outcome`: what must be true when the lane is done.
- `## Files`: the files the lane owns.
- `## Acceptance`: the assertion that separates success from a plausible wrong answer.
- `## Out of scope`: what the lane must not do or touch.

The spawn tool takes `outcome`, `files`, `acceptance`, `outOfScope` and `children` as fields and renders them as sections ahead of `brief`. The refusal names every missing piece in one line; fix them together. A no-op gate (`true`, `:`, `exit 0`, a bare `echo`) is refused when the repo has `.cdx-gate`.

`scopePolicy` decides what a lane does when the outcome needs a file outside `## Files`:

- `extend` (default): the lane edits it and lists it under `## Scope extensions` in its report; the gate receipt records the list as `scopeExtensions`. Read that list before landing.
- `stop`: the lane names the file and the reason and ends the round. Use it where a stray edit costs more than a round.
- `ask`: the lane asks you.

Under extend and stop, cdx answers "may I edit outside my files" questions itself and does not wake you.

Keep a brief under a page: the consumer, the facts the lane would otherwise rediscover, and the decisions still open. Send evidence, not transcripts or keystrokes. Standing lane rules live in each role's lane home and the repo's context digest, so point at repo docs instead of pasting them. The brief and your replies outrank project and skill guidance; a lane blocked by a file must quote the conflicting instruction.

A verification brief also names the candidate, the item IDs under test, a success or refusal obligation per item, one observable assertion per item, the closed findings that could reopen, and an owned evidence directory. A pass needs a fresh attempt with a captured result. A refusal under a success obligation is a failure, never a pass. Read the actual result body before accepting a pass.

## Context digest

`cdx context <repo>` starts job `context-<repo>-<commit>-job` and returns; end your turn and read the digest path from the end of the job-exit log. A digest already current for HEAD prints inline. The job writes `.cdx/context/<HEAD>.md` in the repo's main checkout with one read-only Sol consult: repo map, commands, gate, and rule pointers as `path#anchor`, under 6,000 chars. Every lane brief points at the digest for HEAD or one of the last 20 commits, plus `.cdx-rules.md` when present. Run it before the first batch in a repo that has no digest near HEAD; an existing digest for HEAD is reused.

## Review and land

- Review is optional. Once a lane was reviewed, the newest review of its current or gated tree decides: open P1/P2 findings refuse land. Proof binds to the tree, not the name, so a review under any lane name counts and `resume` with `fix: "review"` works after it.
- One review per consequential diff. P3-only findings close the loop. A clean review is a result; only a changed commit or a failed review justifies another. The reviewer reads the recorded gate result and never runs the suite.
- `mcp__cdx__land` commits the lane, builds the merge with the base, and gates the merge commit once in a frozen snapshot, or skips the gate when the merge tree equals the lane's green receipt. Your edits after the gate are fine; land re-proves instead of refusing. It then advances the base, pushes to its upstream, removes the worktree and branch, and closes the lane. A land that must gate returns at once as job `land-<lane>`: end your turn, and its `job-exit` event carries the land result or refusal. A receipt-proven land finishes inline. While the land job runs, close, review, resume and a second land refuse its lanes.
- Several green lanes on one repo and base land with `lanes: [...]` (`cdx land --batch a b c`): one gate, one push. A red batch bisects, lands the green prefix, and names the lane that broke it. Two lanes that each change a lockfile cannot share one batch.
- A dirty base checkout blocks only when its dirty files overlap the merge. You resolve merge conflicts in the base checkout.

## Supervisors

- A supervisor spawns Sol children, or Gemini for read-only helpers. Each writer child gets its own worktree off the supervisor's branch, and the supervisor merges green children into its own branch with `cdx land <child>`. You land the supervisor lane.
- Supervisors call `cdx` plainly: no pipe, redirect, env prefix, `$(...)` or wildcard, and every brief, gate and question in single quotes with no apostrophes, because only a plain `cdx` call runs outside their sandbox. They never run git writes; cdx does. Do not brief a supervisor to do otherwise.
- A supervisor reviews child trees with git and file reads, because its sandbox cannot open a child's codegraph index.
- Child events go to the supervisor, never to you. `mcp__cdx__kill` on a supervisor stops its tree.

## Panel

`mcp__cdx__panel` (`name`, `question`, `cd`, optional `pack`) asks Astra, Sol and Claude Fable the same read-only question. It always runs detached. cdx merges the answers into `reports/panels/<name>/panel.md` (under 60 lines: recommendations, dissent, claims grouped by cited path with agreement counts, a `!` on citations that do not exist) and adds an Astra verdict on the contradictions when two or more members answered. One `panel` event wakes you. Put shared context in the pack; question plus pack must stay under 20,000 chars. One open panel at a time, 15 minutes per member. cdx refuses the panel when Astra's best account or the active Claude account's tightest weekly window is under 10%, when `cca status --json` cannot say, or when the name is taken by a panel, lane or job. Read the merged report, not the member reports.

## Screenshots

Before you look at any screenshot, run `cdx shots grade <dir> --rubric <file>`. It starts job `shots-<dir>` and returns; end your turn. Sol grades the shots in batches of 8 with images attached and writes `<dir>/verdict.json`; the job's `job-exit` event is the one wake. Open only the failed screens. `--downscale` writes 1000 px copies of failed shots to `<dir>/downscaled/`. A screen the grader skipped counts as failed.

## What lanes can do

- Work lanes write only their cwd, `addDirs`, /tmp and cdx state. `.git` is read-only, so lanes cannot commit. A lane that must write elsewhere needs the directory in `addDirs`.
- Reviews and consults cannot write the checkout; they write only TMPDIR and the codegraph index. Anything they produce comes back in the report.
- Shell output over 4 KB reaches the model as the first 2 KB and last 1.5 KB plus a spill-file path. Lanes have no MCP servers; codegraph runs through the shell with a 60 s deadline, and a worktree lane queries its primary checkout's index with `-p`. Reviews and consults use codegraph too. Chromium in a lane needs `--single-process`, which work lane rules state.

## Gates and lifecycle

- `.cdx-gate` in the primary checkout holds the repo's mandatory check. Parent lanes run it plus their lane gate; children run only their lane gate. Gates must leave source bytes unchanged. For cdx itself the gate is `bun run check`.
- The gate runs the suite once per batch (owner ruling 2026-09-07). Workers and reviewers do not run it, and you merge on the gate result instead of running your own wall. A red gate gets one automatic repair turn; do not intervene while it runs.
- Resume only with `fix: "gate"` or `"review"`, for failed evidence at the same HEAD. New scope is a fresh lane seeded from the report.
- Long commands go to `mcp__cdx__job` with `cd`; end the turn and read the verdict from the completion event.
- Worktree setup (`worktreeSetup`, `.cdx-worktree-setup`) runs in the lane's runner; a failure fails the round and names `logs/<lane>-r<n>.setup.log`.
- Close each handled lane with `mcp__cdx__close` and a note. Close removes a clean worktree and keeps an unmerged branch; a dirty worktree refuses unless `keepWorktree`. `cdx doctor --fix` removes cdx worktrees idle over 7 days and keeps one holding ignored files (a `.env`) the primary checkout lacks.
- Name one release candidate, one gate result, and any later change that invalidates it. No writer touches the candidate during its proof run, and a cancelled run is never green. Production actions end at the owner.

## Cutover from 9.x

1. Stop every lane and job. A 9.x runner left running writes `ledger.json`, which 10.0 never reads.
2. Install 10.0: pull, run `cdx doctor --fix` to render the role lane homes, reload the plugin. Remove `visibility.heartbeatMinutes` and `visibility.fileEdits` from `config.json`; 10.0 refuses them.
3. Run `cdx migrate` once. It imports lanes, events, jobs and questions into `state/cdx.db` and moves the old files to `state/legacy/`. Until it runs, `cdx status` prints a hint and `cdx doctor` warns.
4. Restart every open Claude Code session, or run `/reload-plugins` in each, before the first spawn. A session that still holds the 9.x mod calls the removed takeover tool, sends the old spawn schema that 10.0 refuses, polls with the 9.x cursor, and runs land with a 120 s timeout that kills it mid-merge.

## Commands

```bash
cdx spawn   <lane> [--engine gpt|gemini] [--model M] [--supervisor] [--scope-policy ask|extend|stop] [--cd D] [--worktree P] [--bg] [--gate CMD] [--pre CMD] [--add-dir D]... [--image F]... ("<brief>" | -)
cdx resume  <lane> --fix gate|review [--effort E] [--bg] ("<fix instructions>" | -)
cdx review  <lane> [--engine gpt|gemini] [--model M] [--cd D] [--bg] [--image F]... [--uncommitted | --base B | --commit SHA] [--scope "<files>"] ["<intent>" | -]
cdx consult <lane> [--engine gpt|gemini] [--supervisor] [--model M] [--cd D] [--bg] [--image F]... ("<question>" | -)
cdx panel   <name> --cd D [--pack F] ("<question>" | -)
cdx context <repo> [--model M]
cdx shots grade <dir> --rubric F [--engine gpt|gemini] [--model M] [--downscale]
cdx land    <lane> | cdx land --batch <lane>...
cdx ask     --cd /repo "<question>"        # synchronous read-only Gemini answer, no lane
cdx reply   <lane> [--id SEQ] ("<answer>" | -) | cdx questions [lane] | cdx send <lane> ("<text>" | -)
cdx msg     <lane|full-session-id> ("<text>" | -) | cdx inbox [-n N]
cdx status  [--all] [--json | --brief | --line] | cdx report <lane> [round] | cdx gate-receipt <lane> [--json]
cdx job     <name> --cd D ("<cmd>" | -) | cdx kill <lane|job> | cdx close <lane> [--keep-worktree] ["note"]
cdx usage   [--json] [--totals] | cdx doctor [--fix] [--probe] [--days N] | cdx clean [--days N] | cdx migrate | cdx brief
```

If `cdx doctor` fails `codex models`, run `codex update`, then `codex debug models`.
