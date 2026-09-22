import { isDeepStrictEqual } from "node:util";
// Engine installation, account configuration checks, and diagnostic probes.

import { installLaneHome, laneCodexHome, retiredLaneRule } from "./account-sync.ts";
import {
  accountChoices, adviceLines, cachedAccountStandings, configuredAccountSnapshots, defaultCodexHome,
  exhausting, formatAccountUsage, primaryAccount, refreshUsageSnapshot, resetCreditAlerts, shouldRedeemCredit,
  standingOf, type AccountStanding,
} from "./accounts.ts";
import { config, geminiConfig, resolveCodexModel, resolveEffort, THINKER_MODEL } from "./config.ts";
import { type AppTurn, geminiCapacityNotice, inputText } from "./engines.ts";
import { formatGeminiStanding, geminiQuotaState, readGeminiUsageSnapshot, refreshGeminiUsage } from "./gemini-usage.ts";
import { type AccountChoice, callerSession, laneRunning, readLedger, readSessions, withLedger } from "./ledger.ts";
import { readJsonLines } from "./reports.ts";
import { failActiveRound } from "./round-state.ts";
import {
  color, CONFIG_PATH, displayPath, HOME, LEDGER, parseArgs, pidAlive, REPO_ROOT, ROOT, SELF, singleLine,
  uncoloredChildEnv, VERSION,
} from "./runtime.ts";
import { readUsageHistory } from "./usage-store.ts";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync,
  writeFileSync, renameSync,
} from "node:fs";
import { join } from "node:path";

