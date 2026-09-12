> Root adjudication: use study.md and plan.md for final conclusions. This supporting child digest has been corrected for replacement lanes, unproven causality, and wall avoidability. The original child handoff is retained in children-joined.txt.

# Measured Operations Study: Detached Jobs, Astra Supervisors, and Head-Side Audit

## Executive Outcome

The 48-hour snapshot records 55 detached jobs in jobs-48h.json consuming 29918.6 wall-clock seconds (8.31 hours).
Of these 55 jobs, 26 succeeded (20090.5 seconds) and 29 failed (9828.1 seconds).
Five green wall jobs (2025.3 seconds) were superseded by subsequent commits before live deployment.
A clear distinction exists between avoidable waste and necessary rework:
Three superseded walls expose 1,169.5 seconds across hs-r26-wall7, hs-r26-wall8, and hs-r29-wall2. Dirty-tree and packaging preparation explain the first two; the snapshot does not establish why the release 29 commit changed, so this is not all proven avoidable waste.
Essential defect fixes occurred when deploy acceptance tests caught real journey failures (855.8 seconds across hs-r28-wall6 and hs-r28-wall7).
hs-train-r32c is classified strictly as a failed job (exit 1, 433.6s) due to a post-wall tree mismatch, and is not double-counted as separate wall waste.

Delegation through Astra supervisors occurred in 4 work lanes managing 5 Gemini children.
Across round 1 of all four supervisors, wait_status calls accounted for 475.06 seconds (19.3 percent of round 1 duration).
The remaining 1984.8 seconds of supervisor round duration represents model reasoning, text generation, and local file operations, not continuous command execution.
Supervisors spent 16,175,467 GPT input tokens and 84,068 output tokens.
The five children received 20 steers and had whitespace-only gates. Supervisor reports record corrections, but the logs do not establish that gate choice caused the steers.
Whether a single Gemini lane could match GPT-6-Astra's solution quality on complex design tasks remains an unverified inference without comparative evaluation.

Head-side audit shows that spawn-audit.log terminated on 2026-09-09T09:31:55, offering zero visibility into the 48-hour study period.
feed.log logged 516 events in the window, but records only lane push notifications, omitting all head read, list, and status polling commands.
All 9 lane questions were answered with a median turnaround latency of 21.66 seconds and zero unanswered questions.
This turnaround latency measures elapsed wall-clock time between question and answer, not continuous operator labor time.
All 147 ledger lanes finished closed with zero open lanes.

## Section 1: Detached Jobs Inventory and Analysis

### Aggregate Metrics

- Total detached jobs: 55
- Total wall-clock duration: 29918.6 seconds (8.31 hours)
- Succeeded jobs: 26 (20090.5 seconds, 5.58 hours)
- Failed jobs: 29 (9828.1 seconds, 2.73 hours)
- Superseded passing walls: 5 (2025.3 seconds)
- Combined failed and superseded job time: 11853.4 seconds (3.29 hours, 39.6 percent of detached job time)

### Failure Cause Classification

Inspection of logs/job-*.log identifies nine concrete failure causes across the 29 failed jobs:

