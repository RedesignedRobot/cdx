// Table of tools exposed by the cdx mod. Pure definitions and argv builders.
// Evaluated both in Claude Code hooks and in tests.

export interface ToolRunResult {
  argv: string[];
  stdin?: string;
  timeoutMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => ToolRunResult;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "spawn",
    description:
      "Spawn a new cdx lane with a brief. The brief is delivered whole through stdin so quotes and newlines are safe; completion arrives as a [cdx] event.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name for the new lane" },
        brief: { type: "string", description: "Task brief for the lane" },
        engine: { type: "string", enum: ["gpt", "gemini"], description: "Execution engine" },
        model: { type: "string", description: "Model alias or id" },
        supervisor: { type: "boolean", description: "Run lane as supervisor" },
        cd: { type: "string", description: "Working directory relative to repo root" },
        worktree: { type: "string", description: "Worktree path or name" },
        gate: { type: "string", description: "Verification command to run before reporting" },
        pre: { type: "string", description: "Setup command to run before starting work" },
        effort: { type: "string", description: "Reasoning effort" },
        maxRuntime: { type: "number", description: "Maximum runtime in minutes" },
        account: { type: "string", description: "Account name" },
        addDirs: { type: "array", items: { type: "string" }, description: "Additional directories" },
        schema: { type: "string", description: "Structured output JSON schema path" },
        images: { type: "array", items: { type: "string" }, description: "Image paths to attach" },
      },
      required: ["lane", "brief"],
    },
    run: (input) => {
      const argv = ["spawn", String(input.lane)];
      if (input.engine) argv.push("--engine", String(input.engine));
      if (input.model) argv.push("--model", String(input.model));
      if (input.supervisor) argv.push("--supervisor");
      if (input.cd) argv.push("--cd", String(input.cd));
      if (input.worktree) argv.push("--worktree", String(input.worktree));
      if (input.gate) argv.push("--gate", String(input.gate));
      if (input.pre) argv.push("--pre", String(input.pre));
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.maxRuntime !== undefined) argv.push("--max-runtime", String(input.maxRuntime));
      if (input.account) argv.push("--account", String(input.account));
      if (Array.isArray(input.addDirs)) {
        for (const dir of input.addDirs) argv.push("--add-dir", String(dir));
      }
      if (input.schema) argv.push("--schema", String(input.schema));
      if (Array.isArray(input.images)) {
        for (const img of input.images) argv.push("--image", String(img));
      }
      argv.push("--bg", "-");
      return { argv, stdin: String(input.brief) };
    },
  },
  {
    name: "resume",
    description: "Resume a finished or stopped lane with a follow-up instruction.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name of the lane to resume" },
        followUp: { type: "string", description: "Follow-up instructions for the lane" },
        effort: { type: "string", description: "Reasoning effort" },
        gate: { type: "string", description: "Verification command" },
        addDirs: { type: "array", items: { type: "string" }, description: "Additional directories retained for work resumes" },
        pre: { type: "string", description: "Setup command" },
        maxRuntime: { type: "number", description: "Maximum runtime in minutes" },
      },
      required: ["lane", "followUp"],
    },
    run: (input) => {
      const argv = ["resume", String(input.lane)];
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.gate) argv.push("--gate", String(input.gate));
      if (input.pre) argv.push("--pre", String(input.pre));
      if (input.maxRuntime !== undefined) argv.push("--max-runtime", String(input.maxRuntime));
      if (Array.isArray(input.addDirs)) for (const dir of input.addDirs) argv.push("--add-dir", String(dir));
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
        cd: { type: "string", description: "Working directory relative to repo root" },
        account: { type: "string", description: "Account name" },
      },
      required: ["lane", "question"],
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
    name: "review",
    description: "Start an independent code review lane on uncommitted changes, branches, or commits.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name for the review lane" },
        engine: { type: "string", enum: ["gpt", "gemini"], description: "Execution engine" },
        model: { type: "string", description: "Model alias or id" },
        effort: { type: "string", description: "Reasoning effort" },
        cd: { type: "string", description: "Working directory relative to repo root" },
        uncommitted: { type: "boolean", description: "Review uncommitted changes" },
        base: { type: "string", description: "Base branch to compare against" },
        commit: { type: "string", description: "Specific commit to review" },
        scope: { type: "string", description: "File path pattern scope" },
        intent: { type: "string", description: "Review intent or focus" },
      },
      required: ["lane"],
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
    name: "fork",
    description: "Fork an existing lane into a new branch lane with a brief.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Name for the new lane" },
        source: { type: "string", description: "Source lane name or session id" },
        brief: { type: "string", description: "Task brief for the new lane" },
        model: { type: "string", description: "Model alias or id" },
        effort: { type: "string", description: "Reasoning effort" },
        account: { type: "string", description: "Account name" },
      },
      required: ["lane", "source", "brief"],
    },
    run: (input) => {
      const argv = ["fork", String(input.lane), String(input.source)];
      if (input.model) argv.push("--model", String(input.model));
      if (input.effort) argv.push("--effort", String(input.effort));
      if (input.account) argv.push("--account", String(input.account));
      argv.push("--bg", "-");
      return { argv, stdin: String(input.brief) };
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
    description: "Show the status of active and recent cdx lanes.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include closed lanes" },
      },
    },
    run: (input) => {
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
      const argv = ["gate", String(input.lane)];
      if (input.clear) {
        argv.push("--clear");
      } else if (input.cmd) {
        argv.push(String(input.cmd));
      }
      return { argv };
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
      },
      required: ["name", "cmd", "cd"],
    },
    run: (input) => {
      const argv = ["job", String(input.name)];
      if (input.cd) argv.push("--cd", String(input.cd));
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
    description: "Report token consumption and rate limit windows for engines and accounts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    run: () => ({ argv: ["usage"] }),
  },
  {
    name: "takeover",
    description: "Claim ownership of a lane spawned by another session.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Lane name or session to adopt" },
      },
      required: ["target"],
    },
    run: (input) => ({ argv: ["takeover", String(input.target)] }),
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

export const TOOLS_BY_NAME = new Map<string, ToolDefinition>(
  TOOLS.map((tool) => [tool.name, tool]),
);

export function formatToolOutput(exitCode: number, stdout: string, stderr: string): string {
  if (exitCode === 0) {
    return stdout;
  }
  const parts: string[] = [];
  if (stdout.trim().length > 0) parts.push(stdout);
  if (stderr.trim().length > 0) parts.push(stderr);
  parts.push(`exit ${exitCode}`);
  return parts.join("\n");
}
