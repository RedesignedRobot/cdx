// Pure progress accounting. Runner memory owns tool identities and repetition state.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface VisibilityConfig { heartbeatMinutes: number; failureRepeats: number; fileEdits: number }
export const VISIBILITY_DEFAULTS: VisibilityConfig = { heartbeatMinutes: 10, failureRepeats: 5, fileEdits: 20 };
export interface ToolObservation { id?: string; completed: boolean; command?: string; failed?: boolean; files: string[] }
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
      failed: typeof exit === "number" ? exit !== 0 : ["ERROR", "FAILED"].includes(step.state) || info.is_error === true || Boolean(info.error)
        ? true : undefined,
      files: /^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|write_file|apply_patch)$/.test(name)
        ? [params.TargetFile ?? params.path ?? params.file_path].filter((path): path is string => typeof path === "string") : [],
    };
  }
  const item = event.params?.item ?? event.item;
  if (!item || !["item/started", "item/completed", "item.started", "item.completed"].includes(event.method ?? event.type)) return;
  if (!["commandExecution", "command_execution", "fileChange", "file_change", "mcpToolCall", "mcp_tool_call", "dynamicToolCall", "webSearch", "web_search", "imageView"].includes(item.type)) return;
  const exit = item.exitCode ?? item.exit_code;
  return {
    id: item.id == null ? undefined : `${event.params?.turnId ?? ""}:${item.id}`,
    completed: ["item/completed", "item.completed"].includes(event.method ?? event.type),
    command: typeof item.command === "string" ? item.command : undefined,
    failed: typeof exit === "number" ? exit !== 0 : ["failed", "declined"].includes(item.status) || Boolean(item.error) ? true : undefined,
    files: ["fileChange", "file_change"].includes(item.type)
      ? (Array.isArray(item.changes) ? item.changes : []).map((change: any) => change.path).filter((path: any) => typeof path === "string") : [],
  };
}

export function roundProgress(cwd: string, limits = VISIBILITY_DEFAULTS) {
  const seen = new Set<string>();
  const completed = new Set<string>();
  const edits = new Map<string, number>();
  let steps = 0;
  let previousCommand = "";
  let failures = 0;
  let warned = false;
  return (observation: ToolObservation): { steps: number; thrash?: string } => {
    const id = observation.id;
    // Without an identity, count only the final observation rather than both phases.
    if (id ? !seen.has(id) : observation.completed) {
      steps++;
      if (id) seen.add(id);
    }
    if (!observation.completed || (id && completed.has(id))) return { steps };
    if (id) completed.add(id);
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
    if (!reason || warned) return { steps };
    warned = true;
    return { steps, thrash: reason };
  };
}

export interface ProgressSample { key: string; round?: number; steps?: number; files?: number; stage: string; action: string }
export function digestLines(samples: ProgressSample[], previous: ProgressSample[]): string[] {
  const old = new Map(previous.map((sample) => [sample.key, sample]));
  const delta = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
  return samples.map((sample) => {
    const prior = old.get(sample.key);
    const sameRound = prior?.round === sample.round;
    const steps = sample.steps === undefined ? "" : ` steps=${sample.steps}(${delta(sample.steps - (sameRound ? prior?.steps ?? 0 : 0))})`;
    const files = sample.files === undefined ? "" : ` files=${sample.files}${sameRound && prior?.files !== undefined ? `(${delta(sample.files - prior.files)})` : ""}`;
    const stage = prior && prior.stage !== sample.stage ? `${prior.stage}>${sample.stage}` : sample.stage;
    return `${sample.key}${steps}${files} ${stage} ${sample.action}`.replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 180);
  });
}

export function heartbeatDue(now: number, last: number, minutes: number): boolean {
  return now - last >= minutes * 60_000;
}
