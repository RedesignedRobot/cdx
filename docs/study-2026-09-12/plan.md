# Ranked cdx and head-process plan

Approve the acceptance checklist first, then the small runtime changes below. Keep Gemini reviews. Do not replace cdx, add another wall cache, or build a general telemetry service. The evidence and complete inventories are in [study.md](study.md).

The source remains unchanged. Every runtime proposal modifies the existing `/Users/mas/code/cdx/cdx.ts` and adds only a regression assertion for a real rule in `/Users/mas/code/cdx/cdx.test.ts`. Head-process rules belong in `/Users/mas/code/cdx/SKILL.md`; command behavior belongs in `/Users/mas/code/cdx/README.md`. No Arc or QA implementation is included in these lanes.

## Savings model

A release cycle here means one candidate preparation, lane execution/review, and wall/train sequence. Concurrent lane-minutes measure purchased execution, not owner waiting time. Recent retest estimates divide measured rework by four observed recent releases, 32–35. Historical retry and job estimates divide by ten release labels, 26–35; these are partial-window labels, not ten equally observed complete releases. Estimates assume the next cycles resemble this sample.

I/O below means recorded input plus output counters. It is not billable-token equivalence. GPT input includes cache; Gemini input excludes separately reported cache reads. No dollar saving is asserted. Rows overlap, so do not add them into a total forecast. The acceptance row is the strongest measured opportunity. Rows with no demonstrated saving say zero rather than inventing a return.

| Rank | Change | Conditional saving per release cycle | Risk |
| --- | --- | --- | --- |
| 1 | Require current evidence that satisfies the exact obligation | At 50% prevention of observed recent rework: 14.5 lane-min and 1.56M I/O tokens | Checklist becomes boilerplate; semantic errors still need a reader |
| 2 | Prepare gate prerequisites and immutable evidence before workers | No proven whole-round saving; scenario preventing one 5-minute recovery in five cycles: 1 lane-min and about 80k Gemini I/O tokens | Changing shell semantics or hiding a real gate failure |
| 3 | Forbid child Astra and permit read-only Gemini consult helpers | Zero demonstrated saving; prospective replacement cost must be measured | A default-model guard can be bypassed by aliases, resume, or native helpers |
| 4 | Correct thread usage and retain every round start | Zero real token saving; removes 10.73M falsely attributed input tokens in this snapshot | Double-counting a restored baseline or dropping legitimate child usage |
| 5 | Stop repeating an unchanged transport failure | Observed retries 2–5 expose at most 1.32 lane-min and 113k I/O tokens per historical cycle; 50% eligible prevention gives 0.66 min and 56k | A cap may stop a recoverable stream; careless replay may repeat mutations |
| 6 | Clear obsolete quota advice using fresh window evidence | Zero demonstrated time/token saving; restores a coherent decision for codex-2 | Clearing a real, newer exhaustion or a different active quota window |
| 7 | Freeze preparation before the existing wall/train | At 50% prevention of two identified tree-state failures: 0.70 job-min per historical cycle; job tokens unavailable | Skipping proof after a real change |
| 8 | Shorten briefs by removing repetition and keep one meaningful review | Zero quantified saving until a comparable workload is measured | Dropping a task-specific assertion while cutting prose |

Rank reflects demonstrated rework, policy requirements, and measurement dependencies. Implement rank 4 before using engine cost numbers to judge rank 3. Rank 2's token scenario uses the median per-round Gemini work I/O rate, about 80k counters per lifecycle minute; it is a planning assumption, not measured recovery billing.

## 1. Make a pass claim specific enough to reject

Change `SKILL.md`'s brief and review instructions and `README.md`'s lane examples. Reuse the existing rules injected through `houseRules` at cdx.ts:1166; remove repeated versions of the same guidance rather than adding another prompt layer. Do not put Hyperscale operation names or QA schema rules into the generic runtime.

For a retest assignment, require the candidate identity, cell IDs, success/refusal obligation, one observable assertion per cell, currently closed findings, and the owned evidence directory. The completion report must map each pass to the new attempt and captured result. A refusal under a success obligation is failed or blocked, never passed. Old evidence may guide a procedure but cannot establish a fresh attempt. A closed finding must be re-evaluated against the current candidate before blocking.

The head reads the actual result body before accepting the pass. `qa.ts validate` establishes register consistency, not fulfillment of an operation obligation. Five replacement lanes and two mapping correction rounds cost 115.69 minutes and 12.49M I/O tokens. Preventing half across four recent cycles yields the row's 14.5 minutes and 1.56M counters per cycle.

This plan deliberately does not add a generic cdx regex that declares evidence honest. A future semantic QA gate would change the owning QA application, which is outside the requested cdx file split. The checklist remains human-owned until that separate work is approved.

