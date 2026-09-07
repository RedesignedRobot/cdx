import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const SHARED_KEYS = ["model", "personality", "service_tier", "model_reasoning_effort", "features", "agents", "mcp_servers"] as const;
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

function readConfig(path: string, allowMissing = false): Config {
  const text = readText(path);
  if (text === undefined && !allowMissing) throw new Error("config.toml missing");
  return text === undefined ? {} : Bun.TOML.parse(text);
}

// Environment references are names, never credentials. Reject inline secrets
// before preparing a replacement so refusal cannot delete a server.
function mcpProblems(config: Config): string[] {
  const problems: string[] = [];
  const secretKey = /api[_-]?key|(?:^|[_-])(?:token|secret|password|authorization|credentials?|bearer)(?:$|[_-])/i;
  const secretValue = /^(?:Bearer\s+|sk-|ghp_|ctx7sk-)/i;
  for (const [name, server] of Object.entries(config.mcp_servers ?? {})) {
    if (!object(server)) { problems.push(`${name}: invalid MCP definition`); continue; }
    const inline = [server.env, server.http_headers, server.auth].filter(object)
      .some((table) => Object.entries(table).some(([key, value]) => secretKey.test(key) || (typeof value === "string" && secretValue.test(value))));
    if (inline || server.bearer_token || (typeof server.url === "string" && /:\/\/[^/]+:[^/]+@/.test(server.url))
      || (Array.isArray(server.args) && server.args.some((arg: unknown) => typeof arg === "string" && /--[\w-]*(?:api-key|token|password|secret)(?:=|$)/i.test(arg)))) {
      problems.push(`${name}: literal credentials; use environment references`);
      continue;
    }
    if (object(server.env) && Object.hasOwn(server.env, "CODEX_HOME")) problems.push(`${name}: remove env.CODEX_HOME so the server inherits its account home`);
    if (server.enabled === false) continue;
    const references = [...Object.entries(server.env_http_headers ?? {}), ...(server.bearer_token_env_var ? [["bearer_token_env_var", server.bearer_token_env_var]] : [])];
    for (const [label, variable] of references) {
      if (typeof variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) problems.push(`${name}: ${label} is not an environment variable name`);
      else if (!process.env[variable]?.trim()) problems.push(`${name}: ${label} references an unset or empty environment variable`);
    }
  }
  return problems;
}

function validateShared(config: Config): void {
  for (const key of ["features", "agents", "mcp_servers"]) {
    if (config[key] !== undefined && !object(config[key])) throw new Error(`invalid ${key} table`);
  }
  for (const key of ["model", "personality", "service_tier", "model_reasoning_effort"]) {
    if (config[key] !== undefined && typeof config[key] !== "string") throw new Error(`invalid ${key}`);
  }
}

export function syncAccountHomes(
  accounts: Record<string, string>, fix: boolean,
  good: (message: string) => void,
  bad: (label: string, detail: string, remedy: string) => void,
): void {
  const entries = Object.entries(accounts).map(([name, home]) => [name, home.startsWith("~/") ? join(process.env.HOME ?? "", home.slice(2)) : home] as const);
  if (!entries.length) return;
  const [primaryName, primaryHome] = entries[0]!;
  const remedy = "run cdx doctor --fix to synchronize from the primary home";
  const assets = ["AGENTS.md", "hooks.json"] as const;
  for (const file of assets) {
    let source: string;
    try {
      source = readText(join(primaryHome, file)) ?? "";
      if (!source.trim()) throw new Error("missing or empty");
      if (file === "hooks.json") {
        const hooks = JSON.parse(source);
        if (!object(hooks) || !object(hooks.hooks)) throw new Error("invalid hooks object");
      }
    } catch {
      bad(`${primaryName} ${file}`, "missing, unreadable, or invalid", `restore ${join(primaryHome, file)}`);
      continue;
    }
    for (const [name, home] of entries) {
      const path = join(home, file);
      try {
        const different = readText(path) !== source;
        if (different && fix) atomicWrite(path, source);
        if (different && !fix) bad(`${name} ${file}`, "differs from primary", remedy);
        else good(`${name} ${file}: ${different ? "repaired from" : "matches"} primary`);
      } catch {
        bad(`${name} ${file}`, "cannot read or repair", `check permissions on ${path}`);
      }
    }
  }

  let primary: Config;
  try {
    primary = readConfig(join(primaryHome, "config.toml"));
    validateShared(primary);
  } catch {
    bad(`${primaryName} config`, "config.toml missing, unreadable, or invalid", `repair ${join(primaryHome, "config.toml")}`);
    return;
  }
  const problems = mcpProblems(primary);
  if (problems.length) {
    for (const problem of problems) bad(`${primaryName} MCP`, problem, "repair primary MCP configuration or export the named environment variable");
    return;
  }
  good(`${primaryName} config: matches primary shared settings`);
  for (const [name, home] of entries.slice(1)) {
    const path = join(home, "config.toml");
    try {
      const current = readConfig(path, true);
      if (mcpProblems(current).some((problem) => problem.includes("literal credentials"))) {
        bad(`${name} MCP`, "literal credentials prevent config synchronization", "move credentials to environment references before syncing");
        continue;
      }
      const different = !existsSync(path) || SHARED_KEYS.some((key) => !isDeepStrictEqual(current[key], primary[key]));
      if (different && !fix) { bad(`${name} config`, "shared settings differ from primary", remedy); continue; }
      if (different) {
        const merged = { ...current };
        for (const key of SHARED_KEYS) {
          if (Object.hasOwn(primary, key)) merged[key] = primary[key];
          else delete merged[key];
        }
        const text = Bun.TOML.stringify(merged);
        if (!isDeepStrictEqual(Bun.TOML.parse(text), merged)) throw new Error("TOML serialization changed settings");
        atomicWrite(path, text);
      }
      good(`${name} config: ${different ? "synchronized" : "matches"} primary shared settings`);
    } catch {
      bad(`${name} config`, "cannot read or repair config.toml; no malformed TOML is overwritten", `repair ${path} or its permissions`);
    }
  }
}