1. Test step failure (exit code 1): 6 jobs (hs-r26-wall5, hs-r28-wall4, hs-train-r32, hs-wall-r33c, hs-wall-r33d, hs-train-r34e). Cumulative duration: 2,367.4 seconds.
2. Land step failure (exit code 1): 3 jobs (hs-wall-r32, hs-wall-r33, hs-wall-r33b). Cumulative duration: 524.5 seconds.
3. Tree movement or git state mismatch (exit code 1): 2 jobs. hs-r26-wall6 failed because files changed after land (407.4s); hs-train-r32c passed the wall on a dirty worktree but failed deploy because the release tree was clean (433.6s). Cumulative duration: 841.0 seconds.
4. Deploy acceptance test failure (exit code 1): 3 jobs (hs-r28-deploy2, hs-r28-deploy3, hs-train-r32b). Acceptance journeys detected real functional regressions in deployed services. Cumulative duration: 3,072.0 seconds.
5. Fresh deploy packaging or artifact drift (exit code 1): 5 jobs (hs-r26-deploy2, hs-r27-deploy, hs-r27-deploy2, hs-train-r34, hs-train-r34b). Cumulative duration: 1,873.7 seconds.
6. Guest deploy configuration or seed failure (exit code 1): 2 jobs. hs-r27-deploy3 failed on seed-profile flag validation (206.6s); hs-r27-deploy4 failed during database seed execution (404.8s). Cumulative duration: 611.4 seconds.
7. Immediate wipe confirmation prompt (exit code 1): 1 job (hs-r26-deploy). Duration: 0.3 seconds.
8. Caller cancellation via SIGTERM (exit code 143): 4 jobs in jobs-48h.json (hs-r28-wall2, hs-r28-wall3, hs-r28-wall5, hs-r29-wall1). Cumulative duration: 209.2 seconds.
9. Export refusal on dirty tree or conflict (exit code 1): 2 jobs (hs-r26-export, hs-r26-export2). Cumulative duration: 26.7 seconds.

### Superseded Green Walls: Waste Versus Defect Fixes

Five completed green walls were rendered obsolete by later commits prior to deployment:

1. hs-r26-wall7 (commit c675a558, 380.4s, green): Avoidable waste. Executed on a dirty worktree; replaced by clean commit b8b997cf.
2. hs-r26-wall8 (commit b8b997cf, 380.5s, green): Avoidable waste. Successfully proved commit b8b997cf, but deployment failed due to unverified CLI packaging changes. Fixing packaging required commit 0c57f895 and fresh wall hs-r26-wall9 (385.7s).
3. hs-r28-wall6 (commit d9200bc68, 438.9s, green): Necessary defect fix invalidation. Successfully tested commit d9200bc68, but hs-r28-deploy2 caught real journey acceptance failures. Commit 8ba7f5960 was required to fix the defect.
4. hs-r28-wall7 (commit 8ba7f5960, 416.9s, green): Necessary defect fix invalidation. Successfully tested commit 8ba7f5960, but hs-r28-deploy3 caught another acceptance defect. Commit ab4f63c6a fixed the defect and ran hs-r28-wall8 (413.8s).
5. hs-r29-wall2 (commit 15a4a53fc, 408.6s, green): Avoidability unknown. Superseded by commit 7c8835386, requiring fresh wall hs-r29-wall3 (415.6s).

Note on hs-train-r32c: The wall phase of hs-train-r32c passed, but the overall train job failed on deploy with exit code 1. Its 433.6s duration is accounted for under failed jobs, avoiding double-counting.

### Complete Inventory of All 55 Detached Jobs

