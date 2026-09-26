// Claude Fable as a third engine, for read-only consult rounds only. claude -p
// runs whole under a sandbox-exec profile that denies writes outside its own
// state, prints one JSON result message, and the round finalizes like any
// other consult: report, tokens, terminal event.
import { type Engine, type Spec, type Tokens, withLane, withLedger } from "./ledger.ts";
import { logPathOf, reportPathOf } from "./reports.ts";
import { finalizeRound } from "./runner.ts";
import { HOME, laneChildEnv, ROOT, singleLine } from "./runtime.ts";
import { safeText } from "./safe-text.ts";
import { claudeProfile } from "./sandbox.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLAUDE_MODEL = "claude-fable-5-1";

// No shell: a consult reads, and --restricted drops every code-running tool.
const CLAUDE_TOOLS = "Read,Grep,Glob";
// Per member round; the first real panel answer cost $0.44 at list price.
export const CLAUDE_BUDGET_USD = 2;

export function claudeLaneRefusal(engine: Engine, kind: "work" | "review", consult: boolean): string | undefined {
  if (engine !== "claude" || (kind === "review" && consult)) return undefined;
  return `engine claude runs read-only consult lanes only; a ${kind === "work" ? "work" : "review"} lane on claude is refused`;
}

// In the owner's zsh `claude` is an alias for `cca claude`, which may switch
// accounts. A spawned process never sees shell aliases, so PATH resolves the
// real binary; the install path covers a PATH without ~/.local/bin.
export function claudeBinary(): string {
  return Bun.which("claude") ?? join(HOME, ".local", "bin", "claude");
}

// --safe-mode keeps the owner's hooks, CLAUDE.md, plugins and MCP servers out
// of a headless member: the interactive Stop hook and push rules would steer
// it. --restricted ignores user settings and confines the file tools to the
// checkout plus readDirs; dontAsk refuses any tool outside the read-only set.
export function claudeArgs(model: string, effort: string, readDirs: string[] = []): string[] {
  return ["-p", "--model", model, "--effort", effort, "--output-format", "json", "--safe-mode", "--restricted",
    "--strict-mcp-config", "--no-session-persistence", "--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS,
    "--permission-mode", "dontAsk", "--max-budget-usd", String(CLAUDE_BUDGET_USD), ...readDirs.flatMap((dir) => ["--add-dir", dir])];
}

// What the sandbox lets the member exec: itself, the keychain tool its
// login reads, and git, which it runs for repository status.
export function claudeExecutables(binary = claudeBinary()): string[] {
  const git = Bun.which("git");
  return [binary, "/usr/bin/security", ...(git ? [git] : [])];
}

