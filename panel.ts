// cdx panel: one question to Astra, Sol and Claude Fable as read-only consult
// lanes. cdx merges the three answers by cited path, checks every file:line,
// and one Astra consult rules only on the contradictions. The caller sees one
// completion line; the answers stay on disk.
import { accountSpec, accountStandings, chooseAccount } from "./accounts.ts";
import { CLAUDE_MODEL } from "./claude.ts";
import { config, EXECUTOR_MODEL, resolveEffort, THINKER_MODEL } from "./config.ts";
import {
  activeStateOf, callerOwnership, type Engine, feedEvent, findLane, type LaneOwner, laneRunning, ownershipSpec,
  readLedger, roundNoteOf, type Spec, supervisorLane, type Tokens, validLane, withLane, withLedger,
} from "./ledger.ts";
import { controlPathOf, reportPathOf, specPathOf } from "./reports.ts";
import { openRound } from "./rounds.ts";
import { fail, fmtTokens, parseArgs, pidAlive, resolveBrief, ROOT, runnerEnv, SELF, settleHint, singleLine } from "./runtime.ts";
import { safeJSON, safeText } from "./safe-text.ts";
import { db, write } from "./store.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import { spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const PANEL_MEMBERS = [
  { member: "astra", engine: "gpt", model: THINKER_MODEL },
  { member: "sol", engine: "gpt", model: EXECUTOR_MODEL },
  { member: "fable", engine: "claude", model: CLAUDE_MODEL },
] as const satisfies ReadonlyArray<{ member: string; engine: Engine; model: string }>;

export const PANEL_INPUT_CHARS = 20_000;
export const MEMBER_RUNTIME_MINS = 15;
const VERDICT_RUNTIME_MINS = 10;
export const MIN_HEADROOM_PERCENT = 10;
// The verdict appends a blank line, its heading, a blank line and up to
// VERDICT_LINES, so the merged report stays under 60 lines.
export const REPORT_LINES = 48;
export const VERDICT_LINES = 8;
// Past its runtime cap a member's runner kills the engine and finalizes; the
// panel waits this much longer before it stops waiting.
const SETTLE_GRACE_MS = 3 * 60_000;
const POLL_MS = 5_000;

export type PanelState = "running" | "done" | "incomplete" | "failed";

export interface PanelRecord {
  name: string;
  cwd: string;
  question: string;
  pack?: string;
  // Supervisor lane and round that asked; absent when the head asked.
  caller?: string;
  callerRound?: number;
  owner: LaneOwner;
  background: boolean;
  state: PanelState;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  report?: string;
  summary?: string;
}

export const memberLane = (panel: string, member: string) => `${panel}-${member}`;
export const panelReportPath = (panel: string) => `${ROOT}/reports/${panel}.md`;
export const answerPath = (panel: string, member: string) => `${ROOT}/reports/${panel}-${member}.md`;

export function readPanel(name: string): PanelRecord | undefined {
  const row = db().query<{ data: string }, [string]>("SELECT data FROM panels WHERE name = ?").get(name);
  return row ? JSON.parse(row.data) : undefined;
}

function readPanels(): PanelRecord[] {
  return db().query<{ data: string }, []>("SELECT data FROM panels").all().map((row) => JSON.parse(row.data));
}

function storePanel(record: PanelRecord): void {
  write(() => db().query("INSERT OR REPLACE INTO panels (name, data) VALUES (?, ?)").run(record.name, safeJSON(record)));
}

// Guards

export interface PanelAdmission {
  callerIsMember: boolean;
  supervisorAskedThisRound: boolean;
  openPanel?: string;
  inputChars: number;
  // Percent left on the account an Astra consult would run on; 0 when none is eligible.
  astraHeadroom: number;
  // Percent left in the active Claude account's weekly windows; undefined when cca cannot say.
  claudeHeadroom?: number;
}

export function panelRefusal(input: PanelAdmission): string | undefined {
  if (input.callerIsMember) return "a panel member cannot start a panel";
  if (input.supervisorAskedThisRound) return "a supervisor may call panel once per round; this round already did";
  if (input.openPanel) return `panel ${input.openPanel} is still open; one open panel at a time`;
  if (input.inputChars > PANEL_INPUT_CHARS) return `question plus pack is ${input.inputChars} chars; the cap is ${PANEL_INPUT_CHARS}, trim the pack`;
  if (input.astraHeadroom < MIN_HEADROOM_PERCENT) return `Astra's account has ${Math.floor(input.astraHeadroom)}% left; a panel needs ${MIN_HEADROOM_PERCENT}%`;
  if (input.claudeHeadroom !== undefined && input.claudeHeadroom < MIN_HEADROOM_PERCENT) {
    return `the Claude weekly quota has ${Math.floor(input.claudeHeadroom)}% left; a panel needs ${MIN_HEADROOM_PERCENT}%`;
  }
  return undefined;
}