| Job Name | Kind | State | Exit Code | Duration (s) | Started At | Target Commit / Arguments | Primary Log Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hs-r26-deploy | deploy | failed | 1 | 0.3 | 2026-09-10T11:44:26.030Z | `HYPERSCALE_ESTATE_HOME=$HOME bun infra/vm/dep` | 2026-09-10T11:44:26.335Z deploy: FAILED: BLOCKED: this  |
| hs-r26-deploy2 | deploy | failed | 1 | 73.2 | 2026-09-10T11:45:21.830Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | 2026-09-10T11:46:35.004Z deploy: FAILED: distribution/c |
| hs-r26-deploy3 | deploy | done | 0 | 1455.8 | 2026-09-10T11:57:49.174Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | Success (exit 0) |
| hs-r26-export | export | failed | 1 | 26.0 | 2026-09-10T11:26:43.604Z | `bun toolchain/export-public/run.ts all --push` | export-public: 1 of 4 units failed; nothing was pushed |
| hs-r26-export2 | export | failed | 1 | 0.7 | 2026-09-10T11:28:24.103Z | `bun toolchain/export-public/run.ts all --push` | M toolchain/export-public/run.ts |
| hs-r26-export3 | export | done | 0 | 43.5 | 2026-09-10T11:28:39.328Z | `bun toolchain/export-public/run.ts all --push` | Success (exit 0) |
| hs-r26-land | land | done | 0 | 193.8 | 2026-09-10T11:47:56.312Z | `bunx vp run land` | Success (exit 0) |
| hs-r26-pub-hsx | pub | done | 0 | 13.9 | 2026-09-10T11:30:24.112Z | `/tmp/pub-hsx.sh` | Success (exit 0) |
| hs-r26-pub-udl | pub | done | 0 | 8.7 | 2026-09-10T11:30:06.436Z | `bun toolchain/publish-npm/publish.ts udl` | Success (exit 0) |
| hs-r26-wall5 | wall | failed | 1 | 392.2 | 2026-09-10T10:26:48.663Z | `bun toolchain/testing/wall.ts --out /tmp/hs-r` | verdict=red step=tests |
| hs-r26-wall6 | wall | failed | 1 | 407.4 | 2026-09-10T10:35:00.616Z | `bun toolchain/testing/wall.ts --out /tmp/hs-r` | verdict=red step=tree reason=the tree moved after land, |
| hs-r26-wall7 | wall | done | 0 | 380.4 | 2026-09-10T11:30:38.883Z | `bun toolchain/testing/wall.ts --out /tmp/hs-r` | Success (exit 0) |
| hs-r26-wall8 | wall | done | 0 | 380.5 | 2026-09-10T11:37:56.388Z | `bun toolchain/testing/wall.ts --out /tmp/hs-r` | Success (exit 0) |
| hs-r26-wall9 | wall | done | 0 | 385.7 | 2026-09-10T11:51:19.131Z | `bun toolchain/testing/wall.ts --out /tmp/hs-r` | Success (exit 0) |
| hs-r27-deploy | deploy | failed | 1 | 70.9 | 2026-09-10T18:15:36.797Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | 275 /         if (refusal) throw new Error(refusal); |
| hs-r27-deploy2 | deploy | failed | 1 | 76.3 | 2026-09-10T18:28:26.645Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | 2026-09-10T18:29:42.938Z deploy: FAILED: distribution/c |
| hs-r27-deploy3 | deploy | failed | 1 | 206.6 | 2026-09-10T18:43:11.598Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | 2026-09-10T18:46:38.227Z deploy: FAILED: running the gu |
| hs-r27-deploy4 | deploy | failed | 1 | 404.8 | 2026-09-10T19:02:36.094Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | 2026-09-10T19:09:20.907Z deploy: FAILED: running the gu |
| hs-r27-deploy5 | deploy | done | 0 | 1452.5 | 2026-09-10T19:18:05.476Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | Success (exit 0) |
| hs-r27-export | export | done | 0 | 47.9 | 2026-09-10T18:19:48.203Z | `bun toolchain/export-public/run.ts all --push` | Success (exit 0) |
| hs-r28-deploy | deploy | failed | 1 | 65.6 | 2026-09-10T22:23:18.389Z | `HYPERSCALE_ESTATE_HOME=$HOME bun infra/vm/dep` | 288 /         if (refusal) throw new Error(refusal); |
| hs-r28-deploy2 | deploy | failed | 1 | 790.8 | 2026-09-10T22:26:23.174Z | `HYPERSCALE_ESTATE_HOME=$HOME bun infra/vm/dep` | 2026-09-10T22:39:33.942Z deploy: FAILED: release accept |
| hs-r28-deploy3 | deploy | failed | 1 | 1415.8 | 2026-09-10T23:02:03.665Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | 2026-09-10T23:25:39.436Z deploy: FAILED: release accept |
| hs-r28-deploy4 | deploy | done | 0 | 1088.2 | 2026-09-10T23:37:22.389Z | `HYPERSCALE_ESTATE_HOME=$HOME bun infra/vm/dep` | Success (exit 0) |
| hs-r28-ship | ship | done | 0 | 215.8 | 2026-09-10T22:19:34.163Z | `/tmp/r28-ship.sh d9200bc68` | Success (exit 0) |
| hs-r28-wall1 | wall | done | 0 | 219.2 | 2026-09-10T20:40:43.720Z | `bun install --frozen-lockfile >/tmp/r28-wall1` | Success (exit 0) |
| hs-r28-wall2 | wall | failed | 143 | 142.4 | 2026-09-10T20:45:50.424Z | `bun install --frozen-lockfile >/tmp/r28-wall2` | SIGTERM / canceled by caller (exit code 143) |
| hs-r28-wall3 | wall | failed | 143 | 21.3 | 2026-09-10T21:29:48.956Z | `bun toolchain/testing/wall.ts --out /tmp/r28-` | SIGTERM / canceled by caller (exit code 143) |
| hs-r28-wall4 | wall | failed | 1 | 421.7 | 2026-09-10T21:30:23.650Z | `bun toolchain/testing/wall.ts --out /tmp/r28-` | verdict=red step=tests |
| hs-r28-wall5 | wall | failed | 143 | 32.5 | 2026-09-10T21:57:06.875Z | `git checkout - . && git checkout -q 2d354af85` | SIGTERM / canceled by caller (exit code 143) |
| hs-r28-wall6 | wall | done | 0 | 438.9 | 2026-09-10T22:12:04.556Z | `git checkout - . && git checkout -q d9200bc68` | Success (exit 0) |
| hs-r28-wall7 | wall | done | 0 | 416.9 | 2026-09-10T22:54:34.568Z | `git checkout - . && git checkout -q 8ba7f5960` | Success (exit 0) |
| hs-r28-wall8 | wall | done | 0 | 413.8 | 2026-09-10T23:30:19.341Z | `git checkout - . && git checkout -q ab4f63c6a` | Success (exit 0) |
| hs-r29-deploy1 | deploy | done | 0 | 1409.7 | 2026-09-11T00:47:21.910Z | `HYPERSCALE_ESTATE_HOME=$HOME HYPERSCALE_DEPLO` | Success (exit 0) |
| hs-r29-wall1 | wall | failed | 143 | 13.0 | 2026-09-11T00:20:44.296Z | `git checkout - . && git checkout -q ab4f63c6a` | SIGTERM / canceled by caller (exit code 143) |
| hs-r29-wall2 | wall | done | 0 | 408.6 | 2026-09-11T00:20:58.731Z | `git checkout - . && git checkout -q 15a4a53fc` | Success (exit 0) |
| hs-r29-wall3 | wall | done | 0 | 415.6 | 2026-09-11T00:40:12.962Z | `git checkout - . && git checkout -q 7c8835386` | Success (exit 0) |
| hs-train-r32 | train | failed | 1 | 438.6 | 2026-09-11T19:22:57.894Z | `bun toolchain/release/train.ts 7c00e694bad079` | train: FAILED: running the wall failed |
| hs-train-r32b | train | failed | 1 | 865.4 | 2026-09-11T19:31:04.171Z | `bun toolchain/release/train.ts 30c0fd6c451445` | train: FAILED: running deploy failed |
| hs-train-r32c | train | failed | 1 | 433.6 | 2026-09-11T19:50:22.113Z | `bun toolchain/release/train.ts 26aa946f485cc4` | 2026-09-11T19:57:35.681Z deploy: FAILED: the wall prove |
| hs-train-r32d | train | done | 0 | 1835.7 | 2026-09-11T19:57:59.216Z | `bun toolchain/release/train.ts 1f9f9a03bd92c4` | Success (exit 0) |
| hs-train-r33 | train | done | 0 | 1102.2 | 2026-09-11T22:07:25.412Z | `bun toolchain/release/train.ts 96e96e7d381e5e` | Success (exit 0) |
| hs-train-r34 | train | failed | 1 | 853.9 | 2026-09-12T01:14:58.547Z | `bun toolchain/release/train.ts 80d1c08934801b` | train: FAILED: running deploy failed |
| hs-train-r34b | train | failed | 1 | 799.4 | 2026-09-12T01:30:08.783Z | `bun toolchain/release/train.ts 64486dd1d900b3` | train: FAILED: running deploy failed |
| hs-train-r34c | train | done | 0 | 1819.2 | 2026-09-12T01:46:20.835Z | `bun toolchain/release/train.ts 62a57436cc8856` | Success (exit 0) |
| hs-train-r34d | train | done | 0 | 1827.3 | 2026-09-12T02:44:08.208Z | `bun toolchain/release/train.ts 269e72f619e8db` | Success (exit 0) |
| hs-train-r34e | train | failed | 1 | 420.9 | 2026-09-12T03:14:53.412Z | `bun toolchain/release/train.ts 9e982b27c0389f` | train: FAILED: running the wall failed |
| hs-train-r34f | train | done | 0 | 1810.5 | 2026-09-12T03:22:20.136Z | `bun toolchain/release/train.ts 9e982b27c0389f` | Success (exit 0) |
| hs-train-r35 | train | done | 0 | 1849.0 | 2026-09-12T08:37:53.339Z | `bun toolchain/release/train.ts aa65a736eab834` | Success (exit 0) |
| hs-wall-r32 | wall | failed | 1 | 147.9 | 2026-09-11T19:08:18.502Z | `bun toolchain/testing/wall.ts --out /tmp/wall` | verdict=red step=land |
| hs-wall-r33 | wall-train | failed | 1 | 157.8 | 2026-09-11T20:31:56.573Z | `bun toolchain/release/train.ts 31f3658701acad` | train: FAILED: running the wall failed |
| hs-wall-r33b | wall-train | failed | 1 | 218.8 | 2026-09-11T20:35:39.224Z | `bun toolchain/release/train.ts 916eb4136c2093` | train: FAILED: running the wall failed |
| hs-wall-r33c | wall-train | failed | 1 | 469.2 | 2026-09-11T20:39:57.943Z | `bun toolchain/release/train.ts 6183ef27af76db` | train: FAILED: running the wall failed |
| hs-wall-r33d | wall-train | failed | 1 | 461.1 | 2026-09-11T20:49:45.187Z | `bun toolchain/release/train.ts 5ad8898bc7ba67` | train: FAILED: running the wall failed |
| hs-wall-r33e | wall-train | done | 0 | 457.2 | 2026-09-11T20:58:13.550Z | `bun toolchain/release/train.ts 96e96e7d381e5e` | Success (exit 0) |