async function probeAppServer(account?: AccountChoice): Promise<{ reply: string; usage: string }> {
  const proc = Bun.spawn({
    cmd: ["codex", "app-server", "--listen", "stdio://"],
    cwd: "/tmp",
    ...(account ? { env: uncoloredChildEnv(account.home) } : {}),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let reply = "";
  let usage = "? in / ? out";
  let turnResolve: ((turn: AppTurn) => void) | undefined;
  let turnReject: ((error: Error) => void) | undefined;
  const write = (message: Record<string, unknown>) => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      write({ id, method, params });
    });
  };
  const reader = (async () => {
    try {
      for await (const event of readJsonLines(proc.stdout)) {
        if (typeof event.id === "number" && pending.has(event.id)) {
          const waiter = pending.get(event.id)!;
          pending.delete(event.id);
          if (event.error) waiter.reject(new Error(event.error.message ?? "app-server probe request failed"));
          else waiter.resolve(event.result);
        } else if (event.method === "item/completed" && event.params?.item?.type === "agentMessage") {
          reply = event.params.item.text ?? reply;
        } else if (event.method === "thread/tokenUsage/updated" && event.params?.tokenUsage?.last) {
          const last = event.params.tokenUsage.last;
          usage = `${last.inputTokens ?? "?"} in / ${last.outputTokens ?? "?"} out`;
        } else if (event.method === "turn/completed") {
          const resolve = turnResolve;
          turnResolve = undefined;
          turnReject = undefined;
          resolve?.(event.params.turn as AppTurn);
        }
      }
    } finally {
      const suffix = proc.exitCode === null ? "stdout stream ended" : `child exited ${proc.exitCode}`;
      const closed = new Error(`app-server closed before turn/completed: ${suffix}`);
      for (const waiter of pending.values()) waiter.reject(closed);
      pending.clear();
      const reject = turnReject;
      turnResolve = undefined;
      turnReject = undefined;
      reject?.(closed);
    }
  })();
  const stderr = new Response(proc.stderr).text();
  const killer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 180_000);
  try {
    await request("initialize", {
      clientInfo: { name: "cdx", title: "cdx doctor", version: VERSION },
      capabilities: { experimentalApi: true },
    });
    write({ method: "initialized" });
    const started = await request("thread/start", {
      model: config.model,
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread id");
    const completion = new Promise<AppTurn>((resolve, reject) => { turnResolve = resolve; turnReject = reject; });
    await request("turn/start", {
      threadId,
      input: [inputText("Reply with the single word OK and nothing else.")],
      cwd: "/tmp",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: config.model,
      effort: resolveEffort("gpt", config.model),
    });
    const turn = await completion;
    if (turn.status !== "completed") throw new Error(`turn ended with status ${turn.status}${turn.error?.message ? `: ${turn.error.message}` : ""}`);
    await request("thread/unsubscribe", { threadId });
    proc.stdin.end();
    await Promise.race([proc.exited, Bun.sleep(3000).then(() => { try { proc.kill(); } catch { /* already gone */ } })]);
    await Promise.all([reader, stderr]);
    if (!reply.trim()) throw new Error("turn completed without an agent message");
    return { reply, usage };
  } catch (error) {
    try { proc.stdin.end(); } catch { /* already closed */ }
    try { proc.kill(); } catch { /* already closed */ }
    await Promise.allSettled([reader, stderr, proc.exited]);
    throw error;
  } finally {
    clearTimeout(killer);
  }
}

async function probeGemini(): Promise<string> {
  const agy = Bun.which("agy");
  if (!agy) throw new Error("agy is not on PATH");
  const proc = Bun.spawn([
    agy, "--print=Reply with the single word OK and nothing else.",
    "--model", (config.gemini ?? geminiConfig()).model,
    "--output-format", "json", "--dangerously-skip-permissions",
    "--print-timeout", "2m", "--add-dir", "/tmp",
  ], { cwd: "/tmp", env: uncoloredChildEnv(), stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }, 150_000);
  try {
    const [exitCode, text, err] = await Promise.all([proc.exited, stdout, stderr]);
    if (exitCode !== 0) throw new Error(err.trim() || `agy exited ${exitCode}`);
    let value: any;
    try { value = JSON.parse(text); } catch { throw new Error(`agy returned invalid JSON: ${singleLine(text).slice(0, 160)}`); }
    const reply = value.response ?? value.result?.response ?? value.result ?? value.output;
    if (typeof reply !== "string" || !reply.trim()) throw new Error("agy JSON contained no response");
    return reply.trim();
  } finally {
    clearTimeout(killer);
  }
}

function agentLinkState(name: string, sourceName: "cdx-lane" | "cdx-review"): { source: string; target: string; current: boolean; detail: string } {
  const source = `${REPO_ROOT}/agents/${sourceName}/agent.md`;
  const target = `${HOME}/.gemini/config/agents/${name}/agent.md`;
  if (!existsSync(source)) return { source, target, current: false, detail: `source missing: ${source}` };
  try {
    if (!lstatSync(target).isSymbolicLink()) return { source, target, current: readFileSync(source, "utf8") === readFileSync(target, "utf8"), detail: target };
    return { source, target, current: false, detail: `replace agent symlink with a file: ${target}` };
  } catch {
    return { source, target, current: false, detail: `missing: ${target}` };
  }
}

function installAgentLink(name: string, sourceName: "cdx-lane" | "cdx-review"): void {
  const state = agentLinkState(name, sourceName);
  if (!existsSync(state.source)) return;
  mkdirSync(join(state.target, ".."), { recursive: true });
  writeFileSync(`${state.target}.tmp.${process.pid}`, readFileSync(state.source, "utf8"));
  renameSync(`${state.target}.tmp.${process.pid}`, state.target);
}

// agy drops an agent whose frontmatter it rejects without an error (1.2.8
// refused commandExecutionPolicy "unrestricted"), so launch asks agy itself.
export function agentDiscovered(output: string, name: string): boolean {
  try {
    const agents = JSON.parse(output.slice(output.indexOf("{")))?.command?.data?.agents;
    return Array.isArray(agents) && agents.includes(name);
  } catch {
    return false;
  }
}

export function requireGeminiAgent(name: string, cwd: string): void {
  if (hookInstallState().state !== "current") throw new Error("Gemini lane hooks are missing or stale; run cdx doctor --fix");
  const result = Bun.spawnSync({ cmd: ["agy", "--output-format", "json", "agents"], cwd, env: uncoloredChildEnv(), stdin: "ignore", timeout: 10_000 });
  if (!result.success || !agentDiscovered(result.stdout.toString(), name)) {
    throw new Error(`agy agents did not discover ${name} in ${cwd}; run cdx doctor --fix`);
  }
}

function agyConfigHome(): string {
  return `${HOME}/.gemini/config`;
}

function hooksJsonPath(): string {
  return join(agyConfigHome(), "hooks.json");
}

export function desiredHookEntry(cmd = `${process.execPath} ${realpathSync(SELF)}`): Record<string, unknown> {
  return {
    enabled: true,
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: `${cmd} hook pre-tool`,
            timeout: 10,
          },
        ],
      },
    ],
    PostInvocation: [{ type: "command", command: `${cmd} hook post-invocation`, timeout: 10 }],
    PreInvocation: [
      {
        type: "command",
        command: `${cmd} hook pre-invocation`,
        timeout: 10,
      },
    ],
  };
}