Acceptance criterion: a head following the example brief can distinguish a valid refusal test from a failed success attempt without inferring intent from report prose. No runtime test is needed for a documentation rule.

## 2. Fail prerequisite checks before consuming a worker round

Change `executeGate` at cdx.ts:1779 and the existing `runPreCheck`/launch path at :1823. Preserve explicit lane cwd and existing shell behavior. Prepend the lane's local `node_modules/.bin` to the gate environment while retaining the original PATH. Do not globally rewrite `bun`, `bunx`, `tsc`, package scripts, or user shell syntax. Document that nested package commands should use that package's script or explicit local runner; a root PATH is not a substitute for package selection.

Use existing `--pre` for cheap prerequisite checks: required generated inputs exist, the requested package/test path exists, and the evidence directory is writable and uniquely owned. Do not run the suite as a baseline. The existing `--gate-baseline-check` is a full gate and would violate the one-gate policy if used routinely. Report the actual cwd, gate command, and gate log on failure. Keep deterministic missing-command/setup failures distinct from failed assertions; do not convert them to success.

The head prepares generated inputs before spawning a no-regeneration lane. It assigns each attempt an immutable evidence path and prevents another lane from overwriting historical artifacts. This addresses ten release 26 gates invalidated by one shared evidence store, two excluded-test invocations, and bare `tsc` failing under `sh`. Missing evidence logs and missing generated SDKs remain separate diagnoses.

The three clear invocation failures expose 66.4 lane-minutes and 5.93M I/O tokens, but useful code preceded those failures. Do not claim the entire exposure as saved. The forecast is explicitly one avoided five-minute recovery every five cycles.

Regression criteria: a local fixture executable is found from the lane cwd; a nonexistent command remains a setup failure; a command returning a failed assertion remains a failed gate; a failed cheap precheck starts no worker. Use existing fixture mechanisms, with one assertion per behavior and no full-suite invocation inside a test.

## 3. Make delegation policy consistent across every route

Change `modelOf` at cdx.ts:1299, `openRound` at :1619, `supervisorLane` at :140, `callerLineage` at :165, `consultCommand`/`reviewCommand` at :3674–3759, and `dispatch`/`SUPERVISOR_COMMANDS` at :6258–6280. Update parent cleanup in `finalizeRound` at :3120. Keep the existing lane types and ownership model.

Refuse a child whenever its resolved model is `gpt-6-astra`. Check the resolved value, not only the literal `--model` flag. Cover aliases, config defaults, retained resume choices, changed engine, and existing child lineage during internal quota recovery. Apply the refusal before account probes or process startup, and recheck the committed decision under the existing ledger lock. Head-launched Astra remains permitted. A child must never gain supervisor authority.

Extend the existing consult command with an explicit Gemini engine option for read-only helpers. A head-started consult may opt into the existing supervisor flag, but that role permits only owned, read-only Gemini helpers. It cannot spawn a writable worker, GPT child, grandchild, detached job, or unrelated lane. The helper uses the advisory consult frame and existing Gemini review agent, rather than a new lane kind. Preserve read-only mode on resume, ownership on replies, and cleanup on consult completion. A parent with an unfinished child cannot report done. Document that current review hooks/fingerprints are accidental-write controls, not a security sandbox against arbitrary shell access.

The cdx guard alone does not cover native model spawning. r28-master had three native children and cdx-visibility had one outside cdx's lane ledger. Disable native subagent tools for cdx-launched GPT sessions and route delegation through tracked cdx children. Apply the setting in `appThreadParams` at :2015 and in the exec/consult launch arguments, including resume paths. Do not change global Codex configuration.

Current official configuration documents `agents.enabled = false` as the switch that disables subagent tools; choosing a default helper model alone does not prevent explicit model overrides. The installed Codex 0.153.3 CLI also accepts disabling its `multi_agent` and `multi_agent_v2` feature flags. Confirm the launcher's effective tool availability when implementing rather than assuming CLI flag acceptance proves the session contract. Sources: [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and [subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Regression criteria: head Astra allowed; child Astra refused for explicit, alias, default, and retained-resume resolution; read-only Gemini helper allowed from an authorized consult; writable or GPT helper refused from that consult; grandchild refused; stale parent round refused; consult cleanup joins its children; every GPT launcher receives the native-agent disable setting. Reuse existing command fixtures rather than adding a second scheduler.

No study consult actually exercised this proposed path, so the expected saving is unmeasured. It satisfies the owner's policy and closes a route that makes lineage and accounting incomplete. Pilot one bounded consult split, then compare total parent-plus-child work, not just the parent's visible time.

