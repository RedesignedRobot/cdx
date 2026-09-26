# CLI modules

`cdx.ts` owns startup and re-exports the existing public functions. Tests and external callers can keep importing it. Internal modules import their dependencies directly. Do not import the entrypoint from an internal module.

| File | Responsibility |
| --- | --- |
| `safe-text.ts` | Shared secret redaction for storage and presentation |
| `runtime.ts` | Process paths, child environments, argument parsing, errors, and text formatting |
| `config.ts` | Config parsing, engine and model selection, effort caps, and round limits |
| `store.ts` | The SQLite state database: schema, WAL, busy timeout, and `BEGIN IMMEDIATE` writes |
| `ledger.ts` | Lane and round types, active and archived lane reads, sessions, and event storage and delivery |
| `migrate.ts` | One-shot import of the 9.x JSON state into `state/cdx.db` |
| `usage-store.ts` | Usage snapshots, exhaustion markers, history, and burn projections |
| `accounts.ts` | Codex probes, account selection, holds, demand sizing, and reset credits |
| `gemini-usage.ts` | Gemini usage probes, burn projection and quota admission |
| `engines.ts` | Protocol helpers, token accounting, Gemini retry and report policy, and recovery prompts |
| `rounds.ts` | Account admission and round reservation under the database write lock |
| `runner.ts` | Engine processes, event handling, account failover, gates, and finalization |
| `round-state.ts` | Failure reconciliation and lane or child termination |
| `gates.ts` | Gate execution, receipts, review snapshots, and gate commands |
| `worktrees.ts` | Worktree creation, receipt-bound landing and cleanup |
| `reports.ts` | Captured reports, recovery partials, JSONL framing, and log readers |
| `questions.ts` | Questions, steering, peer messages, and Gemini hook delivery |
| `prompts.ts` | Injected rules, review frames, and resume prompts |
| `jobs.ts` | Detached shell jobs and their lifecycle |
| `session-commands.ts` | Event delivery, overrun notices, and session briefs |
| `lane-commands.ts` | Launch, spawn, resume, review, consult, and cleanup |
| `sandbox.ts` | Codex sandbox policy and the sandbox-exec profile from one set of writable roots |
| `cap.ts` | The shell output cap and spill file |
| `context.ts` | `cdx context` digests and the brief's pointer to them |
| `shots.ts` | `cdx shots grade` batches and `verdict.json` |
| `status.ts` | Status, wait, and usage presentation |
| `outcomes.ts` | First-round-green-landed totals per engine role and repository |
| `brief-contract.ts` | Work brief contract, scope policy, and the scope question classifier |
| `doctor.ts` | Engine installation, configuration checks, and diagnostic probes |
| `commands.ts` | Help text, command restrictions, and dispatch |

The runner keeps its shared GPT and Gemini event state in one function. Launch commands call it, but it never imports those commands. Account admission can reconcile a failed round without importing the runner. Shared usage storage sits below both admission and failure reconciliation. Type-only imports carry lane contracts without runtime import cycles.

`runtime.ts` resolves `SELF` to the source entrypoint or the executing bundle. `config.ts` compares that path with `Bun.main` so CLI invocations read config while test imports retain defaults. Keep initialization free of probes and state writes. Directory creation and dispatch remain guarded by `import.meta.main` in `cdx.ts`.

Every process opens `state/cdx.db` directly; there is no daemon. Lanes are JSON blobs in the `lanes` and `archive` tables, so a new lane field needs no schema change. `migrate.ts` is the only reader of the 9.x files.

`hooks/register.ts` invokes `bun <pluginRoot>/cdx.ts`; it does not import these Bun modules. The package gate remains `bun run check`, including the single-file `bun build cdx.ts --target=bun` bundle. The lane gate runs it after the worker report.

`hooks/tools.ts` bounds native results at 20 KB and requires retention of the full safe text; `hooks/register.ts` writes it under the cdx logs directory. Directory fallback occurs before launch on a missing cwd, never after an execution error. Gemini transcript measurements belong to `roundTools`; the pre-tool hook denies successful unchanged covered reads before execution. Gate diagnostics retain the first fatal line and its typed cause. A gate rejects changes to its owned paths. A red exit gets one same-conversation repair and one rerun; a moving tree gets neither.

`account-sync.ts` creates one isolated lane home per role (`cdx-lane`, `cdx-supervisor`, `cdx-review`, `cdx-review-supervisor`) with the rendered AGENTS.md and the output-cap hook; the supervisor home adds the exec-policy rule that lets plain `cdx` calls leave the sandbox. `appThreadParams` owns context overrides and work-only token limits. Every GPT round uses app-server.

`rounds.ts` reserves review snapshots and queued Gemini starts under the database write lock. `questions.ts` owns invocation counts, quota handoff and unchanged-read denial. `ledger.ts` routes child terminals to supervisor controls as the same five-line digest the head gets. `jobs.ts` records both tree fingerprints. `worktrees.ts` records commit progress before push and cleanup so landing can resume after an interruption.
