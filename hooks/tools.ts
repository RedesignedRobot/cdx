import { renderBrief } from "../brief-contract";
import { safeText } from "../safe-text";
// Table of tools exposed by the cdx mod. Pure definitions and argv builders.
// Evaluated both in Claude Code hooks and in tests.

export interface ToolRunResult {
  argv: string[];
  stdin?: string;
  // A shorter bound for a command known to be quick; absent means the ceiling.
  timeoutMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => ToolRunResult;
}

// $.process.run rejects any timeoutMs above ten minutes, and a rejecting
// handler reaches the head as "no tool.call hook answered". Its own default
// is 30 seconds, shorter than the foreground part of a spawn (git worktree
// add plus the configured worktreeSetup) or a close removing a worktree, so
// every tool runs with the ceiling unless it names a shorter bound.
export const MAX_PROCESS_TIMEOUT_MS = 10 * 60_000;

export const TOOLS: ToolDefinition[] = [
  {
    name: "land", description: "Commit green lanes, gate the merge result once unless a receipt already proves it, fast-forward the base, push, remove worktrees and branches, and close. Pass lanes for a batch; a red batch names the lane that broke it and lands the green prefix. A merge gate longer than ten minutes needs `cdx land` from a terminal.",
    inputSchema: { type: "object", properties: { lane: { type: "string" }, lanes: { type: "array", items: { type: "string" }, description: "Land several lanes with one gate" } } },
    run: (input) => {
      if (Array.isArray(input.lanes) && input.lanes.length) {
        if (input.lane !== undefined) throw new Error("land takes lane or lanes, not both");
        if (!input.lanes.every(isName)) throw new Error("invalid lanes: every item must be a lane name");
        return { argv: ["land", "--batch", ...input.lanes] };
      }
      if (!isName(input.lane)) throw new Error("missing required field: lane or lanes");
      return { argv: ["land", input.lane] };
    },
  },
  {
    name: "ask", description: "Ask Gemini a synchronous read-only code question without creating a lane. Returns file and line evidence within 90 seconds.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, cd: { type: "string" } }, required: ["question", "cd"] },
    run: (input) => ({ argv: ["ask", "--cd", String(input.cd), "-"], stdin: String(input.question), timeoutMs: 100_000 }),
  },
  {
    name: "spawn",
    description:
      "Spawn a new cdx work lane. A work brief needs an outcome, owned files, acceptance, out-of-scope and a gate (gate or the repository's .cdx-gate); pass them as fields or as \"## Outcome\", \"## Files\", \"## Acceptance\", \"## Out of scope\" sections in brief. A supervisor also needs two or more children file sets. The brief is delivered whole through stdin; completion arrives as a [cdx] event.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name for the new lane" },
        brief: { type: "string", description: "Task brief for the lane: context and constraints, plus any sections not passed as fields" },
        outcome: { type: "string", description: "What must be true when the lane is done" },
        files: { type: "array", items: { type: "string" }, description: "Files the lane owns" },
        acceptance: { type: "string", description: "The assertion that separates success from a plausible wrong answer" },
        outOfScope: { type: "string", description: "What the lane must not do or touch" },
        children: { type: "array", items: { type: "string" }, description: "Supervisor only: one child file set per item, two or more" },
        scopePolicy: { type: "string", enum: ["ask", "extend", "stop"], description: "Files outside the brief: extend edits and lists them (default), stop ends the round, ask asks the head" },
        engine: { type: "string", enum: ["gpt", "gemini"], description: "Execution engine" },
        model: { type: "string", description: "Model alias or id" },
        supervisor: { type: "boolean", description: "Run lane as supervisor" },
        cd: { type: "string", description: "Absolute path of the repository the lane runs in (required: the session directory follows the shell, so the tool never guesses); with worktree, the repository the worktree is cut from" },
        worktree: { type: "string", description: "Worktree path or name" },
        gate: { type: "string", description: "Verification command to run before reporting" },
        pre: { type: "string", description: "Setup command to run before starting work" },
        effort: { type: "string", description: "Reasoning effort" },
        maxRuntime: { type: "number", description: "Maximum runtime in minutes" },
        expect: { type: "number", description: "Expected duration in minutes before an overrun notice" },
        account: { type: "string", description: "Account name" },
        addDirs: { type: "array", items: { type: "string" }, description: "Additional directories" },
        schema: { type: "string", description: "Structured output JSON schema path" },
        images: { type: "array", items: { type: "string" }, description: "Image paths to attach" },
      },
      required: ["lane", "brief", "cd"],
    },
    run: (input) => {
      const argv = ["spawn", String(input.lane)];
      if (input.engine) argv.push("--engine", String(input.engine));
      if (input.model) argv.push("--model", String(input.model));
      if (input.supervisor) argv.push("--supervisor");
      if (input.scopePolicy) argv.push("--scope-policy", String(input.scopePolicy));
      if (input.cd) argv.push("--cd", String(input.cd));
      if (input.worktree) argv.push("--worktree", String(input.worktree));
      if (input.gate) argv.push("--gate", String(input.gate));
      if (input.pre) argv.push("--pre", String(input.pre));
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.maxRuntime != null) argv.push("--max-runtime", String(input.maxRuntime));
      if (input.expect != null) argv.push("--expect", String(input.expect));
      if (input.account) argv.push("--account", String(input.account));
      if (Array.isArray(input.addDirs)) {
        for (const dir of input.addDirs) argv.push("--add-dir", String(dir));
      }
      if (input.schema) argv.push("--schema", String(input.schema));
      if (Array.isArray(input.images)) {
        for (const img of input.images) argv.push("--image", String(img));
      }
      argv.push("--bg", "-");
      const list = (value: unknown) => Array.isArray(value) ? value.map(String) : undefined;
      const text = (value: unknown) => typeof value === "string" ? value : undefined;
      const brief = renderBrief({ outcome: text(input.outcome), files: list(input.files), acceptance: text(input.acceptance),
        outOfScope: text(input.outOfScope), children: list(input.children) }, String(input.brief));
      return { argv, stdin: brief };
    },
  },
  {
    name: "resume",
    description: "Repair a failed gate or P1/P2 review on the same diff. New scope needs a fresh lane seeded from the report.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name of the lane to resume" },
        followUp: { type: "string", description: "Fix instructions for the same diff" },
        fix: { type: "string", enum: ["gate", "review"], description: "Evidence being repaired" },
        effort: { type: "string", description: "Reasoning effort" },
        maxRuntime: { type: "number", description: "Maximum runtime in minutes" },
        expect: { type: "number", description: "Expected duration in minutes before an overrun notice" },
      },
      required: ["lane", "followUp", "fix"],
    },
    run: (input) => {
      const argv = ["resume", String(input.lane), "--fix", String(input.fix)];
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.maxRuntime != null) argv.push("--max-runtime", String(input.maxRuntime));
      if (input.expect != null) argv.push("--expect", String(input.expect));
      argv.push("--bg", "-");
      return { argv, stdin: String(input.followUp) };
    },
  },
  {
    name: "consult",
    description: "Start a read-only consultation lane to analyze code and answer a question.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name for the consultation lane" },
        question: { type: "string", description: "Question to investigate" },
        engine: { type: "string", enum: ["gpt", "gemini"], description: "Execution engine" },
        supervisor: { type: "boolean", description: "Run consultation as supervisor" },
        model: { type: "string", description: "Model alias or id" },
        effort: { type: "string", description: "Reasoning effort" },
        cd: { type: "string", description: "Absolute path of the repository the lane runs in (required: the session directory follows the shell, so the tool never guesses); with worktree, the repository the worktree is cut from" },
        account: { type: "string", description: "Account name" },
      },
      required: ["lane", "question", "cd"],
    },
    run: (input) => {
      const argv = ["consult", String(input.lane)];
      if (input.engine) argv.push("--engine", String(input.engine));
      if (input.supervisor) argv.push("--supervisor");
      if (input.model) argv.push("--model", String(input.model));
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.cd) argv.push("--cd", String(input.cd));
      if (input.account) argv.push("--account", String(input.account));
      argv.push("--bg", "-");
      return { argv, stdin: String(input.question) };
    },
  },
  {
    name: "panel",
    description: "Ask Astra, Sol and Claude Fable the same read-only question. cdx merges the three answers by cited path into reports/<name>.md, keeps disagreement, and sends one completion line.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Panel name; the member lanes become <name>-astra, <name>-sol, <name>-fable" },
        question: { type: "string", description: "Question every member answers; question plus pack stays under 20k chars" },
        cd: { type: "string", description: "Absolute path of the repository the members read" },
        pack: { type: "string", description: "Absolute path of a small context pack every member reads first" },
      },
      required: ["name", "question", "cd"],
    },
    run: (input) => {
      const argv = ["panel", String(input.name), "--cd", String(input.cd)];
      if (input.pack) argv.push("--pack", String(input.pack));
      argv.push("--bg", "-");
      return { argv, stdin: String(input.question) };
    },
  },
  {
    name: "review",
    description: "Start an independent code review lane. Two exclusive modes: intent reviews the working tree; uncommitted, base or commit chooses a Git diff target. Passing intent with a target flag is refused.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name for the review lane" },
        engine: { type: "string", enum: ["gpt", "gemini"], description: "Execution engine" },
        model: { type: "string", description: "Model alias or id" },
        effort: { type: "string", description: "Reasoning effort" },
        cd: { type: "string", description: "Absolute path of the repository the lane runs in (required: the session directory follows the shell, so the tool never guesses); with worktree, the repository the worktree is cut from" },
        uncommitted: { type: "boolean", description: "Review uncommitted changes" },
        base: { type: "string", description: "Base branch to compare against" },
        commit: { type: "string", description: "Specific commit to review" },
        scope: { type: "string", description: "File path pattern scope" },
        intent: { type: "string", description: "Review intent or focus" },
      },
      required: ["lane", "cd"],
    },
    run: (input) => {
      const argv = ["review", String(input.lane)];
      if (input.engine) argv.push("--engine", String(input.engine));
      if (input.model) argv.push("--model", String(input.model));
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.cd) argv.push("--cd", String(input.cd));
      if (input.uncommitted) argv.push("--uncommitted");
      if (input.base) argv.push("--base", String(input.base));
      if (input.commit) argv.push("--commit", String(input.commit));
      if (input.scope) argv.push("--scope", String(input.scope));
      argv.push("--bg");
      if (input.intent !== undefined && input.intent !== null && String(input.intent).length > 0) {
        argv.push("-");
        return { argv, stdin: String(input.intent) };
      }
      return { argv };
    },
  },
  {
    name: "events",
    description: "Return every owned event not yet delivered: the mod's buffer, then the feed.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: () => ({ argv: ["events", "--json"] }),
  },
  {
    name: "send",
    description: "Send steering instructions or a message to a running lane.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Target lane name" },
        text: { type: "string", description: "Message text to deliver" },
      },
      required: ["lane", "text"],
    },
    run: (input) => ({
      argv: ["send", String(input.lane), "-"],
      stdin: String(input.text),
    }),
  },
  {
    name: "reply",
    description: "Answer an open question asked by a lane.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Target lane name" },
        answer: { type: "string", description: "Answer text" },
        id: { type: ["number", "string"], description: "Optional question sequence id" },
      },
      required: ["lane", "answer"],
    },
    run: (input) => {
      const argv = ["reply", String(input.lane)];
      if (input.id !== undefined && input.id !== null) {
        argv.push("--id", String(input.id));
      }
      argv.push("-");
      return { argv, stdin: String(input.answer) };
    },
  },
  {
    name: "questions",
    description: "List open questions across all lanes or for a specific lane.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Optional lane filter" },
      },
    },
    run: (input) => {
      const argv = ["questions"];
      if (input.lane) argv.push(String(input.lane));
      return { argv };
    },
  },
  {
    name: "status",
    description: "Show the status of active and recent cdx lanes. brief returns one line per running or unclosed lane plus running jobs; the default is the detailed block per lane.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include closed lanes" },
        brief: { type: "boolean", description: "One line per lane and job, the same text as the session brief" },
      },
    },
    run: (input) => {
      if (input.brief === true) return { argv: ["brief"] };
      const argv = ["status"];
      if (input.all) argv.push("--all");
      return { argv };
    },
  },
  {
    name: "report",
    description: "Read the final report written by a finished lane.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Lane name" },
      },
      required: ["lane"],
    },
    run: (input) => ({ argv: ["report", String(input.lane)] }),
  },
  {
    name: "tail",
    description: "Inspect the latest execution log lines for a running or finished lane.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Lane name" },
        lines: { type: "number", description: "Number of lines to read" },
      },
      required: ["lane"],
    },
    run: (input) => {
      const argv = ["tail", String(input.lane)];
      if (input.lines !== undefined && input.lines !== null) {
        argv.push("-n", String(input.lines));
      }
      return { argv };
    },
  },
  {
    name: "close",
    description: "Close a completed lane and archive its status.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Lane name" },
        keepWorktree: { type: "boolean", description: "Close without removing the worktree or branch; print manual cleanup commands" },
        note: { type: "string", description: "Optional closing note" },
      },
      required: ["lane"],
    },
    run: (input) => {
      const argv = ["close", String(input.lane)];
      if (input.keepWorktree) argv.push("--keep-worktree");
      if (input.note !== undefined && input.note !== null && String(input.note).length > 0) {
        argv.push("-");
        return { argv, stdin: String(input.note) };
      }
      return { argv };
    },
  },
  {
    name: "kill",
    description: "Terminate a running lane process immediately.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Lane name" },
      },
      required: ["lane"],
    },
    run: (input) => ({ argv: ["kill", String(input.lane)] }),
  },
  {
    name: "gate",
    description: "Set or clear the verification gate command for a lane.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Lane name" },
        cmd: { type: "string", description: "New gate command to run" },
        clear: { type: "boolean", description: "Clear existing gate command" },
      },
      required: ["lane"],
    },
    run: (input) => {
      if (input.clear) return { argv: ["gate", String(input.lane), "--clear"] };
      if (!isName(input.cmd)) throw new Error("gate needs cmd or clear");
      return { argv: ["gate", String(input.lane), input.cmd] };
    },
  },
  {
    name: "gate-receipt",
    description: "Read content-bound acceptance proof for the latest work round.",
    inputSchema: { type: "object", properties: { lane: { type: "string", description: "Lane name" } }, required: ["lane"] },
    run: (input) => ({ argv: ["gate-receipt", String(input.lane), "--json"] }),
  },
  {
    name: "job",
    description: "Launch a detached background job command beside lanes.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Job name" },
        cmd: { type: "string", description: "Shell command to run" },
        cd: { type: "string", description: "Explicit working directory for the job" },
        expect: { type: "number", description: "Expected duration in minutes before an overrun notice" },
      },
      required: ["name", "cmd", "cd"],
    },
    run: (input) => {
      const argv = ["job", String(input.name)];
      if (input.cd) argv.push("--cd", String(input.cd));
      if (input.expect != null) argv.push("--expect", String(input.expect));
      argv.push("-");
      return { argv, stdin: String(input.cmd) };
    },
  },
  {
    name: "msg",
    description: "Send a notification message to a session or lane.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Target session or lane" },
        text: { type: "string", description: "Message body" },
      },
      required: ["target", "text"],
    },
    run: (input) => ({
      argv: ["msg", String(input.target), "-"],
      stdin: String(input.text),
    }),
  },
  {
    name: "inbox",
    description: "Read incoming messages sent to this session.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", description: "Number of message lines to read" },
      },
    },
    run: (input) => {
      const argv = ["inbox"];
      if (input.lines !== undefined && input.lines !== null) {
        argv.push("-n", String(input.lines));
      }
      return { argv };
    },
  },
  {
    name: "usage",
    description: "Report Codex and Gemini quota rows, observed burn, projected forfeiture and exhaustion, holds, and GPT account picks. json includes evidence and ledger totals; totals adds ledger totals to text.",
    inputSchema: {
      type: "object",
      properties: {
        totals: { type: "boolean", description: "Include all-time ledger totals in text." },
        json: { type: "boolean", description: "Machine-readable output instead of the text report." },
      },
    },
    run: (input) => ({ argv: ["usage", ...(input.json === true ? ["--json"] : []), ...(input.totals === true ? ["--totals"] : [])] }),
  },
  {
    name: "doctor",
    description: "Diagnose plugin installation, engine accounts, and background workers.",
    inputSchema: {
      type: "object",
      properties: {
        fix: { type: "boolean", description: "Attempt automated repairs" },
        probe: { type: "boolean", description: "Probe live engine credentials and rate limits" },
      },
    },
    run: (input) => {
      const argv = ["doctor"];
      if (input.fix) argv.push("--fix");
      if (input.probe) argv.push("--probe");
      return { argv, timeoutMs: 120000 };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
export const CDX_TOOL_PREFIX = "mcp__cdx__";

// A model that drops a field can still send the text "undefined".
function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value !== "undefined";
}

// Validate before any argv or stdin conversion, including direct table callers.
export function requiredInput(schema: Record<string, unknown>, input: Record<string, unknown>): void {
  for (const field of (schema.required as string[] ?? [])) {
    const value = input[field];
    if (!isName(value)) throw new Error(`missing required field: ${field}`);
    const property = (schema.properties as Record<string, { enum?: string[] }> | undefined)?.[field];
    if (property?.enum && !property.enum.includes(value)) throw new Error(`invalid ${field}: expected ${property.enum.join(" or ")}`);
  }
}
for (const tool of TOOLS) {
  const run = tool.run;
  tool.run = (input) => { requiredInput(tool.inputSchema, input); return run(input); };
}

export function nativeToolResult(exitCode: number, result: string) {
  return exitCode === 0 ? { result } : { result, isError: true as const };
}

export const TOOLS_BY_NAME = new Map<string, ToolDefinition>(
  TOOLS.map((tool) => [tool.name, tool]),
);

const OUTPUT_LIMIT = 20_000;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

export async function formatToolOutput(exitCode: number, stdout: string, stderr: string,
  retain?: (text: string) => Promise<string>): Promise<string> {
  const text = safeText(exitCode === 0 ? stdout : [stdout, stderr, `exit ${exitCode}`].filter((part) => part.trim()).join("\n"));
  if (byteLength(text) <= OUTPUT_LIMIT) return text;
  if (!retain) throw new Error("large tool output requires a retained file");
  const path = await retain(text);
  const marker = `\n... full output: ${path} ...\n`;
  // A UTF-16 code unit needs at most three UTF-8 bytes.
  const size = Math.max(0, Math.floor((OUTPUT_LIMIT - byteLength(marker)) / 6) - 1);
  if (!size) throw new Error("retained output path exceeds output limit");
  return text.slice(0, size) + marker + text.slice(-size);
}

// Only a failed cwd lookup can select the fallback, before any command runs.
export async function runFromCwd<T>(cwd: string, root: string,
  stat: (path: string) => Promise<unknown>, run: (cwd: string) => Promise<T>): Promise<T> {
  try { await stat(cwd); }
  catch (error) {
    if (cwd === root || !error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    cwd = root;
  }
  return run(cwd);
}