// cca status --json lists each Claude login with used percents per window;
// claude -p runs on the active one. Weekly windows are "week" and "Fable wk".
export function claudeHeadroom(status: any): number | undefined {
  const active = Array.isArray(status?.accounts) ? status.accounts.find((account: any) => account?.name === status.active) : undefined;
  const weekly = (Array.isArray(active?.limits) ? active.limits : [])
    .filter((limit: any) => /\b(week|wk)\b/i.test(String(limit?.label)) && typeof limit.percent === "number");
  if (!weekly.length) return undefined;
  return 100 - Math.max(...weekly.map((limit: any) => limit.percent));
}

function readClaudeHeadroom(): number | undefined {
  const cca = Bun.which("cca");
  const result = cca ? Bun.spawnSync({ cmd: [cca, "status", "--json"], stdout: "pipe", stderr: "pipe", timeout: 20_000 }) : undefined;
  let headroom: number | undefined;
  try { headroom = result?.success ? claudeHeadroom(JSON.parse(result.stdout.toString())) : undefined; } catch { /* reported below */ }
  if (headroom === undefined) console.error("cdx: warning: cca status --json gave no Claude weekly quota; the Claude headroom check is skipped");
  return headroom;
}

async function astraHeadroom(): Promise<number> {
  try {
    return chooseAccount(await accountStandings(), "light").pick?.remainingPercent ?? 0;
  } catch {
    return 0;
  }
}

// A running record whose runner died is not open; it failed.
function openPanelName(records: PanelRecord[], alive = pidAlive): string | undefined {
  return records.find((record) => record.state === "running" && alive(record.pid))?.name;
}

// Prompt

export function panelPrompt(question: string, cwd: string, pack?: string): string {
  return [
    "You are one member of a three-model panel (Astra, Sol, Claude Fable). Every member gets this same prompt and answers independently; cdx merges the answers by the file paths you cite.",
    `Read only: do not edit files, run tests, or start cdx lanes. The repository is ${cwd}. If you have a shell and it has .codegraph/, run \`codegraph explore -p ${cwd} "<question>"\` before grep or reading files.`,
    `Question:\n${question}`,
    pack ? `Context pack: ${pack} (read it first).` : "No context pack.",
    [
      "Answer in exactly this shape, nothing before the first heading:",
      "## Recommendation\nOne line: what to do.",
      "## Claims\nOne claim per line: `- verified | path/to/file.ts:123 | claim` or `- inferred | 42 | claim`. The middle field is the evidence: a repository-relative file:line (or file:start-end) or a number. Mark a claim verified only when you read that line or computed that number in this session; otherwise inferred. At most 12 claims.",
      "## Dissent\nWhere a reasonable expert would disagree with your recommendation, and why. One or two lines.",
      "## Confidence\nhigh, medium, or low, then one short reason.",
    ].join("\n\n"),
  ].join("\n\n");
}

// Merge

export interface Claim {
  member: string;
  mark: "verified" | "inferred";
  evidence: string;
  path?: string;
  line?: number;
  endLine?: number;
  text: string;
}

export interface MemberAnswer {
  member: string;
  recommendation?: string;
  claims: Claim[];
  dissent?: string;
  confidence?: string;
}

function sections(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) { current = []; found.set(heading[1]!.toLowerCase(), current); continue; }
    if (current && line.trim()) current.push(line.trim());
  }
  return found;
}

const CLAIM_LINE = /^[-*]\s*\[?(verified|inferred)\]?\s*\|\s*(.+?)\s*\|\s*(.+)$/i;
const FILE_LINE = /^(.+?):(\d+)(?:-(\d+))?$/;

