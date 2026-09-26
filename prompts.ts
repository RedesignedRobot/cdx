// Standing lane rules, review frames, and resume prompt construction.

import { type LaneRole, retiredLaneRule } from "./account-sync.ts";
import { config } from "./config.ts";
import { CODEGRAPH_EXPLORE } from "./codegraph-policy.ts";
import { contextDigest, digestLine } from "./context.ts";
import { type Engine, laneRunning, type Ledger, type Spec, workCwdOf } from "./ledger.ts";
import { specPathOf } from "./reports.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import { existsSync, readFileSync } from "node:fs";

// Standing rules live in the lane home: Codex loads $CODEX_HOME/AGENTS.md into
// every thread and agy loads the agent file, so the brief carries only a pointer
// and the facts that differ per lane. Task briefs supply the outcome and owned files.
const LANE_ROLE = "Claude is the owner's liaison for briefs, answers, review, and merging; your final report is its handoff.";
const WORK_LIMITS = "Never commit, push, deploy, or start servers beyond tests; the liaison integrates after independent review.";
const READ_ONLY = "The sandbox makes this lane read-only: commands and network work, but every file write fails, scratch files in /tmp included.";
const WORK_REPORT = "Report the outcome, changed files, risks, child outcomes, and report paths in plain prose and short lists, without em dashes, filler, or praise.";
const REVIEW_REPORT = "Report your conclusion and evidence in plain prose and short lists, without em dashes or filler.";
const SECRETS_RULE = "Never print or inline secrets; use environment lookups.";
const ASK_RULE = 'Read available evidence, then use `cdx ask "<question>"` for missing answers that change outcome or authorization; timeout is not approval, so stop dependent work, continue authorized work, and report the unanswered question.';
const WORKER_BAN = "Workers cannot drive cdx lanes or jobs or spawn subagents; ask the supervisor or liaison for dependencies.";
const STANDARD_RULE = "Read source, fix causes with the simplest design, and delete unnecessary code and tests.";
export const CODEGRAPH_RULE = `In a repository with .codegraph/, \`${CODEGRAPH_EXPLORE} "<question>"\` is the first tool for every code question, before grep, rg, find, ls, cat or file reads. Text tools are only for literal sweeps, non-code assets, logs and file-existence checks. Codegraph returns source; do not reread the same source with text tools. If codegraph is missing, the repository is unindexed, or the call times out (exit 142) or fails, fall back to rg and file reads and note it in the report.`;
const CHALLENGE_RULE = "Own technical judgment, challenge a wrong brief through cdx ask before changing scope, and report unresolved disagreement.";
const TOKEN_ECONOMY = "Reuse evidence, target reads, keep output compact, and skip polling, timers, or status checks that add no information.";
const GPT_RULES = [
  TOKEN_ECONOMY,
  CHALLENGE_RULE,
  STANDARD_RULE,
  "Finish authorized work, resolve routine reversible choices, prepare concrete results before decisions, and incorporate steering or side questions without dropping the task.",
  "Within runtime constraints, brief and liaison replies outrank project and skill rules; quote any blocking instruction with its path and conflict, without inventing approvals.",
  "Keep one test per real rule and delete fixture restatements or implementation mirrors.",
  ASK_RULE,
];
export const VERIFICATION_RULE = "Run one typecheck before the report, using vp check --no-fmt or the repository equivalent named in .cdx-rules.md, and each touched spec once for mutation proof. Never run the suite or the wall; the lane gate owns those.";
const GPT_WORKER_RULES = [WORKER_BAN, ...GPT_RULES];
const SUPERVISOR_RULES = [
  "Own design and cross-cutting decisions; delegate bounded work to Sol children (the default engine) or Gemini children for mechanical sweeps, use read-only consults when useful, and keep delegation one level deep with native subagents disabled.",
  ...GPT_RULES,
  'Use `cdx spawn <child> --bg --gate "<cmd>" "<brief with the four headings>"` for Sol or add `--engine gemini`; `cdx consult <child> --bg "<question>"` starts an advisor, and `cdx wait <child>... --report` returns 2 for questions answered through `cdx reply`.',
  "Never edit child-owned files. Put shared findings in a file referenced by child briefs and batch corrections into one send per child per review pass.",
  "Give writers exclusive files and each child a gate and relevant facts. cdx refuses a child brief unless it has these markdown headings, each on its own line with text under it: `## Outcome`, `## Files` (the child's exclusive files), `## Acceptance` and `## Out of scope`. Start independent children together. Every writer child gets its own worktree branched from your branch head at spawn, so children never share a tree.",
  "Merge green children into your branch with `cdx land <child>` or `cdx land --batch <child>...`; land a child whose work another child needs before spawning the dependent child, and land every green child before your report.",
  "Run each cdx command as a plain call with no redirect, pipe, env prefix, $(...) or wildcard, because only plain calls leave the sandbox; never run git writes yourself, cdx does them.",
  "Drive only your children and answer promptly; ask the liaison about wrong gates without changing them, and leave jobs and clean to it.",
  "Join children and read reports and gate results without rerunning checks; ending stops active children and fails your round if any remained running.",
  "Send children one-sentence progress updates, keep reports short, and end your report with duplicated investigation or rework.",
];

