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

// Each account keeps its interactive instructions. New lane processes use this home.
export function laneCodexHome(home: string): string { return join(home, "cdx-lane"); }

export function laneHooks(value: any): any {
  if (Array.isArray(value)) return value.map(laneHooks);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "command" && typeof item === "string" && item.includes("codegraph prompt-hook") && !item.includes("CDX_LANE")
      ? `[ -n "$CDX_LANE" ] || ${item}` : laneHooks(item)]));
}

export function installLaneHome(home: string, instructions: string): string {
  const target = laneCodexHome(home);
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
  if (hooks) {
    const text = JSON.stringify(laneHooks(JSON.parse(hooks)), null, 2) + "\n";
    if (readText(join(target, "hooks.json")) !== text) atomicWrite(join(target, "hooks.json"), text);
  }
  return target;
}

export function retiredLaneRule(rule: string): boolean {
  return /Read the repository.s AGENTS\.md and CLAUDE\.md|Retain shell output above 20 KB|lane gate owns verification|re-run every test you cite/.test(rule);
}
