import type { EngineInterface, On, RenderSurface } from "claude-code";
import { blockingCdxCommand, blockingCdxRefusal, invokedRawEngine, rawEngineRefusal } from "../guard";
import {
  afterPoll,
  afterToolCall,
  clearBuffer,
  initialDeliveryState,
  onPromptSubmit,
  onSubmitRefused,
  onTurnComplete,
  onTurnStart,
  type DeliveryState,
  type PendingEvent,
} from "./delivery";
import {
  CDX_TOOL_PREFIX,
  formatToolOutput,
  TOOLS,
  TOOLS_BY_NAME,
} from "./tools";

let session = "";
let root = "";
let CDX: string[] = [];
let surface: RenderSurface | null = null;
let deliveryState: DeliveryState = initialDeliveryState();
let pollInFlight = false;
let pollCount = 0;
// Each refusal message is logged once; the poll runs every two seconds and
// a repeated log would flood the transcript.
const loggedRefusals = new Set<string>();

const BUDGET_SPENT_NOTICE = "cdx: the engine's per-session prompt budget is spent (50 prompts); lane events no longer wake an idle head. "
  + "They still land on the next tool result or typed prompt, a fresh wake goes into the prompt box as a Tab suggestion, "
  + "and the status line shows 'wakes off'. A new session restores wakes.";

async function poll($: EngineInterface) {
  if (pollInFlight || !session || !root) {
    return;
  }
  pollInFlight = true;
  try {
    const eventsResult = await $.process.run(CDX.concat(["events", "--json"]), {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: root,
    });

    pollCount += 1;
    if (pollCount % 5 === 0) {
      const statusResult = await $.process.run(CDX.concat(["status", "--line"]), {
        env: { CLAUDE_CODE_SESSION_ID: session },
        cwd: root,
      });
      const line = statusResult.stdout.trim();
      if (surface !== null) {
        const shown = deliveryState.budgetSpent ? `wakes off${line ? ` · ${line}` : ""}` : line;
        await $.ui.status(shown || undefined);
      }
    }

    let incomingEvents: PendingEvent[] = [];
    if (eventsResult.exitCode === 0 && eventsResult.stdout.trim()) {
      try {
        const parsed = JSON.parse(eventsResult.stdout);
        if (parsed && Array.isArray(parsed.events)) {
          incomingEvents = parsed.events;
        }
      } catch {
        // ignore malformed JSON
      }
    }

    // Everything the submit would carry, kept so a refused submit can put it
    // back. The submit is issued before any await so no turn can start in
    // between; it is not awaited because the prompt runs when the session is
    // idle and the poll must not wait for that.
    const drained = [...deliveryState.pending, ...incomingEvents];
    const outcome = afterPoll(deliveryState, incomingEvents);
    deliveryState = outcome.state;

    if (outcome.submit) {
      $.prompt.submit(outcome.submit).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deliveryState = onSubmitRefused(deliveryState, drained, message);
        if (loggedRefusals.has(message)) return;
        loggedRefusals.add(message);
        await $.ui.log(deliveryState.budgetSpent
          ? BUDGET_SPENT_NOTICE
          : `cdx: prompt not submitted, events kept for the next tool result: ${message}`);
      });
    }

    if (outcome.suggest && surface !== null) {
      await $.prompt.suggest(outcome.suggest).catch(() => undefined);
    }

    if (surface !== null) {
      for (const toastText of outcome.toasts) {
        await $.ui.toast(toastText, { timeoutMs: 8000 });
      }
    }
  } finally {
    pollInFlight = false;
  }
}

// The poll drains the feed every two seconds into the buffer, so the CLI
// alone would answer "nothing" while wake events sit in memory. The tool
// answers with the buffer first, then whatever the feed still held, and
// empties the buffer so the after-hook does not deliver it a second time.
function eventsToolResult(exitCode: number, stdout: string, stderr: string): string {
  const buffered = deliveryState.pending.map((e) => e.text);
  deliveryState = clearBuffer(deliveryState);
  let fresh: string[] = [];
  if (exitCode === 0 && stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && Array.isArray(parsed.events)) fresh = parsed.events.map((e: PendingEvent) => e.text);
    } catch {
      // malformed JSON: report the raw output below
    }
  }
  if (exitCode !== 0) return formatToolOutput(exitCode, [...buffered, stdout].join("\n"), stderr);
  const lines = [...buffered, ...fresh];
  return lines.length ? lines.join("\n") : "no pending events";
}

