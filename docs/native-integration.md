# cdx 7.0: native Claude Code integration

Design contract for the 7.0 rebuild. Two lanes implement it against disjoint files; this file is the shared truth. Written 2026-09-15 from the Claude Mods documentation (function hooks, Claude Code 2.1.270 behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).

## Why

Every link between cdx and the head session was text squeezed through side channels: three classic hooks running `cdx _session`, a separate `cdx watch` monitor process with leases, head-pid receipts and `/clear` following, a regex guard over Bash strings, and Bash calls for every cdx command. Function hooks run inside the Claude Code process with the real session id, a status-line slot, toasts, timers, a command registry, a tool registry and prompt context. The rebuild deletes the side channels and makes cdx a first-party tool set for the head.

## Two halves, one boundary

- `cdx.ts` stays the engine-agnostic CLI. Codex (Astra) and Antigravity (Gemini) lanes run it from their own harnesses through `cdx spawn`, `cdx ask`, `cdx wait` and the rest. Nothing Claude-specific lives in cdx.ts beyond the session id it already reads from `CLAUDE_CODE_SESSION_ID`.
- `hooks/register.ts` is the Claude Code mod. It runs in Claude Code's own runtime, may only touch the world through `$`, and cannot import cdx.ts (Bun-native). It shells to `bun <pluginRoot>/cdx.ts ...` through `$.process.run` and stays a thin delivery and presentation layer. It may import pure repo modules that use no Bun or Node API (`guard.ts`).

The plugin name is `cdx`, so registered tools are `mcp__cdx__<name>`.

## Contract A: the CLI (lane `cli`, files `cdx.ts`, `cdx.test.ts`, `package.json`)

### Remove

- `cdx watch`, `cdx _session`, `watchCommand`, `sessionCommand`, every `CLAUDE_PID` read.
- `SessionState.heads`, `SessionDelivery.wake`, `.quiet`, `.lease`, `.plugin` (hook receipts). Replace with `SessionDelivery = { cursor: number; polledAt?: string; digestAt?: string; progress?: ProgressSample[] }`.
- Doctor checks for the watcher lease, hook receipts, `monitors/monitors.json`, and the classic hook entries.
- `cdx clean` pruning of head receipts.
- Help text and command list entries for `watch` and `_session`.

Keep `takeover`, `msg`, `inbox`, `brief`, `view`, `status --brief`, `status --watch`, the feed, `WAKE_EVENTS` as the wake classification, `sessionSummary`, `sessionProgress`, and everything lane-side.

### Add `cdx events [--json] [--peek]`

For the caller session (`callerSession()`): every owned feed event with `id > cursor`, then the cursor advances to the last record id read (not with `--peek`). Records `polledAt` on the session each call. When the heartbeat is due (`heartbeatDue(now, digestAt, visibility.heartbeatMinutes)`) and owned work is running, a `progress` event is generated for this call the way `watchCommand` did, with the previous samples kept on the session record; that event is emitted inline and also appended to the feed. Config is read the tolerant way `watch` read it (defaults on a bad config, never a crash).

JSON output, one object:

```json
{ "session": "<id>", "events": [ { "id": 12, "kind": "question", "wake": true, "text": "<renderEvent output>", "lane": "search-fix", "round": 2 } ] }
```

Fields: `id`, `kind`, `wake` (`WAKE_EVENTS.has(kind)`), `text`, and any of `lane`, `round`, `job`, `from`, `recipient` present on the record. Text mode prints `text` lines, nothing when empty. Exit 0 always, including an empty list. A `terminal` session id fails: "cdx events needs a Claude session".

### Add `cdx status --line`

One line for the status slot, at most 100 characters, empty output when the caller owns no running lane, job or open question. Shape:

```
cdx 2 lanes · search-fix gate 3m · api-docs working 12m · 1 question
```

Owned running lanes first (name, stage word, age since `lastActionAt ?? lastEventAt`), then owned running jobs as `job <name> <age>`, then `<n> question(s)` when any owned current-round question is open, then a Gemini quota block as `gemini blocked <m>m` when present. Cut the middle items before the counts. Pure function `statusLine(...)` exported and tested beside `statusBrief`.

### Free text from stdin everywhere

Every command taking free text accepts `-` as that argument to read stdin: `spawn` and `job` already do; add `resume`, `consult`, `review` (intent), `send`, `reply`, `msg`. A `-` with empty stdin fails with the command's usage line.

### Doctor

