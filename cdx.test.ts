import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactViewText, houseRules, isAgyCancellationTemplate, REVIEW_FINDINGS_SCHEMA, GEMINI_TRANSPORT_ERRORS, parseQuotaResetDelayMs, parseQuotaResetIso, geminiQuotaState } from "./cdx.ts";

const CLI = join(import.meta.dir, "cdx.ts");
const runners: Bun.Subprocess[] = [];

function tempPath(label: string): string {
  return `${tmpdir()}/cdx-test-${label}-${process.pid}-${crypto.randomUUID()}`;
}

function baseEnv(state: string, bin?: string): Record<string, string> {
  const env = {
    ...process.env,
    NO_COLOR: "1",
    CDX_HOME: state,
    HOME: tempPath("home"),
    PATH: bin ? `${bin}:${process.env.PATH ?? ""}` : process.env.PATH ?? "",
  } as Record<string, string>;
  delete env.CDX_LANE;
  return env;
}

function runCli(args: string[], env: Record<string, string>) {
  const result = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], env });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition did not become true before timeout");
}

function installFakeCodex(root: string, options: { doctorDies?: boolean; ignoreSigterm?: boolean } = {}): string {
  const bin = `${root}/bin`;
  mkdirSync(bin, { recursive: true });
  const path = `${bin}/codex`;
  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const doctorDies = ${Boolean(options.doctorDies)};
const ignoreSigterm = ${Boolean(options.ignoreSigterm)};
const threadId = "11111111-1111-4111-8111-111111111111";
if (args[0] === "--version") { console.log("codex-cli 0.149.1"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") { console.log("Logged in using ChatGPT"); process.exit(0); }
if (args[0] !== "app-server") {
  if (process.env.FAKE_ENV_TRACE) appendFileSync(process.env.FAKE_ENV_TRACE, String(process.env.CODEX_HOME || "") + "\\n");
  if (process.env.FAKE_ARGS_TRACE) appendFileSync(process.env.FAKE_ARGS_TRACE, args.join(" ") + "\\n");
  const lastMessage = args.indexOf("--output-last-message");
  if (lastMessage >= 0) writeFileSync(args[lastMessage + 1], "fake exec report\\n");
  process.exit(0);
}
let buffer = "";
let activeTurn = "";
let turnNumber = 0;
let fallback;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const finishTurn = (turnId, text, phase = "final_answer", status = "completed", error = null) => {
  if (fallback) clearTimeout(fallback);
  if (text !== undefined) send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "message-" + turnId, text, ...(phase === undefined ? {} : { phase }), memoryCitation: null, delivery: null } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 10, cacheWriteInputTokens: 0 }, total: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 10, cacheWriteInputTokens: 0 }, modelContextWindow: 1000 } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [], itemsView: { type: "all" }, error, startedAt: 1, completedAt: 2, durationMs: 1 } } });
};
const complete = (text, phase = "final_answer") => {
  if (!activeTurn) return;
  const turnId = activeTurn;
  activeTurn = "";
  finishTurn(turnId, text, phase);
};
if (ignoreSigterm) process.on("SIGTERM", () => appendFileSync(process.env.FAKE_SIGNAL_TRACE, "SIGTERM\\n"));
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk, { stream: true });
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (process.env.FAKE_TRACE) appendFileSync(process.env.FAKE_TRACE, line + "\\n");
    if (process.env.FAKE_ENV_TRACE && request.method === "initialize") appendFileSync(process.env.FAKE_ENV_TRACE, String(process.env.CODEX_HOME || "") + "\\n");
    if (process.env.FAKE_SUPERVISOR_TRACE && request.method === "initialize") appendFileSync(process.env.FAKE_SUPERVISOR_TRACE, String(process.env.CDX_SUPERVISOR || "none") + "\\n");
    if (request.method === "initialized") continue;
    if (request.method === "initialize") send({ id: request.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
    else if (request.method === "account/rateLimits/read") send({ id: request.id, result: { rateLimits: {} } });
    else if (["thread/start", "thread/resume", "thread/fork"].includes(request.method)) {
      send({ id: request.id, result: { thread: { id: threadId, preview: "", modelProvider: "fake", createdAt: 1 } } });
      send({ method: "thread/started", params: { thread: { id: threadId, preview: "", modelProvider: "fake", createdAt: 1 } } });
    } else if (request.method === "turn/start") {
      activeTurn = "turn-" + (++turnNumber);
      send({ id: request.id, result: { turn: { id: activeTurn, status: "inProgress", items: [], itemsView: { type: "all" }, error: null, startedAt: 1, completedAt: null, durationMs: null } } });
      send({ method: "turn/started", params: { threadId, turn: { id: activeTurn, status: "inProgress", items: [], itemsView: { type: "all" }, error: null, startedAt: 1, completedAt: null, durationMs: null } } });
      const text = request.params.input.find((item) => item.type === "text")?.text || "";
      if (doctorDies) setTimeout(() => process.exit(44), 10);
      else if (text.includes("COMMENTARY_ONLY")) fallback = setTimeout(() => complete("still working", "commentary"), 20);
      else if (text.includes("UNPHASED_REPORT")) fallback = setTimeout(() => complete("legacy final report", undefined), 20);
      else if (text.includes("TURN_ERROR")) fallback = setTimeout(() => {
        const turnId = activeTurn;
        activeTurn = "";
        finishTurn(turnId, undefined, undefined, "failed", { message: "context window exceeded" });
      }, 20);
      else if (text.includes("MULTI_CALL_USAGE")) fallback = setTimeout(() => {
        const turnId = activeTurn;
        activeTurn = "";
        send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "message-" + turnId, text: "multi-call report", phase: "final_answer", memoryCitation: null, delivery: null } } });
        send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 }, total: { inputTokens: 70, cachedInputTokens: 20, outputTokens: 30 }, modelContextWindow: 1000 } } });
        send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { inputTokens: 14, cachedInputTokens: 4, outputTokens: 6 }, total: { inputTokens: 84, cachedInputTokens: 24, outputTokens: 36 }, modelContextWindow: 1000 } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], itemsView: { type: "all" }, error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
      }, 20);
      else if (text.includes("IGNORE_SIGTERM")) { /* max-runtime owns completion */ }
      else if (text.includes("STEER_REJECTED_AFTER_COMPLETION") && turnNumber === 1) { /* wait for steer */ }
      else if (text.includes("WRITE_WORK_FILE")) {
        writeFileSync(process.cwd() + "/worker-output.txt", "worker created output\\n");
        fallback = setTimeout(() => complete("work completed"), 20);
      }
      else if (text.includes("COMMIT_WORK")) {
        Bun.spawnSync({ cmd: ["git", "-c", "user.name=Fake", "-c", "user.email=fake@example.test", "commit", "--allow-empty", "-qm", "worker commit"], cwd: process.cwd() });
        fallback = setTimeout(() => complete("work committed"), 20);
      }
      else if (text.includes("REPORT_ONLY") || turnNumber > 1) fallback = setTimeout(() => complete(turnNumber > 1 ? "follow-up delivered" : "final report from app-server"), 20);
      else fallback = setTimeout(() => complete("fallback report"), 5000);
    } else if (request.method === "turn/steer") {
      if (process.env.FAKE_REJECT_STEER) {
        const completedTurn = activeTurn;
        activeTurn = "";
        send({ id: request.id, error: { code: -32602, message: "no active turn" } });
        setTimeout(() => finishTurn(completedTurn, "first turn commentary", "commentary"), 20);
      } else {
        send({ id: request.id, result: { turnId: activeTurn } });
        complete("stopped at 10");
      }
    } else if (request.method === "thread/unsubscribe") {
      if (process.env.FAKE_CLEANUP_FAIL) {
        appendFileSync(process.env.FAKE_CLEANUP_FAIL, existsSync(process.env.FAKE_REPORT_PATH || "") ? "report-present\\n" : "report-missing\\n");
        send({ id: request.id, error: { code: -32603, message: "cleanup exploded" } });
        setTimeout(() => process.exit(42), 5);
      } else send({ id: request.id, result: { status: "unsubscribed" } });
    }
  }
}
if (ignoreSigterm) {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return bin;
}

function installFakeAgy(root: string): string {
  const bin = `${root}/bin`;
  mkdirSync(bin, { recursive: true });
  const path = `${bin}/agy`;
  writeFileSync(path, `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const conversationFlag = args.indexOf("--conversation");
const conversationId = conversationFlag >= 0 ? args[conversationFlag + 1] : "33333333-3333-4333-8333-333333333333";
const trace = (record) => {
  if (process.env.FAKE_AGY_TRACE) appendFileSync(process.env.FAKE_AGY_TRACE, JSON.stringify(record) + "\\n");
};
if (!args.some((arg) => arg === "--version" || arg.startsWith("--print="))) {
  trace({ args, cwd: process.cwd(), codexHome: process.env.CODEX_HOME, supervisor: process.env.CDX_SUPERVISOR });
}

if (args.includes("--version")) { console.log("agy version 1.1.24"); process.exit(0); }
const modelsIdx = args.indexOf("models");
if (modelsIdx >= 0) {
  const formatIdx = args.indexOf("--output-format");
  if (formatIdx > modelsIdx) {
    console.error("Error: flags provided but not defined: -output-format");
    process.exit(1);
  }
  if (formatIdx >= 0 && formatIdx < modelsIdx && args[formatIdx + 1] === "json") {
    if (process.env.FAKE_AGY_MODELS) {
      console.log(process.env.FAKE_AGY_MODELS);
      process.exit(0);
    }
    console.log(JSON.stringify({
      command: {
        name: "models",
        data: {
          models: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }],
        },
      },
    }));
    process.exit(0);
  }
  console.log("gemini-3.8-flash-high");
  process.exit(0);
}
if (args.includes("--print=/usage")) {
  if (process.env.FAKE_AGY_USAGE === "fail") {
    process.exit(1);
  }
  if (process.env.FAKE_AGY_USAGE) {
    console.log(process.env.FAKE_AGY_USAGE);
    process.exit(0);
  }
  const exhausted = Boolean(process.env.CDX_HOME && existsSync(process.env.CDX_HOME + "/.fake-quota-exhausted"));
  const fiveHour = exhausted ? "1%" : "91%";
  console.log("Gemini Models\\tWeekly Limit Remaining\\t99%\\t2026-09-09T18:16:57Z");
  console.log("Gemini Models\\tFive Hour Limit Remaining\\t" + fiveHour + "\\t2026-09-02T23:16:57Z");
  console.log("Claude and GPT models\\tWeekly Limit Remaining\\t100%\\t2026-09-09T19:10:44Z");
  console.log("Claude and GPT models\\tFive Hour Limit Remaining\\t100%\\t2026-09-03T00:10:44Z");
  process.exit(0);
}
if (args.includes("--print=/hooks")) {
  if (process.env.FAKE_AGY_HOOKS) {
    console.log(process.env.FAKE_AGY_HOOKS);
    process.exit(0);
  }
  console.log(JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "cdx\\tenabled\\tPreInvocation\\t-\\tcommand\\t/Users/mas/.bun/bin/bun /Users/mas/code/cdx/cdx.ts hook pre-invocation\\ncdx\\tenabled\\tPreToolUse\\t*\\tcommand\\t/Users/mas/.bun/bin/bun /Users/mas/code/cdx/cdx.ts hook pre-tool\\n",
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: "hooks",
      data: {
        hooks: [
          {
            name: "cdx",
            enabled: true,
            source: "/Users/mas/.gemini/config/hooks.json",
            actions: [
              {
                event: "PreInvocation",
                type: "command",
                command: "/Users/mas/.bun/bin/bun /Users/mas/code/cdx/cdx.ts hook pre-invocation",
                timeout_seconds: 10,
              },
              {
                event: "PreToolUse",
                matcher: "*",
                type: "command",
                command: "/Users/mas/.bun/bin/bun /Users/mas/code/cdx/cdx.ts hook pre-tool",
                timeout_seconds: 10,
              },
            ],
          },
        ],
      },
    },
  }));
  process.exit(0);
}
if (args.some((arg) => arg.startsWith("--print="))) {
  console.log(JSON.stringify({ response: "OK", conversation_id: conversationId }));
  process.exit(0);
}

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({
  event: "init",
  conversation_id: conversationId,
  init: {
    model: "gemini-3.8-flash-high",
    cwd: process.cwd(),
    tools: ["view_file", "grep_search", "list_dir", "run_command", "finish"],
    permission_mode: "always-proceed",
  },
});

let turn = 0;
let processing = false;
let inputClosed = false;
const queue = [];
let fail3x = false;
const result = (status, response, error, extra) => send({
  event: "result",
  result: {
    conversation_id: conversationId,
    status,
    response,
    ...(extra || {}),
    ...(error !== undefined ? { error } : {}),
    // Cumulative over the conversation, like the real agy; cdx must not add it.
    usage: {
      input_tokens: 999 * turn,
      output_tokens: 999 * turn,
      thinking_tokens: 999 * turn,
      cache_read_tokens: 999 * turn,
      total_tokens: 3996 * turn,
    },
    num_turns: turn,
  },
});

async function runTurn(content) {
  processing = true;
  turn += 1;
  trace({ input: content });
  send({ event: "step_update", step_update: {
    conversation_id: conversationId,
    step_index: turn,
    state: "ACTIVE",
    step_type: "tool",
    usage: { input_tokens: 11, output_tokens: 5, thinking_tokens: 3, cache_read_tokens: 2 },
    tool_name: "list_dir",
    tool_info: { name: "list_dir", parameters: { directoryPath: process.cwd() }, output: "ok" },
  } });
  if (content.includes("ASK_OWNER")) {
    const ask = Bun.spawn({
      cmd: [process.execPath, process.env.FAKE_CDX_CLI, "ask", "Which file should I inspect?"],
      env: process.env,
      stdout: "pipe",
      stderr: "inherit",
    });
    const answer = (await new Response(ask.stdout).text()).trim();
    await ask.exited;
    trace({ answer });
    result("SUCCESS", \`owner answered: \${answer}\`);
    processing = false;
    if (queue.length) await runTurn(queue.shift());
    else if (inputClosed) process.exit(0);
    return;
  }
  if (content.includes("HANG_AGY")) await new Promise(() => {});
  if (content.includes("WAIT_FOR_FOLLOW_UP")) await Bun.sleep(content.includes("LONG_SLEEP") ? 800 : 250);
  if (content.includes("REVIEW_WRITE")) writeFileSync(\`\${process.cwd()}/fake-review-change.txt\`, "changed by fake reviewer\\n");
  if (content.includes("FAIL_3X")) fail3x = true;
  if (fail3x) {
    result("ERROR", "interrupted progress", "The stream was interrupted. Please continue the task you were working on.");
  } else if (content.includes("STREAM_INTERRUPT") && turn === 1) {
    result("ERROR", "turn 1 interrupted progress", "The stream was interrupted. Please continue the task you were working on.");
  } else if (content.includes("NON_TRANSPORT_ERROR")) {
    result("ERROR", "syntax failure", "non-transport fatal error");
  } else if (content.includes("WRITE_WORKER_REPORT_PARTIAL")) {
    const cdxHome = process.env.CDX_HOME;
    const lane = process.env.CDX_LANE;
    const round = process.env.CDX_ROUND;
    if (cdxHome && lane && round) {
      writeFileSync(\`\${cdxHome}/reports/\${lane}-r\${round}.md\`, "worker report\\n");
    }
    result("ERROR", "progress text", "scripted non-transport error");
  } else if (content.includes("AGY_CANCEL_TEMPLATE")) result("SUCCESS", "User initiated cancellation\\nExecution stopped per your cancellation request");
  else if (content.includes("QUOTA_ERROR")) {
    if (process.env.CDX_HOME && !process.env.FAKE_AGY_HEALTHY_USAGE) {
      try { writeFileSync(process.env.CDX_HOME + "/.fake-quota-exhausted", "1"); } catch {}
    }
    const quotaMsg = process.env.FAKE_AGY_QUOTA_ERROR || "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m19s.";
    result("ERROR", "trailing chatter from worker turn", quotaMsg);
  }
  else if (content.includes("QUOTA_UNPARSEABLE")) {
    if (process.env.CDX_HOME && !process.env.FAKE_AGY_HEALTHY_USAGE) {
      try { writeFileSync(process.env.CDX_HOME + "/.fake-quota-exhausted", "1"); } catch {}
    }
    result("ERROR", "trailing chatter from worker turn", "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits.");
  }
  else if (content.includes("REPLAYED_ERROR_WITH_REPORT")) {
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "3",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "Working on tasks.",
    } });
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "7",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "# Lane Report: Resumed Work\\n\\nAll tasks complete.",
    } });
    const quotaMsg = process.env.FAKE_AGY_QUOTA_ERROR || "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m19s.";
    result("ERROR", "trailing chatter from worker turn", quotaMsg);
  }
  else if (content.includes("REPLAYED_ERROR_NO_REPORT")) {
    const quotaMsg = process.env.FAKE_AGY_QUOTA_ERROR || "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m19s.";
    result("ERROR", "", quotaMsg);
  }
  else if (content.includes("DIFF_ERROR_NO_REPORT")) {
    result("ERROR", "", "ERROR: A completely different error occurred.");
  }
  else if (content.includes("STREAM_INTERRUPT_WITH_REPORT")) {
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "1",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "Partial progress before interruption.",
    } });
    result("ERROR", "interrupted progress", "The stream was interrupted. Please continue the task you were working on.");
  }
  else if (content.includes("REVIEW_REPLAYED_STRUCTURED")) {
    const structured = {
      report: "# Review Replayed\\n\\nFound issues.",
      findings: [{ severity: "P1", confidence: "CONFIRMED", file: "src/index.ts", line: 42, summary: "critical defect" }],
    };
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "1",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "# Review Replayed\\n\\nFound issues.",
    } });
    const quotaMsg = process.env.FAKE_AGY_QUOTA_ERROR || "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m19s.";
    result("ERROR", JSON.stringify(structured), quotaMsg, { structured_output: structured });
  }
  else if (content.includes("AGY_ERROR")) result("ERROR", "scripted agy failure");
  else if (content.includes("REVIEW_STRUCTURED")) {
    const structured = {
      report: "# Review\\n\\nclean",
      findings: [{ severity: "P2", confidence: "CONFIRMED", file: "a.ts", line: 3, summary: "x" }],
    };
    result("SUCCESS", JSON.stringify(structured), undefined, { structured_output: structured });
  } else if (content.includes("REVIEW_NON_ARRAY_FINDINGS")) {
    const structured = {
      report: "# Review Non Array\\n\\n\`\`\`json\\n{\\"findings\\":[{\\"severity\\":\\"P1\\",\\"confidence\\":\\"CONFIRMED\\",\\"file\\":\\"f.ts\\",\\"line\\":1,\\"summary\\":\\"extracted from fence\\"}]}\\n\`\`\`",
      findings: "not-an-array",
    };
    result("SUCCESS", JSON.stringify(structured), undefined, { structured_output: structured });
  } else if (content.includes("REVIEW_UNSTRUCTURED_FINDINGS")) {
    result("SUCCESS", "# Unstructured Review\\n\\nSome issues.\\n\\n\`\`\`json\\n{\\"findings\\":[{\\"severity\\":\\"P3\\",\\"confidence\\":\\"PLAUSIBLE\\",\\"file\\":\\"b.ts\\",\\"line\\":10,\\"summary\\":\\"fallback finding\\"}]}\\n\`\`\`");
  } else if (content.includes("SCHEMA_RAW_RESPONSE")) {
    writeFileSync(\`\${process.cwd()}/schema-work.txt\`, "ok\\n");
    result("SUCCESS", JSON.stringify({ answer: "raw schema response" }));
  } else if (content.includes("HIGHEST_EMPTY_AGENT_RESPONSE")) {
    writeFileSync(\`\${process.cwd()}/highest-empty.txt\`, "ok\\n");
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "3",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "# Actual Final Report\\n\\nDone.",
    } });
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "7",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "   \\n  ",
    } });
    result("SUCCESS", "chatter from result");
  } else if (content.includes("TWO_AGENT_RESPONSES")) {
    writeFileSync(\`\${process.cwd()}/final-msg.txt\`, "ok\\n");
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "3",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "I am waiting for bun run check to complete.",
    } });
    send({ event: "step_update", step_update: {
      conversation_id: conversationId,
      step_index: "7",
      state: "DONE",
      step_type: "agent_response",
      text_delta: "# Final Report\\n\\nAll tasks complete.",
    } });
    result("SUCCESS", "I am waiting for bun run check to complete.# Final Report\\n\\nAll tasks complete.");
  } else if (turn > 1) result("SUCCESS", content.includes("cut off by a transport error") ? "second response report" : \`follow-up result: \${content}\`);
  else if (content.includes("REVIEW_CLEAN")) result("SUCCESS", "No findings.");
  else result("SUCCESS", \`gemini report: \${content}\`);
  processing = false;
  if (queue.length) await runTurn(queue.shift());
  else if (inputClosed) process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const event = JSON.parse(line);
  if (event.event !== "user") return;
  trace({ stdinUser: event.message?.content });
  const content = event.message?.content ?? "";
  if (processing) queue.push(content);
  else void runTurn(content);
});
lines.on("close", () => {
  inputClosed = true;
  if (!processing && queue.length === 0) process.exit(0);
});
`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return bin;
}

afterEach(() => {
  for (const proc of runners.splice(0)) {
    if (proc.exitCode === null) proc.kill();
  }
});

describe("cdx jobs", () => {
  test("job runs detached, records exit code, writes a feed line, and wait/kill/status know it", async () => {
    const state = tempPath("jobs");
    mkdirSync(state, { recursive: true });
    const env = { ...baseEnv(state), CLAUDE_CODE_SESSION_ID: "abcdef1234567890" };
    const started = runCli(["job", "wall", "--cd", state, "printf hello; sleep 0.2; exit 3"], env);
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("job=wall");
    const jobsPath = join(state, "jobs.json");
    await waitFor(() => existsSync(jobsPath) && JSON.parse(readFileSync(jobsPath, "utf8")).wall?.state === "failed");
    const job = JSON.parse(readFileSync(jobsPath, "utf8")).wall;
    expect(job.exitCode).toBe(3);
    expect(job.cwd).toBe(state);
    expect(readFileSync(job.log, "utf8")).toContain("hello");
    const feed = readFileSync(join(state, "feed.log"), "utf8");
    expect(feed).toContain("[cdx] job=wall state=failed exit=3 in=");
    expect(feed).toContain("owner=abcdef12");
    const waited = runCli(["wait", "wall"], env);
    expect(waited.exitCode).toBe(1);
    expect(waited.stdout).toContain("job=wall state=failed exit=3");
    const listed = runCli(["job"], env);
    expect(listed.stdout).toContain("job=wall state=failed exit=3");
    const inLane = runCli(["job", "other", "true"], { ...env, CDX_LANE: "some-lane" });
    expect(inLane.exitCode).not.toBe(0);
    expect(inLane.stderr).toContain("lane workers cannot drive the harness");

    const long = runCli(["job", "slow", "--cd", state, "sleep 30"], env);
    expect(long.exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(jobsPath, "utf8")).slow?.pid !== undefined);
    const status = runCli(["status"], env);
    expect(status.stdout).toContain("jobs running:");
    expect(status.stdout).toContain("job=slow state=running");
    const killed = runCli(["kill", "slow", "stopped by test"], env);
    expect(killed.exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(jobsPath, "utf8")).slow?.state === "failed");
    const slow = JSON.parse(readFileSync(jobsPath, "utf8")).slow;
    expect(slow.note).toBe("stopped by test");
    expect(slow.exitCode).toBe(143);
  });
});

