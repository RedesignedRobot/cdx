import { isNoOpGate } from "./brief-contract.ts";
import { GATE_TIMEOUT_EXIT } from "./gate-group.ts";
import { safeText } from "./safe-text.ts";
// Gate execution, content receipts, review tree snapshots, and gate commands.

import {
  activeStateOf, type Config, type GateReceipt, type GateTree, type Lane, laneRunning, type Ledger, readLane, requireOwnChild, type ReviewAttestation,
  type RoundRecord, supervisorLane, withLedger,
} from "./ledger.ts";
import { tailOutput } from "./reports.ts";
import {
  CmdError, color, fail, parseArgs, pidAlive, shellQuote, uncoloredChildEnv,
} from "./runtime.ts";
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

// Receipt format stays at version 1 across ledger migrations. Absence means no content proof.
export function makeGateReceipt(round: number, cwd: string, command: string, exitCode: number,
  finishedAt: string, before?: GateTree, after?: GateTree, error?: string): GateReceipt {
  const reason = error ?? (!before || !after ? "tree snapshot unavailable"
    : before.head !== after.head || before.tree !== after.tree ? "tree changed during gate"
    : exitCode !== 0 ? "gate failed" : undefined);
  return { version: 1, round, cwd, command, exitCode, finishedAt, ...after, valid: !reason, ...(reason ? { reason } : {}) };
}

export function finishGateReceipt(receipt: GateReceipt, state: "done" | "failed"): { receipt: GateReceipt; report: string } {
  const final = state !== "done" && receipt.valid
    ? { ...receipt, valid: false, reason: "work round failed after gate" } : receipt;
  return { receipt: final, report: `\nReceipt ${final.valid ? "valid" : "invalid"}. HEAD ${final.head ?? "unavailable"}, tree ${final.tree ?? "unavailable"}.${final.reason ? ` ${final.reason}.` : ""}\n` };
}

export function gateAcceptanceFailed(exitCode: number | undefined, receipt: GateReceipt | undefined, proofRequired: boolean): boolean {
  return exitCode !== undefined && (exitCode !== 0 || proofRequired && !receipt?.valid);
}

export function receiptRefusal(receipt: GateReceipt | undefined, work: Pick<RoundRecord, "round" | "state" | "exitCode">): string | undefined {
  if (!receipt) return "no content-bound gate receipt; run a new work round";
  if (receipt.round !== work.round) return "receipt belongs to an older work round";
  if (work.state !== "done" && work.state !== "closed") return `work state is ${work.state}`;
  if (work.exitCode !== 0) return "work did not exit successfully";
  if (!receipt.valid || receipt.exitCode !== 0 || !receipt.head || !receipt.tree) return receipt.reason ?? "invalid gate receipt";
}

// A review attests to content: it attaches to the reviewer and to every open
// worktree lane whose checkout it ran in or whose green receipt it saw.
export function reviewedLanes(ledger: Ledger, reviewer: string, tree: GateTree, root: string | undefined,
  real: (path: string) => string | undefined): string[] {
  return Object.entries(ledger).filter(([name, item]) => name === reviewer || item.work.state !== "closed" && item.worktreePath
    && (item.gateReceipt?.tree === tree.tree || root !== undefined && real(item.worktreePath) === root)).map(([name]) => name);
}

