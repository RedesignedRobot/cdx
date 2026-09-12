# cdx execution study

The largest demonstrated process loss was invalid retest evidence. Five replacement lanes consumed 76.9 lane-minutes and 8.96 million input-plus-output tokens. Two earlier mapping correction rounds added 38.8 minutes and 3.53 million tokens. Gemini reviews found defects worth keeping, while cdx's retry and token-accounting paths need changes before the head can judge engine efficiency reliably.

This is a retrospective of the supplied snapshot, not a live estate audit. The implementation plan is in [plan.md](plan.md). No source files, tests, release jobs, or estate state were changed.

## Scope and measurement

The index contains 147 lanes: 124 Gemini and 23 GPT/Astra, with 118 work and 29 review labels. Those are final lane labels, not immutable roles. The logs contain 188 rounds: 148 Gemini work, 16 Gemini review, 19 GPT consult, and 5 GPT work. For example, cdx-visibility implemented with GPT in round 1 and reviewed with Gemini in round 2. Its index label alone misclassifies both engine costs and purpose. Consult rounds must not be counted as defect reviews.

The snapshot includes release-labelled work from 25 through 35, beyond the brief's recent 32–35 context. The earliest indexed start and latest terminal event span about 47 hours 9 minutes. All costs below use only supplied lanes and jobs. This study's four digest children are excluded.

[measure.py](digests/measure.py) streams each JSONL file, deduplicates tool records by event identity, sums Gemini step usage, and separates GPT usage by thread. [Round measurements](digests/round-metrics.json) retain source terminal lines, timing method, missing counters, tool counts, and error result lines. [Per-lane measurements](digests/lane-metrics.md) provide all 147 lanes; [per-lane activity durations](digests/lane-activity.md) separate the recorded read, write, verification, and wait service times.

Exact lifecycle intervals exist for 171 rounds. Seventeen middle rounds lack start timestamps: their previous-terminal-to-current-terminal spans are upper bounds, not execution time. Most Gemini events have no timestamps; cumulative result.duration_seconds includes earlier conversation work and cannot supply the missing clock. Known lane time is 3,212.8 minutes, with at most 173.7 additional minutes in those missing intervals, giving 53.55–56.44 lane-hours. Concurrent lane-hours are not release critical-path hours. Lifecycle intervals include startup and gates.

Four GPT consult rounds lack token counters, so aggregate tokens are a recorded lower bound. Gemini input excludes cache-read tokens; GPT input includes cached input. Cache counters below therefore have different inclusion rules. Do not add every column together or treat input-plus-output as a billing unit. No dollar cost is inferred.

## Time, tokens, reading, and action

| Actual round engine / role | Rounds / timed | Known lane-min | Median / worst timed min | Input | Output | Cache |
| --- | --- | --- | --- | --- | --- | --- |
| gemini / review | 16 / 11 | 72.2 | 6.41 / 8.39 | 7,695,147 | 996,615 | 118,541,991 |
| gemini / work | 148 / 136 | 3,040.6 | 17.68 / 82.58 | 228,888,190 | 19,192,955 | 4,603,512,596 |
| gpt / consult | 19 / 19 | 48.4 | 2.41 / 6.72 | 16,868,000 | 86,453 | 15,442,944 |
| gpt / work | 5 / 5 | 51.5 | 10.53 / 13.68 | 23,302,619 | 119,904 | 22,437,376 |

Whole-lane comparisons using the index's final cohorts follow. A plus sign means missing round time; medians use only fully timed lanes. The mixed-history review cohorts include their earlier implementation rounds, so the round table above is the better engine comparison.

| Final index cohort | Lanes | Fully timed | Median lane min | Worst known lane min | Recorded I/O tokens |
| --- | --- | --- | --- | --- | --- |
| gemini/work | 114 | 109 | 19.45 | r27-f166: 125.80+ | 232,591,093 |
| gemini/review | 10 | 4 | 27.77 | hs-r30-f183: 41.94 | 23,478,114 |
| gpt/work | 4 | 4 | 10.78 | hs-r33-brand-build: 13.68 | 19,446,013 |
| gpt/review | 19 | 19 | 2.78 | cdx-visibility: 16.30 | 21,634,663 |