## Section 2: Astra Supervisors and Delegation Children

### Supervisor Architecture

Astra supervisors run gpt-6-astra with CDX_SUPERVISOR set in the lane environment.
Four supervisor lanes were executed in the 48-hour period: hs-r33-brand-build, hs-r33-email, hs-r33-email-2, and cdx-visibility.
These four supervisors spawned 5 Gemini worker children across three releases.

### Waiting Time and Duration Outside Waits

Supervisor round 1 metrics from digests/round-metrics.json isolate supervisor execution from subsequent review rounds:

| Supervisor Lane | Round | Engine | Duration (s) | wait_status (s) | Duration Outside Waits (s) | In Tokens | Out Tokens | Cached Tokens | Children |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hs-r33-brand-build | 1 | gpt | 820.6 | 140.0 | 680.7 | 4,652,720 | 35,292 | 4,510,464 | r33-brand-terminal, r33-brand-guard |
| hs-r33-email | 1 | gpt | 662.1 | 94.9 | 567.1 | 4,957,622 | 16,200 | 4,828,928 | r33-email-renderer |
| hs-r33-email-2 | 1 | gpt | 502.5 | 59.9 | 442.5 | 2,609,894 | 11,297 | 2,515,072 | r33-email-assets-2 |
| cdx-visibility | 1 | gpt | 474.7 | 180.2 | 294.5 | 3,955,231 | 21,279 | 3,794,688 | visibility-docs |