export function realpathOrUndefined(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

export function reviewRoot(cwd: string): string | undefined {
  const top = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--show-toplevel"] });
  return top.success ? realpathOrUndefined(top.stdout.toString().trim()) : undefined;
}

// Only a review round that finished attests; a failed round's findings may
// be partial.
export function reviewAttests(entry: Lane): boolean {
  return entry.kind === "review" && !entry.consult && activeStateOf(entry) === "done";
}

export function attestReview(ledger: Ledger, reviewer: string, closed: boolean, report: string | undefined, root: string | undefined,
  real = realpathOrUndefined): string | undefined {
  const tree = ledger[reviewer]?.reviewTree;
  if (!tree) return;
  // A --commit or --base review read a commit, not the checkout, so it
  // proves the checkout's tree only when the target ends at that tree.
  if (tree.target && tree.targetTree !== tree.tree) {
    return `review ${reviewer} attests no tree: ${tree.target} ends at tree ${tree.targetTree?.slice(0, 12) ?? "?"}, the checkout is at ${tree.tree.slice(0, 12)}`;
  }
  const attestation: ReviewAttestation = { tree: tree.tree, head: tree.head, reviewer, closed, ...(report ? { report } : {}), at: new Date().toISOString() };
  for (const name of reviewedLanes(ledger, reviewer, tree, root, real)) (ledger[name]!.reviewAttestations ??= []).push(attestation);
}

// Review is optional, but once a lane was reviewed the newest review of its
// current tree, or of the gated tree the head edited, decides.
export function reviewRefusal(attestations: ReviewAttestation[] | undefined, trees: string[]): string | undefined {
  if (!attestations?.length) return;
  const covering = attestations.findLast((item) => trees.includes(item.tree));
  if (!covering) return `the lane was reviewed at ${attestations.at(-1)!.tree.slice(0, 12)}, not at its current or gated tree; review the current tree with any review lane`;
  if (!covering.closed) return `review ${covering.reviewer} has unresolved P1/P2 findings on tree ${covering.tree.slice(0, 12)}`;
}

export function composeGate(required: string | undefined, requested: string | undefined, notice = console.error): string | undefined {
  const baseline = required?.trim();
  let gate = requested?.trim();
  if (!baseline) return gate || undefined;
  if (!gate || baseline === gate) return baseline;
  if (gate.startsWith(`${baseline} && `)) {
    gate = gate.slice(baseline.length + 4);
    notice("cdx: stripped leading repository baseline from lane gate; baseline runs once");
  }
  // Separate shells prevent exit, cd and shell options in one check skipping the other.
  return `(/bin/sh -lc ${shellQuote(baseline)}) && (/bin/sh -lc ${shellQuote(gate)})`;
}

export const DEFAULT_GATE_TIMEOUT_MINUTES = 60;

// A repository's own limit beats the global one. The key is the main
// checkout, as for repoRouting and .cdx-gate, so every worktree matches. A gate
// that waits on shared locks or runs only by day needs more than the default.
export function gateTimeoutMinutes(cwd: string, settings: Pick<Config, "gateTimeoutMinutes" | "repoGateTimeoutMinutes">): number {
  const common = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"] });
  const commonDir = common.success ? realpathOrUndefined(common.stdout.toString().trim()) : undefined;
  const repo = commonDir && basename(commonDir) === ".git" ? dirname(commonDir) : undefined;
  return (repo ? settings.repoGateTimeoutMinutes?.[repo] : undefined) ?? settings.gateTimeoutMinutes ?? DEFAULT_GATE_TIMEOUT_MINUTES;
}

export function repositoryGate(cwd: string): string | undefined {
  const top = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"] });
  if (!top.success) return undefined;
  // The primary checkout owns policy, so a lane cannot delete its own copy to skip it.
  const common = top.stdout.toString().trim();
  const path = join(common, "..", ".cdx-gate");
  if (!existsSync(path)) return undefined;
  const command = readFileSync(path, "utf8").trim();
  if (!command) throw new CmdError(`${path} must contain a nonempty gate command`);
  return command;
}

export function gateTreeFromGit(root: string, git: (cwd: string, ...args: string[]) => string, _paths?: string[]): GateTree {
  const head = git(root, "rev-parse", "HEAD");
  git(root, "read-tree", head);
  // A receipt proves the entire checkout. Scoped staging could admit unrelated
  // edits after a green gate and before landing.
  git(root, "add", "--all", "--", ".");
  if (/^160000 /m.test(git(root, "ls-files", "--stage"))) throw new CmdError("gate receipts do not support submodules or embedded repositories");
  return { head, tree: git(root, "write-tree") };
}

export function captureGateTree(cwd: string, _paths?: string[]): GateTree | undefined {
  const top = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--show-toplevel"] });
  if (!top.success) return undefined;
  const root = top.stdout.toString().trim();
  const scratch = mkdtempSync(join(tmpdir(), "cdx-gate-"));
  const index = join(scratch, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const git = (directory: string, ...args: string[]) => {
    const result = Bun.spawnSync({ cmd: ["git", "-C", directory, ...args], env });
    if (!result.success) throw new CmdError(`gate snapshot failed: git ${args[0]}`);
    return result.stdout.toString().trim();
  };
  try {
    return gateTreeFromGit(root, git);
  } finally {
    for (const file of [index, `${index}.lock`]) { if (existsSync(file)) unlinkSync(file); }
    rmdirSync(scratch);
  }
}

export const NO_BASE_DIFF_NOTE = "no diff against base, gate skipped";
export const DOCS_ONLY_NOTE = "only docs changed against base, gate skipped";

// What a worktree lane's whole checkout, untracked files included, changes
// against the tree of its merge base with the base branch: the base land
// diffs against. Lanes without a managed worktree record no base, and a
// checkout git cannot read has no answer; both always gate.
export function laneDiffAgainstBase(cwd: string, entry: Pick<Lane, "worktreePath" | "branch" | "baseBranch"> | undefined): { paths: string[]; tree: GateTree } | undefined {
  if (!entry?.worktreePath || !entry.branch) return undefined;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
    return result.success ? result.stdout.toString().trim() : undefined;
  };
  const base = git("merge-base", "HEAD", `refs/heads/${entry.baseBranch ?? "main"}`);
  const baseTree = base && git("rev-parse", `${base}^{tree}`);
  if (!baseTree) return undefined;
  let tree: GateTree | undefined;
  try { tree = captureGateTree(cwd); }
  catch { return undefined; }
  if (!tree) return undefined;
  if (tree.tree === baseTree) return { paths: [], tree };
  const diff = git("diff", "--name-only", baseTree, tree.tree);
  return diff === undefined ? undefined : { paths: diff.split("\n").filter(Boolean), tree };
}

// A DEAD lane still commits its report or results note; no gate tests those,
// so a 20-45 minute GPU gate on them only holds the shared lease.
export function docsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((path) => /\.md$/i.test(path) || path.split("/").slice(0, -1).includes("lanes"));
}

