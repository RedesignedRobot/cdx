// Configuration, engine and model selection, effort caps, and round limits.

import { type Config, type Effort, type Engine, type GeminiConfig, type Lane, laneEngine } from "./ledger.ts";
import { CONFIG_PATH, fail, HOME, type Parsed, SELF } from "./runtime.ts";
import { VISIBILITY_DEFAULTS, type VisibilityConfig } from "./visibility.ts";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// Codex reasoning efforts from cheapest to most expensive; effortCaps compare
// against this order. Codex 0.156 also offers "ultra", which delegates to
// native sub-agents; cdx lanes disable those, so ultra is not accepted.
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

// Shipped ceilings. Configured caps may raise or lower either model's ceiling.
const DEFAULT_EFFORT_CAPS: Record<string, string> = { "gpt-6-astra": "medium", "gpt-6-sol": "high" };

// GPT-6 split (owner ruling 2026-09-23): Sol executes work lanes, Astra thinks.
// Astra runs head-launched consults, reviews and supervisors; children never.
export const EXECUTOR_MODEL = "gpt-6-sol";
export const THINKER_MODEL = "gpt-6-astra";

function configError(message: string): never {
  fail(`${CONFIG_PATH}: ${message}`);
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

export function parseConfig(text: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    configError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    configError("config must be a JSON object");
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set(["model", "thinkerModel", "models", "efforts", "defaultEffort", "rules", "accounts", "effortCaps", "expectMinutes", "worktreeSetup", "gemini", "visibility", "model_auto_compact_token_limit", "tool_output_token_limit"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) configError(`unknown config key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);

  const defaults: Config = {
    model: EXECUTOR_MODEL,
    thinkerModel: THINKER_MODEL,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    rules: [],
    effortCaps: DEFAULT_EFFORT_CAPS,
    expectMinutes: 15,
    gemini: geminiConfig(),
  };

  const model = Object.hasOwn(input, "model") ? input.model : defaults.model;
  if (typeof model !== "string" || model.trim().length === 0) configError("model must be a nonempty string");
  const thinkerModel = Object.hasOwn(input, "thinkerModel") ? input.thinkerModel : defaults.thinkerModel;
  if (typeof thinkerModel !== "string" || thinkerModel.trim().length === 0) configError("thinkerModel must be a nonempty string");

  let models: Record<string, string> | undefined;
  if (Object.hasOwn(input, "models")) {
    const value = input.models;
    if (value === null || typeof value !== "object" || Array.isArray(value)) configError("models must be an object mapping aliases to Codex model ids");
    for (const [alias, id] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) configError(`models: alias "${alias}" must be lowercase letters, digits, and dashes`);
      if (typeof id !== "string" || !MODEL_ID.test(id)) configError(`models.${alias} must be a Codex model id`);
    }
    models = { ...(value as Record<string, string>) };
  }

  const efforts = Object.hasOwn(input, "efforts") ? input.efforts : defaults.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) configError("efforts must be a nonempty array of strings");
  if (efforts.some((effort) => typeof effort !== "string" || effort.trim().length === 0)) {
    configError("efforts must contain only nonempty strings");
  }
  if (new Set(efforts).size !== efforts.length) configError("efforts must not contain duplicates");
  if (efforts.some((effort) => !EFFORT_ORDER.includes(effort))) configError(`efforts must be among ${EFFORT_ORDER.join(", ")}`);

  const defaultEffort = Object.hasOwn(input, "defaultEffort") ? input.defaultEffort : defaults.defaultEffort;
  if (typeof defaultEffort !== "string") configError("defaultEffort must be a string");
  if (!efforts.includes(defaultEffort)) configError("defaultEffort must be one of the configured efforts");

  const rules = Object.hasOwn(input, "rules") ? input.rules : defaults.rules;
  if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== "string")) {
    configError("rules must be an array of strings");
  }

  let accounts: Record<string, string> | undefined;
  if (Object.hasOwn(input, "accounts")) {
    const value = input.accounts;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      configError("accounts must be an object mapping account names to Codex home directories");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) configError("accounts must contain at least one entry");
    const parsedAccounts: [string, string][] = [];
    for (const [name, path] of entries) {
      if (name.trim().length === 0) configError("account names must be nonempty strings");
      if (typeof path !== "string" || path.trim().length === 0) {
        configError(`accounts.${name} must be a nonempty string`);
      }
      const home = path === "~" ? HOME : path.startsWith("~/") ? `${HOME}/${path.slice(2)}` : path;
      if (!isAbsolute(home)) configError(`accounts.${name} must be an absolute path or start with ~/`);
      const canonicalHome = resolve(home);
      if (parsedAccounts.some(([, configuredHome]) => configuredHome === canonicalHome)) configError(`accounts.${name} repeats a configured Codex home; each home is one account`);
      parsedAccounts.push([name, canonicalHome]);
    }
    accounts = Object.fromEntries(parsedAccounts);
  }

  let effortCaps: Record<string, string> = defaults.effortCaps;
  if (Object.hasOwn(input, "effortCaps")) {
    const value = input.effortCaps;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      configError("effortCaps must be an object mapping Codex model ids to the highest allowed effort");
    }
    effortCaps = { ...DEFAULT_EFFORT_CAPS };
    for (const [modelId, cap] of Object.entries(value as Record<string, unknown>)) {
      if (!MODEL_ID.test(modelId)) configError(`effortCaps key "${modelId}" is not a Codex model id`);
      if (typeof cap !== "string" || !EFFORT_ORDER.includes(cap)) {
        configError(`effortCaps.${modelId} must be one of ${EFFORT_ORDER.join(", ")}`);
      }
      effortCaps[modelId] = cap;
    }
  }

  let worktreeSetup: string | undefined;
  if (Object.hasOwn(input, "worktreeSetup")) {
    if (typeof input.worktreeSetup !== "string" || input.worktreeSetup.trim().length === 0) {
      configError("worktreeSetup must be a nonempty string (a shell command run inside each new worktree)");
    }
    worktreeSetup = input.worktreeSetup;
  }

  let gemini: GeminiConfig | undefined;
  if (Object.hasOwn(input, "gemini")) {
    const value = input.gemini;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      configError("gemini must be an object");
    }
    const geminiInput = value as Record<string, unknown>;
    const geminiAllowed = new Set(["model", "agent", "reviewAgent", "maxRounds", "maxRuntimeMins", "outageFallbackModel"]);
    const unknownGemini = Object.keys(geminiInput).filter((key) => !geminiAllowed.has(key));
    if (unknownGemini.length > 0) {
      configError(`unknown gemini key${unknownGemini.length === 1 ? "" : "s"}: ${unknownGemini.join(", ")}`);
    }
    const defaults = geminiConfig();
    const values = {
      model: Object.hasOwn(geminiInput, "model") ? geminiInput.model : defaults.model,
      agent: Object.hasOwn(geminiInput, "agent") ? geminiInput.agent : defaults.agent,
      reviewAgent: Object.hasOwn(geminiInput, "reviewAgent") ? geminiInput.reviewAgent : defaults.reviewAgent,
      maxRounds: Object.hasOwn(geminiInput, "maxRounds") ? geminiInput.maxRounds : defaults.maxRounds,
      maxRuntimeMins: Object.hasOwn(geminiInput, "maxRuntimeMins") ? geminiInput.maxRuntimeMins : defaults.maxRuntimeMins,
      outageFallbackModel: Object.hasOwn(geminiInput, "outageFallbackModel") ? geminiInput.outageFallbackModel : defaults.outageFallbackModel,
    };
    if (typeof values.outageFallbackModel !== "string") configError("gemini.outageFallbackModel must be a string (empty disables the fallback round)");
    if (/gemini-3\.[0-7]\b|gemini-3\.1\b/.test(values.outageFallbackModel)) configError("gemini.outageFallbackModel must stay in the gemini-3.8 family (owner ruling 2026-09-16: 3.7 and 3.1 are never used)");
    for (const key of ["model", "agent", "reviewAgent"] as const) {
      const field = values[key];
      if (typeof field !== "string" || field.trim().length === 0) configError(`gemini.${key} must be a nonempty string`);
    }
    if (!Number.isInteger(values.maxRounds) || (values.maxRounds as number) < 1) {
      configError("gemini.maxRounds must be a positive integer");
    }
    if (typeof values.maxRuntimeMins !== "number" || !Number.isFinite(values.maxRuntimeMins) || values.maxRuntimeMins <= 0) {
      configError("gemini.maxRuntimeMins must be a positive number of minutes");
    }
    gemini = values as GeminiConfig;
  }

  const visibility = { ...VISIBILITY_DEFAULTS };
  if (Object.hasOwn(input, "visibility")) {
    const values = input.visibility;
    if (!values || typeof values !== "object" || Array.isArray(values)) configError("visibility must be an object");
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(visibility, key)) configError(`unknown visibility key: ${key}`);
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0
        || (key !== "heartbeatMinutes" && !Number.isSafeInteger(value))) configError(`visibility.${key} must be a positive ${key === "heartbeatMinutes" ? "number" : "integer"}`);
      visibility[key as keyof VisibilityConfig] = value as number;
    }
  }

  let expectMinutes = defaults.expectMinutes;
  if (Object.hasOwn(input, "expectMinutes")) {
    const value = input.expectMinutes;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      configError("expectMinutes must be a positive number of minutes");
    }
    expectMinutes = value;
  }

  const limits = { model_auto_compact_token_limit: 150_000, tool_output_token_limit: 6_000 };
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    if (!Object.hasOwn(input, key)) continue;
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) <= 0) configError(`${key} must be a positive integer`);
    limits[key] = Number(input[key]);
  }
  return {
    ...limits, visibility, expectMinutes,
    model, thinkerModel, ...(models ? { models } : {}), efforts: efforts as string[], defaultEffort, rules: rules as string[],
    ...(accounts ? { accounts } : {}), effortCaps, ...(worktreeSetup ? { worktreeSetup } : {}), gemini: gemini ?? defaults.gemini,
  };
}

function readConfig(skipFile = false): Config {
  const defaults: Config = {
    model: EXECUTOR_MODEL,
    thinkerModel: THINKER_MODEL,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    rules: [],
    effortCaps: DEFAULT_EFFORT_CAPS,
    expectMinutes: 15,
    gemini: geminiConfig(),
  };
  if (skipFile || !existsSync(CONFIG_PATH)) return defaults;

  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    configError(`cannot read config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(text!);
}

export function geminiConfig(): GeminiConfig {
  return {
    model: "gemini-3.8-flash-high",
    agent: "cdx-lane",
    reviewAgent: "cdx-review",
    maxRounds: 2,
    maxRuntimeMins: 90,
    outageFallbackModel: "gemini-3.8-flash-medium",
  };
}

// Pure tests import defaults without reading or writing user state. The
// CLI reads the config file except on the paths that pin what they need.
// This module is imported by the CLI, so import.meta.main would always be false.
export const config: Config = Bun.main === SELF
  ? readConfigForCommand(process.argv[2])
  : readConfig(true);

// The CLI must keep delivering events when config.json is broken, so `events`
// falls back to the defaults and says so once on stderr.
function readConfigForCommand(command: string | undefined): Config {
  const pinned = command === "_run" || command === "view" || command === "hook";
  if (command !== "events") return readConfig(pinned);
  try { return readConfig(false); }
  catch (error) {
    process.stderr.write(`cdx events: ${error instanceof Error ? error.message : String(error)}; using default visibility settings\n`);
    return readConfig(true);
  }
}

function configuredEffort(effort: string): Effort {
  if (!config.efforts.includes(effort)) {
    fail(`effort must be one of ${config.efforts.join(", ")}, set in ${CONFIG_PATH}; got "${effort}"`);
  }
  return effort;
}

export const ENGINE_PICKER = `gpt is the default engine; pass --engine gemini for mechanical sweeps.
gpt work lanes run gpt-6-sol (alias sol). Head-launched reviews, consults and
supervisors run gpt-6-astra (alias astra); a child lane never runs Astra.
For a whole change, use --engine gpt --supervisor: Astra owns the design,
delegates bounded work to Sol or Gemini children, verifies, and reports.
Children need one outcome, named files, and an acceptance gate.
--model picks a Codex model alias or id; Sol and Astra run at effort medium unless --effort high is asked for, and high is the cap.`;

export function engineOf(parsed: Parsed, command: "spawn" | "review" | "adopt"): Engine {
  const value = parsed.flags.engine;
  if (value === undefined) {
    console.log("cdx: engine gpt (default)");
    return "gpt";
  }
  if (value === "gpt" || value === "gemini") return value;
  const usage = `usage: cdx ${command} requires --engine gpt|gemini; gpt is the default (Sol for work, Astra for head-launched thinking), gemini for mechanical sweeps`;
  if (command === "spawn") fail(`${usage}\n\n${ENGINE_PICKER}`);
  fail(usage);
}

export function modelAliases(): string {
  const entries = Object.entries(config.models ?? {});
  return entries.map(([alias, id]) => `${alias}=${id}`).join(", ");
}

const DEFAULT_MODEL_ALIASES: Record<string, string> = {
  astra: THINKER_MODEL,
  sol: EXECUTOR_MODEL,
};

// --model takes an alias from config.models or a raw Codex model id. Gemini
// lanes have one model and refuse the flag.
// Without --model, work lanes run the executor. Head-launched thinking lanes
// (consult, review, supervisor) run the thinker; a child falls back to the
// executor because a child never runs Astra.
export function modelOf(parsed: Parsed, engine: Engine, role: "work" | "think" = "work", isChild = false): string | undefined {
  const value = parsed.flags.model;
  if (engine === "gemini") {
    if (value !== undefined) fail("--model applies to gpt lanes only; gemini always runs the configured gemini model");
    return undefined;
  }
  if (value === undefined) return role === "think" && !isChild ? resolveCodexModel(config.thinkerModel ?? THINKER_MODEL) : config.model;
  const resolved = config.models?.[value] ?? DEFAULT_MODEL_ALIASES[value];
  if (resolved) return resolved;
  if (!MODEL_ID.test(value)) {
    const aliases = modelAliases();
    fail(`--model must be a Codex model id${aliases ? ` or one of ${aliases}` : ""}, set in ${CONFIG_PATH}; got "${value}"`);
  }
  return value;
}

export function laneModel(lane: Pick<Lane, "model"> | undefined): string {
  return lane?.model ?? config.model;
}

export function resolveCodexModel(model?: string, cfg?: { model?: string; models?: Record<string, string> }): string {
  const activeConfig = cfg ?? config;
  const raw = model ?? activeConfig.model ?? "";
  return activeConfig.models?.[raw] ?? DEFAULT_MODEL_ALIASES[raw] ?? raw;
}

export function checkChildAstraRefusal(
  isChild: boolean,
  engine: Engine,
  model: string | undefined,
  cfg?: { model: string; models?: Record<string, string> },
): void {
  if (!isChild || engine !== "gpt") return;
  const resolved = resolveCodexModel(model, cfg);
  if (resolved === "gpt-6-astra") {
    fail("child lane cannot run gpt-6-astra; gpt-6-astra is reserved for head-launched lanes");
  }
}

export function resolveEffort(engine: Engine, model: string | undefined, explicit?: string, inherited?: string): Effort {
  if (engine === "gemini") return "high";
  return configuredEffort(cappedEffort(model, explicit ?? inherited ?? config.defaultEffort, explicit !== undefined));
}

// Caps are keyed by model id, so an alias resolves before the check. An
// explicit --effort above the cap is refused. Any other source above it (the
// config default, a lane recorded before the cap, a gemini review round that
// stored "high" on a gpt lane) clamps to the cap with a note, so nothing runs
// above its configured cap by accident, while preserving resumability.
// Every caller must send the returned effort to Codex; a session's stored
// effort is never trusted.
export function cappedEffort(model: string | undefined, effort: Effort, explicit = true, cfg?: { model?: string; models?: Record<string, string>; effortCaps?: Record<string, string>; efforts?: string[] }): Effort {
  const activeEffortCaps = cfg?.effortCaps ?? config.effortCaps;
  const activeEfforts = cfg?.efforts ?? config.efforts;
  const resolvedModel = model ? resolveCodexModel(model, cfg) : undefined;
  const cap = resolvedModel ? activeEffortCaps[resolvedModel] : undefined;
  if (!cap) return effort;
  const capIndex = EFFORT_ORDER.indexOf(cap);
  const effortIndex = EFFORT_ORDER.indexOf(effort);
  if (effortIndex >= 0 && effortIndex <= capIndex) return effort;
  if (!explicit) {
    return cap;
  }
  const allowed = EFFORT_ORDER.slice(0, capIndex + 1).filter((candidate) => activeEfforts.includes(candidate));
  const remedy = allowed.length > 0 ? `allowed: ${allowed.join(", ")}` : `no configured effort is at or below ${cap}; edit efforts in ${CONFIG_PATH}`;
  fail(`effort ${effort} exceeds the cap for ${model} (max ${cap}); ${remedy}`);
}

export function requireEngineBinary(engine: Engine): void {
  if (engine === "gemini" && !Bun.which("agy")) {
    fail("agy is not on PATH; install Google Antigravity CLI and make ~/.local/bin/agy available");
  }
}

export function rejectEngineMismatch(laneName: string, lane: Lane, requested: Engine): void {
  const recorded = laneEngine(lane);
  if (recorded !== requested) fail(`lane "${laneName}" uses engine ${recorded}; choose --engine ${recorded}`);
}

export function maxRuntimeOf(parsed: Parsed): number | undefined {
  const raw = parsed.flags["max-runtime"];
  if (raw === undefined) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) fail("--max-runtime must be a positive number of minutes");
  return minutes;
}

// A Gemini lane that hangs on its own script (a Playwright run on a remote
// client went 40 minutes silent on 2026-09-11) otherwise runs to the 12-hour
// print timeout. Codex lanes keep no default: --max-runtime stays explicit.
export function defaultMaxRuntime(engine: Engine): number | undefined {
  if (engine !== "gemini") return undefined;
  return (config.gemini ?? geminiConfig()).maxRuntimeMins;
}

export function roundCapRefusal(lane: string, cap: number): string {
  return `round cap ${cap} reached for ${lane}: close it and spawn a new lane with the failure attached`;
}

export function checkRoundCap(lane: string, engine: Engine, workRounds: number, cap = (config.gemini ?? geminiConfig()).maxRounds): void {
  if (engine === "gemini" && workRounds >= cap) fail(roundCapRefusal(lane, cap));
}
