# cdx terminal design

`CDX_TUI=1` enables the terminal renderer on a TTY. Pipes, JSON, and one-line machine output keep their existing formats. `TERM=dumb` uses the existing renderer. Detection uses `isatty(1)` before touching stdout because Bun can change its blocking mode when the stream is opened.

The portal references are `docs/portal-programme/design-direction.md`, `packages/ui/src/styles/globals.css`, and the ArchitectMark paths in `/Users/mas/code/hyperscale-portals`. The palette lives in `tui-theme.ts`. Black, grey, and white carry the content. Blue marks the selected lane or the usage window projected to exhaust first. States remain words. No status pills, background fills, or outer table borders.

## Views

- `cdx status` retains the lane tree, owner, report, question, and progress details.
- `cdx lanes` opens the live lane table. `cdx status --watch` uses the same view. Columns show the full lane name, round, state, last action, changed file count, and gate state. The file count describes the current working tree, not edits attributed to one lane. A question mark means the count was unavailable. Closed lanes are omitted. Running jobs appear below the table.
- `cdx wait <lane|job>...` shows recent log lines and progress until completion, a question, a dead runner, or timeout. Existing completion output, report output, and exit codes follow the live view. Quitting the view leaves work running.
- `cdx tail -f [lane|job] [-n N]` follows logs with a bounded pane. Without a target it follows running lanes. Lane and job names remain the target identities. The job-name extension applies only to the terminal renderer, so existing pipe behavior does not change.
- `cdx usage` keeps the existing provider probes and projections. One shared table renderer handles both the legacy layout and terminal layout. The first projected exhaustion gets blue text. Unknown burn and exhaustion remain unknown. This remains a one-shot command.
- `cdx events` renders the owned event batch. `cdx events --watch` displays the last 100 owned events, including recorded timestamps. `--peek` leaves the delivery cursor unchanged. The cursor advances after a frame is written. Watch requires the terminal renderer and rejects JSON.

`status --json`, `status --line`, and `status --brief` remain machine views. In terminal mode `status --watch --brief` uses the live lane table. Pipes preserve the previous watch path too.

## Layout and input

`tui.ts` owns terminal detection, sanitization, wrapping, the shared table, frames, keyboard input, and pager cleanup. There is no terminal UI dependency. Lane names wrap instead of shortening. Usage rows become label/value blocks if the columns do not fit. A live table starts at the selected row and fits subsequent rows to the available height. An exceptionally long single row can exceed the terminal height because its fields are never silently cut.

In a live view, `q` quits, `j/k` and arrows select lanes or scroll logs, and Enter opens the selected lane report through `$PAGER`. With no pager, it prints the path and exits the view so the next redraw cannot erase it. Log views use the first target's report, or the job log. No report path means Enter has no action.

The pager runs with cooked stdin. The view restores raw mode after it returns and restores the original mode when it exits, receives a signal, or fails. `$PAGER` is a trusted shell command; the report path is a separate argument. Under `NO_COLOR`, Enter prints the path because an external pager could emit controls.

Redraws use the current terminal width. Unchanged frames produce no output. `NO_COLOR` disables every renderer escape, including clear-screen controls, images, and animation. Changed frames then append as plain text. The terminal `wait --report` path also strips report controls and wraps lines; JSON and pipes keep the authored bytes.

## Prism and motion

Production terminal frames use a small text mark.

## Gate witnesses

`tui.test.ts` contains ANSI-stripped snapshots for status, lanes, wait, tail, usage, and events at 80 and 120 columns. Separate rules cover narrow layouts, keyboard actions, `NO_COLOR`, and byte-identical non-TTY commands. Compatibility tests use temporary state and finished work, without engines or provider probes. The usage compatibility witness calls its real formatter directly.

The lane did not run tests, typechecks, builds, terminal captures, or a wall. The gate must run `bun test`. `package.json` has no `typecheck` script. Its `check` script includes TypeScript, a build, and the suite, so do not run both `check` and `bun test` as duplicate suite runs.

API references were read through Context7 `/nodejs/node` for keypress/raw-mode handling and `/oven-sh/bun` for child processes and snapshots.