## 4. Repair usage arithmetic before optimizing models

Change `handleCodexEvent` at cdx.ts:2612–2645 to hold usage baseline and previous counters per `threadId`. For each first event, derive the pre-round baseline from total minus last. Aggregate nonnegative per-thread deltas only after identifying the thread. Preserve idempotence when events repeat, and retain counters through the same round's resume/replay behavior. Do not subtract the historical overcount from a live account's quota.

Change the existing round/spec creation and `launch` event path at :1619–1745 to retain a start timestamp for every round and emit the existing started event for head-owned rounds too. Keep the existing JSONL journal. Do not add an event warehouse, dashboard, or head command recorder.

The observed arithmetic correction removes 10,730,543 input and 44,755 output tokens from attributed usage across two GPT rounds. It saves no actual tokens. Complete start records prevent the 17 missing-clock cases seen here and make future retry savings measurable.

Regression criteria: interleaved root/child usage equals the sum of independent per-thread increments; repeated events add nothing; an existing-session baseline does not charge previous work; each launch/resume records exactly one usable round start. Preserve unknown counters as unknown, not zero consumption.

## 5. Bound retries by failure and progress, not five repetitions

Change `GEMINI_TRANSPORT_ERRORS`/retry constants at cdx.ts:69 and `qualifyGeminiResult` at :2201, together with the existing Gemini process restart/resume path. Keep partial capture and `resumeCommand`'s partial injection at :3594–3609. Do not rebuild recovery from scratch.

Classify interrupted streams, broken pipe, timeout, transient network failure, and 503 separately from malformed function calls, quota refusal, failed gates, and user cancellation. Allow one automatic recovery for the same failed request with no new completed step. Use bounded backoff for a transient 503. If the process has died, use the supported fresh-process session resume instead of writing to a dead stream. Resume from recorded progress; do not replay successful mutation commands. Stop and expose the report when the same failure recurs without progress. A successful step may reset a local no-progress counter, but the round runtime cap still applies.

Show partial/report presence, last successful step, and whether the gate ran in the existing failure summary. Preserve the failed state. The head can request a report-only continuation or remaining gate work after inspecting the artifact. Do not auto-finish from prose, infer a passed gate, or treat replayed errors as new failures. Current code already handles some replayed errors; retain those tested cases.

The ten exhausted-retry rounds all failed. Continues two through five expose 13.21 minutes and 1,126,700 I/O counters across the snapshot. The forecast assumes half would meet the new no-progress stop condition. A 503 retry benefit is not estimated from one sample.

Regression criteria: repeated same-error/no-progress stops after the allowed recovery; a new completed step is retained; dead process uses resume; a gate failure, cancellation, or malformed call is never transport-retried; stale replayed error does not override a current successful completion; partial prose alone cannot produce done. No live-model retry loop belongs in the gate.

## 6. Reconcile exhaustion with fresh quota windows

Change `refreshUsageSnapshot` at cdx.ts:4403–4448, `standingOf` at :4514, and the shared decision used by `usageCommand` at :4833–4913. The fresh usage display and account advice must derive from the same effective snapshot.

The present merge preserves any future `exhaustedUntil`, then `standingOf` prioritizes it over fresh window data. Record enough provenance to relate an exhaustion marker to its observation and quota window. Clear a marker when newer authoritative usage proves that its window reset or that its exhausted condition no longer applies. Preserve a newer refusal, a different active exhausted window, and markers when probing fails. Migrate legacy markers conservatively; the supplied codex-2 case must no longer show contradictory 0% weekly use and unexplained exhaustion advice.

Do not simply delete every future marker when weekly use is low. A short window or newer refusal can still block the account. A fresh weekly reading is evidence about that window, not universal access.

Regression criteria: the supplied old-marker/fresh-window case becomes eligible or explicitly explains any different blocker; a current exhausted window stays blocked; a failed probe preserves the marker; a later refusal wins a racing earlier probe. No calls to live quota services in the gate.

There were zero observed quota-terminal failures. Claim zero measured time or token savings; this is a correctness fix for advice and account selection.

## 7. Finish preparation before the one wall/train sequence

Change the release coordination examples in `SKILL.md` and `README.md`; do not modify Arc's wall or train in this plan. Reuse the existing train's same-commit green summary rather than adding another cache inside cdx.

The head finishes generation, required packaging publication, and integration before selecting the candidate. It allows no concurrent writer to change that candidate during its wall/train. If a real fix changes the candidate, run fresh proof and record why the previous proof no longer applies. A cancelled wall is not a green result. Production actions still end at the owner under the existing authorization rules.