function repoPath(raw: string, cwd: string): string {
  const path = raw.replace(/^`|`$/g, "").replace(/^\.\//, "");
  return isAbsolute(path) && (path === cwd || path.startsWith(`${cwd}/`)) ? relative(cwd, path) : path;
}

export function parseAnswer(member: string, text: string, cwd: string): MemberAnswer {
  const found = sections(text);
  const claims: Claim[] = [];
  for (const line of found.get("claims") ?? []) {
    const match = CLAIM_LINE.exec(line);
    if (!match) continue;
    const evidence = match[2]!.replace(/`/g, "").trim();
    const cited = FILE_LINE.exec(evidence);
    claims.push({
      member, mark: match[1]!.toLowerCase() as Claim["mark"], evidence, text: match[3]!.trim(),
      ...(cited ? { path: repoPath(cited[1]!, cwd), line: Number(cited[2]), ...(cited[3] ? { endLine: Number(cited[3]) } : {}) } : {}),
    });
  }
  const first = (name: string) => found.get(name)?.[0];
  return {
    member, claims,
    ...(first("recommendation") ? { recommendation: first("recommendation") } : {}),
    ...(found.get("dissent")?.length ? { dissent: found.get("dissent")!.join(" ") } : {}),
    ...(first("confidence") ? { confidence: first("confidence") } : {}),
  };
}

export interface PathGroup {
  path: string;
  claims: Record<string, Claim[]>;
  // Members that cite this path.
  agreement: number;
}

// Claims group by the file they cite. A path three members cite is common
// ground; a path one member cites is where its answer stands alone.
export function groupClaims(answers: MemberAnswer[]): PathGroup[] {
  const groups = new Map<string, PathGroup>();
  for (const claim of answers.flatMap((answer) => answer.claims)) {
    if (!claim.path) continue;
    const group = groups.get(claim.path) ?? { path: claim.path, claims: {}, agreement: 0 };
    if (!group.claims[claim.member]) group.agreement += 1;
    (group.claims[claim.member] ??= []).push(claim);
    groups.set(claim.path, group);
  }
  return [...groups.values()].sort((left, right) => right.agreement - left.agreement || left.path.localeCompare(right.path));
}

export function lineCount(cwd: string, path: string): number | undefined {
  const full = resolve(cwd, path);
  try {
    if (!statSync(full).isFile()) return undefined;
    const text = readFileSync(full, "utf8");
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return undefined;
  }
}

export function citationProblem(claim: Claim, lines: (path: string) => number | undefined): string | undefined {
  if (!claim.path || claim.line === undefined) return undefined;
  const count = lines(claim.path);
  if (count === undefined) return `${claim.member} ${claim.evidence} (no such file)`;
  const last = claim.endLine ?? claim.line;
  if (claim.line < 1 || last > count || last < claim.line) return `${claim.member} ${claim.evidence} (file has ${count} lines)`;
  return undefined;
}

export interface MemberOutcome {
  member: string;
  state: string;
  note?: string;
  tokens?: Tokens;
}

const clip = (text: string, chars: number) => {
  const flat = singleLine(text);
  return flat.length > chars ? `${flat.slice(0, chars - 3)}...` : flat;
};

export function renderPanelReport(input: {
  name: string; question: string; outcomes: MemberOutcome[]; answers: MemberAnswer[]; lines: (path: string) => number | undefined;
}): string {
  const members = PANEL_MEMBERS.map(({ member }) => member);
  const answered = new Map(input.answers.map((answer) => [answer.member, answer]));
  const groups = groupClaims(input.answers);
  const problems = input.answers.flatMap((answer) => answer.claims)
    .map((claim) => citationProblem(claim, input.lines)).filter((problem): problem is string => Boolean(problem));
  const bad = new Set(input.answers.flatMap((answer) => answer.claims).filter((claim) => citationProblem(claim, input.lines)));
  const cell = (claims: Claim[] | undefined) => claims
    ? clip(claims.map((claim) => `${claim.line ?? "?"}${claim.mark === "verified" ? "v" : "i"}${bad.has(claim) ? "!" : ""}`).join(" "), 40)
    : "-";
  const head = [
    `# Panel ${input.name}`,
    "",
    `Question: ${clip(input.question, 300)}`,
    `Coverage: ${input.answers.length}/${members.length} (${input.outcomes.map((outcome) => `${outcome.member} ${outcome.state}${outcome.note ? `: ${clip(outcome.note, 80)}` : ""}`).join("; ")})`,
    `Tokens: ${input.outcomes.map((outcome) => `${outcome.member} ${fmtTokens(outcome.tokens)}`).join("; ")}`,
    "",
    "## Recommendations",
    ...members.map((member) => {
      const answer = answered.get(member);
      if (!answer) return `- ${member}: no answer`;
      return `- ${member}${answer.confidence ? ` (${clip(answer.confidence, 40)})` : ""}: ${clip(answer.recommendation ?? "no recommendation line", 240)}`;
    }),
    "",
    "## Dissent",
    ...members.flatMap((member) => answered.get(member)?.dissent ? [`- ${member}: ${clip(answered.get(member)!.dissent!, 240)}`] : []),
    "",
    "## Claims by cited path",
    "Cells list cited lines: v verified, i inferred, ! the line does not exist.",
    `| agreed | path | ${members.join(" | ")} |`,
    `|---|---|${members.map(() => "---").join("|")}|`,
  ];
  const unpathed = members.map((member) => `${member} ${answered.get(member)?.claims.filter((claim) => !claim.path).length ?? 0}`).join(", ");
  const tail = [
    ...(problems.length ? [`Citation problems: ${clip(problems.join("; "), 400)}`] : ["Citation problems: none"]),
    `Claims citing a number, not a path: ${unpathed}`,
    "",
    `Answers: ${members.map((member) => answerPath(input.name, member)).join(" ")}`,
  ];
  const room = REPORT_LINES - head.length - tail.length - 1;
  const rows = groups.slice(0, Math.max(0, room)).map((group) =>
    `| ${group.agreement}/${members.length} | ${clip(group.path, 60)} | ${members.map((member) => cell(group.claims[member])).join(" | ")} |`);
  const more = groups.length > rows.length ? [`(${groups.length - rows.length} more paths in the answers)`] : [];
  return [...head, ...rows, ...more, ...tail].join("\n") + "\n";
}

export function completionLine(record: Pick<PanelRecord, "name">, report: string, answers: MemberAnswer[]): string {
  const coverage = answers.length === PANEL_MEMBERS.length ? `${answers.length}/${PANEL_MEMBERS.length}` : "incomplete";
  const recommendations = PANEL_MEMBERS.map(({ member }) => {
    const answer = answers.find((candidate) => candidate.member === member);
    return `${member}: ${answer ? clip(answer.recommendation ?? "no recommendation line", 120) : "no answer"}`;
  });
  return `[cdx] panel=${record.name} coverage=${coverage} report=${report} ${recommendations.join(" | ")}`;
}

// Runner

async function startLane(panel: PanelRecord, lane: string, engine: Engine, model: string, prompt: string, maxRuntimeMins: number): Promise<void> {
  const effort = engine === "claude" ? "medium" : resolveEffort(engine, model);
  const { round } = await openRound(lane, "review", panel.cwd, effort, {
    engine, consult: true, owner: panel.owner, preserveGate: true, reviewModel: model,
    ...(engine === "gpt" ? { model } : {}), lineage: { supervisor: false },
  });
  const entry = withLane(lane, (item) => { item!.panel = panel.name; return item!; });
  const spec: Spec = {
    effort, engine, model, mode: "spawn", lane, round, cwd: panel.cwd, reviewDir: panel.cwd, prompt, taskPrompt: prompt,
    // The claude member's file tools see only the checkout and these.
    ...(engine === "claude" && panel.pack ? { additionalDirectories: [dirname(panel.pack)] } : {}),
    maxRuntimeMins, accountHomes: config.accounts,
    model_auto_compact_token_limit: config.model_auto_compact_token_limit ?? 150_000,
    tool_output_token_limit: config.tool_output_token_limit ?? 6_000,
    visibility: config.visibility ?? VISIBILITY_DEFAULTS,
    ...(engine === "gpt" ? accountSpec(entry.roundAccount) : {}), ...ownershipSpec(panel.owner),
    startedAt: entry.roundStartedAt ?? new Date().toISOString(),
  };
  writeFileSync(specPathOf(lane, round), safeJSON(spec, 2));
  writeFileSync(`${ROOT}/briefs/${lane}-r${round}.md`, safeText(prompt));
  const crashLog = openSync(`${ROOT}/logs/${lane}-r${round}.runner.log`, "a");
  const child = nodeSpawn(process.execPath, [SELF, "_run", lane, String(round)], { detached: true, env: runnerEnv(spec.codexHome), stdio: ["ignore", crashLog, crashLog] });
  child.unref();
  withLane(lane, (item) => { if (item) item.pid = child.pid; });
}

async function settle(lanes: string[], deadline: number): Promise<void> {
  let stopped = false;
  for (;;) {
    const ledger = readLedger();
    const running = lanes.filter((lane) => {
      const entry = ledger[lane];
      return entry && laneRunning(entry) && (pidAlive(entry.pid) || pidAlive(entry.codexPid));
    });
    if (!running.length) return;
    if (Date.now() > deadline + (stopped ? 60_000 : 0)) {
      if (stopped) return;
      stopped = true;
      for (const lane of running) { try { process.kill(ledger[lane]!.pid!, "SIGTERM"); } catch { /* exited */ } }
    }
    await Bun.sleep(POLL_MS);
  }
}

function outcomeOf(panel: string, member: string): MemberOutcome & { report?: string } {
  const entry = findLane(memberLane(panel, member));
  if (!entry) return { member, state: "not started" };
  const state = activeStateOf(entry);
  const report = reportPathOf(memberLane(panel, member), entry.rounds);
  return {
    member, state, ...(entry.roundTokens ? { tokens: entry.roundTokens } : {}),
    ...(state !== "done" && roundNoteOf(entry) ? { note: roundNoteOf(entry) } : {}),
    ...(state === "done" && existsSync(report) ? { report } : {}),
  };
}

// Panel lanes leave the active table once the panel is done with them.
function closeLanes(lanes: string[]): void {
  withLedger((ledger) => {
    for (const lane of lanes) {
      const item = ledger[lane];
      if (!item || laneRunning(item)) continue;
      item.work.state = "closed";
      item.updatedAt = new Date().toISOString();
    }
  });
}

function verdictPrompt(record: PanelRecord, report: string, answers: MemberAnswer[]): string {
  return [
    "You reconcile a three-model panel (Astra, Sol, Claude Fable). Read only: do not edit files or start cdx lanes.",
    `Question:\n${record.question}`,
    `Merged report: ${report}`,
    `Member answers: ${answers.map((answer) => answerPath(record.name, answer.member)).join(" ")}`,
    `Repository: ${record.cwd}`,
    "Rule only on the contradictions: recommendations that differ, a claim one member makes that another contradicts, and each dissent. Read the cited file:line yourself before siding with a claim. Skip everything the members agree on.",
    `Answer in at most ${VERDICT_LINES} lines, no headings: first line \`Verdict: <one sentence>\`, then one line per contradiction: \`<topic>: <member> is right because <file:line or number>\`. If nothing contradicts, say so on the first line and stop.`,
  ].join("\n\n");
}

function deliver(record: PanelRecord, line: string): void {
  if (!record.background) return;
  if (record.caller && record.callerRound) {
    const caller = findLane(record.caller);
    if (!caller || !laneRunning(caller) || caller.rounds !== record.callerRound) return;
    write(() => appendFileSync(controlPathOf(record.caller!, record.callerRound!), `${safeJSON({ text: line, sentAt: new Date().toISOString(), from: "cdx" })}\n`));
    return;
  }
  feedEvent("panel", line, record.owner.ownerSession);
}

export async function runPanel(name: string): Promise<number> {
  const record = readPanel(name);
  if (!record) fail(`internal: no panel ${name}`);
  storePanel({ ...record, pid: process.pid });
  const prompt = panelPrompt(record.question, record.cwd, record.pack);
  const lanes = PANEL_MEMBERS.map(({ member }) => memberLane(name, member));
  for (const { member, engine, model } of PANEL_MEMBERS) {
    try {
      await startLane(record, memberLane(name, member), engine, model, prompt, MEMBER_RUNTIME_MINS);
    } catch (error) {
      console.error(`cdx: panel ${name} member ${member} did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await settle(lanes, Date.now() + MEMBER_RUNTIME_MINS * 60_000 + SETTLE_GRACE_MS);
  const outcomes = PANEL_MEMBERS.map(({ member }) => outcomeOf(name, member));
  const answers: MemberAnswer[] = [];
  for (const outcome of outcomes) {
    if (!outcome.report) continue;
    copyFileSync(outcome.report, answerPath(name, outcome.member));
    answers.push(parseAnswer(outcome.member, readFileSync(outcome.report, "utf8"), record.cwd));
  }
  const report = panelReportPath(name);
  writeFileSync(report, safeText(renderPanelReport({ name, question: record.question, outcomes, answers, lines: (path) => lineCount(record.cwd, path) })));
  const verdictLane = memberLane(name, "verdict");
  if (answers.length >= 2) {
    try {
      await startLane(record, verdictLane, "gpt", THINKER_MODEL, verdictPrompt(record, report, answers), VERDICT_RUNTIME_MINS);
      await settle([verdictLane], Date.now() + VERDICT_RUNTIME_MINS * 60_000 + SETTLE_GRACE_MS);
    } catch (error) {
      console.error(`cdx: panel ${name} verdict did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    const verdict = outcomeOf(name, "verdict");
    const lines = verdict.report ? readFileSync(verdict.report, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, VERDICT_LINES) : [];
    appendFileSync(report, safeText(`\n## Verdict\n\n${lines.length ? lines.join("\n") : `unavailable: ${verdict.state}${verdict.note ? `, ${clip(verdict.note, 160)}` : ""}`}\n`));
  }
  closeLanes([...lanes, verdictLane]);
  const line = completionLine(record, report, answers);
  const state: PanelState = answers.length === PANEL_MEMBERS.length ? "done" : answers.length ? "incomplete" : "failed";
  storePanel({ ...record, pid: undefined, state, report, summary: line, finishedAt: new Date().toISOString() });
  deliver(record, line);
  console.log(line);
  return state === "failed" ? 1 : 0;
}

// Command

const USAGE = 'usage: cdx panel <name> --cd <repo> [--pack <file>] [--bg] ("<question>" | -)';

export async function panelCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["cd", "pack", "bg"]);
  const [name, questionArg] = parsed.rest;
  const question = await resolveBrief(questionArg, USAGE);
  if (!name || !question || !parsed.flags.cd) fail(USAGE);
  validLane(name);
  if (!existsSync(parsed.flags.cd)) fail(`cwd does not exist: ${parsed.flags.cd}`);
  const cwd = realpathSync(parsed.flags.cd);
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) fail("panel needs macOS sandbox-exec for the Claude member");
  if (parsed.flags.pack !== undefined && !existsSync(parsed.flags.pack)) fail(`--pack does not exist: ${parsed.flags.pack}`);
  const packText = parsed.flags.pack !== undefined ? readFileSync(parsed.flags.pack, "utf8") : "";
  const lanes = [...PANEL_MEMBERS.map(({ member }) => member), "verdict"].map((member) => memberLane(name, member));
  if (readPanel(name) || lanes.some((lane) => findLane(validLane(lane)))) fail(`panel name "${name}" is taken; pick a fresh one`);
  const self = process.env.CDX_LANE ? findLane(process.env.CDX_LANE) : undefined;
  const supervisor = supervisorLane();
  const callerRound = supervisor ? Number(process.env.CDX_ROUND) : undefined;
  const refusal = panelRefusal({
    callerIsMember: Boolean(self?.panel),
    supervisorAskedThisRound: Boolean(supervisor && readPanels().some((record) => record.caller === supervisor && record.callerRound === callerRound)),
    openPanel: openPanelName(readPanels()),
    inputChars: question.length + packText.length,
    astraHeadroom: await astraHeadroom(),
    claudeHeadroom: readClaudeHeadroom(),
  });
  if (refusal) fail(refusal);
  // The pack is frozen beside the briefs so every member reads the same text.
  const pack = parsed.flags.pack !== undefined ? `${ROOT}/briefs/${name}-pack.md` : undefined;
  if (pack) writeFileSync(pack, packText);
  const background = parsed.bools.has("bg");
  write(() => {
    const open = openPanelName(readPanels());
    if (open) fail(`panel ${open} is still open; one open panel at a time`);
    storePanel({
      name, cwd, question, ...(pack ? { pack } : {}), ...(supervisor ? { caller: supervisor, callerRound } : {}),
      owner: callerOwnership(), background, state: "running", startedAt: new Date().toISOString(),
    });
  });
  // The runner drops the caller's lane identity: members are panel lanes,
  // not a supervisor's children, so the Astra member is not refused.
  const runnerLog = openSync(`${ROOT}/logs/${name}.panel.log`, "a");
  const child = nodeSpawn(process.execPath, [SELF, "_panel", name], { detached: background, env: runnerEnv(undefined), stdio: ["ignore", runnerLog, runnerLog] });
  storePanel({ ...readPanel(name)!, pid: child.pid });
  console.log(`cdx: panel=${name} members=${PANEL_MEMBERS.map(({ member }) => member).join(",")} cwd=${cwd} log=${ROOT}/logs/${name}.panel.log`);
  if (background) {
    child.unref();
    console.log(`cdx: detached pid=${child.pid}; ${settleHint(`panel ${name}`)}`);
    return;
  }
  await new Promise<void>((done) => child.on("exit", () => done()));
  const finished = readPanel(name);
  if (finished?.summary) console.log(finished.summary);
  else fail(`panel ${name} runner exited without a result; see ${ROOT}/logs/${name}.panel.log`);
  if (finished.state === "failed") process.exitCode = 1;
}