// The receipt binds the tree without a gate run, so land can merge the docs;
// a merge result that differs from this tree still gates at land.
export function docsOnlyGate(round: number, cwd: string, command: string, tree: GateTree): ReturnType<typeof verifyGate> {
  const receipt: GateReceipt = { ...makeGateReceipt(round, cwd, command, 0, new Date().toISOString(), tree, tree), skipped: "docs only" };
  return { gate: { exitCode: 0, output: "", timedOut: false }, receipt, proofRequired: true };
}

export function gateReceiptCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["json"]);
  const [lane, extra] = parsed.rest;
  if (!lane || extra) fail("usage: cdx gate-receipt <lane> [--json]");
  const entry = readLane(lane);
  const reason = receiptRefusal(entry.gateReceipt, entry.work);
  const result = { version: 1, lane, state: entry.work.state, workExitCode: entry.work.exitCode,
    receipt: entry.gateReceipt ?? null, usable: !reason, ...(reason ? { reason } : {}) };
  console.log(parsed.bools.has("json") ? JSON.stringify(result) : reason
    ? `cdx: ${lane}: ${reason}` : `cdx: ${lane} tree=${entry.gateReceipt!.tree} head=${entry.gateReceipt!.head} gate=0`);
  if (reason) process.exitCode = 1;
}

export function gateEnv(cwd: string): Record<string, string | undefined> {
  const env = uncoloredChildEnv();
  const localBin = join(cwd, "node_modules", ".bin");
  const currentPath = env.PATH ?? process.env.PATH ?? "";
  env.PATH = currentPath ? `${localBin}:${currentPath}` : localBin;
  return env;
}

export type GateFailureKind = "typecheck" | "lint" | "assertion" | "architecture" | "formatter" | "spec cap" | "missing spec" | "stale generated" | "dirty tree" | "setup" | "tool crash";