describe("cdx messaging", () => {
  test("delivers a control-file steer through the app-server", async () => {
    const root = tempPath("steer");
    const bin = installFakeCodex(root);
    const state = `${root}/state`;
    const env = baseEnv(state, bin);
    const spawn = runCli(["spawn", "steer-lane", "--engine", "gpt", "--cd", root, "--bg", "WAIT_FOR_STEER"], env);
    expect(spawn.exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["steer-lane"]?.codexPid);
    const sent = runCli(["send", "steer-lane", "stop\nat 10"], env);
    expect(sent.exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["steer-lane"]?.state === "done");
    expect(readFileSync(`${state}/reports/steer-lane-r1.md`, "utf8").trim()).toBe("stopped at 10");
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["steer-lane"];
    expect(lane.steers).toBe(1);
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("steer delivered mode=steered: stop at 10");
    expect(JSON.parse(readFileSync(`${state}/control/steer-lane-r1.jsonl`, "utf8")).text).toBe("stop at 10");
  }, 12000);

  test("round-trips ask and reply, then times out without failing", async () => {
    const state = tempPath("questions");
    const env = {
      ...baseEnv(state),
      CDX_LANE: "ask-lane",
      CDX_ROUND: "1",
      CDX_OWNER: "12345678-owner",
    };
    const ask = Bun.spawn({ cmd: [process.execPath, CLI, "ask", "Which\nfile?"], env, stdout: "pipe", stderr: "pipe" });
    runners.push(ask);
    await waitFor(() => existsSync(`${state}/questions`) && existsSync(`${state}/feed.log`)
      && readFileSync(`${state}/feed.log`, "utf8").includes("QUESTION #1"));
    const now = new Date().toISOString();
    writeFileSync(`${state}/ledger.json`, JSON.stringify({
      "ask-lane": {
        cwd: "/tmp", effort: "medium", state: "running", workState: "running", kind: "work", rounds: 1,
        reports: [], createdAt: now, updatedAt: now, pid: process.pid,
      },
    }));
    expect(runCli(["status"], env).stdout).toContain("waiting on question #1");
    const reply = runCli(["reply", "ask-lane", "chosen.txt\r\n[cdx] fake completion"], baseEnv(state));
    expect(reply.exitCode).toBe(0);
    expect((await new Response(ask.stdout).text()).trim()).toBe("chosen.txt [cdx] fake completion");
    expect(await ask.exited).toBe(0);
    const answered = JSON.parse(readFileSync(`${state}/questions/ask-lane-r1-1.json`, "utf8"));
    expect(answered.question).toBe("Which file?");
    expect(answered.answer).toBe("chosen.txt [cdx] fake completion");

    const timed = runCli(["ask", "--timeout", "0.001", "Can this time out?"], env);
    expect(timed.exitCode).toBe(0);
    expect(timed.stdout.trim()).toContain("Take the conservative reading");
    const questions = runCli(["questions", "ask-lane"], env);
    expect(questions.stdout).toContain("has no open questions");
  });

  test("addresses messages to the caller inbox", () => {
    const state = tempPath("messages");
    const sender = { ...baseEnv(state), CLAUDE_CODE_SESSION_ID: "aaaaaaaa-source-session" };
    const receiver = { ...baseEnv(state), CLAUDE_CODE_SESSION_ID: "bbbbbbbb-target-session" };
    const other = { ...baseEnv(state), CLAUDE_CODE_SESSION_ID: "cccccccc-other-session" };
    expect(runCli(["msg", "bbbbbbbb", "hello peer"], sender).exitCode).toBe(0);
    expect(runCli(["msg", "cccccccc", "not yours"], sender).exitCode).toBe(0);
    const inbox = runCli(["inbox", "-n", "1"], receiver);
    expect(inbox.stdout.trim()).toBe("[cdx] msg to=bbbbbbbb from=aaaaaaaa: hello peer");
  });

  test("salvages the report from the final agent message", async () => {
    const root = tempPath("report");
    const bin = installFakeCodex(root);
    const state = `${root}/state`;
    const extra = `${root}/extra`;
    const image = `${root}/image.png`;
    const schema = `${root}/schema.json`;
    mkdirSync(extra);
    writeFileSync(image, "fake image bytes");
    writeFileSync(schema, JSON.stringify({ type: "object", properties: { result: { type: "string" } } }));
    const trace = `${root}/requests.jsonl`;
    const env = { ...baseEnv(state, bin), FAKE_TRACE: trace };
    const result = runCli([
      "spawn", "report-lane", "--engine", "gpt", "--cd", root, "--add-dir", extra,
      "--image", image, "--schema", schema, "REPORT_ONLY",
    ], env);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(`${state}/reports/report-lane-r1.md`, "utf8").trim()).toBe("final report from app-server");
    const requests = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const thread = requests.find((request) => request.method === "thread/start");
    const turn = requests.find((request) => request.method === "turn/start");
    expect(thread.params.config.sandbox_workspace_write.writable_roots).toEqual([realpathSync(extra)]);
    expect(thread.params.approvalPolicy).toBe("never");
    expect(thread.params.sandbox).toBe("danger-full-access");
    expect(thread.params.model).toBe("gpt-5.6-sol");
    expect(turn.params.input).toContainEqual({ type: "localImage", path: realpathSync(image) });
    expect(turn.params.outputSchema.type).toBe("object");
    expect(turn.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(turn.params.effort).toBe("medium");
    expect(requests.every((request) => request.jsonrpc === undefined)).toBe(true);
  });

  test("refuses steering for a running review without writing a control record", () => {
    const state = tempPath("review-steer");
    const env = baseEnv(state);
    mkdirSync(state, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(`${state}/ledger.json`, JSON.stringify({
      review: {
        cwd: "/tmp", effort: "medium", state: "done", kind: "review", rounds: 1,
        reports: [], createdAt: now, updatedAt: now, reviewState: "running",
        ownerSession: "12345678-owner", pid: process.pid,
      },
    }));
    const sent = runCli(["send", "review", "change the verdict"], env);
    expect(sent.exitCode).toBe(1);
    expect(sent.stderr).toContain("review turns do not accept steering");
    expect(existsSync(`${state}/control/review-r1.jsonl`)).toBe(false);
    expect(existsSync(`${state}/feed.log`)).toBe(false);
  });

  test("fails a commentary-only round without running its gate", () => {
    const root = tempPath("commentary-only");
    const bin = installFakeCodex(root);
    const state = `${root}/state`;
    const gateMarker = `${root}/gate-ran`;
    const result = runCli(["spawn", "commentary", "--engine", "gpt", "--cd", root, "--gate", `touch ${gateMarker}`, "COMMENTARY_ONLY"], baseEnv(state, bin));
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).commentary;
    expect(result.exitCode).toBe(1);
    expect(lane.state).toBe("failed");
    expect(lane.note).toContain("no final report");
    expect(existsSync(`${state}/reports/commentary-r1.md`)).toBe(false);
    expect(existsSync(gateMarker)).toBe(false);
  });

  test("accepts an unphased agent message from an older server", () => {
    const root = tempPath("unphased-report");
    const state = `${root}/state`;
    const result = runCli(["spawn", "unphased", "--engine", "gpt", "--cd", root, "UNPHASED_REPORT"], baseEnv(state, installFakeCodex(root)));
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).unphased;
    expect(result.exitCode).toBe(0);
    expect(lane.state).toBe("done");
    expect(readFileSync(`${state}/reports/unphased-r1.md`, "utf8").trim()).toBe("legacy final report");
  });

  test("records a failed turn error in the ledger and feed", () => {
    const root = tempPath("turn-error");
    const state = `${root}/state`;
    const result = runCli(["spawn", "failed-turn", "--engine", "gpt", "--cd", root, "TURN_ERROR"], baseEnv(state, installFakeCodex(root)));
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["failed-turn"];
    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(result.exitCode).toBe(1);
    expect(lane.note).toContain("context window exceeded");
    expect(feed).toContain("context window exceeded");
  });

  test("writes the final report before a cleanup failure", () => {
    const root = tempPath("cleanup-failure");
    const state = `${root}/state`;
    const report = `${state}/reports/cleanup-r1.md`;
    const cleanupTrace = `${root}/cleanup.trace`;
    const env = {
      ...baseEnv(state, installFakeCodex(root)),
      FAKE_CLEANUP_FAIL: cleanupTrace,
      FAKE_REPORT_PATH: report,
    };
    const result = runCli(["spawn", "cleanup", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).cleanup;
    expect(result.exitCode).toBe(0);
    expect(readFileSync(report, "utf8").trim()).toBe("final report from app-server");
    expect(readFileSync(cleanupTrace, "utf8").trim()).toBe("report-present");
    expect(lane.state).toBe("done");
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("cleanup warning: thread unsubscribe failed after completed turn: cleanup exploded");
  });

  test("delivers a rejected steer as a follow-up turn", async () => {
    const root = tempPath("steer-follow-up");
    const state = `${root}/state`;
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_REJECT_STEER: "1" };
    expect(runCli(["spawn", "follow-up", "--engine", "gpt", "--cd", root, "--bg", "STEER_REJECTED_AFTER_COMPLETION"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["follow-up"]?.codexPid);
    expect(runCli(["send", "follow-up", "deliver this later"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["follow-up"]?.state === "done");
    expect(readFileSync(`${state}/reports/follow-up-r1.md`, "utf8").trim()).toBe("follow-up delivered");
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("steer delivered mode=follow-up-turn: deliver this later");
  }, 12000);

  test("expires stale questions when a round ends and defaults replies to the current round", async () => {
    const root = tempPath("stale-question");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeCodex(root));
    expect(runCli(["spawn", "questions", "--engine", "gpt", "--cd", root, "--bg", "WAIT_FOR_STEER"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).questions?.codexPid);
    const questionDir = `${state}/questions`;
    const askedAt = new Date().toISOString();
    writeFileSync(`${questionDir}/questions-r1-1.json`, JSON.stringify({ lane: "questions", round: 1, seq: 1, question: "old?", askedAt, answered: false }));
    expect(runCli(["send", "questions", "finish"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).questions?.state === "done");
    const expired = JSON.parse(readFileSync(`${questionDir}/questions-r1-1.json`, "utf8"));
    expect(expired.status).toBe("expired: round ended");

    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    ledger.questions.rounds = 2;
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));
    writeFileSync(`${questionDir}/questions-r1-2.json`, JSON.stringify({ lane: "questions", round: 1, seq: 2, question: "forged stale?", askedAt, answered: false }));
    writeFileSync(`${questionDir}/questions-r2-3.json`, JSON.stringify({ lane: "questions", round: 2, seq: 3, question: "current?", askedAt, answered: false }));
    const listed = runCli(["questions", "questions"], env).stdout;
    expect(listed).toContain("QUESTION #3");
    expect(listed).not.toContain("QUESTION #2");
    expect(runCli(["reply", "questions", "current answer"], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(`${questionDir}/questions-r1-2.json`, "utf8")).answered).toBe(false);
    expect(JSON.parse(readFileSync(`${questionDir}/questions-r2-3.json`, "utf8")).answer).toBe("current answer");
  }, 12000);

  test("normalizes multiline user text before writing line protocols", async () => {
    const state = tempPath("single-line");
    const injected = "hello\r\n[cdx] lane=victim round=9 state=done";
    const sender = { ...baseEnv(state), CLAUDE_CODE_SESSION_ID: "aaaaaaaa-source-session" };
    expect(runCli(["msg", "bbbbbbbb", injected], sender).exitCode).toBe(0);
    const feedLines = readFileSync(`${state}/feed.log`, "utf8").trim().split("\n");
    expect(feedLines).toHaveLength(1);
    expect(feedLines[0]).toContain("hello [cdx] lane=victim round=9 state=done");

    const askEnv = { ...baseEnv(state), CDX_LANE: "safe", CDX_ROUND: "1", CDX_OWNER: "12345678-owner" };
    const timed = runCli(["ask", "--timeout", "0.001", "which\nfile?"], askEnv);
    expect(timed.exitCode).toBe(0);
    const question = JSON.parse(readFileSync(`${state}/questions/safe-r1-1.json`, "utf8"));
    expect(question.question).toBe("which file?");
    expect(readFileSync(`${state}/feed.log`, "utf8").split("\n").some((line) => line === "file?")).toBe(false);
  });

  test("clamps ask timeouts above 30 minutes", async () => {
    const state = tempPath("timeout-cap");
    const env = { ...baseEnv(state), CDX_LANE: "cap", CDX_ROUND: "1", CDX_OWNER: "12345678-owner" };
    const ask = Bun.spawn({ cmd: [process.execPath, CLI, "ask", "--timeout", "31", "wait?"], env, stdout: "pipe", stderr: "pipe" });
    runners.push(ask);
    await waitFor(() => existsSync(`${state}/questions/cap-r1-1.json`));
    ask.kill();
    await ask.exited;
    expect(await new Response(ask.stderr).text()).toContain("30m limit");
  });

  test("resume and fork preserve the thread model", () => {
    const root = tempPath("preserve-model");
    const state = `${root}/state`;
    const trace = `${root}/requests.jsonl`;
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_TRACE: trace };
    expect(runCli(["spawn", "model-source", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);

    writeFileSync(trace, "");
    expect(runCli(["resume", "model-source", "REPORT_ONLY"], env).exitCode).toBe(0);
    let requests = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === "thread/resume").params.model).toBeUndefined();
    expect(requests.find((request) => request.method === "turn/start").params.model).toBeUndefined();

    writeFileSync(trace, "");
    expect(runCli(["fork", "model-fork", "model-source", "REPORT_ONLY"], env).exitCode).toBe(0);
    requests = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === "thread/fork").params.model).toBeUndefined();
    expect(requests.find((request) => request.method === "turn/start").params.model).toBeUndefined();
  }, 15000);

  test("passes the selected account CODEX_HOME to the app-server child", () => {
    const root = tempPath("account-home");
    const state = `${root}/state`;
    const accountHome = `${root}/account`;
    const envTrace = `${root}/env.trace`;
    mkdirSync(state, { recursive: true });
    mkdirSync(accountHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", efforts: ["medium"], defaultEffort: "medium", rules: [], accounts: { paid: accountHome },
    }));
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_ENV_TRACE: envTrace };
    expect(runCli(["spawn", "account", "--engine", "gpt", "--account", "paid", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(readFileSync(envTrace, "utf8").trim()).toBe(accountHome);
  });

  test("resume uses the lane account home and lane-based fork inherits it", () => {
    const root = tempPath("reopen-account-home");
    const state = `${root}/state`;
    const primaryHome = `${root}/codex-1`;
    const pinnedHome = `${root}/codex-2`;
    const envTrace = `${root}/env.trace`;
    mkdirSync(state, { recursive: true });
    mkdirSync(primaryHome, { recursive: true });
    mkdirSync(pinnedHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", efforts: ["medium"], defaultEffort: "medium", rules: [],
      accounts: { "codex-1": primaryHome, "codex-2": pinnedHome },
    }));
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_ENV_TRACE: envTrace };
    expect(runCli(["spawn", "pinned", "--engine", "gpt", "--account", "codex-2", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);

    writeFileSync(envTrace, "");
    expect(runCli(["resume", "pinned", "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(readFileSync(envTrace, "utf8").trim()).toBe(pinnedHome);

    writeFileSync(envTrace, "");
    expect(runCli(["fork", "pinned-fork", "pinned", "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(readFileSync(envTrace, "utf8").trim()).toBe(pinnedHome);
    const fork = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["pinned-fork"];
    expect(fork.account).toBe("codex-2");
    expect(fork.codexHome).toBe(pinnedHome);
  }, 15000);

  test("raw-session fork accepts an account and records its home", () => {
    const root = tempPath("raw-fork-account-home");
    const state = `${root}/state`;
    const pinnedHome = `${root}/codex-2`;
    const envTrace = `${root}/env.trace`;
    mkdirSync(state, { recursive: true });
    mkdirSync(pinnedHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", efforts: ["medium"], defaultEffort: "medium", rules: [],
      accounts: { "codex-2": pinnedHome },
    }));
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_ENV_TRACE: envTrace };
    const source = "22222222-2222-4222-8222-222222222222";
    expect(runCli(["fork", "raw-fork", source, "--account", "codex-2", "--model", "gpt-6-astra", "REPORT_ONLY"], { ...env, FAKE_TRACE: `${root}/requests.trace` }).exitCode).toBe(0);
    expect(readFileSync(envTrace, "utf8").trim()).toBe(pinnedHome);
    const fork = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["raw-fork"];
    expect(fork.account).toBe("codex-2");
    expect(fork.codexHome).toBe(pinnedHome);
    expect(fork.model).toBe("gpt-6-astra");
    // The requested model reaches the forked thread's turn, not just the ledger.
    const turn = readFileSync(`${root}/requests.trace`, "utf8").split("\n").map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).find((request) => request?.method === "turn/start");
    expect(turn.params.model).toBe("gpt-6-astra");
  });

  test("existing-lane commands refuse --account and name the pinned account", () => {
    const root = tempPath("pinned-account-refusal");
    const state = `${root}/state`;
    const pinnedHome = `${root}/codex-2`;
    mkdirSync(state, { recursive: true });
    mkdirSync(pinnedHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", efforts: ["medium"], defaultEffort: "medium", rules: [],
      accounts: { "codex-2": pinnedHome },
    }));
    const env = baseEnv(state, installFakeCodex(root));
    expect(runCli(["spawn", "pinned", "--engine", "gpt", "--account", "codex-2", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);

    const resume = runCli(["resume", "pinned", "--account", "codex-2", "REPORT_ONLY"], env);
    expect(resume.exitCode).toBe(1);
    expect(`${resume.stdout}${resume.stderr}`).toContain('lane "pinned" is pinned to account "codex-2"');

    const fork = runCli(["fork", "copy", "pinned", "--account", "codex-2", "REPORT_ONLY"], env);
    expect(fork.exitCode).toBe(1);
    expect(`${fork.stdout}${fork.stderr}`).toContain('lane "pinned" is pinned to account "codex-2"');

    const review = runCli(["review", "pinned", "--engine", "gpt", "--account", "codex-2", "review this"], env);
    expect(review.exitCode).toBe(1);
    expect(`${review.stdout}${review.stderr}`).toContain('lane "pinned" is pinned to account "codex-2"');

    const respawn = runCli(["spawn", "pinned", "--engine", "gpt", "--account", "codex-2", "--cd", root, "REPORT_ONLY"], env);
    expect(respawn.exitCode).toBe(1);
    expect(`${respawn.stdout}${respawn.stderr}`).toContain('lane "pinned" is pinned to account "codex-2"');
  });

  test("review of an existing lane uses its recorded account home", () => {
    const root = tempPath("review-account-home");
    const state = `${root}/state`;
    const primaryHome = `${root}/codex-1`;
    const pinnedHome = `${root}/codex-2`;
    const envTrace = `${root}/env.trace`;
    mkdirSync(state, { recursive: true });
    mkdirSync(primaryHome, { recursive: true });
    mkdirSync(pinnedHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", efforts: ["medium"], defaultEffort: "medium", rules: [],
      accounts: { "codex-1": primaryHome, "codex-2": pinnedHome },
    }));
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_ENV_TRACE: envTrace };
    expect(runCli(["spawn", "review-pinned", "--engine", "gpt", "--account", "codex-2", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);

    writeFileSync(envTrace, "");
    expect(runCli(["review", "review-pinned", "--engine", "gpt", "review this"], env).exitCode).toBe(0);
    expect(readFileSync(envTrace, "utf8").trim()).toBe(pinnedHome);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["review-pinned"];
    expect(lane.account).toBe("codex-2");
    expect(lane.codexHome).toBe(pinnedHome);
  });

  test("pre-upgrade lane resumes with the default Codex home and writes a feed note", () => {
    const root = tempPath("legacy-account-fallback");
    const state = `${root}/state`;
    const pinnedHome = `${root}/codex-2`;
    const envTrace = `${root}/env.trace`;
    mkdirSync(state, { recursive: true });
    mkdirSync(pinnedHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", efforts: ["medium"], defaultEffort: "medium", rules: [],
      accounts: { "codex-2": pinnedHome },
    }));
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_ENV_TRACE: envTrace };
    delete env.CODEX_HOME;
    expect(runCli(["spawn", "legacy", "--engine", "gpt", "--account", "codex-2", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    delete ledger.legacy.account;
    delete ledger.legacy.codexHome;
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));

    writeFileSync(envTrace, "");
    expect(runCli(["resume", "legacy", "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(readFileSync(envTrace, "utf8").trim()).toBe(`${env.HOME}/.codex`);
    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain("lane=legacy");
    expect(feed).toContain("pre-upgrade lane has no recorded account");
    expect(feed).toContain(`${env.HOME}/.codex`);
  });

  test("fails doctor promptly when the app-server dies before completion", () => {
    const root = tempPath("doctor-death");
    const state = `${root}/state`;
    const bin = installFakeCodex(root, { doctorDies: true });
    const env = baseEnv(state, bin);
    env.PATH = `${bin}:${process.execPath.replace(/\/[^/]+$/, "")}:/usr/bin:/bin`;
    const started = Date.now();
    const result = runCli(["doctor", "--probe"], env);
    expect(result.exitCode).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(`${result.stdout}${result.stderr}`).toContain("app-server closed");
  });

  test("escalates max-runtime from SIGTERM to SIGKILL", () => {
    const root = tempPath("max-runtime");
    const state = `${root}/state`;
    const signalTrace = `${root}/signals.log`;
    const env = { ...baseEnv(state, installFakeCodex(root, { ignoreSigterm: true })), FAKE_SIGNAL_TRACE: signalTrace };
    const started = Date.now();
    const result = runCli(["spawn", "runtime", "--engine", "gpt", "--cd", root, "--max-runtime", "0.02", "IGNORE_SIGTERM"], env);
    const elapsed = Date.now() - started;
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).runtime;
    expect(result.exitCode).toBe(1);
    expect(readFileSync(signalTrace, "utf8")).toContain("SIGTERM");
    expect(elapsed).toBeGreaterThanOrEqual(10_500);
    expect(elapsed).toBeLessThan(16_000);
    expect(lane.state).toBe("failed");
    expect(lane.note).toContain("max runtime");
  }, 20_000);

  test("counts all model calls in a Codex round", () => {
    const root = tempPath("multi-call-tokens");
    const state = `${root}/state`;
    const result = runCli(["spawn", "multi-call", "--engine", "gpt", "--cd", root, "MULTI_CALL_USAGE"], baseEnv(state, installFakeCodex(root)));
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["multi-call"];
    expect(result.exitCode).toBe(0);
    expect(lane.roundTokens).toEqual({ input: 21, cached: 6, output: 9 });
    expect(lane.tokens).toEqual({ input: 21, cached: 6, output: 9 });
  });

  test("refuses to close a lane with a live round", async () => {
    const root = tempPath("close-running");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeCodex(root));
    expect(runCli(["spawn", "close-running", "--engine", "gpt", "--cd", root, "--bg", "WAIT_FOR_STEER"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["close-running"]?.codexPid);
    const closed = runCli(["close", "close-running"], env);
    expect(closed.exitCode).toBe(1);
    expect(closed.stderr).toContain("kill it first");
    expect(runCli(["kill", "close-running"], env).exitCode).toBe(0);
  }, 12_000);

  test("records a cdx kill as a signal exit", async () => {
    const root = tempPath("kill-signal");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeCodex(root));
    expect(runCli(["spawn", "kill-signal", "--engine", "gpt", "--cd", root, "--bg", "WAIT_FOR_STEER"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["kill-signal"]?.codexPid);
    expect(runCli(["kill", "kill-signal"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["kill-signal"]?.state === "failed");
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["kill-signal"];
    expect(lane.exitCode).toBe(143);
    expect(lane.note).toContain("signal (exit 143)");
  }, 12_000);

  test("does not print a report from an earlier round", () => {
    const root = tempPath("stale-report");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeCodex(root));
    expect(runCli(["spawn", "stale-report", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    ledger["stale-report"].rounds = 2;
    ledger["stale-report"].workReport = undefined;
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));
    const waited = runCli(["wait", "stale-report", "--report"], env);
    expect(waited.exitCode).toBe(0);
    expect(waited.stdout).not.toContain("final report from app-server");
  });

  test("prints a status --json larger than a pipe buffer in full", () => {
    const root = tempPath("big-status");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeCodex(root));
    expect(runCli(["spawn", "seed", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    for (let index = 0; index < 200; index += 1) ledger[`copy-${index}`] = { ...ledger.seed };
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));
    const result = runCli(["status", "--json"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(70_000);
    expect(Object.keys(JSON.parse(result.stdout)).length).toBe(201);
  });

  test("truncates feed.log to its last 2000 lines during clean", () => {
    const state = tempPath("feed-rotation");
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/feed.log`, Array.from({ length: 2105 }, (_, index) => `line-${index}`).join("\n") + "\n");
    expect(runCli(["clean"], baseEnv(state)).exitCode).toBe(0);
    const lines = readFileSync(`${state}/feed.log`, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toBe("line-105");
    expect(lines.at(-1)).toBe("line-2104");
  });
});

describe("cdx execution engines", () => {
  test("defaults engine to gemini for spawn, review, and adopt, and prints default notice", () => {
    const root = tempPath("engine-default");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeAgy(root));

    const spawnResult = runCli(["spawn", "default-spawn", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(spawnResult.exitCode).toBe(0);
    expect(spawnResult.stdout).toContain("cdx: engine gemini (default)");
    const spawnLane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["default-spawn"];
    expect(spawnLane.engine).toBe("gemini");

    const adoptResult = runCli(["adopt", "default-adopt", "44444444-4444-4444-8444-444444444444", "--cd", root], env);
    expect(adoptResult.exitCode).toBe(0);
    expect(adoptResult.stdout).toContain("cdx: engine gemini (default)");
    const adoptLane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["default-adopt"];
    expect(adoptLane.engine).toBe("gemini");

    const spawnBad = runCli(["spawn", "bad-engine", "--engine", "claude", "--cd", root, "REPORT_ONLY"], env);
    expect(spawnBad.exitCode).toBe(1);
    expect(spawnBad.stderr).toContain("--engine gpt|gemini");
    expect(spawnBad.stderr).toContain("gemini is the default; pass --engine gpt for design-heavy or judgment work");
    expect(spawnBad.stderr).toContain("gpt:\n+ strongest code and judgment on hard multi-file work, design-heavy lanes");
    expect(spawnBad.stderr).toContain("- weaker adversarial self-doubt, needs a precise brief with named files and acceptance checks");
  });

  test("resolves gemini for review without --engine on gpt lane and warns for gemini on gemini", () => {
    const root = tempPath("review-engine-resolution");
    const state = tempPath("review-engine-state");
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(root);
    const env = {
      ...baseEnv(state),
      PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}`,
    };
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const spawnGpt = runCli(["spawn", "gpt-lane", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env);
    expect(spawnGpt.exitCode).toBe(0);

    const reviewGpt = runCli(["review", "gpt-lane", "--cd", root, "REVIEW_CLEAN"], env);
    expect(reviewGpt.exitCode).toBe(0);
    expect(reviewGpt.stdout).toContain("cdx: engine gemini (default)");
    const gptLane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gpt-lane"];
    expect(gptLane.reviewState).toBe("done");
    expect(gptLane.engine).toBe("gpt");
    expect(gptLane.reviewEngine).toBe("gemini");
    expect(runCli(["resume", "gpt-lane", "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gpt-lane"].engine).toBe("gpt");

    const spawnGemini = runCli(["spawn", "gemini-lane", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(spawnGemini.exitCode).toBe(0);

    const reviewGemini = runCli(["review", "gemini-lane", "--cd", root, "REVIEW_CLEAN"], env);
    expect(reviewGemini.exitCode).toBe(0);
    expect(reviewGemini.stdout).toContain("cdx: engine gemini (default)");
    expect(reviewGemini.stdout).toContain("cdx: gemini reviewing a gemini lane; give the intent explicit attack items");
    const geminiLane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-lane"];
    expect(geminiLane.reviewState).toBe("done");
  }, 15000);

  test("a review-only lane follows the engine of its latest review and resumes there", () => {
    const root = tempPath("review-only-switch");
    const state = tempPath("review-only-switch-state");
    // The trace lives outside the reviewed repo, or the review round would
    // rightly fail as "review modified the tree".
    const trace = `${state}/agy-trace.jsonl`;
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(root);
    const env = {
      ...baseEnv(state),
      PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}`,
      FAKE_AGY_TRACE: trace,
    };
    mkdirSync(state, { recursive: true });
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    // The fake codex has no exec mode, so the review-only gpt lane is seeded
    // from a gemini review and re-labelled to the shape a codex intent review
    // leaves behind: kind review, engine gpt, a codex session id, no work thread.
    expect(runCli(["review", "audit", "--engine", "gemini", "--cd", root, "REVIEW_CLEAN"], env).exitCode).toBe(0);
    const ledgerPath = `${state}/ledger.json`;
    const seeded = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(seeded.audit.kind).toBe("review");
    expect(seeded.audit.workSessionId).toBeUndefined();
    seeded.audit.engine = "gpt";
    seeded.audit.reviewEngine = "gpt";
    seeded.audit.sessionId = "22222222-2222-4222-8222-222222222222";
    writeFileSync(ledgerPath, JSON.stringify(seeded, null, 2));

    expect(runCli(["review", "audit", "--engine", "gemini", "--cd", root, "REVIEW_CLEAN"], env).exitCode).toBe(0);
    const switched = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).audit;
    expect(switched.engine).toBe("gemini");
    expect(switched.reviewEngine).toBe("gemini");

    writeFileSync(trace, "");
    expect(runCli(["resume", "audit", "REVIEW_CLEAN"], env).exitCode).toBe(0);
    const calls = readFileSync(trace, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { args?: string[] })
      .filter((record): record is { args: string[] } => Array.isArray(record.args));
    expect(calls.length).toBeGreaterThan(0);
    const conversations = calls.map((call) => call.args[call.args.indexOf("--conversation") + 1]);
    expect(conversations).toEqual(calls.map(() => switched.sessionId));
  }, 20000);

  test("refuses agy cancellation template as a report and suppresses gate", () => {
    expect(isAgyCancellationTemplate("User initiated cancellation")).toBe(true);
    expect(isAgyCancellationTemplate("Execution stopped per your cancellation request.")).toBe(true);
    expect(isAgyCancellationTemplate("An execution step was interrupted by the user.\n\nReason: User initiated cancellation.")).toBe(true);
    expect(isAgyCancellationTemplate("# Audit: User initiated cancellation handling in cdx\n\nFindings follow.")).toBe(false);
    expect(isAgyCancellationTemplate("An execution step was interrupted by the user while running tool")).toBe(true);
    expect(isAgyCancellationTemplate("Finished inspecting the files; report complete.")).toBe(false);
    expect(isAgyCancellationTemplate(`An execution step was interrupted by the user while running tool run_command with ${"x".repeat(400)}`)).toBe(true);
    expect(isAgyCancellationTemplate('# Lane report\n\nThe runner prints "User initiated cancellation" when a turn is aborted.')).toBe(false);

    const root = tempPath("gemini-cancel-template");
    const state = tempPath("gemini-cancel-state");
    const gateMarker = `${root}/gate-ran`;
    const env = baseEnv(state, installFakeAgy(root));

    const result = runCli(["spawn", "cancel-lane", "--engine", "gemini", "--cd", root, "--gate", `touch ${gateMarker}`, "AGY_CANCEL_TEMPLATE"], env);
    expect(result.exitCode).toBe(1);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["cancel-lane"];
    expect(lane.state).toBe("failed");
    expect(lane.note).toContain("agy returned its cancellation template as the report; no qualifying report");
    expect(readFileSync(`${state}/reports/cancel-lane-r1.md`, "utf8")).toContain("User initiated cancellation");
    expect(existsSync(gateMarker)).toBe(false);
  });

  test("empty-diff work round under a gate still runs the gate and reports the unchanged tree", () => {
    const root = tempPath("empty-diff-gate");
    const state = tempPath("empty-diff-gate-state");
    const bin = installFakeCodex(root);
    const gateMarker = `${root}/gate-ran`;
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const env = baseEnv(state, bin);
    const result = runCli(["spawn", "empty-gate", "--engine", "gpt", "--cd", root, "--gate", `touch ${gateMarker}`, "REPORT_ONLY"], env);
    expect(result.exitCode).toBe(0);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["empty-gate"];
    expect(lane.state).toBe("done");
    expect(lane.diffEmpty).toBe(true);
    expect(existsSync(gateMarker)).toBe(true);
    expect(readFileSync(`${state}/reports/empty-gate-r1.md`, "utf8")).toContain("This round changed no files.");
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("diff=empty");

    // A failing gate is still the verdict, changed tree or not.
    const failing = runCli(["spawn", "empty-gate-red", "--engine", "gpt", "--cd", root, "--gate", "exit 3", "REPORT_ONLY"], env);
    expect(failing.exitCode).toBe(1);
    const red = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["empty-gate-red"];
    expect(red.state).toBe("failed");
    expect(red.note).toContain("gate failed (exit 3)");
  });

  test("a commit made during the round counts as landed work under a gate", () => {
    const root = tempPath("commit-diff-gate");
    const state = tempPath("commit-diff-gate-state");
    const bin = installFakeCodex(root);
    const gateMarker = `${root}/gate-ran`;
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const result = runCli(["spawn", "commit-gate", "--engine", "gpt", "--cd", root, "--gate", `touch ${gateMarker}`, "COMMIT_WORK"], baseEnv(state, bin));
    expect(result.exitCode).toBe(0);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["commit-gate"];
    expect(lane.state).toBe("done");
    expect(existsSync(gateMarker)).toBe(true);
  });

  test("empty-diff work round without gate completes done with report note, feed token, and status marker", () => {
    const root = tempPath("empty-diff-nogate");
    const state = tempPath("empty-diff-nogate-state");
    const bin = installFakeCodex(root);
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const env = baseEnv(state, bin);
    const result = runCli(["spawn", "empty-nogate", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env);
    expect(result.exitCode).toBe(0);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["empty-nogate"];
    expect(lane.state).toBe("done");
    expect(lane.diffEmpty).toBe(true);
    expect(readFileSync(`${state}/reports/empty-nogate-r1.md`, "utf8")).toContain("\n\n## Harness note\n\nThis round changed no files.\n");
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("diff=empty");
    const status = runCli(["status"], env);
    expect(status.stdout).toContain("no tree change");
  });

  test("changed tree work round is unaffected by unchanged-tree check", () => {
    const root = tempPath("changed-work-tree");
    const state = tempPath("changed-work-tree-state");
    const bin = installFakeCodex(root);
    const gateMarker = `${root}/gate-ran`;
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const env = baseEnv(state, bin);
    const result = runCli(["spawn", "changed-tree", "--engine", "gpt", "--cd", root, "--gate", `touch ${gateMarker}`, "WRITE_WORK_FILE"], env);
    expect(result.exitCode).toBe(0);
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["changed-tree"];
    expect(lane.state).toBe("done");
    expect(lane.diffEmpty).toBeUndefined();
    expect(existsSync(gateMarker)).toBe(true);
    expect(readFileSync(`${state}/reports/changed-tree-r1.md`, "utf8")).not.toContain("## Harness note");
    expect(readFileSync(`${state}/feed.log`, "utf8")).not.toContain("diff=empty");
    const status = runCli(["status"], env);
    expect(status.stdout).not.toContain("no tree change");
  });

  test("houseRules emits gemini-specific rules and gpt-specific rules", () => {
    const harnessCommandRule = "Never run cdx spawn, resume, fork, review, adopt, kill, or close from inside a lane; the harness refuses them. cdx ask is the only harness command you need.";
    const geminiRules = houseRules("/tmp", false, "gemini");
    expect(geminiRules).toContain(harnessCommandRule);
    expect(geminiRules).toContain("run `cdx ask");
    expect(geminiRules).toContain("Execute the task as written. Do not redesign, expand scope, or resolve open design questions yourself; the head owns the design and you own the delivery.");
    expect(geminiRules).toContain("do not spawn subagents");
    expect(geminiRules).not.toContain("search_web");
    expect(geminiRules).toContain("remove the temporary diagnostics you added while debugging");
    expect(geminiRules).toContain("The report lists exactly which files changed, the commands you ran with their exit codes, and an Assumptions heading (write 'none' if empty).");
    expect(geminiRules).toContain("You are one lane of cdx");

    const gptRules = houseRules("/tmp", false, "gpt");
    expect(gptRules).toContain(harnessCommandRule);
    expect(gptRules).toContain("Delegate to your own subagents only when");
    expect(gptRules).toContain("run `cdx ask");
    expect(gptRules).not.toContain("Execute the task as written");

    const review = houseRules("/tmp", true, "gemini");
    expect(review).toContain("READ-ONLY: change nothing in the tree");
    expect(review).not.toContain("Never commit, push");
    expect(review).not.toContain(harnessCommandRule);
  });

  test("refuses driving commands from inside a lane worker but allows inspection commands", () => {
    const root = tempPath("worker-guard");
    const state = tempPath("worker-guard-state");
    const env = { ...baseEnv(state), CDX_LANE: "some-lane" };

    const spawnResult = runCli(["spawn", "nested", "--cd", root, "DO_WORK"], env);
    expect(spawnResult.exitCode).toBe(1);
    expect(spawnResult.stderr).toContain('cdx: lane workers cannot drive the harness (command "spawn" refused inside lane some-lane); use cdx ask for anything you need from the head');

    const statusResult = runCli(["status"], env);
    expect(statusResult.exitCode).toBe(0);
  });

  test("runs .cdx-worktree-setup in newly created worktree", () => {
    const root = tempPath("repo-setup-hook");
    const state = tempPath("repo-setup-hook-state");
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const setupHook = `${root}/.cdx-worktree-setup`;
    writeFileSync(setupHook, "#!/bin/sh\ntouch repo-setup-marker\n", { mode: 0o755 });
    chmodSync(setupHook, 0o755);
    expect(Bun.spawnSync({ cmd: ["git", "add", ".cdx-worktree-setup"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "-qm", "add hook"], cwd: root }).exitCode).toBe(0);

    const wtPath = `${root}/wt-hook`;
    const env = baseEnv(state, installFakeCodex(root));
    const result = runCli(["spawn", "wt-hook-lane", "--engine", "gpt", "--cd", root, "--worktree", wtPath, "REPORT_ONLY"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cdx: repo worktree setup: .cdx-worktree-setup");
    expect(existsSync(`${wtPath}/repo-setup-marker`)).toBe(true);
  });

  test("runs a gemini lane and records its report, tokens, engine, and conversation", () => {
    const root = tempPath("gemini-spawn");
    const state = `${root}/state`;
    const trace = `${root}/agy.trace`;
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    const result = runCli(["spawn", "gemini-work", "--engine", "gemini", "--effort", "low", "--cd", root, "BUILD_SMALL_THING"], env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--effort ignored for gemini; gemini lanes always run gemini-3.8-flash-high");
    expect(readFileSync(`${state}/reports/gemini-work-r1.md`, "utf8")).toContain("gemini report:");
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-work"];
    expect(lane.engine).toBe("gemini");
    expect(lane.effort).toBe("high");
    expect(lane.sessionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(lane.tokens).toEqual({ input: 11, cached: 2, output: 5 });
    expect(lane.roundTokens).toEqual({ input: 11, cached: 2, output: 5 });

    const invocation = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
    expect(invocation.args).toContain("--input-format");
    expect(invocation.args).toContain("stream-json");
    expect(invocation.args).toContain("gemini-3.8-flash-high");
    expect(invocation.args).toContain("cdx-lane");
    expect(invocation.args).toContain(root);
    expect(invocation.codexHome).toBeUndefined();
  });

  test("adds the bounded-work rule only to gemini prompts", () => {
    const root = tempPath("gemini-house-rule");
    const state = `${root}/state`;
    const agyTrace = `${root}/agy.trace`;
    const codexTrace = `${root}/codex.trace`;
    const rule = "Execute the task as written. Do not redesign, expand scope, or resolve open design questions yourself; the head owns the design and you own the delivery.";
    const bin = installFakeCodex(root);
    installFakeAgy(root);

    expect(runCli(["spawn", "gemini-rule", "--engine", "gemini", "--cd", root, "inspect one file"], {
      ...baseEnv(state, bin),
      FAKE_AGY_TRACE: agyTrace,
    }).exitCode).toBe(0);
    const geminiPrompt = readFileSync(agyTrace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.input)?.input;
    expect(geminiPrompt).toContain(rule);

    expect(runCli(["spawn", "gpt-rule", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], {
      ...baseEnv(state, bin),
      FAKE_TRACE: codexTrace,
    }).exitCode).toBe(0);
    const requests = readFileSync(codexTrace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const gptPrompt = requests.find((request) => request.method === "turn/start").params.input.find((item) => item.type === "text").text;
    expect(gptPrompt).not.toContain(rule);
  });

  test("warns when a gemini brief exceeds 1500 words", () => {
    const root = tempPath("gemini-long-brief");
    const state = `${root}/state`;
    const configHome = `${root}/agy-config`;
    mkdirSync(configHome, { recursive: true });
    writeFileSync(`${configHome}/hooks.json`, JSON.stringify({
      cdx: {
        enabled: true,
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${process.execPath} ${realpathSync(CLI)} hook pre-tool`, timeout: 10 }] }],
        PreInvocation: [{ type: "command", command: `${process.execPath} ${realpathSync(CLI)} hook pre-invocation`, timeout: 10 }],
      },
    }, null, 2) + "\n");
    const env = {
      ...baseEnv(state, installFakeAgy(root)),
      CDX_AGY_CONFIG_HOME: configHome,
    };
    const brief = Array.from({ length: 1501 }, (_, index) => `word${index}`).join(" ");
    const expected = "cdx: gemini brief is 1501 words; gemini works best on one outcome per lane, consider splitting into parallel lanes";
    const result = runCli(["spawn", "gemini-long", "--engine", "gemini", "--cd", root, brief], env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe(expected);
    expect(readFileSync(`${state}/feed.log`, "utf8").split("\n")).toContain(expected);

    const boundary = Array.from({ length: 1500 }, (_, index) => `word${index}`).join(" ");
    const boundaryResult = runCli(["spawn", "gemini-boundary", "--engine", "gemini", "--cd", root, boundary], env);
    expect(boundaryResult.exitCode).toBe(0);
    expect(boundaryResult.stderr).not.toContain("gemini brief is");
  });

  test("delivers cdx send as a gemini follow-up turn and resumes its conversation", async () => {
    const root = tempPath("gemini-follow-up");
    const state = `${root}/state`;
    const trace = `${root}/agy.trace`;
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    expect(runCli(["spawn", "gemini-follow-up", "--engine", "gemini", "--cd", root, "--bg", "WAIT_FOR_FOLLOW_UP LONG_SLEEP"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-follow-up"]?.codexPid);
    expect(runCli(["send", "gemini-follow-up", "inspect the tests"], env).exitCode).toBe(0);

    // With hooks missing, the send is written immediately to stdin
    const getStdinUsers = () => {
      if (!existsSync(trace)) return [];
      return readFileSync(trace, "utf8").trim().split("\n")
        .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .filter((r) => r.stdinUser)
        .map((r) => r.stdinUser);
    };
    await waitFor(() => getStdinUsers().some((u: string) => u.includes("inspect the tests")));
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-follow-up"]?.state).toBe("running");

    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-follow-up"]?.state === "done");
    expect(readFileSync(`${state}/reports/gemini-follow-up-r1.md`, "utf8").trim()).toContain("follow-up result: inspect the tests");
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("mode=follow-up-turn");
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-follow-up"].steers).toBe(1);
    expect(readFileSync(`${state}/control/gemini-follow-up-r1.delivered`, "utf8").trim()).toBe("1");

    writeFileSync(trace, "");
    expect(runCli(["resume", "gemini-follow-up", "check once more"], env).exitCode).toBe(0);
    const invocation = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
    const conversationIndex = invocation.args.indexOf("--conversation");
    expect(invocation.args[conversationIndex + 1]).toBe("33333333-3333-4333-8333-333333333333");
  }, 15_000);

  test("round-trips cdx ask and reply from a gemini child", async () => {
    const root = tempPath("gemini-ask");
    const state = `${root}/state`;
    const trace = `${root}/agy.trace`;
    const env = {
      ...baseEnv(state, installFakeAgy(root)),
      FAKE_AGY_TRACE: trace,
      FAKE_CDX_CLI: CLI,
    };
    expect(runCli(["spawn", "gemini-ask", "--engine", "gemini", "--cd", root, "--bg", "ASK_OWNER"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/questions/gemini-ask-r1-1.json`));
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("QUESTION #1: Which file should I inspect?");
    expect(runCli(["reply", "gemini-ask", "src/engine.ts"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-ask"]?.state === "done");
    expect(readFileSync(`${state}/reports/gemini-ask-r1.md`, "utf8").trim()).toBe("owner answered: src/engine.ts");
    const answer = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.answer)?.answer;
    expect(answer).toBe("src/engine.ts");
  }, 12_000);

  test("refuses unsupported gemini fork, image, and account options", () => {
    const root = tempPath("gemini-options");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeAgy(root));
    expect(runCli(["spawn", "gemini-source", "--engine", "gemini", "--cd", root, "DONE"], env).exitCode).toBe(0);

    const fork = runCli(["fork", "gemini-copy", "gemini-source", "continue"], env);
    expect(fork.exitCode).toBe(1);
    expect(fork.stderr).toContain("gemini has no headless fork; use cdx resume");

    const resume = runCli(["resume", "gemini-source", "--engine", "gemini", "continue"], env);
    expect(resume.exitCode).toBe(1);
    expect(resume.stderr).toContain("--engine");

    const image = runCli(["spawn", "gemini-image", "--engine", "gemini", "--cd", root, "--image", `${root}/image.png`, "inspect"], env);
    expect(image.exitCode).toBe(1);
    expect(image.stderr).toContain("not supported for gemini");

    const account = runCli(["spawn", "gemini-account", "--engine", "gemini", "--account", "paid", "--cd", root, "inspect"], env);
    expect(account.exitCode).toBe(1);
    expect(account.stderr).toContain("--account");
  });

  test("passes a copied schema to agy", () => {
    const root = tempPath("gemini-schema");
    const state = `${root}/state`;
    const schema = `${root}/answer.schema.json`;
    const trace = `${root}/agy.trace`;
    mkdirSync(root, { recursive: true });
    writeFileSync(schema, JSON.stringify({ type: "object", required: ["answer"], properties: { answer: { type: "string" } } }));
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    expect(runCli(["spawn", "gemini-schema", "--engine", "gemini", "--cd", root, "--schema", schema, "answer"], env).exitCode).toBe(0);

    const args = JSON.parse(readFileSync(trace, "utf8").split("\n")[0]).args;
    const schemaIndex = args.indexOf("--json-schema");
    expect(args[schemaIndex + 1]).toBe(`${state}/specs/gemini-schema-r1.schema.json`);
    expect(JSON.parse(readFileSync(args[schemaIndex + 1], "utf8"))).toEqual(JSON.parse(readFileSync(schema, "utf8")));
  });

  test("fails a hanging gemini lane at max runtime", () => {
    const root = tempPath("gemini-runtime");
    const state = `${root}/state`;
    const started = Date.now();
    const result = runCli(["spawn", "gemini-runtime", "--engine", "gemini", "--cd", root, "--max-runtime", "0.005", "HANG_AGY"], baseEnv(state, installFakeAgy(root)));
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-runtime"];
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lane.state).toBe("failed");
    expect(lane.note).toContain("max runtime");
  }, 6000);

  test("fails a gemini lane when agy returns ERROR", () => {
    const root = tempPath("gemini-error");
    const state = `${root}/state`;
    const result = runCli(["spawn", "gemini-error", "--engine", "gemini", "--cd", root, "AGY_ERROR"], baseEnv(state, installFakeAgy(root)));
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-error"];
    expect(result.exitCode).toBe(1);
    expect(lane.state).toBe("failed");
    expect(lane.note).toContain("scripted agy failure");
    expect(readFileSync(`${state}/reports/gemini-error-r1.partial.md`, "utf8")).toContain("scripted agy failure");
  });

  test("auto-continues on gemini stream-interrupted transport error and succeeds on second turn", () => {
    const root = tempPath("gemini-auto-continue");
    const state = `${root}/state`;
    const trace = `${root}/agy.trace`;
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    const result = runCli(["spawn", "gemini-continue", "--engine", "gemini", "--cd", root, "STREAM_INTERRUPT"], env);
    expect(result.exitCode).toBe(0);

    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-continue"];
    expect(lane.state).toBe("done");
    expect(lane.continuations).toBe(1);

    const report = readFileSync(`${state}/reports/gemini-continue-r1.md`, "utf8").trim();
    expect(report).toBe("second response report");

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain("auto-continue 1/2");

    const traceLines = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const inputs = traceLines.filter((record) => record.input).map((record) => record.input);
    expect(inputs.length).toBe(2);
    expect(inputs[1]).toBe("The previous turn was cut off by a transport error. Continue the task you were working on from where you left off. When the task is complete, print your final lane report.");

    const status = runCli(["status"], env);
    expect(status.stdout).toContain("auto-continued 1x");
  });

  test("fails after 2 auto-continues when gemini errors 3 times in a row", () => {
    const root = tempPath("gemini-fail-3x");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeAgy(root));
    const result = runCli(["spawn", "gemini-fail-3x", "--engine", "gemini", "--cd", root, "FAIL_3X"], env);
    expect(result.exitCode).toBe(1);

    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-fail-3x"];
    expect(lane.state).toBe("failed");
    expect(lane.continuations).toBe(2);
    expect(lane.note).toMatch(/^turn failed after 2 auto-continues/);

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain("auto-continue 1/2");
    expect(feed).toContain("auto-continue 2/2");
  });

  test("fails without continuation on non-transport gemini error", () => {
    const root = tempPath("gemini-non-transport");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeAgy(root));
    const result = runCli(["spawn", "gemini-non-transport", "--engine", "gemini", "--cd", root, "NON_TRANSPORT_ERROR"], env);
    expect(result.exitCode).toBe(1);

    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-non-transport"];
    expect(lane.state).toBe("failed");
    expect(lane.continuations ?? 0).toBe(0);
    expect(lane.note).not.toContain("auto-continue");
    expect(lane.note).toContain("non-transport fatal error");

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).not.toContain("auto-continue");
  });

  test("never overwrites worker-written report with partial turn text on failure", () => {
    const root = tempPath("gemini-partial-report");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeAgy(root));
    const result = runCli(["spawn", "gemini-partial", "--engine", "gemini", "--cd", root, "WRITE_WORKER_REPORT_PARTIAL"], env);
    expect(result.exitCode).toBe(1);

    const workerReport = readFileSync(`${state}/reports/gemini-partial-r1.md`, "utf8").trim();
    expect(workerReport).toBe("worker report");

    const partialReport = readFileSync(`${state}/reports/gemini-partial-r1.partial.md`, "utf8").trim();
    expect(partialReport).toBe("progress text");

    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-partial"];
    expect(lane.state).toBe("failed");
    expect(lane.workReport).toBe(`${state}/reports/gemini-partial-r1.md`);

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain(`report=${state}/reports/gemini-partial-r1.md`);
  });

  test("gemini brief in briefs/ reflects updated house rules", () => {
    const root = tempPath("gemini-brief-rules");
    const state = `${root}/state`;
    const env = baseEnv(state, installFakeAgy(root));
    const result = runCli(["spawn", "brief-rules", "--engine", "gemini", "--cd", root, "inspect"], env);
    expect(result.exitCode).toBe(0);

    const brief = readFileSync(`${state}/briefs/brief-rules-r1.md`, "utf8");
    expect(brief).not.toContain("search_web");
    expect(brief).toContain("do not spawn subagents");
  });

  test("guards gemini reviews against writes and converts native targets to prompt text", () => {
    const root = tempPath("gemini-review");
    const state = tempPath("gemini-review-state");
    const trace = tempPath("gemini-review-trace");
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const clean = runCli(["review", "gemini-review-clean", "--engine", "gemini", "--cd", root, "REVIEW_CLEAN"], env);
    expect(clean.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-review-clean"].reviewState).toBe("done");

    writeFileSync(trace, "");
    const native = runCli(["review", "gemini-review-native", "--engine", "gemini", "--cd", root, "--uncommitted"], env);
    expect(native.exitCode).toBe(0);
    const prompt = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.input)?.input;
    expect(prompt).toContain("Review the diff shown by `git diff HEAD`");
    const promptFor = (args: string[]) => {
      writeFileSync(trace, "");
      expect(runCli(["review", ...args, "--engine", "gemini", "--cd", root], env).exitCode).toBe(0);
      return readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.input)?.input;
    };
    expect(promptFor(["gemini-review-base", "--base", "main"])).toContain("Review the diff shown by `git diff main...HEAD`");
    expect(promptFor(["gemini-review-commit", "--commit", "abc1234"])).toContain("Review the diff shown by `git show abc1234`");

    writeFileSync(`${root}/aaa-existing-dirty.txt`, "unchanged baseline dirt\n");
    writeFileSync(`${root}/fake-review-change.txt`, "original dirty content\n");
    const dirty = runCli(["review", "gemini-review-dirty", "--engine", "gemini", "--cd", root, "REVIEW_WRITE"], env);
    expect(dirty.exitCode).toBe(1);
    const dirtyLane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["gemini-review-dirty"];
    expect(dirtyLane.reviewState).toBe("failed");
    expect(dirtyLane.reviewNote).toContain("review modified the tree: fake-review-change.txt");
    expect(existsSync(`${state}/reports/gemini-review-dirty-r1.md`)).toBe(true);
  }, 15000);

  test("treats legacy lane entries without engine as gpt", () => {
    const root = tempPath("legacy-engine");
    const state = `${root}/state`;
    const trace = `${root}/codex.trace`;
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_TRACE: trace };
    expect(runCli(["spawn", "legacy-engine", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    delete ledger["legacy-engine"].engine;
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));
    const specPath = `${state}/specs/legacy-engine-r1.json`;
    const spec = JSON.parse(readFileSync(specPath, "utf8"));
    delete spec.engine;
    writeFileSync(specPath, JSON.stringify(spec));

    expect(runCli(["status"], env).stdout).toContain("gpt");
    expect(JSON.parse(runCli(["status", "--json"], env).stdout)["legacy-engine"].engine).toBe("gpt");
    expect(JSON.parse(runCli(["wait", "legacy-engine", "--json"], env).stdout).engine).toBe("gpt");
    expect(runCli(["resume", "legacy-engine", "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(readFileSync(trace, "utf8")).toContain('"method":"thread/resume"');
  });

  test("parses gemini usage into its own snapshot", () => {
    const root = tempPath("gemini-usage");
    const state = `${root}/state`;
    const bin = installFakeCodex(root);
    installFakeAgy(root);
    const result = runCli(["usage", "--json"], baseEnv(state, bin));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"gemini"');
    expect(result.stdout).toContain("99");
    expect(result.stdout).toContain("91");
    expect(readFileSync(`${state}/usage-gemini.json`, "utf8")).toContain("2026-09-09T18:16:57Z");
  });

  test("reports how to install agy when gemini is selected", () => {
    const root = tempPath("gemini-missing-binary");
    mkdirSync(root, { recursive: true });
    const result = runCli(["spawn", "gemini-missing", "--engine", "gemini", "--cd", root, "inspect"], {
      ...baseEnv(`${root}/state`),
      PATH: "/usr/bin:/bin",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("agy");
    expect(result.stderr).toContain("install");
  });

  test("rejects unknown gemini config keys", () => {
    const root = tempPath("gemini-config-key");
    const state = `${root}/state`;
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      rules: [],
      gemini: { effort: "high" },
    }));
    const result = runCli(["help"], baseEnv(state, installFakeAgy(root)));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("gemini");
    expect(result.stderr).toContain("effort");
  });

  test("doctor --probe round-trips the gemini engine", () => {
    const root = tempPath("gemini-probe");
    const state = `${root}/state`;
    const bin = installFakeCodex(root, { doctorDies: true });
    installFakeAgy(root);
    const env = baseEnv(state, bin);
    env.PATH = `${bin}:${process.execPath.replace(/\/[^/]+$/, "")}:/usr/bin:/bin`;
    const result = runCli(["doctor", "--probe"], env);
    expect(result.stdout).toContain("gemini probe: OK");
  });

  test("doctor checks and installs both gemini agent files", () => {
    const root = tempPath("gemini-doctor");
    const state = `${root}/state`;
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      rules: [],
      gemini: {},
    }));
    const bin = installFakeCodex(root);
    installFakeAgy(root);
    const env = baseEnv(state, bin);
    const fixed = runCli(["doctor", "--fix"], env);
    expect(fixed.exitCode).toBe(0);
    expect(existsSync(`${env.HOME}/.gemini/config/agents/cdx-lane/agent.md`)).toBe(true);
    expect(existsSync(`${env.HOME}/.gemini/config/agents/cdx-review/agent.md`)).toBe(true);
    const checked = runCli(["doctor"], env);
    expect(checked.exitCode).toBe(0);
    expect(checked.stdout).toContain("cdx-lane");
    expect(checked.stdout).toContain("cdx-review");
  });

  test("gemini review captures structured findings and writes clean markdown report", () => {
    const root = tempPath("gemini-review-structured");
    const state = tempPath("gemini-review-structured-state");
    const trace = tempPath("gemini-review-structured-trace");
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const result = runCli(["review", "structured-review", "--engine", "gemini", "--cd", root, "REVIEW_STRUCTURED"], env);
    expect(result.exitCode).toBe(0);

    const report = readFileSync(`${state}/reports/structured-review-r1.md`, "utf8");
    expect(report).toContain("# Review");
    expect(report).not.toContain("{");
    expect(report).not.toContain("}");

    const findings = JSON.parse(readFileSync(`${state}/reports/structured-review-r1.findings.json`, "utf8"));
    expect(findings).toEqual({
      findings: [{ severity: "P2", confidence: "CONFIRMED", file: "a.ts", line: 3, summary: "x" }],
    });

    const traces = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const invocation = traces[0];
    const schemaIdx = invocation.args.indexOf("--json-schema");
    expect(schemaIdx).toBeGreaterThanOrEqual(0);
    const schemaFile = invocation.args[schemaIdx + 1];
    expect(JSON.parse(readFileSync(schemaFile, "utf8"))).toEqual(REVIEW_FINDINGS_SCHEMA);
  });

  test("gemini review without structured output falls back to response text and harness note", () => {
    const root = tempPath("gemini-review-fallback");
    const state = tempPath("gemini-review-fallback-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    const result = runCli(["review", "fallback-review", "--engine", "gemini", "--cd", root, "REVIEW_UNSTRUCTURED_FINDINGS"], env);
    expect(result.exitCode).toBe(0);

    const report = readFileSync(`${state}/reports/fallback-review-r1.md`, "utf8");
    expect(report).toContain("# Unstructured Review");
    expect(report).toContain("## Harness note");
    expect(report.toLowerCase()).toContain("structured output was missing");

    const findings = JSON.parse(readFileSync(`${state}/reports/fallback-review-r1.findings.json`, "utf8"));
    expect(findings).toEqual({
      findings: [{ severity: "P3", confidence: "PLAUSIBLE", file: "b.ts", line: 10, summary: "fallback finding" }],
    });
  });

  test("gemini work spawn with --schema keeps raw response text as report", () => {
    const root = tempPath("gemini-work-schema");
    const state = tempPath("gemini-work-schema-state");
    const schemaFile = `${root}/test.schema.json`;
    mkdirSync(root, { recursive: true });
    writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: { answer: { type: "string" } } }));
    const env = baseEnv(state, installFakeAgy(root));

    const result = runCli(["spawn", "schema-work", "--engine", "gemini", "--cd", root, "--schema", schemaFile, "SCHEMA_RAW_RESPONSE"], env);
    expect(result.exitCode).toBe(0);

    const report = readFileSync(`${state}/reports/schema-work-r1.md`, "utf8").trim();
    expect(report).toBe(JSON.stringify({ answer: "raw schema response" }));
    expect(existsSync(`${state}/reports/schema-work-r1.findings.json`)).toBe(false);
  });

  test("transcriptPath is recorded on ledger and rendered by cdx log --transcript", () => {
    const root = tempPath("gemini-transcript");
    const state = tempPath("gemini-transcript-state");
    const agyStateHome = tempPath("gemini-agy-home");
    const env = {
      ...baseEnv(state, installFakeAgy(root)),
      CDX_AGY_STATE_HOME: agyStateHome,
    };

    const spawn = runCli(["spawn", "transcript-lane", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(spawn.exitCode).toBe(0);

    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const lane = ledger["transcript-lane"];
    expect(lane.transcriptPath).toBe(`${agyStateHome}/brain/${lane.sessionId}/.system_generated/logs/transcript_full.jsonl`);

    const missingLog = runCli(["log", "transcript-lane", "--transcript"], env);
    expect(missingLog.exitCode).toBe(1);
    expect(missingLog.stderr).toContain('no transcript for lane "transcript-lane"');

    mkdirSync(join(lane.transcriptPath, ".."), { recursive: true });
    const records = [
      { step_index: 1, source: "user", type: "USER_INPUT", status: "DONE", created_at: "2026-09-03T00:00:00Z", content: "hello world" },
      { step_index: 2, source: "agent", type: "AGENT_RESPONSE", status: "DONE", created_at: "2026-09-03T00:00:01Z", content: "response line 1\nresponse line 2" },
    ];
    writeFileSync(lane.transcriptPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const okLog = runCli(["log", "transcript-lane", "--transcript"], env);
    expect(okLog.exitCode).toBe(0);
    const lines = okLog.stdout.trim().split("\n");
    expect(lines).toEqual([
      "#1 USER_INPUT DONE hello world",
      "#2 AGENT_RESPONSE DONE response line 1 response line 2",
    ]);

    // Round arg scans for the first line with conversation_id even if line 0 is preamble
    const roundLog = `${state}/logs/transcript-lane-r1.jsonl`;
    writeFileSync(roundLog, `{"preamble":"starting"}\n{"conversation_id":"${lane.sessionId}","event":"init"}\n`);
    const roundLogResult = runCli(["log", "transcript-lane", "1", "--transcript"], env);
    expect(roundLogResult.exitCode).toBe(0);
    expect(roundLogResult.stdout.trim().split("\n")).toEqual([
      "#1 USER_INPUT DONE hello world",
      "#2 AGENT_RESPONSE DONE response line 1 response line 2",
    ]);

    // openRound resets transcriptPath to undefined before init
    const resume = runCli(["resume", "transcript-lane", "--bg", "WAIT_FOR_FOLLOW_UP"], env);
    expect(resume.exitCode).toBe(0);
    const ledgerRound2 = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledgerRound2["transcript-lane"].transcriptPath).toBeUndefined();
  });

  test("gemini review with non-array structured findings omits findings.json and unlinks stale findings", () => {
    const root = tempPath("gemini-review-non-array");
    const state = tempPath("gemini-review-non-array-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });
    expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: root }).exitCode).toBe(0);
    expect(Bun.spawnSync({ cmd: ["git", "-c", "user.name=CDX Test", "-c", "user.email=cdx@example.test", "commit", "--allow-empty", "-qm", "baseline"], cwd: root }).exitCode).toBe(0);

    // Create a stale findings.json before the round starts
    mkdirSync(`${state}/reports`, { recursive: true });
    writeFileSync(`${state}/reports/non-array-review-r1.findings.json`, JSON.stringify({ findings: [{ severity: "P3", summary: "stale" }] }));

    const result = runCli(["review", "non-array-review", "--engine", "gemini", "--cd", root, "REVIEW_NON_ARRAY_FINDINGS"], env);
    expect(result.exitCode).toBe(0);

    const report = readFileSync(`${state}/reports/non-array-review-r1.md`, "utf8");
    expect(report).toContain("# Review Non Array");

    // Finalize extracted the fenced JSON block because structured.findings was not an array
    const findings = JSON.parse(readFileSync(`${state}/reports/non-array-review-r1.findings.json`, "utf8"));
    expect(findings).toEqual({
      findings: [{ severity: "P1", confidence: "CONFIRMED", file: "f.ts", line: 1, summary: "extracted from fence" }],
    });
  });

  test("doctor checks for configured gemini model slug and handles presence and absence", () => {
    const root = tempPath("doctor-models");
    const state = tempPath("doctor-models-state");
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      rules: [],
      gemini: { model: "gemini-3.8-flash-high", agent: "cdx-lane", reviewAgent: "cdx-review" },
    }));
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(root);
    const baseTestEnv = {
      ...baseEnv(state),
      PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}`,
    };
    const fixResult = runCli(["doctor", "--fix"], baseTestEnv);
    expect(fixResult.exitCode).toBe(0);

    // Fake agy rejects --output-format after models subcommand
    const proc = Bun.spawnSync({ cmd: [join(binAgy, "agy"), "models", "--output-format", "json"], env: baseTestEnv });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("Error: flags provided but not defined: -output-format");

    // Presence check
    const presentEnv = {
      ...baseTestEnv,
      FAKE_AGY_MODELS: JSON.stringify({ command: { name: "models", data: { models: [{ id: "gemini-3.8-flash-high" }, { id: "gemini-3.7-flash" }] } } }),
    };
    const presentResult = runCli(["doctor"], presentEnv);
    expect(presentResult.exitCode).toBe(0);
    expect(presentResult.stdout).toContain("gemini-3.8-flash-high available");

    // Absence check
    const absentEnv = {
      ...baseTestEnv,
      FAKE_AGY_MODELS: JSON.stringify({ command: { name: "models", data: { models: [{ id: "gemini-3.7-flash" }] } } }),
    };
    const absentResult = runCli(["doctor"], absentEnv);
    expect(absentResult.exitCode).toBe(1);
    expect(absentResult.stdout).toContain('FAIL agy model: configured model "gemini-3.8-flash-high" not found in agy models');

    // Failed probe warns, never bad
    const failedProbeEnv = {
      ...baseTestEnv,
      FAKE_AGY_MODELS: "NOT_JSON",
    };
    const failedProbeResult = runCli(["doctor"], failedProbeEnv);
    expect(failedProbeResult.exitCode).toBe(0);
    expect(failedProbeResult.stdout).toContain("agy models: probe returned invalid JSON");
  });

  test("gemini report captures only the final agent message from multi-message turn", () => {
    const root = tempPath("gemini-final-message");
    const state = tempPath("gemini-final-message-state");
    const env = baseEnv(state, installFakeAgy(root));

    const result = runCli(["spawn", "final-msg-lane", "--engine", "gemini", "--cd", root, "TWO_AGENT_RESPONSES"], env);
    expect(result.exitCode).toBe(0);

    const report = readFileSync(`${state}/reports/final-msg-lane-r1.md`, "utf8");
    expect(report).toBe("# Final Report\n\nAll tasks complete.\n");
    expect(report).not.toContain("I am waiting for bun run check to complete.");
  });

  test("gemini report skips empty agent responses to take highest non-empty step", () => {
    const root = tempPath("gemini-skip-empty");
    const state = tempPath("gemini-skip-empty-state");
    const env = baseEnv(state, installFakeAgy(root));

    const result = runCli(["spawn", "skip-empty-lane", "--engine", "gemini", "--cd", root, "HIGHEST_EMPTY_AGENT_RESPONSE"], env);
    expect(result.exitCode).toBe(0);

    const report = readFileSync(`${state}/reports/skip-empty-lane-r1.md`, "utf8");
    expect(report).toBe("# Actual Final Report\n\nDone.\n");
    expect(report).not.toContain("chatter from result");
  });
});

describe("agy lifecycle hooks", () => {
  test("cdx hook pre-tool allows or denies based on lane state and tool name", () => {
    const state = tempPath("hook-pre-tool");
    const env = baseEnv(state);
    mkdirSync(state, { recursive: true });

    // 1. with no CDX_LANE answers allow
    const noLaneResult = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-tool"],
      env,
      stdin: new Blob([JSON.stringify({ toolCall: { name: "write_to_file" } })]),
    });
    expect(noLaneResult.exitCode).toBe(0);
    expect(JSON.parse(noLaneResult.stdout.toString())).toEqual({ decision: "allow" });

    // Setup review lane and work lane in ledger
    const now = new Date().toISOString();
    writeFileSync(`${state}/ledger.json`, JSON.stringify({
      "review-lane": {
        engine: "gemini",
        cwd: "/tmp",
        effort: "high",
        state: "running",
        reviewState: "running",
        reviewRound: 1,
        kind: "review",
        rounds: 1,
        reports: [],
        createdAt: now,
        updatedAt: now,
      },
      "work-lane": {
        engine: "gemini",
        cwd: "/tmp",
        effort: "high",
        state: "running",
        workState: "running",
        kind: "work",
        rounds: 1,
        reports: [],
        createdAt: now,
        updatedAt: now,
      },
    }));

    const reviewEnv = { ...env, CDX_LANE: "review-lane", CDX_ROUND: "1" };

    // 2. with a review row and write_to_file answers deny with the reason
    const reviewWriteResult = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-tool"],
      env: reviewEnv,
      stdin: new Blob([JSON.stringify({ toolCall: { name: "write_to_file", args: {} } })]),
    });
    expect(reviewWriteResult.exitCode).toBe(0);
    expect(JSON.parse(reviewWriteResult.stdout.toString())).toEqual({
      decision: "deny",
      reason: "cdx: review lanes are read-only; put findings in the report instead",
    });

    // 3. with a review row and view_file answers allow
    const reviewViewResult = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-tool"],
      env: reviewEnv,
      stdin: new Blob([JSON.stringify({ toolCall: { name: "view_file", args: {} } })]),
    });
    expect(reviewViewResult.exitCode).toBe(0);
    expect(JSON.parse(reviewViewResult.stdout.toString())).toEqual({ decision: "allow" });

    // 4. with a work row and write_to_file answers allow
    const workEnv = { ...env, CDX_LANE: "work-lane", CDX_ROUND: "1" };
    const workWriteResult = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-tool"],
      env: workEnv,
      stdin: new Blob([JSON.stringify({ toolCall: { name: "write_to_file", args: {} } })]),
    });
    expect(workWriteResult.exitCode).toBe(0);
    expect(JSON.parse(workWriteResult.stdout.toString())).toEqual({ decision: "allow" });

    // 5. with unparsable stdin answers allow and exits 0
    const unparseResult = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-tool"],
      env: reviewEnv,
      stdin: new Blob(["not-json"]),
    });
    expect(unparseResult.exitCode).toBe(0);
    expect(JSON.parse(unparseResult.stdout.toString())).toEqual({ decision: "allow" });
  });

  test("cdx hook pre-invocation delivers pending control records and advances sidecar", () => {
    const state = tempPath("hook-pre-invocation");
    const env = baseEnv(state);
    mkdirSync(state, { recursive: true });
    mkdirSync(`${state}/control`, { recursive: true });

    const now = new Date().toISOString();
    writeFileSync(`${state}/ledger.json`, JSON.stringify({
      "steer-lane": {
        engine: "gemini",
        cwd: "/tmp",
        effort: "high",
        state: "running",
        workState: "running",
        kind: "work",
        rounds: 1,
        reports: [],
        createdAt: now,
        updatedAt: now,
        steers: 0,
        ownerSession: "12345678-session",
      },
    }));

    const sentAt1 = "2026-09-03T10:00:00.000Z";
    const sentAt2 = "2026-09-03T10:01:00.000Z";
    writeFileSync(`${state}/control/steer-lane-r1.jsonl`, [
      JSON.stringify({ text: "first steer", sentAt: sentAt1 }),
      JSON.stringify({ text: "second steer", sentAt: sentAt2 }),
    ].join("\n") + "\n");

    const hookEnv = { ...env, CDX_LANE: "steer-lane", CDX_ROUND: "1" };

    // First call: returns two injectSteps in order, advances sidecar to 2, increments steers by 2, writes 2 feed lines
    const res1 = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-invocation"],
      env: hookEnv,
      stdin: new Blob([JSON.stringify({ invocationNum: 0 })]),
    });
    expect(res1.exitCode).toBe(0);
    const parsed1 = JSON.parse(res1.stdout.toString());
    expect(parsed1).toEqual({
      injectSteps: [
        { userMessage: `HEAD STEER (sent ${sentAt1}): first steer` },
        { userMessage: `HEAD STEER (sent ${sentAt2}): second steer` },
      ],
    });

    expect(readFileSync(`${state}/control/steer-lane-r1.delivered`, "utf8").trim()).toBe("2");
    const ledger1 = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["steer-lane"];
    expect(ledger1.steers).toBe(2);

    const feedLines = readFileSync(`${state}/feed.log`, "utf8").trim().split("\n");
    expect(feedLines).toHaveLength(2);
    expect(feedLines[0]).toContain("steer delivered mode=in-turn: first steer");
    expect(feedLines[1]).toContain("steer delivered mode=in-turn: second steer");

    // Second call: returns {} and changes nothing
    const res2 = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-invocation"],
      env: hookEnv,
      stdin: new Blob([JSON.stringify({ invocationNum: 1 })]),
    });
    expect(res2.exitCode).toBe(0);
    expect(JSON.parse(res2.stdout.toString())).toEqual({});

    expect(readFileSync(`${state}/control/steer-lane-r1.delivered`, "utf8").trim()).toBe("2");
    const ledger2 = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["steer-lane"];
    expect(ledger2.steers).toBe(2);
    const feedLines2 = readFileSync(`${state}/feed.log`, "utf8").trim().split("\n");
    expect(feedLines2).toHaveLength(2);
  });

  test("runner coordinates cdx send with fake agy when hooks are installed", async () => {
    const root = tempPath("gemini-hooks-steer");
    const state = `${root}/state`;
    const trace = `${root}/agy.trace`;
    const configHome = `${root}/agy-config`;
    mkdirSync(configHome, { recursive: true });
    writeFileSync(`${configHome}/hooks.json`, JSON.stringify({
      cdx: {
        enabled: true,
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${process.execPath} ${realpathSync(join(import.meta.dir, "cdx.ts"))} hook pre-tool`, timeout: 10 }] }],
        PreInvocation: [{ type: "command", command: `${process.execPath} ${realpathSync(join(import.meta.dir, "cdx.ts"))} hook pre-invocation`, timeout: 10 }],
      },
    }, null, 2) + "\n");

    const env = {
      ...baseEnv(state, installFakeAgy(root)),
      FAKE_AGY_TRACE: trace,
      CDX_AGY_CONFIG_HOME: configHome,
    };

    expect(runCli(["spawn", "hooks-lane", "--engine", "gemini", "--cd", root, "--bg", "WAIT_FOR_FOLLOW_UP LONG_SLEEP"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/ledger.json`) && JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["hooks-lane"]?.codexPid);

    // Send while first turn is active
    expect(runCli(["send", "hooks-lane", "steer while active"], env).exitCode).toBe(0);

    // While turn 1 is active, verify the steer has NOT been written to fake agy's stdin
    const getStdinUsers = () => {
      if (!existsSync(trace)) return [];
      return readFileSync(trace, "utf8").trim().split("\n")
        .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
        .filter((r) => r.stdinUser)
        .map((r) => r.stdinUser);
    };

    await Bun.sleep(300);
    const immediateUsers = getStdinUsers();
    expect(immediateUsers.some((u: string) => u.includes("steer while active"))).toBe(false);
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["hooks-lane"]?.state).toBe("running");

    // Wait for the lane to complete
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["hooks-lane"]?.state === "done");

    // After result arrived, it was delivered as follow-up turn once
    const finalUsers = getStdinUsers();
    expect(finalUsers.filter((u: string) => u.includes("steer while active"))).toHaveLength(1);
    expect(readFileSync(`${state}/reports/hooks-lane-r1.md`, "utf8").trim()).toContain("follow-up result: steer while active");
    expect(readFileSync(`${state}/feed.log`, "utf8")).toContain("mode=follow-up-turn");
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["hooks-lane"].steers).toBe(1);
    expect(readFileSync(`${state}/control/hooks-lane-r1.delivered`, "utf8").trim()).toBe("1");
  }, 15_000);

  test("doctor --fix creates hooks.json, preserves other entries, and is idempotent", () => {
    const root = tempPath("doctor-hooks");
    const state = `${root}/state`;
    const configHome = `${root}/agy-config`;
    mkdirSync(state, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      rules: [],
      gemini: {},
    }));

    const bin = installFakeCodex(root);
    installFakeAgy(root);
    const env = {
      ...baseEnv(state, bin),
      CDX_AGY_CONFIG_HOME: configHome,
    };

    // On an empty config dir, doctor --fix creates hooks.json with cdx entry
    const fix1 = runCli(["doctor", "--fix"], env);
    expect(fix1.exitCode).toBe(0);
    expect(existsSync(`${configHome}/hooks.json`)).toBe(true);
    const hooks1 = JSON.parse(readFileSync(`${configHome}/hooks.json`, "utf8"));
    expect(hooks1.cdx).toBeDefined();
    expect(hooks1.cdx.enabled).toBe(true);
    expect(hooks1.cdx.PreToolUse[0].hooks[0].command).toContain("hook pre-tool");
    expect(hooks1.cdx.PreInvocation[0].command).toContain("hook pre-invocation");

    // Second --fix is a no-op; doctor reports current
    const contentBefore = readFileSync(`${configHome}/hooks.json`, "utf8");
    const fix2 = runCli(["doctor", "--fix"], env);
    expect(fix2.exitCode).toBe(0);
    const contentAfter = readFileSync(`${configHome}/hooks.json`, "utf8");
    expect(contentAfter).toBe(contentBefore);

    const docCurrent = runCli(["doctor"], env);
    expect(docCurrent.exitCode).toBe(0);
    expect(docCurrent.stdout).toContain("agy hooks: current");

    // On a config that already has another entry "foo", keeps foo unchanged and adds cdx
    const configHome2 = `${root}/agy-config-foo`;
    mkdirSync(configHome2, { recursive: true });
    const fooHook = { enabled: false, custom: "kept-value" };
    writeFileSync(`${configHome2}/hooks.json`, JSON.stringify({ foo: fooHook }, null, 2) + "\n");

    const env2 = {
      ...baseEnv(state, bin),
      CDX_AGY_CONFIG_HOME: configHome2,
    };
    const fixFoo = runCli(["doctor", "--fix"], env2);
    expect(fixFoo.exitCode).toBe(0);
    const hooksMerged = JSON.parse(readFileSync(`${configHome2}/hooks.json`, "utf8"));
    expect(hooksMerged.foo).toEqual(fooHook);
    expect(hooksMerged.cdx).toBeDefined();
    expect(hooksMerged.cdx.enabled).toBe(true);
  });

  test("cdx hook pre-tool exits 0 with allow when config.json has invalid JSON", () => {
    const state = tempPath("hook-invalid-config");
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/config.json`, "{invalid: json");
    const env = baseEnv(state);

    const result = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook", "pre-tool"],
      env,
      stdin: new Blob([JSON.stringify({ toolCall: { name: "write_to_file" } })]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('{"decision":"allow"}');
  });

  test("doctor --fix reports bad and does not overwrite corrupt hooks.json", () => {
    const root = tempPath("doctor-corrupt-hooks");
    const state = `${root}/state`;
    const configHome = `${root}/agy-config`;
    mkdirSync(state, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol",
      efforts: ["medium"],
      defaultEffort: "medium",
      rules: [],
      gemini: {},
    }));
    const corruptContent = "{\ninvalid json\n";
    writeFileSync(`${configHome}/hooks.json`, corruptContent);

    const bin = installFakeCodex(root);
    installFakeAgy(root);
    const env = {
      ...baseEnv(state, bin),
      CDX_AGY_CONFIG_HOME: configHome,
    };

    const fixed = runCli(["doctor", "--fix"], env);
    expect(fixed.exitCode).toBe(1);
    expect(fixed.stdout).toContain(`remedy: fix or move ${configHome}/hooks.json by hand`);
    expect(readFileSync(`${configHome}/hooks.json`, "utf8")).toBe(corruptContent);
  });

  test("doctor checks whether cdx hook is loaded in agy via --print=/hooks", () => {
    const root = tempPath("doctor-hooks-loaded");
    const state = `${root}/state`;
    const configHome = `${root}/agy-config`;
    mkdirSync(state, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(root);
    const baseTestEnv = {
      ...baseEnv(state),
      PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}`,
      CDX_AGY_CONFIG_HOME: configHome,
    };

    // Install hook so hookInstallState() becomes current
    const fixResult = runCli(["doctor", "--fix"], baseTestEnv);
    expect(fixResult.exitCode).toBe(0);

    // 1. With cdx hook present in agy --print=/hooks
    const withHookResult = runCli(["doctor"], baseTestEnv);
    expect(withHookResult.exitCode).toBe(0);
    expect(withHookResult.stdout).toContain("agy hooks: current");
    expect(withHookResult.stdout).toContain("agy hooks: loaded in agy");

    // 2. Without cdx hook in agy --print=/hooks (answers observed shape but without cdx)
    const withoutHookEnv = {
      ...baseTestEnv,
      FAKE_AGY_HOOKS: JSON.stringify({
        conversation_id: "",
        status: "SUCCESS",
        response: "",
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        command: {
          name: "hooks",
          data: {
            hooks: [
              {
                name: "other-tool",
                enabled: true,
                source: "/tmp/other.json",
                actions: [{ event: "PreToolUse", type: "command", command: "echo allow" }],
              },
            ],
          },
        },
      }),
    };
    const withoutHookResult = runCli(["doctor"], withoutHookEnv);
    expect(withoutHookResult.exitCode).toBe(0);
    expect(withoutHookResult.stdout).toContain("agy hooks: current");
    expect(withoutHookResult.stdout).toContain("agy hooks: cdx hook not loaded in agy");
  });

  test("warns once on stderr at spawn and resume when gemini work round opens without hooks", async () => {
    const root = tempPath("gemini-no-hooks-warning");
    const state = `${root}/state`;
    const configHome = `${root}/agy-config`;
    mkdirSync(configHome, { recursive: true });
    const env = {
      ...baseEnv(state, installFakeAgy(root)),
      CDX_AGY_CONFIG_HOME: configHome,
    };
    const expectedWarn = "cdx: agy hooks not installed; steering falls back to follow-up turns (cdx doctor --fix)";

    const spawnRes = runCli(["spawn", "warn-lane", "--engine", "gemini", "--cd", root, "REPORT_ONLY"], env);
    expect(spawnRes.exitCode).toBe(0);
    const spawnWarnCount = spawnRes.stderr.split("\n").filter((l) => l.trim() === expectedWarn).length;
    expect(spawnWarnCount).toBe(1);

    const resumeRes = runCli(["resume", "warn-lane", "REPORT_ONLY"], env);
    expect(resumeRes.exitCode).toBe(0);
    const resumeWarnCount = resumeRes.stderr.split("\n").filter((l) => l.trim() === expectedWarn).length;
    expect(resumeWarnCount).toBe(1);

    const rootGpt = tempPath("gpt-no-hooks-warning");
    const stateGpt = `${rootGpt}/state`;
    const binCodex = installFakeCodex(rootGpt);
    const envGpt = {
      ...baseEnv(stateGpt, binCodex),
      CDX_AGY_CONFIG_HOME: configHome,
    };
    const gptSpawnRes = runCli(["spawn", "gpt-lane", "--engine", "gpt", "--cd", rootGpt, "REPORT_ONLY"], envGpt);
    expect(gptSpawnRes.exitCode).toBe(0);
    expect(gptSpawnRes.stderr).not.toContain(expectedWarn);
  });
});

describe("raw engine guard", () => {
  const guard = join(import.meta.dir, "hooks/guard-raw-codex.ts");
  const guardInput = (command: string) => JSON.stringify({ tool_input: { command } });

  test("blocks headless agy commands", () => {
    for (const command of ["agy --print='x'", "agy --input-format stream-json"]) {
      const result = Bun.spawnSync({ cmd: [process.execPath, guard], stdin: new Blob([guardInput(command)]) });
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("Use cdx --engine gemini for Antigravity work. Run 'cdx help'.");
    }
  });

  test("blocks headless agy hidden behind quotes or escapes", () => {
    for (const command of ['agy "--print=x"', '"agy" --print=x', "\\agy --print=x", "agy '-p' x"]) {
      const result = Bun.spawnSync({ cmd: [process.execPath, guard], stdin: new Blob([guardInput(command)]) });
      expect(result.exitCode).toBe(2);
    }
    for (const command of ['echo "agy --print=x"', "git commit -m 'codex exec notes'"]) {
      const result = Bun.spawnSync({ cmd: [process.execPath, guard], stdin: new Blob([guardInput(command)]) });
      expect(result.exitCode).toBe(0);
    }
  });

  test("allows agy model discovery", () => {
    const result = Bun.spawnSync({ cmd: [process.execPath, guard], stdin: new Blob([guardInput("agy models")]) });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});

describe("gemini quota handling", () => {
  test("quota error is not in GEMINI_TRANSPORT_ERRORS", () => {
    const rawQuotaError = "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m19s.";
    expect(GEMINI_TRANSPORT_ERRORS.some((pattern) => pattern.test(rawQuotaError))).toBe(false);
  });

  test("parseQuotaResetDelayMs parses m/s, h/m/s, and bare s formats", () => {
    expect(parseQuotaResetDelayMs("Individual quota reached. Resets in 27m19s.")).toBe((27 * 60 + 19) * 1000);
    expect(parseQuotaResetDelayMs("Resets in 1h2m3s")).toBe((3600 + 2 * 60 + 3) * 1000);
    expect(parseQuotaResetDelayMs("Limits exhausted. Resets in 45s.")).toBe(45 * 1000);
    expect(parseQuotaResetDelayMs("Resets in 2h")).toBe(2 * 3600 * 1000);
    expect(parseQuotaResetDelayMs("Resets in 10m")).toBe(10 * 60 * 1000);
    expect(parseQuotaResetDelayMs("no reset info")).toBeUndefined();
    expect(parseQuotaResetIso("no reset info", 10_000)).toBe(new Date(10_000 + 30 * 60 * 1000).toISOString());
  });

  test("a gemini round whose result carries the quota error writes gemini-quota.json, sets clean note, emits feed line, and does not auto-continue", () => {
    const root = tempPath("gemini-quota-error");
    const state = tempPath("gemini-quota-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    const before = Date.now();
    const spawnResult = runCli(["spawn", "quota-lane", "--engine", "gemini", "--cd", root, "QUOTA_ERROR"], env);
    const after = Date.now();
    expect(spawnResult.exitCode).toBe(1);

    const quotaPath = `${state}/gemini-quota.json`;
    expect(existsSync(quotaPath)).toBe(true);
    const quota = JSON.parse(readFileSync(quotaPath, "utf8"));
    expect(quota.lane).toBe("quota-lane");
    expect(quota.round).toBe(1);
    expect(typeof quota.observedAt).toBe("string");
    expect(typeof quota.blockedUntil).toBe("string");
    const resetTime = Date.parse(quota.blockedUntil);
    const expectedDelay = (27 * 60 + 19) * 1000;
    expect(resetTime).toBeGreaterThanOrEqual(before + expectedDelay);
    expect(resetTime).toBeLessThanOrEqual(after + expectedDelay + 2000);

    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const lane = ledger["quota-lane"];
    expect(lane.state).toBe("failed");
    expect(lane.note).toBe(`turn failed: gemini five-hour quota exhausted; resets at ${quota.blockedUntil}; resume this lane after the reset`);
    expect(lane.note).not.toContain("Individual quota reached");
    expect(lane.note).not.toContain("trailing chatter");
    expect(lane.continuations ?? 0).toBe(0);

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain(`[cdx] lane=quota-lane round=1 gemini quota exhausted; resets at ${quota.blockedUntil}`);
    expect(feed).not.toContain("auto-continue");
  });

  test("spawn, resume, and review fail with block message while blocked and succeed after blockedUntil passes", () => {
    const root = tempPath("gemini-refuse-quota");
    const state = tempPath("gemini-refuse-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    const initSpawn = runCli(["spawn", "test-lane", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(initSpawn.exitCode).toBe(0);

    const futureReset = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: futureReset,
      observedAt: new Date().toISOString(),
      lane: "other-lane",
      round: 1,
    }, null, 2));

    const spawnBlocked = runCli(["spawn", "blocked-lane", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(spawnBlocked.exitCode).toBe(1);
    expect(spawnBlocked.stderr).toContain(`cdx: gemini five-hour quota exhausted; resets at ${futureReset} (in 25m). Wait, or pass --engine gpt.`);

    const resumeBlocked = runCli(["resume", "test-lane", "MORE_WORK"], env);
    expect(resumeBlocked.exitCode).toBe(1);
    expect(resumeBlocked.stderr).toContain(`cdx: gemini five-hour quota exhausted; resets at ${futureReset} (in 25m). Wait, or pass --engine gpt.`);

    const reviewBlocked = runCli(["review", "test-lane", "--engine", "gemini", "--cd", root, "REVIEW_CLEAN"], env);
    expect(reviewBlocked.exitCode).toBe(1);
    expect(reviewBlocked.stderr).toContain(`cdx: gemini five-hour quota exhausted; resets at ${futureReset} (in 25m). Wait, or pass --engine gpt.`);

    const pastReset = new Date(Date.now() - 60 * 1000).toISOString();
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: pastReset,
      observedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      lane: "other-lane",
      round: 1,
    }, null, 2));

    const spawnAfter = runCli(["spawn", "unblocked-lane", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(spawnAfter.exitCode).toBe(0);
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(false);

    const resumeAfter = runCli(["resume", "test-lane", "MORE_WORK"], env);
    expect(resumeAfter.exitCode).toBe(0);

    const reviewAfter = runCli(["review", "test-lane", "--engine", "gemini", "--cd", root, "REVIEW_CLEAN"], env);
    expect(reviewAfter.exitCode).toBe(0);
  }, 15_000);

  test("usage snapshot: 3% blocks, 10% warns on stderr and proceeds, 50% is silent", () => {
    const root = tempPath("gemini-snapshot-levels");
    const state = tempPath("gemini-snapshot-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });
    mkdirSync(state, { recursive: true });

    const resetsAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();

    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt: new Date().toISOString(),
      weekly: { remainingPercent: 90, resetsAt },
      fiveHour: { remainingPercent: 3, resetsAt },
    }, null, 2));
    const blockResult = runCli(["spawn", "lane-3pct", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(blockResult.exitCode).toBe(1);
    expect(blockResult.stderr).toContain(`cdx: gemini five-hour quota exhausted; resets at ${resetsAt} (in 45m). Wait, or pass --engine gpt.`);

    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt: new Date().toISOString(),
      weekly: { remainingPercent: 90, resetsAt },
      fiveHour: { remainingPercent: 10, resetsAt },
    }, null, 2));
    const warnResult = runCli(["spawn", "lane-10pct", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(warnResult.exitCode).toBe(0);
    expect(warnResult.stderr).toContain(`cdx: gemini five-hour window at 10%, resets at ${resetsAt}; fan out with care`);

    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt: new Date().toISOString(),
      weekly: { remainingPercent: 90, resetsAt },
      fiveHour: { remainingPercent: 50, resetsAt },
    }, null, 2));
    const silentResult = runCli(["spawn", "lane-50pct", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(silentResult.exitCode).toBe(0);
    expect(silentResult.stderr).not.toContain("five-hour");
  });

  test("a snapshot older than 15 minutes never blocks", () => {
    const root = tempPath("gemini-old-snapshot");
    const state = tempPath("gemini-old-snapshot-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });
    mkdirSync(state, { recursive: true });

    const resetsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      weekly: { remainingPercent: 90, resetsAt },
      fiveHour: { remainingPercent: 2, resetsAt },
    }, null, 2));

    const result = runCli(["spawn", "lane-old-snap", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("cdx: gemini five-hour quota exhausted");
  });

  test("gpt spawn ignores quota blocks", () => {
    const root = tempPath("gpt-ignore-quota");
    const bin = installFakeCodex(root);
    const state = `${root}/state`;
    const env = baseEnv(state, bin);
    mkdirSync(root, { recursive: true });

    const resetsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: resetsAt,
      observedAt: new Date().toISOString(),
      lane: "gemini-lane",
      round: 1,
    }, null, 2));
    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt: new Date().toISOString(),
      weekly: { remainingPercent: 90, resetsAt },
      fiveHour: { remainingPercent: 1, resetsAt },
    }, null, 2));

    const result = runCli(["spawn", "gpt-lane", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("gemini five-hour");
  });

  test("cdx status and cdx brief show quota line while blocked", () => {
    const root = tempPath("status-quota");
    const state = tempPath("status-quota-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(state, { recursive: true });

    const resetsAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: resetsAt,
      observedAt: new Date().toISOString(),
      lane: "quota-lane",
      round: 1,
    }, null, 2));

    const statusResult = runCli(["status"], env);
    expect(statusResult.stdout).toContain(`gemini quota: exhausted until ${resetsAt} (in 20m)`);

    const briefResult = runCli(["brief"], env);
    expect(briefResult.stdout).toContain(`gemini quota: exhausted until ${resetsAt} (in 20m)`);
  });

  test("cdx doctor warns when blocked and reports clear when snapshot five-hour figure is >= 15%", () => {
    const root = tempPath("doctor-quota");
    const state = tempPath("doctor-quota-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(state, { recursive: true });

    const resetsAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: resetsAt,
      observedAt: new Date().toISOString(),
      lane: "blocked-lane",
      round: 1,
    }, null, 2));

    const blockedDoctor = runCli(["doctor"], env);
    expect(blockedDoctor.stdout).toContain(`gemini quota: exhausted until ${resetsAt} (in 15m)`);

    unlinkSync(`${state}/gemini-quota.json`);
    const clearDoctor = runCli(["doctor"], env);
    expect(clearDoctor.stdout).toContain("gemini quota: clear");
  });

  test("gemini round refreshes usage-gemini.json on finalize for both success and failure", () => {
    const root = tempPath("gemini-refresh-usage");
    const state = tempPath("gemini-refresh-usage-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    expect(existsSync(`${state}/usage-gemini.json`)).toBe(false);
    const successResult = runCli(["spawn", "success-lane", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(successResult.exitCode).toBe(0);
    expect(existsSync(`${state}/usage-gemini.json`)).toBe(true);

    const firstUsage = JSON.parse(readFileSync(`${state}/usage-gemini.json`, "utf8"));
    expect(firstUsage.fiveHour.remainingPercent).toBe(91);

    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt: new Date(Date.now() - 30000).toISOString(),
      weekly: { remainingPercent: 50, resetsAt: new Date().toISOString() },
      fiveHour: { remainingPercent: 50, resetsAt: new Date().toISOString() },
    }, null, 2));

    const failResult = runCli(["spawn", "fail-lane", "--engine", "gemini", "--cd", root, "AGY_ERROR"], env);
    expect(failResult.exitCode).toBe(1);
    expect(existsSync(`${state}/usage-gemini.json`)).toBe(true);
    const secondUsage = JSON.parse(readFileSync(`${state}/usage-gemini.json`, "utf8"));
    expect(secondUsage.fiveHour.remainingPercent).toBe(91);
  });

  test("snapshot with past resetsAt neither blocks nor warns even if fresh", () => {
    const root = tempPath("gemini-past-reset");
    const state = tempPath("gemini-past-reset-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });
    mkdirSync(state, { recursive: true });

    const checkedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const resetsAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    writeFileSync(`${state}/usage-gemini.json`, JSON.stringify({
      checkedAt,
      weekly: { remainingPercent: 90, resetsAt: new Date(Date.now() + 3600 * 1000).toISOString() },
      fiveHour: { remainingPercent: 1, resetsAt },
    }, null, 2));

    const result = runCli(["spawn", "lane-past-reset", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("cdx: gemini five-hour");
  });

  test("cdx adopt succeeds with gemini even when quota is blocked", () => {
    const root = tempPath("adopt-blocked");
    const state = tempPath("adopt-blocked-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(state, { recursive: true });

    const futureReset = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: futureReset,
      observedAt: new Date().toISOString(),
      lane: "some-lane",
      round: 1,
    }, null, 2));

    const result = runCli(["adopt", "adopted-lane", "4a5e2f7b-1111-2222-3333-444455556666", "--engine", "gemini"], env);
    expect(result.exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledger["adopted-lane"]?.engine).toBe("gemini");
    expect(ledger["adopted-lane"]?.sessionId).toBe("4a5e2f7b-1111-2222-3333-444455556666");
  });

  test("geminiQuotaState is pure and status/brief/doctor never unlink expired or unparseable block file", () => {
    const root = tempPath("quota-pure-state");
    const state = tempPath("quota-pure-state-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(state, { recursive: true });

    const pastReset = new Date(Date.now() - 60 * 1000).toISOString();
    writeFileSync(`${state}/gemini-quota.json`, JSON.stringify({
      blockedUntil: pastReset,
      observedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      lane: "other-lane",
      round: 1,
    }, null, 2));

    runCli(["status"], env);
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(true);

    runCli(["brief"], env);
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(true);

    runCli(["doctor"], env);
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(true);

    mkdirSync(root, { recursive: true });
    const spawnResult = runCli(["spawn", "clean-spawn", "--engine", "gemini", "--cd", root, "BUILD_SMALL_THING"], env);
    expect(spawnResult.exitCode).toBe(0);
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(false);
  });

  test("when Resets in does not parse, blocks for 30 minutes and feed line says reset time unknown; assuming 30m", () => {
    const root = tempPath("gemini-unparseable-quota");
    const state = tempPath("gemini-unparseable-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    const before = Date.now();
    const spawnResult = runCli(["spawn", "unparse-lane", "--engine", "gemini", "--cd", root, "QUOTA_UNPARSEABLE"], env);
    const after = Date.now();
    expect(spawnResult.exitCode).toBe(1);

    const quotaPath = `${state}/gemini-quota.json`;
    expect(existsSync(quotaPath)).toBe(true);
    const quota = JSON.parse(readFileSync(quotaPath, "utf8"));
    const resetTime = Date.parse(quota.blockedUntil);
    const expectedDelay = 30 * 60 * 1000;
    expect(resetTime).toBeGreaterThanOrEqual(before + expectedDelay);
    expect(resetTime).toBeLessThanOrEqual(after + expectedDelay + 2000);

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain("[cdx] lane=unparse-lane round=1 gemini quota exhausted; reset time unknown; assuming 30m");
  });

  test("replayed error detection: round 1 quota error writes block and lastResultError, round 2 and round 3 replay error and finalize done, genuine success clears it", { timeout: 45_000 }, () => {
    const root = tempPath("gemini-replay-root");
    const state = tempPath("gemini-replay-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    // 1. Round 1 quota error writes the block and lastResultError
    const r1Spawn = runCli(["spawn", "replay-lane", "--engine", "gemini", "--cd", root, "QUOTA_ERROR"], env);
    expect(r1Spawn.exitCode).toBe(1);
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(true);

    const ledgerR1 = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const laneR1 = ledgerR1["replay-lane"];
    expect(laneR1.state).toBe("failed");
    const expectedError = "ERROR: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 27m19s.";
    expect(laneR1.lastResultError).toBe(expectedError);

    // 2. Round 2 resume replays error E with report and finalizes done.
    unlinkSync(`${state}/gemini-quota.json`);

    const r2Resume = runCli(["resume", "replay-lane", "REPLAYED_ERROR_WITH_REPORT"], env);
    expect(r2Resume.exitCode).toBe(0);

    const ledgerR2 = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const laneR2 = ledgerR2["replay-lane"];
    expect(laneR2.state).toBe("done");
    // Ruling (1): lastResultError is RETAINED on replayed success
    expect(laneR2.lastResultError).toBe(expectedError);

    // No new block written
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(false);

    // Report on disk
    const r2ReportPath = `${state}/reports/replay-lane-r2.md`;
    expect(existsSync(r2ReportPath)).toBe(true);
    expect(readFileSync(r2ReportPath, "utf8")).toContain("# Lane Report: Resumed Work");

    // Feed line present
    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain(`[cdx] lane=replay-lane round=2 ignored replayed agy error: ${expectedError.slice(0, 80)}`);

    // Round 3 resume replays error E again with report and must ALSO finalize done
    const r3Resume = runCli(["resume", "replay-lane", "REPLAYED_ERROR_WITH_REPORT"], env);
    expect(r3Resume.exitCode).toBe(0);

    const ledgerR3 = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const laneR3 = ledgerR3["replay-lane"];
    expect(laneR3.state).toBe("done");
    expect(laneR3.lastResultError).toBe(expectedError);
    expect(existsSync(`${state}/reports/replay-lane-r3.md`)).toBe(true);

    // 3. A resume with a different error text still fails
    const diffRoot = tempPath("gemini-diff-root");
    mkdirSync(diffRoot, { recursive: true });
    const r1DiffSpawn = runCli(["spawn", "diff-lane", "--engine", "gemini", "--cd", diffRoot, "QUOTA_ERROR"], env);
    expect(r1DiffSpawn.exitCode).toBe(1);
    if (existsSync(`${state}/gemini-quota.json`)) unlinkSync(`${state}/gemini-quota.json`);

    const diffResume = runCli(["resume", "diff-lane", "DIFF_ERROR_NO_REPORT"], env);
    expect(diffResume.exitCode).toBe(1);
    const ledgerDiff = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledgerDiff["diff-lane"].state).toBe("failed");
    expect(ledgerDiff["diff-lane"].lastResultError).toBe("ERROR: A completely different error occurred.");

    // 4. A replayed error with no agent_response text still fails
    const noReportRoot = tempPath("gemini-no-report-root");
    mkdirSync(noReportRoot, { recursive: true });
    const r1NoReportSpawn = runCli(["spawn", "no-report-lane", "--engine", "gemini", "--cd", noReportRoot, "QUOTA_ERROR"], env);
    expect(r1NoReportSpawn.exitCode).toBe(1);
    if (existsSync(`${state}/gemini-quota.json`)) unlinkSync(`${state}/gemini-quota.json`);

    const noReportResume = runCli(["resume", "no-report-lane", "REPLAYED_ERROR_NO_REPORT"], env);
    expect(noReportResume.exitCode).toBe(1);
    const ledgerNoReport = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledgerNoReport["no-report-lane"].state).toBe("failed");
  });

  test("transport errors are excluded from replay detection: stream-interrupted error with response text auto-continues, does not finalize done", { timeout: 25_000 }, () => {
    const root = tempPath("gemini-transport-exclude-root");
    const state = tempPath("gemini-transport-exclude-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    // Round 1 encounters stream interrupted error with partial response text.
    // Even if previousResultError on ledger is identical or set, it must auto-continue, not finalize done.
    const spawnResult = runCli(["spawn", "transport-lane", "--engine", "gemini", "--cd", root, "STREAM_INTERRUPT_WITH_REPORT"], env);
    expect(spawnResult.exitCode).toBe(0);

    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const lane = ledger["transport-lane"];
    expect(lane.state).toBe("done");
    expect(lane.continuations).toBe(1);

    const feed = readFileSync(`${state}/feed.log`, "utf8");
    expect(feed).toContain("[cdx] lane=transport-lane round=1 auto-continue 1/2");
    expect(feed).not.toContain("ignored replayed agy error");
  });

  test("replayed review shares genuine success code: extracts structured_output with findings array to findings.json", { timeout: 30_000 }, () => {
    const root = tempPath("gemini-review-replay-root");
    const state = tempPath("gemini-review-replay-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    // Round 1 review fails with quota error to record lastResultError
    const r1Review = runCli(["review", "rev-lane", "--engine", "gemini", "--cd", root, "QUOTA_ERROR"], env);
    expect(r1Review.exitCode).toBe(1);
    unlinkSync(`${state}/gemini-quota.json`);

    // Round 2 review replays the error but carries structured_output with findings
    const r2Review = runCli(["review", "rev-lane", "--engine", "gemini", "--cd", root, "REVIEW_REPLAYED_STRUCTURED"], env);
    expect(r2Review.exitCode).toBe(0);

    const findingsPath = `${state}/reports/rev-lane-r2.findings.json`;
    expect(existsSync(findingsPath)).toBe(true);
    const findingsData = JSON.parse(readFileSync(findingsPath, "utf8"));
    expect(Array.isArray(findingsData.findings)).toBe(true);
    expect(findingsData.findings[0]?.summary).toBe("critical defect");

    const reportPath = `${state}/reports/rev-lane-r2.md`;
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toContain("# Review Replayed");

    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledger["rev-lane"].reviewState).toBe("done");
  });

  test("spawn --worktree with bad --add-dir path exits nonzero and leaves no worktree directory and no branch", () => {
    const root = tempPath("gemini-wt-clean-root");
    const state = tempPath("gemini-wt-clean-state");
    const env = baseEnv(state, installFakeAgy(root));
    mkdirSync(root, { recursive: true });

    Bun.spawnSync({ cmd: ["git", "init", "-b", "main"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "config", "user.email", "test@example.com"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "config", "user.name", "Test User"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "commit", "--allow-empty", "-m", "init"], cwd: root });

    const wtPath = join(root, "wt-dest");
    const badDir = join(root, "nonexistent-add-dir");

    const spawnResult = runCli(["spawn", "wt-lane", "--worktree", wtPath, "--add-dir", badDir, "--cd", root, "task"], env);
    expect(spawnResult.exitCode).not.toBe(0);

    // No worktree directory created
    expect(existsSync(wtPath)).toBe(false);

    // No git branch created
    const branchCheck = Bun.spawnSync({ cmd: ["git", "branch", "--list", "lane/wt-lane"], cwd: root });
    expect(branchCheck.stdout.toString().trim()).toBe("");
  });

  test("quota class refreshGeminiUsage check: if fiveHour >= 5% remaining, does not write block and fails with note", { timeout: 15_000 }, () => {
    const root = tempPath("gemini-healthy-usage-root");
    const state = tempPath("gemini-healthy-usage-state");
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_HEALTHY_USAGE: "1" };
    mkdirSync(root, { recursive: true });

    const spawnResult = runCli(["spawn", "healthy-lane", "--engine", "gemini", "--cd", root, "QUOTA_ERROR"], env);
    expect(spawnResult.exitCode).toBe(1);

    // Block must NOT be written because usage was 91% (>= 5%)
    expect(existsSync(`${state}/gemini-quota.json`)).toBe(false);

    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    const lane = ledger["healthy-lane"];
    expect(lane.state).toBe("failed");
    expect(lane.note).toContain("agy reported quota exhausted but usage shows 91% five-hour remaining; no block written");
    expect(lane.lastResultError).toContain("Individual quota reached");
  });
});

describe("cdx models and supervisors", () => {
  test("resolves --model aliases and raw ids, records the model, and passes it to the app-server", () => {
    const root = tempPath("model-picker");
    const state = `${root}/state`;
    const trace = `${root}/requests.jsonl`;
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({
      model: "gpt-5.6-sol", models: { astra: "gpt-6-astra" }, efforts: ["medium", "high", "xhigh"], defaultEffort: "medium",
    }));
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_TRACE: trace };

    const spawned = runCli(["spawn", "m-astra", "--engine", "gpt", "--model", "astra", "--effort", "xhigh", "--cd", root, "REPORT_ONLY"], env);
    expect(spawned.exitCode).toBe(0);
    expect(spawned.stdout).toContain("model=gpt-6-astra");
    let requests = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === "thread/start").params.model).toBe("gpt-6-astra");
    expect(requests.find((request) => request.method === "turn/start").params.effort).toBe("xhigh");
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledger["m-astra"].model).toBe("gpt-6-astra");
    expect(ledger["m-astra"].effort).toBe("xhigh");
    expect(runCli(["status"], env).stdout).toContain("model=gpt-6-astra");

    writeFileSync(trace, "");
    expect(runCli(["spawn", "m-raw", "--engine", "gpt", "--model", "gpt-5.5", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    requests = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === "thread/start").params.model).toBe("gpt-5.5");

    const bad = runCli(["spawn", "m-bad", "--engine", "gpt", "--model", "Nope!", "--cd", root, "REPORT_ONLY"], env);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('--model must be a Codex model id or one of astra=gpt-6-astra');

    const gemini = runCli(["spawn", "m-gem", "--model", "astra", "--cd", root, "REPORT_ONLY"], env);
    expect(gemini.exitCode).toBe(1);
    expect(gemini.stderr).toContain("--model applies to gpt lanes only");

    const reviewFlag = runCli(["review", "m-astra", "--engine", "gpt", "--model", "astra", "look"], env);
    expect(reviewFlag.exitCode).toBe(1);
    expect(reviewFlag.stderr).toContain("review of an existing lane uses its model (gpt-6-astra)");

    const forkFlag = runCli(["fork", "m-fork", "m-astra", "--model", "astra", "REPORT_ONLY"], env);
    expect(forkFlag.exitCode).toBe(1);
    expect(forkFlag.stderr).toContain("fork inherits the source lane's model (gpt-6-astra)");
    expect(runCli(["fork", "m-fork", "m-astra", "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"))["m-fork"].model).toBe("gpt-6-astra");

    expect(runCli(["help"], env).stdout).toContain("model gpt-5.6-sol (aliases astra=gpt-6-astra)");
  }, 30_000);

  test("rejects malformed models config", () => {
    const state = tempPath("models-config");
    mkdirSync(state, { recursive: true });
    const env = baseEnv(state);
    writeFileSync(`${state}/config.json`, JSON.stringify({ models: ["gpt-6-astra"] }));
    expect(runCli(["status"], env).stderr).toContain("models must be an object mapping aliases to Codex model ids");
    writeFileSync(`${state}/config.json`, JSON.stringify({ models: { "Bad Alias": "gpt-6-astra" } }));
    expect(runCli(["status"], env).stderr).toContain('models: alias "Bad Alias" must be lowercase letters, digits, and dashes');
    writeFileSync(`${state}/config.json`, JSON.stringify({ models: { astra: 7 } }));
    expect(runCli(["status"], env).stderr).toContain("models.astra must be a Codex model id");
  });

  test("houseRules gives a gpt supervisor delegation rules instead of the worker ban", () => {
    const supervisor = houseRules("/tmp", false, "gpt", { supervisor: true });
    expect(supervisor).toContain("You supervise this lane for the head, who reviews and merges");
    expect(supervisor).toContain("The bar is world class");
    expect(houseRules("/tmp", false, "gemini")).not.toContain("The bar is world class");
    expect(supervisor).toContain("cdx wait <child>... --report");
    expect(supervisor).toContain("returns exit 2 the moment one of them asks a question");
    expect(supervisor).toContain("Never weaken or clear a child's gate");
    expect(supervisor).toContain("Do not spawn your own native subagents");
    expect(supervisor).toContain("The brief is the head's best current understanding, not an order.");
    expect(houseRules("/tmp", false, "gpt")).toContain("The brief is the head's best current understanding, not an order.");
    expect(houseRules("/tmp", false, "gemini")).not.toContain("not an order");
    expect(supervisor).not.toContain("Never run cdx spawn, resume, fork, review, adopt, kill, or close from inside a lane");
    expect(supervisor).toContain("run `cdx ask");
    const worker = houseRules("/tmp", false, "gpt");
    expect(worker).toContain("Never run cdx spawn, resume, fork, review, adopt, kill, or close from inside a lane");
    expect(worker).not.toContain("You supervise this lane");
    expect(houseRules("/tmp", false, "gemini", { supervisor: true })).not.toContain("You supervise this lane");
    expect(houseRules("/tmp", true, "gpt", { supervisor: true })).not.toContain("You supervise this lane");
  });

  test("a supervisor lane exports CDX_SUPERVISOR and drives gemini children only", async () => {
    const root = tempPath("supervisor");
    const state = `${root}/state`;
    const supervisorTrace = `${root}/supervisor.trace`;
    const agyTrace = `${root}/agy.trace`;
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(`${root}/agy`);
    const env = {
      ...baseEnv(state),
      PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}`,
      FAKE_SUPERVISOR_TRACE: supervisorTrace,
      FAKE_AGY_TRACE: agyTrace,
    };

    const badEngine = runCli(["spawn", "nosup", "--engine", "gemini", "--supervisor", "--cd", root, "REPORT_ONLY"], env);
    expect(badEngine.exitCode).toBe(1);
    expect(badEngine.stderr).toContain("--supervisor needs --engine gpt");

    const spawned = runCli(["spawn", "sup", "--engine", "gpt", "--supervisor", "--cd", root, "--bg", "WAIT_FOR_STEER"], env);
    expect(spawned.exitCode).toBe(0);
    expect(spawned.stdout).toContain("engine=gpt model=gpt-5.6-sol supervisor mode=spawn");
    await waitFor(() => existsSync(supervisorTrace) && readFileSync(supervisorTrace, "utf8").trim() === "sup");
    expect(readFileSync(`${state}/briefs/sup-r1.md`, "utf8")).toContain("You supervise this lane");
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).sup.supervisor).toBe(true);
    expect(runCli(["status"], env).stdout).toContain("engine=gpt  model=gpt-5.6-sol  supervisor");

    // A plain gpt worker gets no supervisor variable.
    writeFileSync(supervisorTrace, "");
    expect(runCli(["spawn", "plain", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(readFileSync(supervisorTrace, "utf8").trim()).toBe("none");

    // Inside the supervisor's codex process.
    const inside = { ...env, CDX_LANE: "sup", CDX_SUPERVISOR: "sup", CDX_ROUND: "1", CDX_OWNER: "terminal" };
    const child = runCli(["spawn", "child", "--cd", root, "BUILD_SMALL_THING"], inside);
    expect(child.exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    expect(ledger.child.parent).toBe("sup");
    expect(ledger.child.parentRound).toBe(1);
    expect(ledger.child.engine).toBe("gemini");
    const invocation = readFileSync(agyTrace, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
    expect(invocation.supervisor).toBeUndefined();
    expect(runCli(["status"], inside).stdout).toContain("parent=sup");

    const gptChild = runCli(["spawn", "child-gpt", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], inside);
    expect(gptChild.exitCode).toBe(1);
    expect(gptChild.stderr).toContain("supervisor sup may only spawn gemini children; drop --engine gpt");
    const nested = runCli(["spawn", "child-sup", "--engine", "gpt", "--supervisor", "--cd", root, "REPORT_ONLY"], inside);
    expect(nested.exitCode).toBe(1);
    expect(nested.stderr).toContain("supervisor sup cannot spawn another supervisor");
    const forked = runCli(["fork", "child-fork", "sup", "REPORT_ONLY"], inside);
    expect(forked.exitCode).toBe(1);
    expect(forked.stderr).toContain('supervisor sup may run spawn, resume, review, kill, close, gate, reply on its children; command "fork" refused');
    const foreign = runCli(["resume", "plain", "REPORT_ONLY"], inside);
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr).toContain('supervisor sup may only drive its own children; lane "plain" is not one');
    const gptReview = runCli(["review", "child", "--engine", "gpt", "look again"], inside);
    expect(gptReview.exitCode).toBe(1);
    expect(gptReview.stderr).toContain("supervisor sup may only run gemini reviews");
    // One ownership policy: a supervisor mutates only lanes it spawned.
    const foreignSend = runCli(["send", "plain", "stop"], inside);
    expect(foreignSend.exitCode).toBe(1);
    expect(foreignSend.stderr).toContain('supervisor sup may only drive its own children; lane "plain" is not one');
    const foreignReply = runCli(["reply", "plain", "an answer"], inside);
    expect(foreignReply.exitCode).toBe(1);
    expect(foreignReply.stderr).toContain('lane "plain" is not one');
    const foreignSpawn = runCli(["spawn", "plain", "--cd", root, "BUILD_SMALL_THING"], inside);
    expect(foreignSpawn.exitCode).toBe(1);
    expect(foreignSpawn.stderr).toContain('lane "plain" is not one');
    const ownGate = runCli(["gate", "child", "--clear"], inside);
    expect(ownGate.exitCode).toBe(1);
    expect(ownGate.stderr).toContain("supervisor sup may not change a child's gate");
    expect(runCli(["job", "headjob", "--cd", root, "true"], env).exitCode).toBe(0);
    const jobKill = runCli(["kill", "headjob"], inside);
    expect(jobKill.exitCode).toBe(1);
    expect(jobKill.stderr).toContain("supervisor sup may not stop jobs");

    // A shell from another round of the supervisor has no authority.
    const stale = runCli(["spawn", "child-stale", "--cd", root, "BUILD_SMALL_THING"], { ...inside, CDX_ROUND: "2" });
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain('supervisor identity "sup" round 2 does not match a running supervisor round');

    expect(runCli(["close", "child"], inside).exitCode).toBe(0);
    expect(runCli(["close", "sup"], inside).exitCode).toBe(1);

    // A child of the supervisor is an ordinary worker.
    const grandchild = runCli(["spawn", "grandchild", "--cd", root, "BUILD_SMALL_THING"], { ...env, CDX_LANE: "child", CDX_ROUND: "1" });
    expect(grandchild.exitCode).toBe(1);
    expect(grandchild.stderr).toContain("lane workers cannot drive the harness");

    // Once the supervisor round is over its identity is dead, and a plain
    // respawn of the same name is a plain lane again.
    expect(runCli(["kill", "sup"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).sup.state === "failed");
    const finished = runCli(["spawn", "child-late", "--cd", root, "BUILD_SMALL_THING"], inside);
    expect(finished.exitCode).toBe(1);
    expect(finished.stderr).toContain("does not match a running supervisor round");
    expect(runCli(["spawn", "sup", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).sup.supervisor).toBeUndefined();
  }, 40_000);

  test("consult runs a read-only gpt lane with the advisor frame and resumes read-only", () => {
    const root = tempPath("consult");
    const state = `${root}/state`;
    const trace = `${root}/args.trace`;
    const env = { ...baseEnv(state, installFakeCodex(root)), FAKE_ARGS_TRACE: trace };
    const result = runCli(["consult", "advisor", "--model", "gpt-6-astra", "--cd", root, "Should the ledger move to sqlite?"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("engine gemini (default)");
    const brief = readFileSync(`${state}/briefs/advisor-r1.md`, "utf8");
    expect(brief).toContain("CONSULT. You are the senior advisor to the head");
    expect(brief).toContain("wants to be challenged, not confirmed");
    expect(brief).toContain("The bar is world class");
    expect(brief).toContain("READ-ONLY: change nothing in the tree");
    expect(brief).not.toContain("ADVERSARIAL REVIEW");
    const args = readFileSync(trace, "utf8");
    expect(args).toContain("exec");
    expect(args).toContain("read-only");
    expect(args).toContain("gpt-6-astra");
    expect(readFileSync(`${state}/reports/advisor-r1.md`, "utf8")).toContain("fake exec report");
    const lane = JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).advisor;
    expect(lane.kind).toBe("review");
    expect(lane.consult).toBe(true);
    expect(lane.model).toBe("gpt-6-astra");
    expect(runCli(["status"], env).stdout).toContain("consult ");

    const gemini = runCli(["consult", "advisor2", "--engine", "gemini", "--cd", root, "why"], env);
    expect(gemini.exitCode).toBe(1);
    expect(gemini.stderr).toContain("--engine is not valid for this command");
    const inside = runCli(["consult", "advisor3", "--cd", root, "why"], { ...env, CDX_LANE: "worker" });
    expect(inside.exitCode).toBe(1);
    expect(inside.stderr).toContain('command "consult" refused inside lane worker');

    // A consult lane and a work lane never share a name: resume would pick
    // the writable work thread over the read-only consult session.
    expect(runCli(["spawn", "worker-lane", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env).exitCode).toBe(0);
    const reused = runCli(["consult", "worker-lane", "--cd", root, "assess this"], env);
    expect(reused.exitCode).toBe(1);
    expect(reused.stderr).toContain('lane "worker-lane" has work history; consult needs a fresh name');
    const promoted = runCli(["spawn", "advisor", "--engine", "gpt", "--cd", root, "REPORT_ONLY"], env);
    expect(promoted.exitCode).toBe(1);
    expect(promoted.stderr).toContain('lane "advisor" is a consult lane');
  }, 20_000);

  test("killing a supervisor kills its running children", async () => {
    const root = tempPath("supervisor-kill");
    const state = `${root}/state`;
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(`${root}/agy`);
    const env = { ...baseEnv(state), PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}` };
    expect(runCli(["spawn", "sup", "--engine", "gpt", "--supervisor", "--cd", root, "--bg", "WAIT_FOR_STEER"], env).exitCode).toBe(0);
    const inside = { ...env, CDX_LANE: "sup", CDX_SUPERVISOR: "sup", CDX_ROUND: "1", CDX_OWNER: "terminal" };
    expect(runCli(["spawn", "child", "--cd", root, "--bg", "HANG_AGY"], inside).exitCode).toBe(0);
    const read = () => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    await waitFor(() => read().sup?.codexPid && read().child?.codexPid);

    const killed = runCli(["kill", "sup", "stop everything"], env);
    expect(killed.exitCode).toBe(0);
    await waitFor(() => read().sup.state === "failed" && read().child.state === "failed");
    // The supervisor's runner settles its children as part of its own
    // finalization; the CLI cascade is the fallback for a dead runner.
    expect(read().sup.note).toContain("stop everything");
    expect(read().child.note).toContain("supervisor sup killed");
  }, 30_000);

  test("a supervisor that finishes with a child still running fails and stops the child", async () => {
    const root = tempPath("supervisor-orphans");
    const state = `${root}/state`;
    const binCodex = installFakeCodex(root);
    const binAgy = installFakeAgy(`${root}/agy`);
    const env = { ...baseEnv(state), PATH: `${binCodex}:${binAgy}:${process.env.PATH ?? ""}` };
    expect(runCli(["spawn", "sup", "--engine", "gpt", "--supervisor", "--cd", root, "--bg", "WAIT_FOR_STEER"], env).exitCode).toBe(0);
    const inside = { ...env, CDX_LANE: "sup", CDX_SUPERVISOR: "sup", CDX_ROUND: "1", CDX_OWNER: "terminal" };
    const read = () => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8"));
    await waitFor(() => Boolean(read().sup?.codexPid));
    expect(runCli(["spawn", "child", "--cd", root, "--bg", "HANG_AGY"], inside).exitCode).toBe(0);
    await waitFor(() => Boolean(read().child?.codexPid));

    // The steer completes the supervisor's turn while the child still hangs.
    expect(runCli(["send", "sup", "finish now"], env).exitCode).toBe(0);
    await waitFor(() => read().sup.state === "failed" && read().child.state === "failed", 15_000);
    expect(read().sup.note).toBe("supervisor ended with running children: child (stopped)");
    expect(read().child.note).toContain("supervisor sup round 1 ended");
  }, 30_000);

  test("wait returns exit 2 as soon as a waited lane asks a question", async () => {
    const root = tempPath("wait-question");
    const state = `${root}/state`;
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_CDX_CLI: CLI };
    expect(runCli(["spawn", "asker", "--engine", "gemini", "--cd", root, "--bg", "ASK_OWNER"], env).exitCode).toBe(0);
    await waitFor(() => existsSync(`${state}/questions/asker-r1-1.json`));
    const blocked = runCli(["wait", "asker", "--timeout", "20"], env);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stdout).toContain("QUESTION #1: Which file should I inspect? (answer with: cdx reply asker");
    const asJson = runCli(["wait", "asker", "--timeout", "20", "--json"], env);
    expect(asJson.exitCode).toBe(2);
    expect(JSON.parse(asJson.stdout.trim())).toEqual({ lane: "asker", round: 1, question: 1, text: "Which file should I inspect?" });
    expect(runCli(["reply", "asker", "src/engine.ts"], env).exitCode).toBe(0);
    const finished = runCli(["wait", "asker", "--timeout", "20"], env);
    expect(finished.exitCode).toBe(0);
    expect(finished.stdout).toContain("state=done");
  }, 20_000);

  test("a detached gemini round runs the configured model and agent", async () => {
    const root = tempPath("gemini-pinned");
    const state = `${root}/state`;
    const trace = `${root}/agy.trace`;
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/config.json`, JSON.stringify({ gemini: { model: "gemini-custom-pro", agent: "house-lane", reviewAgent: "house-review" } }));
    const env = { ...baseEnv(state, installFakeAgy(root)), FAKE_AGY_TRACE: trace };
    expect(runCli(["spawn", "pinned", "--engine", "gemini", "--cd", root, "--bg", "DONE"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).pinned?.state === "done");
    const spec = JSON.parse(readFileSync(`${state}/specs/pinned-r1.json`, "utf8"));
    expect(spec.model).toBe("gemini-custom-pro");
    expect(spec.agent).toBe("house-lane");
    const work = JSON.parse(readFileSync(trace, "utf8").trim().split("\n")[0]!);
    expect(work.args).toContain("gemini-custom-pro");
    expect(work.args).toContain("house-lane");
    expect(runCli(["review", "pinned", "--bg", "attack the change"], env).exitCode).toBe(0);
    await waitFor(() => JSON.parse(readFileSync(`${state}/ledger.json`, "utf8")).pinned?.reviewState !== "running");
    const review = JSON.parse(readFileSync(`${state}/specs/pinned-r2.json`, "utf8"));
    expect(review.agent).toBe("house-review");
  }, 20_000);
});

describe("cdx view", () => {
  test("redacts credentials without hiding lane names or standalone git SHAs", () => {
    const cases = [
      ['CONTEXT7_API_KEY=example-value ctx7 docs', 'CONTEXT7_API_KEY=[redacted] ctx7 docs'],
      ['CONTEXT7_API_KEY="value with spaces" ctx7', 'CONTEXT7_API_KEY=[redacted] ctx7'],
      ["--api-key 'value with spaces' docs", '--api-key [redacted] docs'],
      ['--api-key example-value docs', '--api-key [redacted] docs'],
      ['ctx7sk_abcdefgh12345678', '[redacted]'],
      ['sk-abcdefghijklmnop123456', '[redacted]'],
      ['Bearer abcdefghijklmnop.1234', '[redacted]'],
      ['ghp_abcdefghijklmnopqrst1234', '[redacted]'],
      ...['key', 'token', 'secret', 'password'].map(word => [word + ': ' + 'a1'.repeat(20), word + ': [redacted]']),
      ['Key received: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==', 'Key received: [redacted]'],
      ['token values ' + 'a'.repeat(32) + ' and ' + 'b'.repeat(32), 'token values [redacted] and [redacted]'],
      ['key absent\n' + 'a'.repeat(40), 'key absent\n' + 'a'.repeat(40)],
      ['lane build-view-1 commit ' + 'a1'.repeat(20), 'lane build-view-1 commit ' + 'a1'.repeat(20)],
    ];
    for (const [input, expected] of cases) expect(redactViewText(input!)).toBe(expected!);
  });

  test("serves read-only fixture state, details, incremental transcripts, and live events on loopback", async () => {
    const state = tempPath('view');
    mkdirSync(`${state}/logs`, { recursive: true });
    mkdirSync(`${state}/reports`);
    mkdirSync(`${state}/questions`);
    const env = baseEnv(state);
    const startedAt = '2026-09-05T10:00:00.000Z';
    const lane = { engine: 'gpt', model: 'gpt-6-astra', kind: 'work', state: 'running', rounds: 1, reports: [], cwd: state, effort: 'medium', createdAt: startedAt, updatedAt: startedAt, roundStartedAt: startedAt, ownerSession: 'fixture-owner', tokens: { input: 1200, cached: 200, output: 300 } };
    const report = `${state}/reports/done-r1.md`;
    writeFileSync(report, 'Finished. --api-key fixture-secret');
    const ledger = { lead: { ...lane, supervisor: true }, child: { ...lane, engine: 'gemini', model: 'gemini-3.8-flash-high', parent: 'lead', parentRound: 1 }, done: { ...lane, state: 'done', reports: [report] } };
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));
    writeFileSync(`${state}/jobs.json`, JSON.stringify({ check: { state: 'done', startedAt, finishedAt: '2026-09-05T10:00:02.000Z', exitCode: 0, cwd: state, cmd: 'bun run check', log: `${state}/logs/job-check.log` } }));
    writeFileSync(`${state}/logs/job-check.log`, 'tests passed\nCONTEXT7_API_KEY=fixture-secret\n');
    writeFileSync(`${state}/feed.log`, 'lead started\n');
    writeFileSync(`${state}/questions/child-1.json`, JSON.stringify({ lane: 'child', round: 1, seq: 1, askedAt: startedAt, question: 'Which file?', answered: false }));
    const log = `${state}/logs/lead-r1.jsonl`;
    const event = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\n';
    writeFileSync(log, event('First line'));
    mkdirSync(`${state}/bin`);
    symlinkSync(CLI, `${state}/bin/cdx`);
    const proc = Bun.spawn([process.execPath, `${state}/bin/cdx`, 'view', '--port', '0'], { env, stdout: 'pipe', stderr: 'pipe' });
    runners.push(proc);
    const output = proc.stdout.getReader();
    const first = await output.read();
    const startup = new TextDecoder().decode(first.value);
    const url = startup.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    const json = async (path: string) => { const response = await fetch(url + path); expect(response.status).toBe(200); return response.json() as Promise<any>; };
    const snapshot = await json('/api/state');
    expect(snapshot.lanes.map((entry: any) => entry.name)).toEqual(['lead', 'child', 'done']);
    expect(snapshot.lanes[1].parent).toBe('lead');
    expect(snapshot.jobs[0]).toMatchObject({ name: 'check', exitCode: 0, duration: '2s', lastLines: ['tests passed', 'CONTEXT7_API_KEY=[redacted]'] });
    expect(snapshot.feed).toEqual(['lead started']);
    expect((await json('/api/lanes/lead')).children[0].name).toBe('child');
    expect((await json('/api/lanes/child')).questions[0].question).toBe('Which file?');
    expect((await json('/api/lanes/done')).reports[0].text).toBe('Finished. --api-key [redacted]');
    const initial = await json('/api/lanes/lead/transcript');
    expect(initial.lines).toEqual(['codex: First line']);
    const nextEvent = Buffer.from(event('Second line 日本語 --api-key fixture-secret'));
    const split = nextEvent.indexOf(Buffer.from('日')) + 1;
    writeFileSync(log, nextEvent.subarray(0, split), { flag: 'a' });
    const partial = await json('/api/lanes/lead/transcript?after=' + encodeURIComponent(initial.cursor));
    expect(partial.lines).toEqual([]);
    expect(partial.cursor).toBe(initial.cursor);
    writeFileSync(log, nextEvent.subarray(split), { flag: 'a' });
    const next = await json('/api/lanes/lead/transcript?after=' + encodeURIComponent(partial.cursor));
    expect(next.lines).toEqual(['codex: Second line 日本語 --api-key [redacted]']);
    expect((await json('/api/lanes/lead/transcript?after=' + encodeURIComponent(next.cursor))).lines).toEqual([]);
    expect(existsSync(`${state}/specs`)).toBe(false);
    const tail = runCli(['tail', 'lead', '-n', '20'], env);
    expect(tail.exitCode).toBe(0);
    expect(tail.stdout).toBe('codex: First line\ncodex: Second line 日本語 --api-key fixture-secret\n');
    writeFileSync(log, event('Truncated'));
    expect(await json('/api/lanes/lead/transcript?after=' + encodeURIComponent(next.cursor))).toMatchObject({ lines: ['codex: Truncated'], reset: true });
    expect((await fetch(url + '/api/state', { method: 'POST' })).status).toBe(405);
    expect((await fetch(url + '/api/state', { headers: { Origin: 'https://example.com' } })).status).toBe(403);
    expect((await fetch(url + '/api/state', { headers: { Host: 'example.com' } })).status).toBe(403);
    expect((await fetch(url + '/api/lanes/__proto__')).status).toBe(404);
    expect((await fetch(url + '/api/lanes/lead/transcript?round=2')).status).toBe(404);
    const page = await fetch(url + '/');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Local workspace');
    const controller = new AbortController();
    const stream = await fetch(url + '/events?lane=lead', { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let events = '';
    const until = async (text: string) => {
      const deadline = Date.now() + 5000;
      while (!events.includes(text)) {
        if (Date.now() > deadline) throw new Error('SSE event missing: ' + text);
        const result = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error('SSE timeout'); })]);
        events += decoder.decode(result.value);
      }
    };
    await until('event: transcript:lead');
    expect(events).toContain('event: state');
    expect(events).toContain('event: lane');
    writeFileSync(log, event('Live output'), { flag: 'a' });
    writeFileSync(`${state}/feed.log`, 'secret: ' + 'z'.repeat(40) + '\n', { flag: 'a' });
    await until('Live output');
    await until('event: feed');
    expect(events).toContain('secret: [redacted]');
    expect(events).not.toContain('z'.repeat(40));
    writeFileSync(`${state}/logs/lead-r2.log`, 'New round output\n');
    writeFileSync(`${state}/ledger.json`, JSON.stringify({ ...ledger, lead: { ...ledger.lead, rounds: 2 } }));
    await until('New round output');
    expect(events).toContain('"round":2,"lines":["New round output"]');
    expect(events).toContain('"reset":true');
    writeFileSync(`${state}/ledger.json`, JSON.stringify(ledger));
    controller.abort();
    await reader.cancel().catch(() => {});
    const curl = Bun.spawnSync(['curl', '--silent', '--show-error', `${url}/api/state`], { env });
    expect(curl.exitCode).toBe(0);
    if (process.env.CDX_VIEW_PROOF) {
      console.log(`fixture curl: curl --silent --show-error ${url}/api/state\n${curl.stdout.toString()}`);
    }
    proc.kill('SIGINT');
    expect(await proc.exited).toBe(0);
    expect(readFileSync(`${state}/ledger.json`, 'utf8')).toBe(JSON.stringify(ledger));
  }, 15000);

  test('rejects non-loopback bind flags and does not create an empty home', async () => {
    const state = tempPath('view-empty');
    const env = baseEnv(state);
    for (const args of [['--host','0.0.0.0'], ['--hostname','0.0.0.0'], ['--port','7477','0.0.0.0'], ['--port','65536']]) {
      expect(runCli(['view', ...args], env).exitCode).toBe(1);
    }
    expect(existsSync(state)).toBe(false);
    const proc = Bun.spawn([process.execPath, CLI, 'view', '--port', '0'], { env, stdout: 'pipe', stderr: 'pipe' });
    runners.push(proc);
    const startup = await proc.stdout.getReader().read();
    const url = new TextDecoder().decode(startup.value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    expect(await (await fetch(url + '/api/state')).json()).toEqual({ lanes: [], jobs: [], feed: [] });
    proc.kill('SIGINT');
    expect(await proc.exited).toBe(0);
    expect(existsSync(state)).toBe(false);
  });
});