The longest individual round was hs-r32-portal-c r1 at 82.58 minutes and 6,048,909 input tokens. r27-f166 accumulated 125.80 known minutes across three rounds, plus at most 1.18 missing minutes, and 9,249,188 input tokens. hs-r27-compose consumed 96.8 minutes across two rounds; its second round was killed after another background Playwright hang. These are stronger optimization targets than the median 2.41-minute GPT consult.

Gemini emitted 37,300 distinct tool calls. The classifier assigns 23,748 to reading, 2,982 to writes, 1,019 to test or gate commands, 31 to wait/status, 15 to coordination, and 9,505 to other operations. Reading accounts for 63.7% of calls; explicit writes account for 8.0%. Browser work hidden inside shell scripts and compound commands often lands in other. The 1,019 verification-like calls are not 1,019 full-suite runs.

Recorded Gemini tool service time was 160.9 minutes reading, 57.3 writing, 244.4 verifying, 2.3 waiting, 5.1 coordinating, and 568.5 other. Agent-response durations sum to 2,129.2 minutes. Parallel tool service intervals and model intervals are not a mutually exclusive wall-clock partition. GPT emitted 789 calls: 529 reads, 35 writes, 21 verification-like calls, 22 waits, 22 coordination calls, and 160 other. Legacy consult logs do not expose command durations. Thus the logs support per-lane read/action call proxies, not an exact percentage of time or tokens spent understanding versus acting. Allocating tokens by call counts would invent precision.

A source defect inflates GPT accounting. handleCodexEvent uses one previous usage counter across thread/tokenUsage/updated events without separating threadId. Interleaved native children cause another thread's lower counter to reset the comparison and the next higher counter to be charged again. Reproducing the arithmetic gives 8,502,019 excess input tokens in r28-master r1 and 2,228,524 in cdx-visibility r1. The ledger reports 287,484,499 input tokens across the snapshot; per-thread reconstruction gives 276,753,956. Output falls from 20,440,682 to 20,395,927. This corrects measurement by 10.73 million input tokens, not actual consumption. See [the accounting reproduction](digests/token-accounting.md) and cdx.ts:2612–2645.

## Failures and partial rounds

There were 54 failed rounds across 39 lanes and 134 successful rounds. Failed rounds expose 1,204.0 known lane-minutes plus at most 71.9 missing minutes, with 88,564,675 input and 6,993,057 output tokens. This is cost incurred in failed rounds, not wholly avoidable waste.

| Primary failure class | Rounds | Known min | Additional unknown upper min | Input | Output |
| --- | --- | --- | --- | --- | --- |
| gate failure | 29 | 738.1 | 61.3 | 59,145,634 | 4,558,443 |
| malformed function call | 2 | 100.9 | 0.0 | 8,400,058 | 581,688 |
| stop/unknown | 7 | 39.7 | 3.6 | 1,058,958 | 77,935 |
| transport broken pipe/interruption | 14 | 267.9 | 6.9 | 16,925,962 | 1,487,235 |
| runtime | 1 | 45.0 | 0.0 | 2,419,927 | 216,586 |
| 503 | 1 | 12.4 | 0.0 | 614,136 | 71,170 |
| quota | 0 | 0.0 | 0.0 | 0 | 0 |
| question | 0 | 0.0 | 0.0 | 0 | 0 |

[The complete failure inventory](digests/failure-inventory.md) lists every failed round, its captured error, cost, artifact status, and later disposition. [The detailed failure digest](digests/failures.md) supplies gate causes and quoted source handles. There are 22 partial files: 17 in failed rounds and 5 normal GPT streaming checkpoints in successful rounds. Two further successful Gemini resumes contain replayed old errors. Counting partial files or error strings as terminal failures would overstate failures.