Replace the removed checks with three: the personal plugin path `~/.claude/skills/cdx` resolves to this repo; `hooks/hooks.json` names `modules: ["./register.ts"]` and has no classic entries; and the calling session's `polledAt` is within 15 seconds ("plugin: mod live, last poll <n>s ago"), else warn "plugin: mod not polling; set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in ~/.claude/settings.json env and /reload-plugins". Also warn when neither the process environment nor `~/.claude/settings.json` `env` sets the flag.

### Version

`VERSION` in cdx.ts and `package.json` become `7.0.0`. Do not touch `hooks/`, `monitors/`, `.claude-plugin/`, README, SKILL or CHANGELOG.

### Tests

Update the `state` fixture in cdx.test.ts (no `heads`). Add one test per observable rule: events selection and cursor advance as a pure function over records, `statusLine` shape and cut, and the `-` stdin refusal text. No spawned processes, sleeps or temporary homes.

## Contract B: the mod (lane `mod`, files `hooks/**`, `.claude-plugin/plugin.json`, `monitors/`, `tsconfig.json`, `package.json` check script only)

### Layout

- `hooks/hooks.json`: `{ "description": "...", "modules": ["./register.ts"] }`. No classic entries. Delete `hooks/guard-raw-codex.ts` and `monitors/`.
- `hooks/register.ts`: `export function register(on: On)`; glue only.
- `hooks/tools.ts`: the tool table. `hooks/delivery.ts`: the pending-event buffer and its drain rules. `hooks/argv.ts` if the argv builder wants its own file. Pure modules, no `$` inside, unit-tested with `bun test` (`hooks/*.test.ts`). Do not import `bun:*` or `node:*` in any hooks module except the test files.
- `hooks/types/claude-code.d.ts`: vendored declarations (already present). `hooks/tsconfig.json` mirrors the upstream mods tsconfig (`types: []`, `lib: ["es2023"]`, strict, `include: ["*.ts", "types"]`, exclude the test files). `package.json` `check` gains `tsc -p hooks --noEmit`.
- `.claude-plugin/plugin.json` version `7.0.0`, description updated.