const fatalDiagnostics: Array<[GateFailureKind, RegExp]> = [
  ["typecheck", /(?:error TS\d+|typescript\(TS\d+\)|\bTS\d{4}:)/i],
  ["architecture", /(?:^error (?:no-runtime-cycles|arc-|no-)|arch:check:.*violations above|runtime cycle|dependency cycle|circular dependency|prohibited .*import|forbidden .*import|architecture.*(?:fail|violation)|import.*(?:prohibited|forbidden))/i],
  ["missing spec", /(?:No test files found|unreadable spec:|(?:unreadable|missing|not found|no .*found|cannot find|does not exist).*\b(?:spec|test)\b|(?:spec|test).*?(?:missing|not found|does not exist))/i],
  ["spec cap", /(?:\d+ over 400|cap breach:|\d+[- ]line spec|spec.*(?:exceeds|over.*(?:limit|cap)|cap.*(?:exceeded|breach|fail))|\d+ lines.*(?:limit|cap|400)|cap.*(?:exceeded|failed))/i],
  ["stale generated", /(?:is stale:|stale.*generat|generat.*(?:stale|out.of.date)|generated files.*(?:differ|mismatch))/i],
  ["formatter", /(?:format(?:ting)?.*(?:fail|error|issues|incorrect)|Code style issues|trailing whitespace|new blank line at EOF)/i],
  ["lint", /(?:eslint|oxlint|biome).*?(?:error|fail)|\berror\s{2,}.*[\w-]+\/[\w-]+|\blint.*(?:error|fail)/i],
  ["tool crash", /(?:panicked at|segmentation fault|core dumped|fatal (?:runtime )?error|SIGSEGV|SIGABRT)/i],
  ["dirty tree", /^(?:diff --git |error:.*(?:dirty|uncommitted)|.*working tree.*(?:dirty|not clean))/i],
  ["setup", /(?:command not found|\bENOENT\b|cannot execute|Permission denied|No such file or directory|(?:cannot find|could not resolve|missing) (?:package|module)|(?:sh|bash|zsh):.*?:\s*not found)/i],
  ["assertion", /(?:AssertionError|Assertion failed|^\s*[×❯]|\(fail\)|^FAIL\b|(?:tests?|expect|assert).*?(?:failed|expected|received)|^error:|^Error:)/i],
];

export function gateFailure(exitCode: number, output: string): { kind: GateFailureKind; diagnostic: string } {
  const lines = safeText(output).split(/\r?\n/);
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    for (const [kind, pattern] of fatalDiagnostics) {
      if (pattern.test(plain)) return { kind, diagnostic: line };
    }
  }
  return { kind: "assertion", diagnostic: lines.find((line) => line.trim()) ?? `gate exited ${exitCode} without a diagnostic` };
}

export function classifyGateFailure(exitCode: number, output: string): GateFailureKind {
  return gateFailure(exitCode, output).kind;
}

interface GateResult { exitCode: number; output: string; timedOut: boolean }

export function verifyGate(round: number, cwd: string, command: string,
  snapshot: () => GateTree | undefined, run: () => GateResult,
  changedPaths = (before: GateTree, after: GateTree): string[] => {
    const diff = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "--name-only", before.tree, after.tree] });
    return diff.success ? diff.stdout.toString().trim().split("\n").filter(Boolean) : [];
  }) {
  let snapshotError: string | undefined;
  const capture = () => {
    try { return snapshot(); }
    catch (error) { snapshotError = String(error); return undefined; }
  };
  const before = capture();
  const gate = run();
  const after = capture();
  const proofRequired = Boolean(before || after || snapshotError);
  const receipt = makeGateReceipt(round, cwd, command, gate.exitCode, new Date().toISOString(), before, after, snapshotError);
  if (receipt.reason === "tree changed during gate" && before && after) {
    let paths: string[] = [];
    try { paths = changedPaths(before, after); } catch { /* retain invalid receipt */ }
    receipt.reason += `: ${paths.length ? paths.join(", ") : "changed paths unavailable"}`;
  }
  return { gate, receipt, proofRequired };
}

const GATE_GROUP = join(import.meta.dir, "gate-group.ts");
// gate-group.ts stops the gate's group itself; this only catches a wrapper
// that hangs past its own deadline.
const WRAPPER_BACKSTOP_MS = 60_000;

