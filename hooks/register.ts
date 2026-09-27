import type { BoxProps, ElementConstructor, EngineInterface, On, RenderElement, RenderSurface, TextProps, Timer } from "claude-code";
import { blockingCdxCommand, blockingCdxRefusal, invokedRawEngine, nativeCdxCommand, nativeCdxRefusal, rawEngineRefusal } from "../guard";
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
  type LiveSnapshot,
  type BandCell,
  bandTable,
  orderedRows,
} from "./delivery";
import { afterCompaction, stopOutcome } from "./rollover";
import {
  CDX_TOOL_PREFIX,
  MAX_PROCESS_TIMEOUT_MS,
  nativeToolResult, formatToolOutput,
  runFromCwd,
  SESSION_TOOLS,
  TOOL_NAMES,
  TOOLS,
  TOOLS_BY_NAME,
} from "./tools";

const NATIVE_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

let session = "";
let root = "";
let CDX: string[] = [];
let surface: RenderSurface | null = null;
let deliveryState: DeliveryState = initialDeliveryState();
let pollInFlight = false;
let pollTimer: Timer | undefined;
let outputSequence = 0;
const liveRef = { plugin: "cdx", key: "live" } as const;
const rolloverRef = { plugin: "cdx", key: "rollover" } as const;
const pollerRef = { plugin: "cdx", key: "poller" } as const;
const POLL_INTERVAL_MS = 2000;
const INSTANCE = `${Date.now()}-${Math.random()}`;
// Each refusal message is logged once; the poll runs every two seconds and
// a repeated log would flood the transcript.
const loggedRefusals = new Set<string>();

const BUDGET_SPENT_NOTICE = "cdx: the engine's per-session prompt budget is spent (50 prompts); lane events no longer wake an idle head. "
  + "They still land on the next tool result or typed prompt, and a fresh wake goes into the prompt box as a Tab suggestion. "
  + "A new session restores wakes.";