Cumulative supervisor wait_status duration reached 475.06 seconds across round 1.
The duration outside waits (1,984.8 seconds across all 4 supervisors) represents model reasoning, token generation, streaming, and tool execution, not continuous command execution.

### Child Lane Performance and Cost

All five child lanes executed on the Gemini engine (gemini-3.8-flash-high).

| Child Lane | Parent Lane | Engine | Duration (s) | In Tokens | Out Tokens | Cached Tokens | Steers Received | Exit State |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r33-brand-terminal | hs-r33-brand-build | gemini | 516.4 | 642,602 | 88,940 | 9,366,655 | 4 | closed (exit 0) |
| r33-brand-guard | hs-r33-brand-build | gemini | 505.6 | 528,587 | 95,970 | 7,588,804 | 5 | closed (exit 0) |
| r33-email-renderer | hs-r33-email | gemini | 350.2 | 304,733 | 81,593 | 4,773,430 | 7 | closed (exit 0) |
| r33-email-assets-2 | hs-r33-email-2 | gemini | 237.0 | 273,333 | 27,369 | 3,382,452 | 2 | closed (exit 0) |
| visibility-docs | cdx-visibility | gemini | 367.3 | 506,597 | 49,605 | 9,768,715 | 2 | closed (exit 0) |

Total child tokens: 2,255,852 input, 343,477 output, 34,880,056 cached.
Total child execution time: 1976.3 seconds (32.9 minutes).