export function executeGate(command: string, cwd: string, logPath: string, timeoutMs = DEFAULT_GATE_TIMEOUT_MINUTES * 60_000): GateResult {
  const started = Date.now();
  const gate = Bun.spawnSync({
    cmd: [process.execPath, GATE_GROUP, String(timeoutMs), command], cwd, env: gateEnv(cwd),
    timeout: timeoutMs + WRAPPER_BACKSTOP_MS, killSignal: "SIGKILL",
  });
  const timedOut = gate.exitCode === GATE_TIMEOUT_EXIT && Date.now() - started >= timeoutMs;
  const exitCode = gate.exitCode ?? 1;
  const timeoutNote = timedOut ? `\ncdx: gate timed out after ${timeoutMs / 60_000} minutes\n` : "";
  const output = safeText(`${gate.stdout.toString()}${gate.stderr.toString()}${timeoutNote}`);
  writeFileSync(logPath, output);
  return { exitCode, output, timedOut };
}

export function gateOutputForReport(output: string, exitCode = 0): string {
  const trimmed = safeText(output).trim();
  const tail = trimmed.length > 4000 ? `...${trimmed.slice(-4000)}` : trimmed;
  if (!exitCode) return "Gate exited 0.";
  const failure = gateFailure(exitCode, output);
  return `gate ${failure.kind} failed\n${failure.diagnostic}\n\n${tail}`;
}

function executePreCheck(command: string, cwd: string): { exitCode: number; output: string } {
  const proc = Bun.spawnSync({
    cmd: ["/bin/sh", "-lc", command],
    cwd,
    env: gateEnv(cwd),
  });
  const exitCode = proc.exitCode ?? 1;
  const output = safeText(`${proc.stdout.toString()}${proc.stderr.toString()}`);
  return { exitCode, output };
}

export function runPreCheck(command: string, cwd: string): void {
  const result = executePreCheck(command, cwd);
  if (result.exitCode !== 0) {
    const tail = tailOutput(result.output, 20);
    if (tail.length > 0) {
      console.error(tail);
    }
    fail(`pre-check failed (exit ${result.exitCode}) in ${cwd}: ${command}`);
  }
}

interface ReviewTreeSnapshot {
  kind: "git" | "files";
  fingerprint: string;
  paths: string[];
  pathFingerprints: Record<string, string>;
}

function hashParts(parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function recursiveFileListing(cwd: string): Omit<ReviewTreeSnapshot, "kind"> {
  const rows: string[] = [];
  const paths: string[] = [];
  const pathFingerprints: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = lstatSync(path);
        const name = relative(cwd, path);
        paths.push(name);
        const row = `${name}\0${info.size}\0${info.mtimeMs}\n`;
        rows.push(row);
        pathFingerprints[name] = hashParts([row]);
      }
    }
  };
  walk(cwd);
  rows.sort();
  paths.sort();
  return { fingerprint: hashParts(rows), paths, pathFingerprints };
}

export function captureReviewTree(cwd: string): ReviewTreeSnapshot {
  const inside = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"] });
  if (!inside.success) return { kind: "files", ...recursiveFileListing(cwd) };
  const head = Bun.spawnSync({ cmd: ["git", "-C", cwd, "rev-parse", "HEAD"] });
  const status = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--porcelain=v1", "-z"] });
  const diff = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "HEAD", "--binary", "--no-ext-diff"] });
  const names = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "HEAD", "--name-only", "--no-ext-diff"] });
  const untracked = Bun.spawnSync({ cmd: ["git", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"] });
  const statusText = status.stdout.toString();
  const paths = new Set(names.stdout.toString().split("\n").filter(Boolean));
  const statusByPath = new Map<string, string>();
  const statusRecords = statusText.split("\0").filter(Boolean);
  for (let index = 0; index < statusRecords.length; index += 1) {
    const record = statusRecords[index]!;
    const path = record.slice(3).replace(/^"|"$/g, "");
    if (path) {
      paths.add(path);
      statusByPath.set(path, record.slice(0, 2));
    }
    if (/[RC]/.test(record.slice(0, 2)) && statusRecords[index + 1]) {
      const source = statusRecords[++index]!;
      paths.add(source);
      statusByPath.set(source, `source of ${path}`);
    }
  }
  const untrackedParts: Array<string | Uint8Array> = [untracked.stdout, untracked.stderr];
  for (const path of untracked.stdout.toString().split("\0").filter(Boolean).sort()) {
    paths.add(path);
    const fullPath = join(cwd, path);
    try {
      const info = lstatSync(fullPath);
      untrackedParts.push(`${path}\0${info.mode}\0${info.size}\0`);
      untrackedParts.push(info.isSymbolicLink() ? readlinkSync(fullPath) : readFileSync(fullPath));
    } catch {
      untrackedParts.push(`${path}\0missing`);
    }
  }
  const pathFingerprints: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    const fileParts: Array<string | Uint8Array> = [statusByPath.get(path) ?? ""];
    const pathDiff = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "HEAD", "--binary", "--no-ext-diff", "--", path] });
    fileParts.push(pathDiff.stdout, pathDiff.stderr);
    const fullPath = join(cwd, path);
    try {
      const info = lstatSync(fullPath);
      fileParts.push(`${info.mode}\0${info.size}\0`);
      if (info.isSymbolicLink()) fileParts.push(readlinkSync(fullPath));
      else if (info.isFile()) fileParts.push(readFileSync(fullPath));
    } catch {
      fileParts.push("missing");
    }
    pathFingerprints[path] = hashParts(fileParts);
  }
  return {
    kind: "git",
    fingerprint: hashParts([head.stdout, status.stdout, status.stderr, diff.stdout, diff.stderr, ...untrackedParts]),
    paths: [...paths].sort(),
    pathFingerprints,
  };
}