async function poll($: EngineInterface) {
  if (pollInFlight || !session || !root) {
    return;
  }
  pollInFlight = true;
  try {
    const eventsResult = await $.process.run(CDX.concat(["events", "--json", "--snapshot"]), {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: root,
    });

    let incomingEvents: PendingEvent[] = [];
    let snapshot: LiveSnapshot | undefined;
    if (eventsResult.exitCode === 0 && eventsResult.stdout.trim()) {
      try {
        const parsed = JSON.parse(eventsResult.stdout);
        if (parsed && Array.isArray(parsed.events)) {
          incomingEvents = parsed.events;
        }
        if (parsed && Array.isArray(parsed.rows) && typeof parsed.now === "number") {
          snapshot = { rows: parsed.rows, now: parsed.now };
        }
      } catch {
        // ignore malformed JSON
      }
    }
    if (snapshot) {
      await $.state.set(liveRef, snapshot);
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

// A hot reload runs this module afresh with every variable above empty, and
// session.start does not always fire again, so each hook that needs the
// session context loads it here. The engine may not drop the old instance's
// timer either: the newest instance claims the poller in $.state and an
// older timer stops at its next tick.
async function ensure($: EngineInterface) {
  if (!session) session = await $.session.id();
  if (root) return;
  root = $.plugin.root;
  CDX = ["bun", `${root}/cdx.ts`];
  if (surface === null) surface = (await $.session.surfaces())[0] ?? null;
  await startPolling($);
}

// The host holds $.state for the session, so after a /clear or /resume the
// session the process moved to has no claim and the running timer would
// read that as a newer instance and stop. That hook starts the timer again.
async function startPolling($: EngineInterface) {
  pollTimer?.cancel();
  const timer = $.clock.every(POLL_INTERVAL_MS, async () => {
    if ((await $.state.get(pollerRef)).value !== INSTANCE) return timer.cancel();
    await ensure($);
    await poll($);
  });
  pollTimer = timer;
  await $.state.set(pollerRef, INSTANCE);
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
  if (exitCode !== 0) return [...buffered, stdout].join("\n");
  const lines = [...buffered, ...fresh];
  return lines.length ? lines.join("\n") : "no pending events";
}

function bandLine(Box: ElementConstructor<BoxProps>, Text: ElementConstructor<TextProps>, cells: BandCell[]): RenderElement {
  return Box({ flexDirection: "row", children: cells.map((cell) =>
    Text({ ...(cell.color ? { color: cell.color } : {}), ...(cell.bold ? { bold: true } : {}), ...(cell.dim ? { dimColor: true } : {}),
      wrap: "truncate", children: cell.text })) });
}

export function register(on: On) {
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const { value } = await $.state.get(liveRef);
    if (!value?.rows.length || e.props.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    // The margin is the blank line between the chat and the band.
    return Box({ flexDirection: "column", marginTop: 1, children: bandTable(orderedRows(value.rows), value.now, e.props.bodyColumns)
      .map((cells) => bandLine(Box, Text, cells)) });
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== "cdx-lanes") return next(e);
    const { value } = await $.state.get(liveRef);
    const { Box, Text } = $.ui.resolve(e);
    const rows = orderedRows(value?.rows ?? []);
    if (!rows.length) return Box({ flexDirection: "column", children: [Text({ children: "No running lanes or jobs" })] });
    const [header, ...lines] = bandTable(rows, value?.now ?? Date.now(), e.props.bodyColumns);
    return Box({ flexDirection: "column", children: [bandLine(Box, Text, header!), ...rows.flatMap((row, index) => [
      bandLine(Box, Text, lines[index]!),
      ...(row.transcript ?? []).map((text) => Text({ dimColor: true, wrap: "truncate",
        children: `  ${Array.from(text).slice(0, Math.max(0, e.props.bodyColumns - 3)).join("")}` })),
    ])] });
  });

  on("session.start", async ($, e, next) => {
    surface = e.surface;
    await ensure($);

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
        description: "Open live lanes, or forward arguments to cdx",
      });
    } catch (error) {
      await $.ui.log(`cdx: /lanes not registered: ${error instanceof Error ? error.message : String(error)}`);
    }

    // cdx elects the head only from sessions that drove it. A person at the
    // prompt claims the wakes at start; a -p run or an SDK host never does.
    const briefResult = await $.process.run(CDX.concat(e.isInteractive ? ["brief", "--head"] : ["brief"]), {
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
    await ensure($);
    if (!(e as { agentId?: string }).agentId) deliveryState = onTurnStart(deliveryState);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) deliveryState = onTurnComplete(deliveryState);
    return next(e);
  });

  // Counts compactions that stand in the head's own conversation; a subagent's,
  // a precompute and a skipped one leave the head's context as it was.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || e.trigger === "precompute" || !result.messages) return result;
    const { value } = await $.state.get(rolloverRef);
    await $.state.set(rolloverRef, afterCompaction(value, await $.session.id()));
    return result;
  });

  // The settings Stop hooks (the owner's push guard among them) sit beneath
  // this one and still run; a block of theirs travels with the rollover's.
  on("classic.Stop", async ($, e, next) => {
    const result = await next(e);
    const { value } = await $.state.get(rolloverRef);
    const outcome = stopOutcome(value, await $.session.id());
    if (!outcome || result.preventContinuation) return result;
    await $.state.set(rolloverRef, outcome.state);
    return { ...result, block: [result.block, outcome.block].filter(Boolean).join("\n\n") };
  });

  on("command.run", { command: "lanes" }, async ($, e) => {
    await ensure($);
    if (!e.args.trim()) {
      const opened = await $.ui.open({ id: "cdx-lanes", title: "Lanes", focus: true });
      return { text: opened.isPlaced ? "Lanes pane opened" : `Lanes pane unavailable: ${opened.reason ?? "surface refused"}` };
    }
    const args = e.args.trim().split(/\s+/);
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
    await ensure($);
    session = await $.session.id();
    deliveryState = clearBuffer(deliveryState);
    await startPolling($);
    // The user typed /clear or /resume here, so this session keeps the head
    // under its new id.
    const briefResult = await $.process.run(CDX.concat(["brief", "--head"]), {
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
    const native = nativeCdxCommand(command, NATIVE_TOOLS);
    if (native) {
      return { deny: nativeCdxRefusal(native) };
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    await ensure($);
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
    { tool: /^mcp__cdx__/ },
    async ($, e) => {
    const toolName = e.tool.startsWith(CDX_TOOL_PREFIX)
      ? e.tool.slice(CDX_TOOL_PREFIX.length)
      : e.tool;
    const def = TOOLS_BY_NAME.get(toolName);
    if (!def) {
      return { isError: true, result: `unknown tool ${e.tool}` };
    }
    await ensure($);
    if (!session && SESSION_TOOLS.has(toolName)) {
      return { isError: true, result: `cdx ${toolName}: the engine gave no session id, so the lane or job would have no owner; retry, or run /clear` };
    }
    const toolInput = (e as { input?: Record<string, unknown> }).input ?? (e as Record<string, unknown>);
    let runSpec;
    try { runSpec = def.run(toolInput); }
    catch (error) { return { isError: true, result: String(error) }; }
    // Tool commands run where the head works, not in the plugin root: a
    // spawn --worktree without cd cuts from the caller's directory, and a
    // relative cd resolves against it.
    const procInit: {
      env: Record<string, string>;
      cwd: string;
      stdin?: string;
      timeoutMs: number;
    } = {
      env: { CLAUDE_CODE_SESSION_ID: session },
      cwd: await $.session.cwd(),
      timeoutMs: runSpec.timeoutMs ?? MAX_PROCESS_TIMEOUT_MS,
    };
    if (runSpec.stdin !== undefined) {
      procInit.stdin = runSpec.stdin;
    }
    let res;
    try {
      res = await runFromCwd(procInit.cwd, root, (path) => $.fs.stat(path),
        (cwd) => $.process.run(CDX.concat(runSpec.argv), { ...procInit, cwd }));
    } catch (error) {
      return { isError: true, result: `cdx ${runSpec.argv[0]}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const stdout = toolName === "events" ? eventsToolResult(res.exitCode, res.stdout, res.stderr) : res.stdout;
    const text = await formatToolOutput(res.exitCode, stdout, res.stderr, async (content) => {
      const home = await $.env.get("CDX_HOME") || `${await $.env.get("HOME")}/.cdx`;
      const path = `${home}/logs/native-${session}-${Date.now()}-${++outputSequence}.log`;
      await $.fs.write(path, content);
      return path;
    });
    return nativeToolResult(res.exitCode, text);
  });

  on("prompt.submit", async ($, e, next) => {
    await ensure($);
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