Ten of the 29 gate failures were release 26 acceptance lanes hitting the same overwritten evidence hashes under hs-r26-webhooks. Together they expose 256.8 lane-minutes and 23.35 million I/O tokens. The underlying work was not necessarily wrong. The shared evidence store invalidated their common gate. Evidence paths must be immutable and owned by one attempt; a harness retry cannot repair historical evidence safely. Source: logs/hs-r26-billing-r1.gate.log and the other nine release 26 gate logs.

Three clear gate invocation mistakes consumed 66.4 lane-minutes and 5.93 million I/O tokens: hs-r30-f183 r1 and hs-r30-f185 r1 passed open/hsx tests to a root runner that excluded them, yielding "No test files found"; r32-cli r1 invoked bare tsc through sh and got "tsc: command not found". This does not establish 66.4 recoverable minutes: useful implementation preceded the bad gate. cdx should resolve local binary PATH consistently and expose gate setup failures distinctly; the head must choose the package's actual runner. It should not rewrite arbitrary shell commands by guessing.

Other preparation failures were different. hs-r30-qakit r1 lacked scratchpad capture helpers, and r2 referenced missing evidence logs. r28-q, r32-fix-docscli, and r34-support lacked generated SDK artifacts. hs-r35-mcpcost and hs-r35-sdkmoney required generated files while their briefs forbade regeneration. The latter is a head preparation conflict, not permission for workers to ignore the brief. Actual type failures, failed acceptance assertions, and wall failures remain real failed gates. No terminal failure is proven to be caused solely by an incorrect cwd.

Ten Gemini rounds reached all five auto-continues after the first stream failure; all ten ended failed. The 50 continues consumed a measured 15.59 minutes and 1,257,539 I/O tokens after the first failed result. Continues two through five account for 13.21 minutes and 1,126,700 I/O tokens. These increments come from differences within cumulative result records, not summing those records. They bound exposure to repeated retry, not all useful work after interruption. See [retry measurements](digests/retry-metrics.json).

cdx already saves partial reports and injects them into resume prompts. Several failed rounds have substantial artifacts, including r27-f166 r1, hs-r27-money, hs-r27-rentguard, and hs-r30-train. Others have only 39–306 bytes. The journal explicitly says the head handled hs-r27-vehicle and r32-mcp manually, and hs-r27-compose r2 was killed so the head could finish from evidence. A substantial partial is a recovery candidate, not proof that obligations were met. Auto-promoting any final-looking prose would amplify the retest errors below. Preserve the failure, show the artifact and gate state, and allow the head to request only the missing work.

The current transport matcher handles stream interruption and timeout text. Broken pipe, generic network failure, and 503 need distinct treatment. One 503 round cost 12.4 minutes; one max-runtime round cost 45.0 minutes. Two malformed function-call rounds cost 100.9 minutes and are not max-runtime events. No observed terminal round failed for quota or an unanswered question. Rejected admissions outside these indexed rounds are not measured.

## Rework, release jobs, and wall reuse

Twenty-four lanes had additional rounds, totalling 41 extra rounds, 288.9 known minutes plus at most 173.7 missing minutes, and 31.23 million I/O tokens. They comprise 17 successful work continuations, 8 failed work continuations, 13 successful reviews, 2 failed reviews, and 1 successful consult continuation. These are not 41 duplicate implementations: the first independent review is useful new work.

Specific rework is established by brief text, not suffixes. hs-r32-http-c replaces four voided attempts from hs-r32-http-b; hs-r33-portal-c replaces four from hs-r33-portal-a. hs-r31-tags-a and tags-b are disjoint channel assignments. hs-r31-desk-spec2 follows a stopped first lane, but the snapshot does not prove every read was duplicated. Keep continuation on the existing lane with the prior report when its scope still fits. Transport resumes that preserve artifacts are better than a new brief that asks for the entire task again.

The 55 detached jobs consumed 498.6 job-minutes: 26 succeeded in 334.8 minutes and 29 failed in 163.8. Seventeen commands ran train.ts, including five wall-only train invocations; ten failed. Seventeen standalone walls included eight failures. Thirteen direct deploy jobs included nine failures. The eight remaining jobs included two failures. [The job inventory](digests/operations.md) lists all 55 and their log outcomes.