const roleTitle = (role: LaneRole) => role.review ? "review lane" : role.supervisor ? "supervisor lane" : "work lane";
const testRunRule = () => `Keep test invocations within ${config.visibility?.testRuns ?? VISIBILITY_DEFAULTS.testRuns} this round, including the lane gate. Run each touched spec once; ask the supervisor if the gate needs more.`;
const ownerRules = () => config.rules.filter((rule) => !retiredLaneRule(rule));

// The AGENTS.md cdx writes into each role's Codex lane home.
export function laneInstructions(role: LaneRole = {}): string {
  const rules = role.review ? [LANE_ROLE, READ_ONLY, REVIEW_REPORT, SECRETS_RULE, CODEGRAPH_RULE]
    : [LANE_ROLE, WORK_LIMITS, WORK_REPORT, SECRETS_RULE, CODEGRAPH_RULE, ...(role.supervisor ? SUPERVISOR_RULES : GPT_WORKER_RULES),
      VERIFICATION_RULE, ...(role.supervisor ? [] : [testRunRule()])];
  const owner = ownerRules();
  return [`# cdx ${roleTitle(role)}`, "", "These are your standing rules as a cdx lane. The brief carries the task and the facts for this lane.", "",
    ...rules.map((rule) => `- ${rule}`), ...(owner.length ? ["", "## Owner rules", "", ...owner.map((rule) => `- ${rule}`)] : [])].join("\n") + "\n";
}

// Save what the conversation received, including repository rules, in its existing spec.
export function promptRules(prompt: string): string | undefined {
  return /Ground rules:\n([\s\S]*?)\n\nTask:\n/.exec(prompt)?.[1]?.split("\n\nYour previous round ended")[0];
}

export function resumePrompt(followUp: string, current: string, previous: string | undefined, recovery = ""): string {
  return [current !== previous ? `Replacement ground rules, superseding the previous block:\n${current}` : "",
    recovery, `Task:\n${followUp}`].filter(Boolean).join("\n\n");
}

export function conversationRules(lane: string, round: number, session: string | undefined, engine: Engine, review: boolean): string | undefined {
  for (let n = round; n > 0; n--) {
    try {
      const saved = JSON.parse(readFileSync(specPathOf(lane, n), "utf8")) as Spec;
      if (saved.engine !== engine || Boolean(saved.reviewDir) !== review) continue;
      const thread = saved.sessionId ?? saved.sourceThreadId;
      if (thread && thread !== session) continue;
      const rules = saved.injectedRules ?? promptRules(saved.prompt);
      if (rules !== undefined) return rules;
    } catch { /* older or missing spec */ }
  }
  return undefined;
}

export function pendingTestsRefusal(partial: string, followUp: string): string | undefined {
  const lines = partial.replaceAll("\r\n", "\n").split("\n");
  const pendingProcess = lines.find((line) => line.startsWith("Outstanding process: "))?.slice("Outstanding process: ".length).trim();
  const evidence = lines.indexOf("Evidence paths mentioned in transcript:");
  if (lines[0] !== "# Partial recovery" || !pendingProcess || pendingProcess === "None recorded."
    || evidence < 0 || lines[evidence + 1] !== "None recorded.") return;
  const [header, ...state] = followUp.replaceAll("\r\n", "\n").split("\n");
  if (header === "Recovery:" && state.filter((line) => line.trim()).length >= 2) return;
  return `Pending-only partial requires a Recovery: first line, followed by the process result and remaining work on separate lines.\n${partial}`;
}

export function sharedTreeLanes(lane: string, cwd: string, ledger: Ledger, treeRoot: (cwd: string) => string | undefined): string[] {
  const root = treeRoot(cwd);
  if (!root) return [];
  return Object.entries(ledger).filter(([name, entry]) => name !== lane && laneRunning(entry)
    && treeRoot(entry.kind === "review" ? entry.review!.cwd : workCwdOf(entry)) === root).map(([name]) => name).sort();
}