Two tree-state failed jobs consumed 841.0 seconds. Preventing half across ten historical release labels gives 0.70 job-minutes per cycle. The five superseded green walls expose another 33.76 minutes, but at least 14.26 preceded necessary deploy-discovered fixes, and release 29's change is unexplained. Do not promise to save them all. Job logs contain no model token accounting.

Acceptance criterion: the head names one candidate, one gate result, and any later invalidating change. No new runtime test or second wall is needed for this documentation change.

## 8. Keep briefs and reviews narrow without hiding dependencies

Change `SKILL.md`'s brief template and `README.md`'s supervisor/review examples. Preserve cdx.ts's existing 1,500-word warning; do not invent a magic shorter threshold. Remove duplicated global rules from examples and reference their source once.

A brief needs the outcome, consumer, exclusive files, prohibited actions, candidate/inputs, and exact gate. It also needs the specific assertion that distinguishes success from an attractive but wrong answer. The head sends evidence and unresolved decisions, not a long transcript or a list of keystrokes. A lane with a settled edit should be Gemini work, not an Astra supervisor holding a single Gemini child.

Keep one independent review of the consequential diff, including affected callers and contracts. Ask for severity, trigger, code location, and failure mechanism. Separate accepted defects, disputed findings, integration hygiene, and unverified candidates. A clean review is a result, not a reason to commission another. A later changed commit or a failed/incomplete review can justify another review. The reviewer reads the recorded gate result and does not run the suite.

The sample supports 11 accepted defects from Gemini reviews of Gemini work and does not support eliminating those reviews. It also does not quantify a causal benefit from shorter briefs. Record the next cycles using the repaired counters before claiming a token reduction.

## Gemini implementation split

The runtime is concentrated in one file. Do not create modules solely to manufacture parallel ownership. Two Gemini lanes have disjoint files; run them as two serial approved batches so the documentation reflects final behavior and each batch has exactly one gate. The head does not rerun either gate. If the owner wants one batch and one gate total, collapse both rows into one Gemini lane rather than running two duplicate gates on the same batch.

| Lane | Exclusive files under /Users/mas/code/cdx | Outcome | Gate |
| --- | --- | --- | --- |
| cdx-study-runtime | cdx.ts, cdx.test.ts | Implement ranks 2–6 as small changes in existing paths; no extra modules, live quota calls, or live-model tests | `bun run check` |
| cdx-study-guidance | SKILL.md, README.md | Implement ranks 1, 7, and 8 and document the finalized runtime/consult policy from ranks 2–6 | `bun run check` |

Each lane uses Gemini, receives the measured evidence and this plan, and may not delegate. The runtime lane owns all cross-cutting changes to `cdx.ts`; the guidance lane may report a source mismatch but must not edit runtime files. No lane commits, pushes, deploys, starts a server, or runs the suite. Its configured lane gate runs once after its report. The liaison orders the independent review and integrates on the recorded result. No new files outside these four are required.

The gate is the existing package command, which builds cdx.ts and runs cdx.test.ts. It has not been run during this study. Review the runtime batch before starting the guidance batch; there is no useful speed gain from concurrent changes to this monolith.

## Head checklist

1. Choose the smallest lane that can own the outcome. Use Gemini for settled work and Astra only for unresolved design or integration judgment.
2. Read the current candidate, findings, existing report, and required generated inputs before writing the brief. Reuse an existing lane when the scope still fits.
3. Give the lane exclusive files, immutable evidence paths, exact obligation assertions, the actual package runner, and one stored gate. Use cheap prechecks, not a baseline suite.
4. Wait once over owned lanes, answer questions when raised, and read each report plus gate. Do not infer failure or duplication from a name suffix.
5. After transport failure, inspect the partial and the last completed action before resuming. Ask only for missing work; never turn prose into a passed gate.
6. Reject old evidence, refusals under success obligations, and unsupported blocks on closed findings. Keep mechanical validation separate from experience proof.
7. Record one independent review's accepted defects and disagreements. Do not count untracked-file hygiene as a proved runtime defect or rerun the suite in review.
8. Finish preparation, freeze the candidate, and use the existing wall/train proof once. Join children and close owned work before the final handoff.

## Approval boundary and remaining risk

The owner is approving a design and file split, not a completed runtime change. The next implementation must verify the installed Codex native-tool disable behavior and reconcile quota-marker provenance with existing tests. Exact head polling costs and model-quality comparisons remain unmeasured. The final source diff and its one recorded gate per approved batch remain the liaison's integration evidence.

Duplicated investigation in this study: all four digest children needed a correction round, and root rechecked review acceptance and replacement-lane claims after the second reports. That is evidence to read a digest's cited source before adopting its conclusion, not a reason to add another autonomous review layer.