Failed job causes were six test failures, three land-step failures, two tree mismatches, three deploy acceptance failures, five packaging/artifact failures, two guest configuration/seed failures, one immediate wipe-confirmation refusal, four cancellations, and two export refusals. The ten failed train invocations were hs-train-r32, hs-train-r32b, hs-train-r32c, hs-wall-r33, hs-wall-r33b, hs-wall-r33c, hs-wall-r33d, hs-train-r34, hs-train-r34b, and hs-train-r34e. Their logs distinguish tests, acceptance, tree identity, land, and package drift. Do not label every train failure a test failure.

Five green wall jobs were superseded by later commits: hs-r26-wall7/8, hs-r28-wall6/7, and hs-r29-wall2, totalling 33.76 minutes. The release 28 pair accounts for 14.26 minutes and preceded real deploy-discovered defects; fresh proof after those fixes was necessary. The other three expose 19.49 minutes, but release 29's commit change is not established as avoidable. hs-train-r32c's passing wall phase is already included in its failed job duration and is not counted again. Failed plus superseded jobs expose 197.6 minutes, or 39.6% of job duration, not 39.6% provable waste.

Existing wall reuse worked. logs/job-hs-train-r33.log:6 records skipping the wall because the same commit already held a green summary from hs-wall-r33e, whose job took 457.2 seconds. Do not build another wall cache. Freeze the candidate and finish required packaging preparation before the one wall/train sequence. hs-train-r34e failed a test and hs-train-r34f later passed on the same commit; that is a flake or environment candidate, not proof that repeated tests are a sound release policy.

## Retest evidence and brief quality

The evidence supports invalid claims, not an inference about intent.

| Replacement or correction | Reason | Affected cells | Lane-min | I/O tokens |
| --- | --- | --- | ---: | ---: |
| hs-r32-http-c | Old object IDs/evidence reused under fresh replay obligations | 4 | 15.16 | 1,901,810 |
| hs-r32-mcp-b | Refusal cited as success | 1 | 8.96 | 1,117,097 |
| hs-r32-sdk-b | Refusals cited as success | 9 | 21.59 | 2,404,284 |
| hs-r33-http-b | Blocked on closed F-013 | 1 | 9.81 | 1,222,489 |
| hs-r33-portal-c | Two invalid success claims and two blocks on closed/fixed findings | 4 | 21.40 | 2,315,848 |
| hs-r32-sdk r2 and hs-r32-mcp r2 | Corrected 21 and 13 cells initially mapped to non-defects | 34 | 38.77 | 3,529,031 |

The five replacement lanes total 76.91 minutes and 8,961,528 I/O tokens. Adding the two distinct mapping correction rounds gives 115.69 minutes and 12,490,559 tokens. This is documented rework across releases 32–33, not a general estimate from names. Sources: briefs/hs-r32-http-c-r1.md:54, hs-r32-mcp-b-r1.md:38, hs-r32-sdk-b-r1.md:68, hs-r33-http-b-r1.md:27, hs-r33-portal-c-r1.md:27, and their predecessor reports.

A refusal can be valid proof for a refusal obligation, but not for an operation-success obligation. A closed finding can explain history, but cannot substitute for trying the current candidate. Fresh evidence requires a current attempt, candidate identity, and newly captured results. Reusing a technique is different from replaying old evidence. Generic qa.ts validate passed some invalid claims because it checks register consistency, not whether an HTTP response fulfills the obligation.

The brief should carry the exact cells, candidate, obligation polarity, required assertion, current finding dispositions, and evidence ownership. Existing notes already described some mappings; adding more prose alone will not prevent ignoring them. The head must review the result body and current finding state before accepting a pass. A domain-semantic QA gate belongs in the QA repository, not a generic cdx shell heuristic. That separate implementation is outside this cdx-only plan.

Gemini task-brief length correlates with cost and failures in this snapshot:

