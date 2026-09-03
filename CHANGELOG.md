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
