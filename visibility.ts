// Pure progress accounting. Runner memory owns tool identities and repetition state.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { codegraphActions } from "./codegraph-policy.ts";

export interface VisibilityConfig { heartbeatMinutes: number; failureRepeats: number; fileEdits: number; testRuns: number }
export const VISIBILITY_DEFAULTS: VisibilityConfig = { heartbeatMinutes: 10, failureRepeats: 5, fileEdits: 20, testRuns: 3 };
export interface ToolObservation { id?: string; completed: boolean; command?: string; toolName?: string; cwd?: string; args?: unknown; failed?: boolean; files: string[]; output?: string }
const object = (value: any): any => value && typeof value === "object" ? value : {};

export function toolObservation(event: any): ToolObservation | undefined {
  if (event.event === "step_update") {
    const step = event.step_update;
    if (step?.step_type !== "tool") return;
    const info = object(step.tool_info);
    let params = info.parameters;
    if (typeof params === "string") { try { params = JSON.parse(params); } catch { params = {}; } }
    params = object(params);
    const name = step.tool_name ?? info.name ?? "";
    const output = object(info.output);
    const exit = info.exit_code ?? output.exit_code ?? output.exitCode;
    return {
      id: step.step_index == null ? undefined : `${step.conversation_id ?? ""}:${step.step_index}`,
      completed: ["DONE", "ERROR", "FAILED"].includes(step.state),
      command: params.CommandLine ?? params.command ?? params.cmd,
      toolName: name,
      cwd: params.Cwd ?? params.cwd,
      args: params,
      failed: typeof exit === "number" ? exit !== 0 : ["ERROR", "FAILED"].includes(step.state) || info.is_error === true || Boolean(info.error)
        ? true : undefined,
      files: /^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|write_file|apply_patch)$/.test(name)
        ? [params.TargetFile ?? params.path ?? params.file_path].filter((path): path is string => typeof path === "string") : [],
      output: typeof info.output === "string" ? info.output : typeof output.output === "string" ? output.output : undefined,
    };
  }
  const item = event.params?.item ?? event.item;
  if (!item || !["item/started", "item/completed", "item.started", "item.completed"].includes(event.method ?? event.type)) return;
  if (!["commandExecution", "command_execution", "fileChange", "file_change", "mcpToolCall", "mcp_tool_call", "dynamicToolCall", "webSearch", "web_search", "imageView"].includes(item.type)) return;
  const exit = item.exitCode ?? item.exit_code;
  let args = item.arguments ?? item.input;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* Keep unstructured arguments uncertain. */ } }
  return {
    id: item.id == null ? undefined : `${event.params?.turnId ?? ""}:${item.id}`,
    completed: ["item/completed", "item.completed"].includes(event.method ?? event.type),
    command: typeof item.command === "string" ? item.command : undefined,
    toolName: item.type === "mcpToolCall" || item.type === "mcp_tool_call"
      ? (item.server ? `${item.server}/${item.tool}` : item.tool) : item.tool ?? item.type,
    cwd: item.cwd,
    args,
    failed: typeof exit === "number" ? exit !== 0 : ["failed", "declined"].includes(item.status) || Boolean(item.error) ? true : undefined,
    files: ["fileChange", "file_change"].includes(item.type)
      ? (Array.isArray(item.changes) ? item.changes : []).map((change: any) => change.path).filter((path: any) => typeof path === "string") : [],
    output: [item.aggregatedOutput, item.aggregated_output, item.output].find((value) => typeof value === "string"),
  };
}