| Task words | Rounds | Failed rounds | Median timed min | Median input tokens |
| --- | --- | --- | --- | --- |
| 0–249 | 30 | 5 | 6.41 | 365,418 |
| 250–499 | 46 | 15 | 12.88 | 913,042 |
| 500–999 | 79 | 25 | 19.72 | 1,411,374 |
| 1000–1499 | 4 | 2 | 38.26 | 3,175,338 |
| 1500+ | 5 | 4 | 45.27 | 3,760,183 |

These are descriptive cohorts, not a controlled test: longer briefs contain larger jobs, later corrections, and more constraints. There is no supported optimal word limit or claim that shortening a brief causes success. cdx already warns above 1,500 words at cdx.ts:3506. Replace repeated governance paragraphs with source references while preserving the few task-specific assertions that change acceptance.

Two concrete instruction problems cost rounds. Generated-file gates were incompatible with no-regeneration briefs on unprepared worktrees. Retest briefs relied on register notes or broad "fresh evidence" language where the outcome needed a named object assertion and an explicit refusal prohibition. The later replacement briefs made those conditions concrete. Conversely, asking permission to edit qa.ts was compliance with scope, not wasted indecision. The passkey-related clarification took seconds, not an entire lost round. All nine recorded questions were answered.

## Reviews and delegation

| Gemini review round | P1 / P2 / P3 | Accepted lower bound | Result |
| --- | --- | --- | --- |
| hs-r30-f183 r2 | 0 / 3 / 2 | 0 | completed |
| hs-r30-f185 r3 | 1 / 2 / 1 | 2 | completed |
| hs-r30-f187 r3 | 2 / 1 / 1 | 3 | completed |
| hs-r30-train r3 | 1 / 3 / 4 | 0 | completed |
| hs-r30-qakit r4 | 3 / 5 / 2 | 6 | completed |
| cdx-visibility r2 | 1 / 2 / 1 | 0 | completed |
| r34-support r2 | 0 / 0 / 0 | 0 | completed |
| r34-seed r2 | 0 / 0 / 3 | 0 | completed |
| r34-rebuild r3 | 1 / 1 / 1 | 0 | completed |
| hs-r34-seed-review r1 | 0 / 3 / 2 | 0 | completed |
| hs-r35-recompose r3 | 2 / 1 / 1 | 0 | completed |
| hs-r35-support r3 | 0 / 0 / 0 | 0 | completed |
| hs-r35-mcpcost r3 | 1 / 4 / 2 | 0 | completed |
| hs-r35-sdkmoney r2 | 0 / 0 / 0 | 0 | failed_transport |
| hs-r35-sdkmoney r3 | 0 / 0 / 0 | 0 | failed_signal |
| hs-r35-sdkmoney r4 | 0 / 0 / 0 | 0 | completed |

Ten completed Gemini review rounds reported P1/P2 candidates. Three were clean, one found P3 issues only, and two stopped without a completed review. The 37 P1/P2 reports comprise 12 P1 and 25 P2 candidates; 20 P3 reports are excluded from defect economics. Three P1s concerned untracked new files before integration, so they are integration hygiene rather than demonstrated runtime defects.

A conservative accepted lower bound is 11 defect reports: two from hs-r30-f185, three from hs-r30-f187, and six from hs-r30-qakit, corroborated by later fix reports and their recorded successful outcomes. Two further claims were narrowed or rejected as stated, and 21 candidates lack sufficient acceptance evidence in this snapshot. The QA readiness fix still permits ready cells with empty proof lists; the named-constant critique was not established by the final held-payment fix. Do not count the child's initial 13-finding acceptance claim. [The adjudicated inventory](digests/reviews.md) names these corrections.

Gemini reviewing Gemini consumed 7,988,062 I/O tokens across 15 rounds, or 234,943 per reported P1/P2 candidate and 726,187 per accepted lower-bound finding. The same-engine review time was 63.85 known minutes plus at most 24.86 missing minutes, or 5.80–8.07 lane-minutes per accepted lower-bound finding. Cache reads were another separately reported 111,183,289 tokens. These reviews found zero-transfer settlement, lifecycle transition, resolver attribution, readiness-scope, and retest selection defects. Keep independent Gemini review of Gemini work. The snapshot does not compare against equally scoped GPT review, so it cannot establish comparative quality or cost per prevented incident.

