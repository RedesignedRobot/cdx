// Standing lane rules, review frames, and resume prompt construction.

import { retiredLaneRule } from "./account-sync.ts";
import { config } from "./config.ts";
import { type Engine, laneRunning, type Ledger, type Spec, workCwdOf } from "./ledger.ts";
import { specPathOf } from "./reports.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import { existsSync, readFileSync } from "node:fs";

// Standing rules live here; task briefs supply the outcome and owned files.
const LANE_ROLE = "Claude is the owner's liaison for briefs, answers, review, and merging; your final report is its handoff.";
const WORK_LIMITS = "Never commit, push, deploy, or start servers beyond tests; the liaison integrates after independent review.";
const READ_ONLY = "The sandbox makes this lane read-only: commands and network work, but every file write fails, scratch files in /tmp included.";
const WORK_REPORT = "Report the outcome, changed files, risks, child outcomes, and report paths in plain prose and short lists, without em dashes, filler, or praise.";
const REVIEW_REPORT = "Report your conclusion and evidence in plain prose and short lists, without em dashes or filler.";
const ASK_RULE = 'Read available evidence, then use `cdx ask "<question>"` for missing answers that change outcome or authorization; timeout is not approval, so stop dependent work, continue authorized work, and report the unanswered question.';
const WORKER_BAN = "Workers cannot drive cdx lanes or jobs or spawn subagents; ask the supervisor or liaison for dependencies.";
const STANDARD_RULE = "Read source, fix causes with the simplest design, and delete unnecessary code and tests.";
const CODEGRAPH_RULE = "In a repository with .codegraph/, codegraph explore (CLI) or codegraph_explore (MCP) is the first tool for every code question, before grep, rg, find, ls, cat or file reads. Text tools are only for literal sweeps, non-code assets, logs and file-existence checks. Codegraph returns source; do not reread the same source with text tools. If codegraph fails, report the failure and resolve availability before continuing the code question.";
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
export const GEMINI_WORKER_RULES = [
  WORKER_BAN,
  "Deliver within your files; the parent owns design and scope.",
  ASK_RULE,
  "Use shell codegraph explore for code questions. Batch independent queries. For permitted non-code reads, read files under 800 lines whole once; reread only after they change.",
  "Remove temporary diagnostics and report commands and scope separately from the gate verdict. End with Assumptions or 'none'.",
];
const SUPERVISOR_RULES = [
  "Own design and cross-cutting decisions; delegate bounded work to Sol children (the default engine) or Gemini children for mechanical sweeps, use read-only consults when useful, and keep delegation one level deep with native subagents disabled.",
  ...GPT_RULES,
  'Use `cdx spawn <child> --bg --gate "<cmd>" "<brief>"` for Sol or add `--engine gemini`; `cdx consult <child> --bg "<question>"` starts an advisor, and `cdx wait <child>... --report` returns 2 for questions answered through `cdx reply`.',
  "Never edit child-owned files. Put shared findings in a file referenced by child briefs and batch corrections into one send per child per review pass.",
  "Give writers exclusive files and each child an outcome, gate, and relevant facts; start independent children together. Every writer child gets its own worktree branched from your branch head at spawn, so children never share a tree.",
  "Merge green children into your branch with `cdx land <child>` or `cdx land --batch <child>...`; land a child whose work another child needs before spawning the dependent child, and land every green child before your report.",
  "Drive only your children and answer promptly; ask the liaison about wrong gates without changing them, and leave jobs, adopt, and clean to it.",
  "Join children and read reports and gate results without rerunning checks; ending stops active children and fails your round if any remained running.",
  "Send children one-sentence progress updates, keep reports short, and end your report with duplicated investigation or rework.",
];

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
  const builtIns = reviewOnly ? [LANE_ROLE, READ_ONLY, REVIEW_REPORT] : [LANE_ROLE, WORK_LIMITS, WORK_REPORT];
  builtIns.push(CODEGRAPH_RULE);
  if (!reviewOnly) {
    if (opts.supervisor && engine === "gpt") builtIns.push(...SUPERVISOR_RULES);
    else builtIns.push(...(engine === "gemini" ? GEMINI_WORKER_RULES : GPT_WORKER_RULES));
  }
  if (!reviewOnly) builtIns.push(VERIFICATION_RULE);
  if (!reviewOnly && !opts.supervisor) builtIns.push(`Keep test invocations within ${config.visibility?.testRuns ?? VISIBILITY_DEFAULTS.testRuns} this round, including the lane gate. Run each touched spec once; ask the supervisor if the gate needs more.`);
  const sections = [builtIns.map((rule) => `- ${rule}`).join("\n")];
  if (config.rules.length > 0) sections.push(config.rules.filter((rule) => !retiredLaneRule(rule)).map((rule) => `- ${rule}`).join("\n"));
  const projectRules = `${cwd}/.cdx-rules.md`;
  if (existsSync(projectRules)) {
    const text = readFileSync(projectRules, "utf8").trim();
    if (text) sections.push(text);
  }
  return sections.join("\n");
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

export const CONSULT_FRAME = `CONSULT. Advise the supervisor or the owner's liaison. Challenge the premise when evidence supports a better approach. ${STANDARD_RULE} Ground recommendations in the tree; separate verified facts from inference. Recommend one approach and explain rejected alternatives. You have full access: run commands, use the network, and write notes or maps where the caller asks. Edit tracked source only when the question asks for it. End with Decisions for the caller, limited to choices that need the caller or owner.`;

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