// Count verification invocations, not the number of test files in output.
function shellParts(input: string, separators: boolean): string[] {
  const parts: string[] = [];
  let quote = "", escaped = false, part = "", depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (escaped) { part += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { if (separators) part += char; escaped = true; continue; }
    if (char === quote) { if (separators) part += char; quote = ""; continue; }
    if (!quote && (char === "'" || char === '"')) { if (separators) part += char; quote = char; continue; }
    if (separators && !quote && char === "(") depth++;
    if (separators && !quote && char === ")") depth--;
    if (!quote && (!separators || depth === 0) && (separators ? char === ";" || char === "\n" || input.slice(i, i + 2) === "&&" || input.slice(i, i + 2) === "||" : /\s/.test(char))) {
      if (part.trim()) parts.push(part.trim());
      part = "";
      if (separators && (char === "&" || char === "|")) i++;
      continue;
    }
    part += char;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}

export function testCommands(command: string, gate?: string): { command: string; suite: boolean }[] {
  const runs = shellParts(command, true).flatMap((part) => {
    if (part.startsWith("(") && part.endsWith(")")) return testCommands(part.slice(1, -1), gate);
    const words = shellParts(part, false);
    if (/^(?:\/bin\/)?(?:zsh|bash|sh)$/.test(words[0] ?? "") && /^-[a-z]*c$/.test(words[1] ?? "")) {
      return testCommands(words.slice(2).join(" "), gate);
    }
    const plain = part.replace(/^(?:(?:\w+=\S+)\s+)*/, "");
    const recognized = /^(?:(?:bunx?\s+)?vp\s+(?:check|test)(?:\s|$)|bun\s+(?:run\s+check|test|wall)(?:\s|$)|(?:bunx?\s+)?vitest(?:\s|$)|(?:bun\s+run\s+)?wall(?:\s|$))/.test(plain);
    if (!recognized && part !== gate?.trim()) return [];
    const suite = /^(?:bun\s+run\s+(?:check|wall)|(?:bun\s+)?wall)(?:\s|$)/.test(plain)
      || /^(?:bun\s+test|(?:bunx?\s+)?vp\s+test|(?:bunx?\s+)?vitest)(?:\s+(?:run|--[\w-]+))*\s*$/.test(plain);
    return [{ command: part, suite }];
  });
  if (!runs.length && command.trim() === gate?.trim()) return [{ command: command.trim(), suite: false }];
  return runs;
}

export function roundProgress(cwd: string, limits = VISIBILITY_DEFAULTS, gate?: string, indexedRoot: (cwd: string) => string | undefined = () => undefined) {
  const seen = new Set<string>();
  const completed = new Set<string>();
  const countedTests = new Set<string>();
  const edits = new Map<string, number>();
  const graphRepos = new Set<string>();
  const countedGraph = new Set<string>();
  let codegraphCalls = 0;
  let codeSearchesBeforeGraph = 0;
  let graphWarned = false;
  let steps = 0;
  let previousCommand = "";
  let failures = 0;
  let warned = false;
  let testRuns = 0;
  let testSuites = 0;
  let testStatus: "running" | "passed" | "failed" | undefined;
  let testWarned = false;
  return (observation: ToolObservation): { steps: number; thrash?: string; testRuns: number; testSuites: number; testStatus?: "running" | "passed" | "failed"; testThrash?: string; codegraphCalls: number; codeSearchesBeforeGraph: number; codegraphThrash?: string } => {
    const id = observation.id;
    let codegraphThrash: string | undefined;
    const hasDetails = !!observation.command?.trim() || !!(observation.args && typeof observation.args === "object" && Object.keys(observation.args).length);
    if ((id ? !countedGraph.has(id) : observation.completed) && (observation.completed || hasDetails)) {
      if (id) countedGraph.add(id);
      for (const action of codegraphActions(observation, cwd)) {
        const root = indexedRoot(action.cwd);
        if (!root) continue;
        const repo = resolve(root);
        if (action.kind === "graph") { codegraphCalls++; graphRepos.add(repo); }
        else if (!graphRepos.has(repo)) {
          codeSearchesBeforeGraph++;
          if (!graphWarned) {
            graphWarned = true;
            codegraphThrash = `codegraph-first: use codegraph explore before code questions in ${repo}. Exceptions: fixed-string or existence searches, non-code files, logs.`;
          }
        }
      }
    }
    // Without an identity, count only the final observation rather than both phases.
    if (id ? !seen.has(id) : observation.completed) {
      steps++;
      if (id) seen.add(id);
    }
    const runs = observation.command ? testCommands(observation.command, gate) : [];
    if (runs.length && (id ? !countedTests.has(id) : observation.completed)) {
      if (id) countedTests.add(id);
      testRuns += runs.length;
      testSuites += runs.filter((run) => run.suite).length;
      testStatus = observation.completed ? observation.failed === true ? "failed" : "passed" : "running";
    }
    const testThrash = !testWarned && testRuns > limits.testRuns ? `tests run ${testRuns}x this round` : undefined;
    if (testThrash) testWarned = true;
    if (!observation.completed || (id && completed.has(id))) return { steps, testRuns, testSuites, testStatus, testThrash, codegraphCalls, codeSearchesBeforeGraph, codegraphThrash };
    if (id) completed.add(id);
    if (runs.length || (id && countedTests.has(id))) testStatus = observation.failed === true ? "failed" : "passed";
    let reason: string | undefined;
    if (typeof observation.command === "string") {
      const command = observation.command.trim();
      const key = createHash("sha256").update(command).digest("hex");
      failures = observation.failed === true ? (key === previousCommand ? failures + 1 : 1) : 0;
      previousCommand = key;
      if (failures >= limits.failureRepeats) reason = `command failed ${failures}x: ${command.replace(/\s+/g, " ").slice(0, 80)}`;
    }
    if (observation.failed !== true) for (const path of new Set(observation.files.map((path) => resolve(cwd, path)))) {
      const count = (edits.get(path) ?? 0) + 1;
      edits.set(path, count);
      if (count > limits.fileEdits) reason ??= `file edited ${count}x: ${path.slice(-80)}`;
    }
    if (!reason || warned) return { steps, testRuns, testSuites, testStatus, testThrash, codegraphCalls, codeSearchesBeforeGraph, codegraphThrash };
    warned = true;
    return { steps, thrash: reason, testRuns, testSuites, testStatus, testThrash, codegraphCalls, codeSearchesBeforeGraph, codegraphThrash };
  };
}