There is no evidence for deleting all second reviews. hs-r34-seed-review targeted a later commit than r34-seed r2. hs-r35-sdkmoney's two failed review attempts cost 405,454 I/O tokens and at most 5.94 minutes before a completed clean review. One repeated P3 observation is not evidence of duplicated P1/P2 discovery. Review the changed behavior and its callers once; do not run a second full review just to rephrase the first report.

Four metadata-marked Astra supervisors spawned five tracked Gemini children. Their round-1 time totalled 41.0 minutes; explicit wait/status service time was 7.92 minutes, or 19.3%. The remainder includes reasoning, generation, and local work, not uninterrupted execution. Corrected supervisor counters were 16,175,467 input and 84,068 output tokens. Their children consumed 32.94 lane-minutes, 2,255,852 input, and 343,477 output tokens; all five completed. The children received 20 steers. Reports show supervisor corrections to brand and renderer work, but do not prove that whitespace-only child gates caused those corrections. One parent-owned final gate remains preferable to every child rerunning the suite.

r28-master also used three native children, and cdx-visibility used one. Native children were not separate cdx ledger lanes and contributed to the accounting defect. No controlled comparison proves that a plain Gemini lane could replace these supervisors at equal quality. For settled, bounded edits, default to one Gemini worker; retain Astra for unresolved design and integration decisions. Do not spend a supervisor merely to wait for a single already-specified edit.

## Head process, policy gaps, and limits

The journal contains 516 events in the observed window. spawn-audit.log ends before the study window. feed.log records runner events, not every Claude head command. Head polling frequency, repeated cdx status calls, head token consumption, and time spent reading reports therefore cannot be measured from these files. Claiming a precise head polling cost would be fabricated. Within GPT implementation rounds, 22 wait/status calls are measurable, but these are lane activity, not Claude-head activity.

All 147 work-state records are closed. No lanes remained open in this snapshot. Nine questions had 286.7 seconds total elapsed reply latency, a median of 21.66 seconds, and a maximum of 122.38 seconds. There were zero unanswered questions. Reply latency is not head labor time. Explicit replacement briefs establish duplicate effort where cited above; no count of duplicate spawns can be inferred from suffixes alone.

Three requested runtime gaps are grounded in current code. Model aliases and inherited choices resolve through modelOf/openRound without a central child-Astra refusal. supervisorLane and dispatch admit delegation only from running work supervisors, excluding read-only consult parents. refreshUsageSnapshot preserves a future exhaustedUntil marker, and standingOf checks it before fresh windows. usage.json records codex-2 at 0% weekly use with reached false at 08:17:22Z, while the retained exhaustion marker points to September 15. That contradiction explains stale advice and can also affect selection. It does not establish a lost job or authorize assuming unlimited quota.

The study recommends eight ranked changes in plan.md. Savings are stated as conditional scenarios with explicit denominators. It does not total overlapping failure, retest, retry, and wall exposures as if they were independent cash savings.

## Delivery and verification

Four Gemini digest lanes completed two rounds each and passed their artifact-presence gates. Their raw handoffs are retained under digests/child-{failures,acceptance,reviews,operations}-r2.md; digests/children-joined.txt records all four gate outcomes. Those gates prove artifact presence, not analytical correctness. Root reconciliation corrected review acceptance counts, replacement-lane classification, and unsupported causal savings. The final study and adjudicated inventories supersede raw child conclusions.

Verification consisted of streaming log arithmetic, source inspection, cross-checking reports against briefs and questions, and artifact consistency checks. No test suite, wall, git command, commit, deployment, or server was run for this study. Exact read-versus-action token allocation, 17 round clocks, four consult token counters, head polling, and comparative model quality remain unknown. Duplicated investigation occurred when all four child drafts required correction rounds; root also rechecked review and operations claims after those rounds.
