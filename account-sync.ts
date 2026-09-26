import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Config = Record<string, any>;

function object(value: unknown): value is Config {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = `${path}.tmp.${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, text, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    if (readFileSync(path, "utf8") !== text) throw new Error("write verification failed");
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

// Each account keeps its interactive instructions. Lane processes use one home
// per role: Codex loads the home's AGENTS.md as the standing lane rules, and
// only supervisors carry the cdx exec-policy rule.
export interface LaneRole { review?: boolean; supervisor?: boolean }

export function laneCodexHome(home: string, role: LaneRole = {}): string {
  if (role.review) return join(home, role.supervisor ? "cdx-review-supervisor" : "cdx-review");
  return join(home, role.supervisor ? "cdx-supervisor" : "cdx-lane");
}

// Seatbelt does not nest: a child lane started from a sandboxed supervisor could
// not sandbox its own commands. Codex runs a command that matches an allow rule
// outside the sandbox, so a supervisor's cdx calls start children normally.
export const SUPERVISOR_RULES = 'prefix_rule(pattern = ["cdx"], decision = "allow", justification = "cdx starts each child lane in its own sandbox")\n';

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export const CAP_HOOK_COMMAND = `${quote(process.execPath)} ${quote(join(import.meta.dir, "cap.ts"))} codex-pre-tool`;

export function withCapHook(value: any, command = CAP_HOOK_COMMAND): any {
  const config = object(value) ? value : {};
  const hooks = object(config.hooks) ? config.hooks : {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  return { ...config, hooks: { ...hooks, PreToolUse: [...preToolUse, { matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] }] } };
}

export function laneHooks(value: any): any {
  if (Array.isArray(value)) return value.map(laneHooks);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "command" && typeof item === "string" && item.includes("codegraph prompt-hook") && !item.includes("CDX_LANE")
      ? `[ -n "$CDX_LANE" ] || ${item}` : laneHooks(item)]));
}

export function installLaneHome(home: string, instructions: string, role: LaneRole = {}): string {
  const target = laneCodexHome(home, role);
  mkdirSync(target, { recursive: true });
  // Auth and conversation history stay on the account. Never copy credentials or databases.
  for (const name of ["auth.json", "config.toml", "sessions", "archived_sessions", "models_cache.json"]) {
    const source = join(home, name);
    const link = join(target, name);
    if (!existsSync(source)) continue;
    try { lstatSync(link); } catch {
      try { symlinkSync(source, link); } catch (error) { if (!existsSync(link)) throw error; }
    }
  }
  if (readText(join(target, "AGENTS.md")) !== instructions) atomicWrite(join(target, "AGENTS.md"), instructions);
  const hooks = readText(join(home, "hooks.json"));
  const text = JSON.stringify(withCapHook(hooks ? laneHooks(JSON.parse(hooks)) : {}), null, 2) + "\n";
  if (readText(join(target, "hooks.json")) !== text) atomicWrite(join(target, "hooks.json"), text);
  const rules = join(target, "rules", "cdx.rules");
  if (role.supervisor && readText(rules) !== SUPERVISOR_RULES) atomicWrite(rules, SUPERVISOR_RULES);
  return target;
}

export function retiredLaneRule(rule: string): boolean {
  return /Read the repository.s AGENTS\.md and CLAUDE\.md|Retain shell output above 20 KB|lane gate owns verification|re-run every test you cite/.test(rule);
}
