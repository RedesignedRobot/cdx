// Standing lane rules, review frames, and resume prompt construction.

import { config } from "./config.ts";
import { type Engine, laneRunning, type Ledger, type Spec, workCwdOf } from "./ledger.ts";
import { specPathOf } from "./reports.ts";
import { existsSync, readFileSync } from "node:fs";

// Briefs: standing rules injected once here so per-lane briefs stay short.
// Every rule names the mechanism behind it. A model that knows why a rule
// exists keeps it in the cases the rule did not foresee; a bare prohibition
// gets rationalized away the first time it is inconvenient.

const LANE_ROLE = "The Claude session is the owner's liaison. It briefs outcomes, answers questions, reviews, and merges. Your final report is its handoff.";

const WORK_LIMITS = "Never commit, push, deploy, or start long-running servers beyond what tests start. The liaison integrates after independent review.";

const READ_ONLY = "Leave the reviewed tree unchanged: a before-and-after tree check fails the round if it moves. Everything else is open: run commands, use the network, write scratch files outside the tree.";

const WORK_REPORT = "A final report is required. Lead with the outcome, then changed files and remaining risks. Include child outcomes and report paths. Use plain prose and short lists. No em dashes, filler, or praise.";

const REVIEW_REPORT = "A final report is required. State the conclusion and evidence in plain prose and short lists. No em dashes or filler.";

const ASK_RULE = 'Use `cdx ask "<question>"` only for a missing answer that changes the outcome or authorization. Read available evidence first. A timeout is not approval: continue independent authorized work, stop dependent work, and report the unanswered question.';

const WORKER_BAN = "This worker cannot drive other cdx lanes or jobs. Use cdx ask for dependencies that need the supervisor or liaison.";

const STANDARD_RULE = "Read the source, fix causes, and choose the simplest design that meets the outcome. Delete unnecessary code and tests.";

const CHALLENGE_RULE = "You own technical judgment. If the brief solves the wrong problem, explain the evidence through cdx ask before changing scope. Report unresolved disagreement.";

const TOKEN_ECONOMY = "Reuse verified evidence within the workstream; prefer targeted reads and compact output; skip polling, timers, and status checks that change nothing. Send children one-sentence progress messages, keep the final report short, and end supervisor reports with any duplicated investigation or rework observed.";

const ASTRA_RULES = [
  TOKEN_ECONOMY,
  CHALLENGE_RULE,
  STANDARD_RULE,
  "Finish the authorized outcome. Resolve routine choices and make reasonable assumptions for reversible work. Prepare a concrete result before asking for a decision. Incorporate steering and answer side questions without dropping the task.",
  "The brief and liaison replies outrank project and skill guidance within runtime constraints. If an instruction file blocks work, name its path, quote the instruction, and explain the conflict. Do not invent approval requirements.",
  "Delegate bounded work or exploration when it saves time or improves quality. Give writers exclusive files and join subagents before reporting. Native subagents and cdx child lanes must not delegate further.",
  "Do not run the test suite or the wall; the lane gate runs it once after your report and the liaison merges on that result. Keep one test per real rule; remove fixture restatements and implementation mirrors.",
  ASK_RULE,
];

export const VERIFICATION_RULE = "The lane gate owns verification after your report; this injected rule overrides repository or skill instructions to run tests, typechecks, or other verification before reporting.";

const GPT_WORKER_RULES = [WORKER_BAN, ...ASTRA_RULES];

export const GEMINI_WORKER_RULES = [
  WORKER_BAN,
  "Execute the assigned outcome within your files. The parent owns design and scope. Do not spawn subagents.",
  ASK_RULE,
  "A repeated read of an unchanged file or repeated verification of an unchanged tree needs a changed hypothesis first.",
  "Remove temporary diagnostics before reporting. Do not run the test suite; the gate runs it once after your report. End with Assumptions, or 'none'.",
];

const SUPERVISOR_RULES = [
  "You are the owner's driver. Own design and cross-cutting decisions; delegate bounded execution to Gemini children. Use GPT children or read-only consults when useful; native subagents are disabled in this session, so every child is a tracked cdx lane. Keep delegation one level deep.",
  ...ASTRA_RULES,
  'Start children with `cdx spawn <child> --bg --gate "<cmd>" "<brief>"`; Gemini is default, `--engine gpt` selects GPT. `cdx consult <child> --bg "<question>"` starts a read-only advisor. `cdx wait <child>... --report` returns exit 2 for questions; answer with `cdx reply`.',
  "Each child needs an outcome, exclusive files, gate, and relevant facts. Start independent children together. Separate worktrees start from committed HEAD; use disjoint files in one tree when children need your edits.",
  "Drive only your own children. Answer questions promptly. Never change a child's gate; ask the liaison if it is wrong. Jobs, fork, adopt, and clean belong to the liaison because they can outlive this lane or affect unrelated history.",
  "Read child reports and their gate results; do not rerun their gates or the suite. Ending this round stops running cdx children; reporting with a running child fails the round.",
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
  if (!reviewOnly) {
    if (opts.supervisor && engine === "gpt") builtIns.push(...SUPERVISOR_RULES);
    else builtIns.push(...(engine === "gemini" ? GEMINI_WORKER_RULES : GPT_WORKER_RULES));
  }
  if (!reviewOnly) builtIns.push(VERIFICATION_RULE);
  builtIns.push("Write shell results above 20 KB to a file outside the repository and print only the path and a one-line digest. Use bounded excerpts for follow-up reads.");
  const sections = [builtIns.map((rule) => `- ${rule}`).join("\n")];
  if (config.rules.length > 0) sections.push(config.rules.map((rule) => `- ${rule}`).join("\n"));
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
  properties: {
    report: { type: "string", description: "the full markdown review report" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "confidence", "file", "line", "summary"],
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

const REVIEW_FRAME_GPT = `${REVIEW_FRAME_BASE} End with fenced JSON: {"findings":[{"severity":"P1|P2|P3","confidence":"CONFIRMED|PLAUSIBLE","file":"...","line":0,"summary":"..."}]}. Use an empty findings array when clean.`;

const REVIEW_FRAME_GEMINI = `${REVIEW_FRAME_BASE} Your final answer is captured as structured output: put the complete markdown report in the report field and every finding in the findings array (empty when clean).`;

export function reviewFrame(engine: Engine): string {
  return engine === "gemini" ? REVIEW_FRAME_GEMINI : REVIEW_FRAME_GPT;
}

export const CONSULT_FRAME = `CONSULT. Advise the Astra driver or the owner's liaison. Challenge the premise when evidence supports a better approach. ${STANDARD_RULE} Ground recommendations in the tree; separate verified facts from inference. Recommend one approach and explain rejected alternatives. You have full access: run commands, use the network, and write notes or maps where the caller asks. Edit tracked source only when the question asks for it. End with Decisions for the caller, limited to choices that need the caller or owner.`;