export function houseRules(cwd: string, reviewOnly: boolean, engine: Engine = "gpt", opts: { supervisor?: boolean } = {}): string {
  const role = { review: reviewOnly, supervisor: Boolean(opts.supervisor) && engine === "gpt" };
  const facts = [engine === "gpt"
    ? `Standing rules: the "cdx ${roleTitle(role)}" AGENTS.md from your lane home.`
    : `Standing rules: your cdx agent file.`];
  if (engine !== "gpt") facts.push(...ownerRules(), ...(reviewOnly ? [] : [testRunRule()]));
  const projectRules = `${cwd}/.cdx-rules.md`;
  if (existsSync(projectRules) && readFileSync(projectRules, "utf8").trim()) facts.push(`Project rules: read ${projectRules} before starting.`);
  const digest = digestLine(contextDigest(cwd));
  if (digest) facts.push(digest);
  return facts.map((fact) => `- ${fact}`).join("\n");
}

export const REVIEW_FINDINGS_SCHEMA = {
  type: "object",
  required: ["report", "findings"],
  additionalProperties: false,
  properties: {
    report: { type: "string", description: "the full markdown review report" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "confidence", "file", "line", "summary"],
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["P1", "P2", "P3"] },
          confidence: { type: "string", enum: ["CONFIRMED", "PLAUSIBLE"] },
          file: { type: "string" },
          line: { type: "integer" },
          summary: { type: "string" },
        },
      },
    },
  },
};

const REVIEW_FRAME_BASE = "ADVERSARIAL REVIEW. Find defects in behavior, contracts, data handling, or verification. For each finding give severity, file and line, and the input or state that produces the wrong result. P1 breaks users or data; P2 fails under realistic conditions; P3 is a smaller defect. Mark traced paths CONFIRMED and unverified paths PLAUSIBLE. Rank findings by severity. If clean, say so in one line. Omit praise and style remarks. Do not run the test suite; the lane gate already ran it and its result is in the report.";

export function reviewFrame(_engine: Engine): string {
  return `${REVIEW_FRAME_BASE} Your final answer is captured as structured output: put the complete markdown report in the report field and every finding in the findings array (empty when clean).`;
}

export const CONSULT_FRAME = `CONSULT. Advise the supervisor or the owner's liaison. Challenge the premise when evidence supports a better approach. ${STANDARD_RULE} Ground recommendations in the tree; separate verified facts from inference. Recommend one approach and explain rejected alternatives. You run read-only: commands and the network work, file writes fail, so everything the caller needs goes in your final message. End with Decisions for the caller, limited to choices that need the caller or owner.`;

export function resumeRefusal(kind: string | undefined, lane: import("./ledger.ts").Lane, head: string): string | undefined {
  const fresh = "New scope requires a fresh lane seeded from the report. Resume accepts only --fix gate or --fix review on the same diff.";
  if (lane.consult || !["gate", "review"].includes(kind ?? "")) return fresh;
  const review = lane.reviewAttestations?.at(-1);
  const previous = kind === "gate" ? lane.gateReceipt : review;
  if (kind === "review" && !review) return "No review is attached to this lane; review its tree with any review lane first.";
  if (!previous?.head || previous.head !== head) return `The diff HEAD changed. ${fresh}`;
  if (kind === "gate" && (!lane.gateReceipt || lane.gateReceipt.exitCode === 0 && lane.gateReceipt.valid)) return `There is no failed gate to fix. ${fresh}`;
  if (kind === "review" && review!.closed) return `There are no blocking review findings to fix. ${fresh}`;
}

export function reviewLoopClosed(findings: unknown): boolean {
  return Array.isArray(findings) && findings.every((item) => item && item.severity === "P3");
}

export function reviewerForTree(ledger: Ledger, tree: import("./ledger.ts").GateTree): string | undefined {
  return Object.entries(ledger).find(([, item]) => item.reviewTree?.tree === tree.tree && item.reviewTree.head === tree.head)?.[0];
}

export function fixReviewPrompt(previous: import("./ledger.ts").GateTree, current: import("./ledger.ts").GateTree, report: string): string {
  return `Check only the fix diff against the earlier findings and regressions introduced by those fixes. Use git diff ${previous.tree} ${current.tree}.\nPrevious findings:\n${report}`;
}