export interface ClaudeResult {
  report?: string;
  failure?: string;
  sessionId?: string;
  tokens?: Tokens;
  costUsd?: number;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

// cdx counts cached tokens inside input, as Codex does. Claude reports cache
// reads and writes beside input_tokens. modelUsage covers the whole tree
// (claude may route turns to more than one model); usage covers the main loop.
export function claudeTokens(result: any): Tokens | undefined {
  const models = result?.modelUsage && typeof result.modelUsage === "object" ? Object.values(result.modelUsage) as any[] : [];
  const rows = models.length ? models.map((row) => ({ input: row.inputTokens, read: row.cacheReadInputTokens, write: row.cacheCreationInputTokens, output: row.outputTokens }))
    : result?.usage ? [{ input: result.usage.input_tokens, read: result.usage.cache_read_input_tokens, write: result.usage.cache_creation_input_tokens, output: result.usage.output_tokens }] : [];
  if (!rows.length) return undefined;
  return rows.reduce<Tokens>((sum, row) => ({
    input: sum.input + count(row.input) + count(row.read) + count(row.write),
    cached: sum.cached + count(row.read),
    output: sum.output + count(row.output),
  }), { input: 0, cached: 0, output: 0 });
}

export function parseClaudeResult(stdout: string): ClaudeResult {
  let value: any;
  try { value = JSON.parse(stdout.trim()); } catch { return { failure: "claude printed no JSON result" }; }
  if (value?.type !== "result") return { failure: "claude printed no result message" };
  const text = typeof value.result === "string" ? value.result.trim() : "";
  const failure = value.subtype !== "success" ? `claude ${value.subtype ?? "error"}${value.api_error_status ? ` (${value.api_error_status})` : ""}`
    : value.is_error ? `claude error: ${singleLine(text).slice(0, 200)}`
    : text ? undefined : "claude returned an empty result";
  const tokens = claudeTokens(value);
  return {
    ...(failure ? { failure } : { report: text }),
    ...(typeof value.session_id === "string" ? { sessionId: value.session_id } : {}),
    ...(tokens ? { tokens } : {}),
    ...(typeof value.total_cost_usd === "number" ? { costUsd: value.total_cost_usd } : {}),
  };
}

export async function runClaudeRound(lane: string, round: number, spec: Spec): Promise<number> {
  const logPath = logPathOf(lane, round, true);
  const reportPath = reportPathOf(lane, round);
  withLedger((ledger) => {
    const item = ledger[lane]!;
    item.pid = process.pid;
    item.expectMinutes ??= spec.expectMinutes ?? 15;
    item.review!.state = "running";
    item.lastAction = `claude ${spec.model ?? CLAUDE_MODEL} answering`;
  });
  const proc = Bun.spawn({
    cmd: ["sandbox-exec", "-p", claudeProfile(claudeExecutables()), claudeBinary(), ...claudeArgs(spec.model ?? CLAUDE_MODEL, spec.effort, spec.additionalDirectories)],
    cwd: spec.cwd,
    env: laneChildEnv(undefined, { lane, round, owner: spec.ownerSession }, "claude"),
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(spec.prompt);
  proc.stdin.end();
  withLane(lane, (item) => { if (item) item.codexPid = proc.pid; });
  let receivedSignal: "SIGTERM" | "SIGINT" | undefined;
  const onTerm = () => { receivedSignal = "SIGTERM"; proc.kill("SIGTERM"); };
  const onInt = () => { receivedSignal = "SIGINT"; proc.kill("SIGINT"); };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  let maxRuntimeHit = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const maxRuntimeTimer = spec.maxRuntimeMins ? setTimeout(() => {
    maxRuntimeHit = true;
    proc.kill("SIGTERM");
    forceTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
  }, spec.maxRuntimeMins * 60_000) : undefined;
  const [exited, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(maxRuntimeTimer);
  clearTimeout(forceTimer);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  writeFileSync(`${ROOT}/logs/${lane}-r${round}.stderr.log`, safeText(stderr));
  writeFileSync(logPath, safeText(stdout.trim() ? `${stdout.trim()}\n` : ""));
  const result = parseClaudeResult(stdout);
  if (result.report) writeFileSync(reportPath, safeText(`${result.report}\n`));
  withLane(lane, (item) => {
    if (!item) return;
    if (result.sessionId) item.sessionId = result.sessionId;
    if (!result.tokens) { item.review!.tokensIncomplete = true; return; }
    item.roundTokens = result.tokens;
    const total = (item.tokens ??= { input: 0, cached: 0, output: 0 });
    total.input += result.tokens.input;
    total.cached += result.tokens.cached;
    total.output += result.tokens.output;
    item.lastAction = `claude finished${result.costUsd === undefined ? "" : ` at $${result.costUsd.toFixed(2)} list price`}`;
  });
  const exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal ? 143 : exited;
  return finalizeRound({
    treeCwd: spec.cwd, spec, lane, round, jsonMode: true, gemini: false, logPath, reportPath, exitCode,
    turnFailureReason: receivedSignal ? undefined : result.failure, receivedSignal, maxRuntimeHit, geminiContinuations: 0,
  });
}