function gateLabel(command?: string): string {
  return command ?? "<none>";
}

export function printGateChange(lane: string, oldGate: string | undefined, newGate: string | undefined): void {
  console.log(`cdx: lane=${color.magenta(lane)} gate old=${gateLabel(oldGate)}`);
  console.log(`cdx: lane=${color.magenta(lane)} gate new=${gateLabel(newGate)}`);
}

export function gateCommand(argv: string[]): void {
  const parsed = parseArgs(argv, ["clear"]);
  const [lane, command, extra] = parsed.rest;
  if (!lane || extra || (parsed.bools.has("clear") ? command !== undefined : command === undefined)) {
    fail('usage: cdx gate <lane> "<cmd>" | cdx gate <lane> --clear');
  }
  if (!parsed.bools.has("clear") && command!.trim() === "") fail("gate command cannot be empty; use --clear");
  const before = readLane(lane);
  requireOwnChild(lane, before);
  if (supervisorLane()) fail(`supervisor ${supervisorLane()} may not change a child's gate; the gate is the liaison's acceptance check (cdx ask if it is wrong)`);
  if (laneRunning(before) && pidAlive(before.pid)) fail(`lane "${lane}" is running; stop it before changing the gate`);
  const next = parsed.bools.has("clear") ? undefined : command;
  if (next && isNoOpGate(next) && repositoryGate(before.work.cwd)) fail(`gate "${next}" checks nothing and this repository has .cdx-gate; clear the gate or pass a real check`);
  withLedger((ledger) => {
    const item = ledger[lane]!;
    requireOwnChild(lane, item);
    item.gate = next;
    item.gateReceipt = undefined;
    item.updatedAt = new Date().toISOString();
  });
  printGateChange(lane, before.gate, next);
}

export function failureDigest(output: string): string {
  const lines = safeText(output).split(/\r?\n/);
  const first = lines.findIndex((line) => fatalDiagnostics.some(([, pattern]) => pattern.test(line)));
  return lines.slice(first < 0 ? Math.max(0, lines.length - 40) : first, first < 0 ? undefined : first + 40).join("\n").slice(0, 10_000);
}

export async function repairGateOnce<T extends { gate: { exitCode: number; output: string }; receipt: GateReceipt }>(run: () => T, repair: (prompt: string) => Promise<boolean>): Promise<T> {
  const first = run();
  if (first.gate.exitCode === 0 || first.receipt.reason?.startsWith("tree changed")) return first;
  const tail = first.gate.output.trimEnd().split(/\r?\n/).slice(-60).join("\n");
  if (!await repair(`Gate fix on the same diff. Correct only the failure below and write the updated report. Do not rerun the suite or wall; cdx runs the gate once after your fix.\n\n${tail}`)) return first;
  return run();
}

export function changedPaths(before: ReviewTreeSnapshot, after: ReviewTreeSnapshot): string[] {
  return [...new Set([...before.paths, ...after.paths])].filter((path) => before.pathFingerprints[path] !== after.pathFingerprints[path]).sort();
}