### Delegation Utility and Quality Considerations

1. Child gate limitations: Children were assigned whitespace-only gates (`git diff --check`). They executed without unit test or type check gates, allowing semantic bugs to leak to the supervisor.
2. Mid-flight steering: Supervisors monitored children via `cdx tail` and issued 20 mid-flight steers through `cdx send` (r33-email-renderer received 7 steers; r33-brand-guard received 5; r33-brand-terminal received 4; r33-email-assets-2 received 2; visibility-docs received 2).
3. Supervisor rework: In hs-r33-brand-build, Astra rewrote child regex colour matchers into numeric evaluators, expanded black/white coverage, fixed label alignment, and corrected an invalid login command.
4. Comparative quality is an unverified hypothesis: The 4 supervisors consumed 16,175,467 GPT input tokens to direct 2,255,852 Gemini child input tokens. While this generated coordination overhead, there is no controlled comparison demonstrating that a direct Gemini lane would achieve equivalent architectural quality on complex design tasks.

## Section 3: Head-Side Feed and Spawn Audit

### Journal Visibility Limits

1. spawn-audit.log temporal boundary: The file spawn-audit.log terminated on 2026-09-09T09:31:55, exactly 25 hours before the 48-hour study window began. It contains 693 historical entries and zero entries from release cycles 32 through 35.
2. feed.log push-only architecture: feed.log records exclusively push events emitted by runners (started, progress, question, partial, terminal, gate-started, gate-finished, report-written, job-exit). It does not log read operations initiated by the head, such as `cdx status`, `cdx wait`, `cdx list`, or log reads.
3. Observability limit: The head session's polling rate cannot be measured from feed.log. Polling frequency can only be observed within agent-driven supervisor rounds.

### Measured Lower Bounds