Reference material outside the repo: `/tmp/cdx-mods-reference/mods` (Anthropic's three built-in mods: `diff/hooks/register.ts` shows command registration, a clock poll, `$.process.run`, `$.ui.status`, `command.run` for `/clear` and `/resume`; `telemetry` shows the smallest module), `/tmp/cdx-mods-reference/function-hooks-architecture.txt` (the architecture paper), `/tmp/cdx-mods-reference/cheatsheet.png`.

### Binding

On `session.start`: `session = await $.session.id()`; `root = $.plugin.root`; `CDX = [\"bun\", \`${root}/cdx.ts\`]`. Register every tool in the table, then `/lanes` with `$.command.register({ name: "lanes", ... })` inside a try/catch: Claude Code refuses the name `cdx` because `/cdx` is the user's skill, and a refused command must never stop the tools and the poll. Start `$.clock.every(2000, poll)`. Run `cdx brief`; a non-empty result goes to `$.ui.log` (when `e.surface` is not null) and into the pending buffer as one quiet entry so the first prompt carries it. Then `next(e)`.

Every `$.process.run` on cdx passes `env: { CLAUDE_CODE_SESSION_ID: session }` and `cwd: root`.

On `command.run` of `clear` or `resume`, after `next`: re-read the session id, clear the buffer, clear the status line, run `cdx brief` again as at start.

### Delivery

`poll` (skipped while a previous poll is in flight): `cdx events --json` appends to the buffer. Every fifth poll also runs `cdx status --line` and sets `$.ui.status(line || undefined)`. For each new event with `wake: true`, `$.ui.toast(text, { timeoutMs: 8000 })` when a surface exists. When no turn is running and the buffer holds at least one wake event, drain the whole buffer into one `$.prompt.submit({ text })` whose text starts with `[cdx]` and joins the event texts with newlines.

`turn.start` and `turn.complete` track whether a turn is running.

`tool.call` (no matcher), after `next(e)`: when the result is not a deny, `e.agentId` is unset and the buffer is non-empty, return `{ ...result, context: [...(result.context ?? []), drained] }` where `drained` is the buffer joined with newlines under a first line `[cdx] events`. Subagent calls never drain.

`prompt.submit`, on the way down, for any origin other than this plugin's own: attach the drained buffer as one context entry the same way.

The drain rules live in `hooks/delivery.ts` as pure functions over `{ pending, inTurn }` so they are testable: `afterPoll(state, events) -> { state, toasts, submit? }`, `afterToolCall(state) -> { state, context? }`, `onPromptSubmit(state) -> { state, context? }`.

### Guard

`on("tool.call", { tool: "Bash" }, ...)`: `invokedRawEngine(e.command)` from `../guard.ts`; on a hit return `{ deny: rawEngineRefusal(engine) }`, else `next(e)`. Register it before the generic drain hook so the deny never carries context.

### `/lanes`

`command.run` of `lanes` (the name `cdx` belongs to the user skill): no args runs `cdx status`; args are split on whitespace and passed through. Reply `{ text }` with stdout, or stderr on a non-zero exit. Never `next(e)`.

### Tools

Table-driven: `{ name, description, inputSchema, run(input) -> { argv, stdin?, timeoutMs? } }`. One `tool.call` hook with the matcher `{ tool: [...names.map(n => \`mcp__cdx__${n}\`)] }` dispatches by name, runs the process, and returns `{ result: text }` where `text` is stdout, followed by stderr and `exit <code>` when the exit is non-zero. Never `next(e)` for an own tool. Free text always travels as stdin with `-` in argv, never quoted into argv.

| name | required | optional | argv |
| --- | --- | --- | --- |
| spawn | lane, brief | engine, model, supervisor, cd, worktree, gate, pre, effort, maxRuntime, account, addDirs[], schema, images[] | `spawn <lane> [flags] --bg -` |
| resume | lane, followUp | effort, gate, pre, maxRuntime | `resume <lane> [flags] --bg -` |
| consult | lane, question | engine, supervisor, model, effort, cd, account | `consult <lane> [flags] --bg -` |
| review | lane | engine, model, effort, cd, uncommitted, base, commit, scope, intent | `review <lane> [flags] --bg [-]` |
| events | | | `events --json`; the mod answers with its own buffer first, then the feed, and empties the buffer |
| send | lane, text | | `send <lane> -` |
| reply | lane, answer | id | `reply <lane> [--id N] -` |
| questions | | lane | `questions [lane]` |
| status | | all | `status [--all]` |
| report | lane | | `report <lane>` |
| tail | lane | lines | `tail <lane> [-n N]` |
| close | lane | note | `close <lane> [-]` |
| kill | lane | | `kill <lane>` |
| gate | lane | cmd, clear | `gate <lane> (<cmd> \| --clear)` |
| job | name, cmd | cd | `job <name> [--cd D] -` |
| msg | target, text | | `msg <target> -` |
| inbox | | lines | `inbox [-n N]` |
| usage | | | `usage` |
| takeover | target | | `takeover <target>` |
| doctor | | fix, probe | `doctor [--fix] [--probe]` |

Descriptions tell the model what the command does and when to use it in one or two sentences; `spawn`'s says the brief is delivered whole through stdin so quotes and newlines are safe, and that completion arrives as a `[cdx]` event.

### Never block

Owner ruling, 2026-09-15: the head never blocks on a lane. There is no `wait` tool in the mod. The head spawns, keeps working or ends its turn, and the mod wakes it: a wake event becomes a `[cdx]` prompt when the session is idle and rides the next tool result as context while a turn runs. `events` and `status` are the check-in tools when the head wants to look. `cdx wait` stays in the CLI for Astra, Gemini and people at a terminal.

### Headless

`e.surface === null` at `session.start` means no UI: skip `ui.log`, `ui.toast` and `ui.status`, keep polling, context and `prompt.submit`.

### Tests

One test per rule in `hooks/delivery.test.ts` and `hooks/tools.test.ts`: wake drains only when idle, quiet stays for the next tool result, subagent calls never drain, argv for spawn puts the brief on stdin with `-`, no tool argv contains `wait`, non-zero exits append stderr and the code. Run under `bun test`; no processes, no sleeps.

## Integration order

1. Lane `cli` and lane `mod` run in parallel on worktrees off `main`, gate `bun run check`.
2. The head merges `cli` first, then `mod`, then a docs lane rewrites README, SKILL.md and CHANGELOG for 7.0.0.
3. One read-only Gemini review of the merged diff.
4. The head sets `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in `~/.claude/settings.json` env, restarts a session with `claude --plugin-dir ~/code/cdx`, and checks `cdx doctor` reports the mod live.

## Open risks, verified live after the merge

- Hook budget: the cheat sheet says a hook that overruns 10 s is skipped. Every own tool runs a short cdx command (`--bg` launches return at once), so no tool call should approach it; `doctor --probe` is the longest and gets `timeoutMs` 120000.
- `$.session.id()` must equal the `CLAUDE_CODE_SESSION_ID` the Bash tool exports, or Bash-launched lanes and mod-launched lanes would have different owners. Doctor's `polledAt` check proves it either way.
- The API is early access and may change; `hooks/types/claude-code.d.ts` names the Claude Code version it came from on its first line.
