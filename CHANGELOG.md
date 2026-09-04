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