1. Question response latency: Exactly 9 lane questions were logged in feed.log and questions/*.json during the 48-hour window.
All 9 questions were answered by the head. Zero questions timed out or remained unanswered.
Total elapsed turnaround time was 286.72 seconds (4.78 minutes).
Median turnaround time was 21.66 seconds, ranging from 7.49 seconds (r33-cli) to 122.38 seconds (hs-r31-tags-a).
This turnaround latency represents elapsed time until an answer was recorded, not active operator labor time.

| Question File | Lane | Round | Asked At | Answered At | Turnaround (s) | Subject |
| --- | --- | --- | --- | --- | --- | --- |
| hs-r26-identity-r1-1.json | hs-r26-identity | 1 | 2026-09-10T12:50:04Z | 2026-09-10T12:50:30Z | 25.9 | Bootstrap passkey authorization token |
| hs-r30-f184-r1-1.json | hs-r30-f184 | 1 | 2026-09-11T10:49:18Z | 2026-09-11T10:49:40Z | 21.7 | Target documentation file placement |
| hs-r30-f185-r4-1.json | hs-r30-f185 | 4 | 2026-09-11T11:12:47Z | 2026-09-11T11:12:54Z | 7.8 | Typecheck const reference scope |
| hs-r31-tags-a-r1-1.json | hs-r31-tags-a | 1 | 2026-09-11T15:52:57Z | 2026-09-11T15:55:00Z | 122.4 | Missing check option in qa.ts OPTS |
| r32-public-r1-1.json | r32-public | 1 | 2026-09-11T16:53:17Z | 2026-09-11T16:53:31Z | 14.0 | Ownership of public pricing page |
| r33-cli-r1-1.json | r33-cli | 1 | 2026-09-11T17:57:40Z | 2026-09-11T17:57:47Z | 7.5 | SubcommandHelp signature options |
| r33-kit-r1-1.json | r33-kit | 1 | 2026-09-11T18:02:26Z | 2026-09-11T18:03:16Z | 49.7 | Kit archive root README creation |
| r32-fix-portal-r1-1.json | r32-fix-portal | 1 | 2026-09-11T18:42:47Z | 2026-09-11T18:42:59Z | 11.9 | FAQ pricing sentence file location |
| r34-support-r1-1.json | r34-support | 1 | 2026-09-12T00:28:55Z | 2026-09-12T00:29:20Z | 25.8 | Support ticket author and plan principals |

2. Observed supervisor polling: In supervisor logs, wait commands clustered at 30-second and 45-second intervals (`cdx wait --timeout 30`, `cdx wait --timeout 45`), with 1-second non-blocking probes and direct log inspection (`cdx tail -n 5`).

### Verification of Lane Suffixes and Parallel Shards

Inspection of briefs confirms that lane name suffixes predominantly represent parallel sharding rather than failed retries:

1. Disjoint parallel shares: hs-r31-tags-a and hs-r31-tags-b were disjoint assignments. Tags-a was assigned portal, cli, create, and mcp channels; tags-b was assigned http, typescript, python, and go channels.
2. Suffixes require brief inspection. hs-r32-http-c explicitly replaces four voided attempts from hs-r32-http-b. hs-r33-portal-c explicitly replaces four voided attempts from hs-r33-portal-a. These are rework, not independent shards. Other suffixes alone do not prove duplication.
3. True retries after failure: hs-r32-sdk-b was a genuine retry of hs-r32-sdk following a malformed tool call error in round 2. hs-r31-desk-spec2 was a retry of hs-r31-desk-spec following termination via SIGTERM.
4. Scope addition: hs-r33-email-2 was commissioned after hs-r33-email at owner request for an expanded second pass.
5. Open lanes: All 147 ledger entries finished in closed status (`work.state == "closed"`). No open lanes remained.

## Assumptions

1. Detached job durations are computed as the difference between finishedAt and startedAt recorded in jobs-48h.json.
2. Supervisor round metrics are taken specifically from round 1 in digests/round-metrics.json, excluding subsequent review rounds.
3. Question turnaround latency reflects elapsed notification-to-answer time, not continuous operator labor time.