export function hooksCurrent(entry: unknown, cmd = `${process.execPath} ${realpathSync(SELF)}`): boolean {
  return isDeepStrictEqual(entry, desiredHookEntry(cmd));
}

export function hookInstallState(): { path: string; state: "missing" | "stale" | "corrupt" | "current"; detail: string } {
  const path = hooksJsonPath();
  if (!existsSync(path)) return { path, state: "missing", detail: `missing: ${path}` };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, state: "corrupt", detail: `corrupt JSON at ${path}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { path, state: "corrupt", detail: `corrupt config at ${path}` };
  }
  const cdxEntry = parsed.cdx;
  if (!cdxEntry || typeof cdxEntry !== "object") {
    return { path, state: "missing", detail: `entry "cdx" missing in ${path}` };
  }
  const current = hooksCurrent(cdxEntry);

  return current
    ? { path, state: "current", detail: path }
    : { path, state: "stale", detail: `stale hook commands in ${path}` };
}

function installHooks(): boolean {
  const path = hooksJsonPath();
  mkdirSync(join(path, ".."), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    existing = parsed as Record<string, unknown>;
  }
  existing.cdx = desiredHookEntry();
  writeFileSync(`${path}.tmp.${process.pid}`, `${JSON.stringify(existing, null, 2)}\n`);
  renameSync(`${path}.tmp.${process.pid}`, path);
  return true;
}

function parseAgyModels(stdout: string): string[] | undefined {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    const models = parsed?.command?.data?.models;
    if (Array.isArray(models)) {
      return models.map((m: any) => typeof m?.id === "string" ? m.id : "").filter(Boolean);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function checkDoctorGeminiModel(
  good: (message: string) => void,
  warn: (message: string) => void,
  bad: (label: string, detail: string, remedy: string) => void,
): Promise<void> {
  const agy = Bun.which("agy");
  if (!agy) return;
  const configuredModel = (config.gemini ?? geminiConfig()).model;
  const proc = Bun.spawn([agy, "--output-format", "json", "models"], {
    env: uncoloredChildEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch { /* exited */ }
  }, 10_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, stdout]);
    await stderr;
    if (timedOut || proc.signalCode === "SIGKILL") {
      warn("agy models: probe timed out after 10s");
      return;
    }
    if (exitCode !== 0) {
      warn(`agy models: probe exited ${exitCode}`);
      return;
    }
    const slugs = parseAgyModels(text);
    if (!slugs) {
      warn("agy models: probe returned invalid JSON");
      return;
    }
    if (slugs.includes(configuredModel)) {
      good(`agy model: ${configuredModel} available`);
    } else {
      bad("agy model", `configured model "${configuredModel}" not found in agy models`, `check \`agy models\` or update gemini.model in ${CONFIG_PATH}`);
    }
  } catch (error) {
    warn(`agy models: probe failed (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    clearTimeout(timer);
  }
}

function parseAgyHooksLoaded(stdout: string): boolean {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return false;
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    const hooks = parsed?.command?.data?.hooks;
    if (Array.isArray(hooks)) {
      for (const hook of hooks) {
        if (hook?.name === "cdx") return true;
        if (Array.isArray(hook?.actions)) {
          for (const action of hook.actions) {
            if (typeof action?.command === "string" && action.command.includes("hook pre-invocation")) {
              return true;
            }
          }
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function checkDoctorAgyHooks(
  good: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  const agy = Bun.which("agy");
  if (!agy) {
    warn("agy hooks: CLI not found");
    return;
  }
  const proc = Bun.spawn([agy, "--print=/hooks", "--output-format", "json", "--add-dir", "/tmp"], {
    env: uncoloredChildEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch { /* exited */ }
  }, 15_000);
  try {
    const [exitCode, text] = await Promise.all([proc.exited, stdout]);
    await stderr;
    if (timedOut || proc.signalCode === "SIGKILL") {
      warn("agy hooks: probe timed out after 15s");
      return;
    }
    if (exitCode !== 0) {
      warn(`agy hooks: probe exited ${exitCode}`);
      return;
    }
    if (parseAgyHooksLoaded(text)) {
      good("agy hooks: loaded in agy");
    } else {
      warn("agy hooks: cdx hook not loaded in agy");
    }
  } catch (error) {
    warn(`agy hooks: probe failed (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    clearTimeout(timer);
  }
}

// Account homes share directives and tools, not credentials. Report config
// differences without printing values that might contain server credentials.


// Codex refreshes models_cache.json from the server catalog; a model id that
// is not there fails every round that names it, so doctor checks the
// executor, the thinker and every alias before a lane pays for the refusal.
export function missingCodexModels(cacheText: string, wanted: readonly string[]): string[] {
  const parsed = JSON.parse(cacheText) as { models?: Array<{ slug?: string }> } | Array<{ slug?: string }>;
  const models = Array.isArray(parsed) ? parsed : parsed.models ?? [];
  const known = new Set(models.map((model) => model.slug));
  return [...new Set(wanted)].filter((id) => !known.has(id));
}

function checkCodexCatalog(home: string, good: (message: string) => void, bad: (label: string, detail: string, remedy: string) => void): void {
  const cachePath = `${home}/models_cache.json`;
  const wanted = [config.model, config.thinkerModel ?? THINKER_MODEL, ...Object.values(config.models ?? {})].map((id) => resolveCodexModel(id));
  const remedy = "run `codex update`, then `codex debug models` to refresh the catalog";
  if (!existsSync(cachePath)) return bad("codex models", `${cachePath} missing`, remedy);
  let missing: string[];
  try {
    missing = missingCodexModels(readFileSync(cachePath, "utf8"), wanted);
  } catch (error) {
    return bad("codex models", `${cachePath} unreadable: ${error instanceof Error ? error.message : String(error)}`, remedy);
  }
  if (missing.length > 0) return bad("codex models", `not in the Codex catalog: ${missing.join(", ")}`, remedy);
  good(`codex models: ${[...new Set(wanted)].join(", ")} in the catalog`);
}

type UsageVerdict = "ok" | "caution" | "blocked";

export function usageVerdict(standing: AccountStanding, usedPercent: number): UsageVerdict {
  if (standing.reached || usedPercent >= 95) return "blocked";
  if (exhausting(standing) || usedPercent >= 75) return "caution";
  return "ok";
}

export async function doctorCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["fix", "probe"]);
  let failures = 0;
  const good = (message: string) => console.log(color.green(message));
  const warn = (message: string) => console.log(color.yellow(message));
  const bad = (label: string, detail: string, remedy: string) => {
    failures += 1;
    console.log(color.red(`FAIL ${label}: ${detail}`));
    console.log(color.yellow(`     remedy: ${remedy}`));
  };

  const codexPath = Bun.which("codex");
  const doctorAccount = primaryAccount();
  const version = codexPath ? Bun.spawnSync({
    cmd: [codexPath, "--version"],
    ...(doctorAccount ? { env: uncoloredChildEnv(doctorAccount.home) } : {}),
  }) : undefined;
  if (version?.success) good(`codex: ${version.stdout.toString().trim()} (${codexPath})`);
  else bad("codex", "CLI not found or not runnable", "reinstall the Codex CLI (`npm i -g @openai/codex` or your install method), then log in with `codex login`");

  const agyPath = Bun.which("agy");
  const agyVersion = agyPath ? Bun.spawnSync({ cmd: [agyPath, "--version"], env: uncoloredChildEnv() }) : undefined;
  if (agyVersion?.success) good(`agy: ${agyVersion.stdout.toString().trim()} (${agyPath})`);
  else if (config.gemini) bad("agy", "CLI not found or not runnable", "install Google Antigravity CLI and make ~/.local/bin/agy available");
  else warn("agy: CLI not found; Gemini lanes are unavailable until it is installed");

  if (agyVersion?.success) {
    const geminiUsage = await refreshGeminiUsage();
    if (geminiUsage) {
      good(`agy usage: ${formatGeminiStanding(geminiUsage).detail}`);
    } else warn("agy usage: unavailable");

    const quotaState = geminiQuotaState();
    const snapshot = geminiUsage ?? readGeminiUsageSnapshot();
    if (quotaState.block) {
      warn(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
    } else if (quotaState.warnPercent !== undefined && quotaState.resetsAt) {
      warn(`gemini quota: five-hour window at ${quotaState.warnPercent}%, resets at ${quotaState.resetsAt}; fan out with care`);
    } else if (snapshot && snapshot.fiveHour.remainingPercent >= 15) {
      good("gemini quota: clear");
    }

    await checkDoctorGeminiModel(good, warn, bad);
    const capacity = geminiCapacityNotice();
    (capacity.peak ? warn : good)(capacity.text);
    const fallback = (config.gemini ?? geminiConfig()).outageFallbackModel;
    good(`gemini outage fallback: ${fallback ? `${fallback} for one round after the 503 ladder` : "off"}`);
  } else {
    warn("agy usage: unavailable");
    const quotaState = geminiQuotaState();
    if (quotaState.block) {
      warn(`gemini quota: exhausted until ${quotaState.block.resetsAt} (in ${quotaState.block.minutesRemaining}m)`);
    }
  }

  const geminiPolicy = config.gemini ?? geminiConfig();
  for (const [name, sourceName] of [[geminiPolicy.agent, "cdx-lane"], [geminiPolicy.reviewAgent, "cdx-review"]] as const) {
    let state = agentLinkState(name, sourceName);
    let installed = false;
    if (!state.current && parsed.bools.has("fix")) {
      installAgentLink(name, sourceName);
      state = agentLinkState(name, sourceName);
      if (state.current) { good(`agy agent ${name}: installed ${state.target}`); installed = true; }
    }
    if (state.current) {
      if (!installed) good(`agy agent ${name}: current (${state.target})`);
    } else if (config.gemini) {
      bad(`agy agent ${name}`, state.detail, `run \`cdx doctor --fix\` to install ${sourceName}`);
    } else {
      warn(`agy agent ${name}: ${state.detail}; run cdx doctor --fix to install`);
    }
  }

  let hookState = hookInstallState();
  let hookInstalled = false;
  if (hookState.state === "corrupt") {
    bad("agy hooks", hookState.detail, `fix or move ${hookState.path} by hand`);
  } else {
    if (hookState.state !== "current" && parsed.bools.has("fix")) {
      installHooks();
      hookState = hookInstallState();
      if (hookState.state === "current") { good(`agy hooks: installed ${hookState.path}`); hookInstalled = true; }
    }
    if (hookState.state === "current") {
      if (!hookInstalled) good(`agy hooks: current (${hookState.path})`);
      await checkDoctorAgyHooks(good, warn);
    } else if (config.gemini) {
      bad("agy hooks", hookState.detail, "run `cdx doctor --fix` to install hooks");
    } else {
      warn(`agy hooks: ${hookState.detail}; run cdx doctor --fix to install`);
    }
  }

  const laneInstructions = readFileSync(`${REPO_ROOT}/agents/codex-lane.md`, "utf8");
  for (const [name, home] of Object.entries(config.accounts ?? { default: defaultCodexHome() })) {
    try {
      if (parsed.bools.has("fix")) installLaneHome(home, laneInstructions);
      if (readFileSync(`${laneCodexHome(home)}/AGENTS.md`, "utf8") !== laneInstructions) throw new Error("stale lane instructions");
      good(`${name}: lane home ${laneCodexHome(home)}`);
    } catch (error) { bad(name, String(error), "run cdx doctor --fix"); }
  }
  if (parsed.bools.has("fix")) {
    const stored = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : {};
    stored.rules = (stored.rules ?? []).filter((rule: string) => !retiredLaneRule(rule));
    stored.model_auto_compact_token_limit ??= 150_000;
    stored.tool_output_token_limit ??= 6_000;
    writeFileSync(`${CONFIG_PATH}.tmp.${process.pid}`, JSON.stringify(stored, null, 2) + "\n");
    renameSync(`${CONFIG_PATH}.tmp.${process.pid}`, CONFIG_PATH);
  }
  if (agyVersion?.success) for (const agent of [geminiPolicy.agent, geminiPolicy.reviewAgent]) {
    try { requireGeminiAgent(agent, process.cwd()); good(`agy agents: ${agent} discovered`); }
    catch (error) { bad(`agy agent ${agent}`, String(error), "run cdx doctor --fix"); }
  }

  // Quota is a warning while any account can take work; doctor fails only
  // when no account can (projected exhaustion used to fail every run).
  const reportUsage = (indent: string, verdict: UsageVerdict, detail: string, standing: AccountStanding) => {
    if (verdict === "ok") return good(`${indent}usage: ${detail}`);
    if (verdict === "caution") return warn(`${indent}usage: ${detail}; caution: 25% or less remains or exhaustion is projected before reset`);
    console.log(color.red(`${indent}usage: ${detail}`));
    console.log(color.yellow(`${indent}     remedy: ${shouldRedeemCredit(standing) ? "redeem a reset credit in the codex TUI /usage or wait for reset" : "wait for reset or use another account"}`));
  };
  let blocked = 0;
  let loggedIn = false;
  if (config.accounts) {
    const entries = Object.entries(config.accounts);
    for (const [index, [name, home]] of entries.entries()) {
      const account = { name, home };
      console.log(color.cyan(`account ${name} (${home.replace(HOME, "~")}):`));
      if (!version?.success) {
        warn("  auth: unavailable");
        warn("  usage: unavailable");
        continue;
      }
      const login = Bun.spawnSync({ cmd: ["codex", "login", "status"], env: uncoloredChildEnv(home) });
      if (index === 0) loggedIn = login.success;
      if (login.success) good("  auth: logged in");
      else {
        bad(`${name} auth`, "not logged in", `run \`CODEX_HOME=${home} codex login\`, then re-run \`cdx doctor\``);
        warn("  usage: unavailable");
        continue;
      }
      const refreshed = await refreshUsageSnapshot({ account });
      if (!refreshed) {
        warn("  usage: unavailable");
        continue;
      }
      const formatted = formatAccountUsage(refreshed.usage);
      const standing = standingOf(account, refreshed.snapshot, readUsageHistory());
      const verdict = usageVerdict(standing, formatted.usedPercent);
      if (verdict === "blocked") blocked += 1;
      reportUsage("  ", verdict, formatted.detail, standing);
    }
    if (blocked === entries.length) bad("accounts", "no Codex account has usable quota", "redeem a reset credit in the codex TUI /usage or wait for a reset");
    for (const line of adviceLines(cachedAccountStandings())) console.log(color.cyan(line));
    for (const line of resetCreditAlerts(configuredAccountSnapshots())) console.log(color.red(line));
  } else if (version?.success) {
    const login = Bun.spawnSync({ cmd: ["codex", "login", "status"] });
    loggedIn = login.success;
    if (loggedIn) good("auth: logged in");
    else bad("auth", "not logged in", "run `codex login` in a terminal (opens a browser), then re-run `cdx doctor`");
  }

  if (!config.accounts) {
    const refreshed = version?.success && loggedIn ? await refreshUsageSnapshot() : undefined;
    if (!refreshed) {
      warn("usage: unavailable");
    } else {
      const formatted = formatAccountUsage(refreshed.usage);
      const standing = standingOf(accountChoices()[0], refreshed.snapshot, readUsageHistory());
      const verdict = usageVerdict(standing, formatted.usedPercent);
      if (verdict === "blocked") failures += 1;
      reportUsage("", verdict, formatted.detail, standing);
      for (const line of resetCreditAlerts([{ name: "codex", snapshot: refreshed.snapshot }])) console.log(color.red(line));
    }
  }

  const primaryHome = primaryAccount()?.home ?? defaultCodexHome();
  const configPath = `${primaryHome}/config.toml`;
  if (existsSync(configPath)) {
    const configModel = readFileSync(configPath, "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    if (configModel === config.model) good(`config: model ${configModel}`);
    else warn(`config: warning: Codex CLI default model is ${configModel ?? "unset"}, but cdx uses ${config.model} from ${CONFIG_PATH}`);
  } else {
    warn(`config: warning: ${configPath} missing; cdx uses model ${config.model} and effort ${config.defaultEffort} from cdx policy`);
  }
  checkCodexCatalog(primaryHome, good, bad);

  if (!Bun.which("cdx")) bad("path", "cdx not on PATH", `ln -s ${SELF} ~/.local/bin/cdx`);

  const pluginLink = `${HOME}/.claude/skills/cdx`;
  const thisRepo = realpathSync(REPO_ROOT);
  let resolvedPlugin: string | undefined;
  try {
    resolvedPlugin = realpathSync(pluginLink);
  } catch { /* link missing or unresolvable */ }
  if (resolvedPlugin && resolvedPlugin === thisRepo) {
    good(`plugin: personal link ${displayPath(pluginLink)} -> ${displayPath(thisRepo)}`);
  } else {
    bad("plugin", `${displayPath(pluginLink)} does not resolve to this repository (${displayPath(thisRepo)})`, `ln -sfn "${thisRepo}" "${pluginLink}"`);
  }

  const hooksFile = `${REPO_ROOT}/hooks/hooks.json`;
  try {
    const hookConfig = JSON.parse(readFileSync(hooksFile, "utf8"));
    const modules = hookConfig.modules;
    const hasModules = Array.isArray(modules) && modules.length === 1 && modules[0] === "./register.ts";
    const hasClassic = Boolean(hookConfig.hooks && Object.keys(hookConfig.hooks).length > 0);
    if (hasModules && !hasClassic) {
      good('plugin: hooks/hooks.json names modules: ["./register.ts"]');
    } else {
      bad("plugin", 'hooks/hooks.json must declare modules: ["./register.ts"] and no classic hooks', "update hooks/hooks.json to use function hooks");
    }
  } catch (error) {
    bad("plugin", `hooks/hooks.json unreadable: ${error instanceof Error ? error.message : String(error)}`, "restore hooks/hooks.json");
  }

  const currentSession = callerSession();
  const sessionRecord = currentSession && currentSession !== "terminal" ? readSessions().sessions[currentSession] : undefined;
  if (sessionRecord?.polledAt) {
    const pollAgeSec = Math.max(0, Math.round((Date.now() - Date.parse(sessionRecord.polledAt)) / 1000));
    if (pollAgeSec <= 15) {
      good(`plugin: mod live, last poll ${pollAgeSec}s ago`);
    } else {
      warn("plugin: mod not polling; set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in ~/.claude/settings.json env and /reload-plugins");
    }
  } else {
    warn("plugin: mod not polling; set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in ~/.claude/settings.json env and /reload-plugins");
  }

  let envHasFlag = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === "1";
  if (!envHasFlag) {
    const settingsPath = `${HOME}/.claude/settings.json`;
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
        if (settings?.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === "1" || settings?.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === 1) {
          envHasFlag = true;
        }
      } catch { /* ignore */ }
    }
  }
  if (!envHasFlag) {
    warn("plugin: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 is not set in environment or ~/.claude/settings.json env");
  }

  if (parsed.bools.has("fix")) withLedger(() => {});
  good(`ledger: ${LEDGER} (${Object.keys(readLedger()).length} lanes)`);
  if (existsSync(`${ROOT}/.lock`)) warn("warning: ledger lock present (breaks automatically after 30s if stale)");
  const stale = Object.entries(readLedger()).filter(([, entry]) => laneRunning(entry) && !pidAlive(entry.pid));
  for (const [lane, entry] of stale) {
    const orphan = pidAlive(entry.codexPid) ? ` and its codex child (pid ${entry.codexPid}) is STILL RUNNING` : "";
    console.log(color.red(`stale: lane "${lane}" has a running ${entry.kind} round but its runner is dead${orphan}`));
  }
  if (stale.length > 0 && parsed.bools.has("fix")) {
    for (const [lane, entry] of stale) {
      if (pidAlive(entry.codexPid)) {
        try { process.kill(entry.codexPid!, "SIGTERM"); good(`fixed: sent SIGTERM to orphaned codex pid ${entry.codexPid} (lane "${lane}")`); } catch { /* raced */ }
        for (let waited = 0; waited < 3000 && pidAlive(entry.codexPid); waited += 100) Bun.sleepSync(100);
      }
    }
    withLedger((ledger) => {
      for (const [lane] of stale) {
        const item = ledger[lane]!;
        if (!pidAlive(item.codexPid)) failActiveRound(lane, item, "runner died without finalizing; repaired by cdx doctor --fix");
      }
    });
    good("fixed: reconciled stale runners; holds remain until live engine children exit");
  } else if (stale.length > 0) {
    warn("run `cdx doctor --fix` to mark them failed (kills orphaned codex children)");
  }

  if (parsed.bools.has("probe")) {
    if (!version?.success || !loggedIn) {
      warn("probe: skipped, fix the failures above first");
    } else {
      console.log(color.cyan("probe: live app-server round-trip, may take about 30s..."));
      const started = Date.now();
      try {
        const result = await probeAppServer(doctorAccount);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        good(`probe: OK in ${secs}s (reply "${result.reply.trim()}", ${result.usage}, thread unsubscribed)`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const remedy = /auth|login|401|unauthorized/i.test(detail) ? "run `codex login`"
          : /model/i.test(detail) ? `model ${config.model} rejected; check \`codex features\` and account access`
          : "check the 0.154.0 app-server schema, network, and `codex login status`";
        bad("probe", detail.slice(0, 240), remedy);
      }
    }
    if (!agyVersion?.success) {
      warn("gemini probe: skipped, agy is unavailable");
    } else {
      console.log(color.cyan("gemini probe: live one-word round-trip..."));
      const started = Date.now();
      try {
        const reply = await probeGemini();
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        if (reply !== "OK") throw new Error(`expected OK, got ${JSON.stringify(reply)}`);
        good(`gemini probe: OK in ${secs}s (reply "${reply}")`);
      } catch (error) {
        bad("gemini probe", error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240), "run `agy` once to finish sign-in, then re-run `cdx doctor --probe`");
      }
    }
  }

  if (failures > 0) process.exitCode = 1;
}