export function register(on: On) {
  on("session.start", async ($, e, next) => {
    session = await $.session.id();
    root = $.plugin.root;
    CDX = ["bun", `${root}/cdx.ts`];
    surface = e.surface;

    for (const tool of TOOLS) {
      await $.tool.register({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    // /cdx is the user's skill, so the engine refuses that name. A refused
    // command must never stop the tools and the poll from starting.
    try {
      await $.command.register({
        name: "lanes",
        description: "cdx lanes: status, or any read-only cdx command",
      });
    } catch (error) {
      await $.ui.log(`cdx: /lanes not registered: ${error instanceof Error ? error.message : String(error)}`);
    }

    $.clock.every(2000, async () => {
      await poll($);
    });

    const briefResult = await $.process.run(CDX.concat(["brief"]), {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: root,
    });
    const briefText = briefResult.stdout.trim();
    if (briefText) {
      if (surface !== null) {
        await $.ui.log(briefText);
      }
      deliveryState = {
        ...deliveryState,
        pending: [...deliveryState.pending, { text: briefText, wake: false }],
      };
    }

    return next(e);
  });

  // A subagent's loop raises its own turn events with agentId set. Only the
  // head's turn decides whether the session is idle.
  on("turn.start", async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) deliveryState = onTurnStart(deliveryState);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) deliveryState = onTurnComplete(deliveryState);
    return next(e);
  });

  on("command.run", { command: "lanes" }, async ($, e) => {
    const args = e.args.trim().length > 0 ? e.args.trim().split(/\s+/) : ["status"];
    const res = await $.process.run(CDX.concat(args), {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: root,
    });
    if (res.exitCode !== 0) {
      return { text: res.stderr || res.stdout || `exit ${res.exitCode}` };
    }
    return { text: res.stdout };
  });

  on("command.run", { command: ["clear", "resume"] }, async ($, e, next) => {
    const result = await next(e);
    session = await $.session.id();
    deliveryState = clearBuffer(deliveryState);
    if (surface !== null) {
      await $.ui.status(undefined);
    }
    const briefResult = await $.process.run(CDX.concat(["brief"]), {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: root,
    });
    const briefText = briefResult.stdout.trim();
    if (briefText) {
      if (surface !== null) {
        await $.ui.log(briefText);
      }
      deliveryState = {
        ...deliveryState,
        pending: [{ text: briefText, wake: false }],
      };
    }
    return result;
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const command = typeof (e as { command?: unknown }).command === "string"
      ? (e as { command: string }).command
      : "";
    const engine = invokedRawEngine(command);
    if (engine) {
      return { deny: rawEngineRefusal(engine) };
    }
    const blocking = blockingCdxCommand(command);
    if (blocking) {
      return { deny: blockingCdxRefusal(blocking) };
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (result && "deny" in result && result.deny !== undefined) {
      return result;
    }
    if (e.agentId) {
      return result;
    }
    const outcome = afterToolCall(deliveryState);
    deliveryState = outcome.state;
    if (!outcome.context) {
      return result;
    }
    return {
      ...result,
      context: [...(result.context ?? []), outcome.context],
    };
  });

  on(
    "tool.call",
    {
      tool: [
        "mcp__cdx__spawn",
        "mcp__cdx__resume",
        "mcp__cdx__consult",
        "mcp__cdx__review",
        "mcp__cdx__fork",
        "mcp__cdx__events",
        "mcp__cdx__send",
        "mcp__cdx__reply",
        "mcp__cdx__questions",
        "mcp__cdx__status",
        "mcp__cdx__report",
        "mcp__cdx__tail",
        "mcp__cdx__close",
        "mcp__cdx__kill",
        "mcp__cdx__gate",
        "mcp__cdx__job",
        "mcp__cdx__msg",
        "mcp__cdx__inbox",
        "mcp__cdx__usage",
        "mcp__cdx__takeover",
        "mcp__cdx__doctor",
      ],
    },
    async ($, e) => {
    const toolName = e.tool.startsWith(CDX_TOOL_PREFIX)
      ? e.tool.slice(CDX_TOOL_PREFIX.length)
      : e.tool;
    const def = TOOLS_BY_NAME.get(toolName);
    if (!def) {
      return { result: `unknown tool ${e.tool}` };
    }
    const toolInput = (e as { input?: Record<string, unknown> }).input ?? (e as Record<string, unknown>);
    const runSpec = def.run(toolInput);
    // Tool commands run where the head works, not in the plugin root: a
    // spawn --worktree without cd cuts from the caller's directory, and a
    // relative cd resolves against it.
    const procInit: {
      env: Record<string, string>;
      cwd: string;
      stdin?: string;
      timeoutMs?: number;
    } = {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: await $.session.cwd().catch(() => root),
    };
    if (runSpec.stdin !== undefined) {
      procInit.stdin = runSpec.stdin;
    }
    if (runSpec.timeoutMs !== undefined) {
      procInit.timeoutMs = runSpec.timeoutMs;
    }
    const res = await $.process.run(CDX.concat(runSpec.argv), procInit);
    if (toolName === "events") {
      return { result: eventsToolResult(res.exitCode, res.stdout, res.stderr) };
    }
    const text = formatToolOutput(res.exitCode, res.stdout, res.stderr);
    return { result: text };
  });

  on("prompt.submit", async ($, e, next) => {
    if (e.origin && e.origin.kind === "plugin" && e.origin.name === "cdx") {
      return next(e);
    }
    const outcome = onPromptSubmit(deliveryState);
    deliveryState = outcome.state;
    if (outcome.context) {
      return next({
        ...e,
        context: [...(e.context ?? []), outcome.context],
      });
    }
    return next(e);
  });
}
