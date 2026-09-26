// Worktree creation, reuse, directory persistence, and cleanup.

import { config } from "./config.ts";
import { readLane, requireOwnChild, withLedger, laneRunning, type Lane, type Spec } from "./ledger.ts";
import { captureGateTree, receiptRefusal } from "./gates.ts";
import { runFrozenGate } from "./snapshots.ts";
import { specPathOf } from "./reports.ts";
import { CmdError, displayPath, fail, HOME, ROOT, shellQuote, uncoloredChildEnv } from "./runtime.ts";
import { existsSync, mkdirSync, rmdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function resolveWorktreeTarget(target: string): string {
  if (isAbsolute(target)) return target;
  return target.includes("/") ? join(process.cwd(), target) : join(HOME, "code", "wt", target);
}

export function storedDirectories(lane: string, entry?: Pick<Lane, "additionalDirectories" | "work" | "rounds">,
  readSpec: (lane: string, round: number) => Pick<Spec, "additionalDirectories"> | undefined = (name, round) => {
    const path = specPathOf(name, round);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Spec : undefined;
  }): string[] {
  if (!entry) return [];
  if (entry.additionalDirectories) return entry.additionalDirectories;
  return readSpec(lane, entry.work.round ?? entry.rounds)?.additionalDirectories ?? [];
}

export function mergeDirectories(previous: string[] = [], added: string[] = []): string[] {
  return [...new Set([...previous, ...added])];
}

export function worktreeReuseRefusal(expectedBranch: string, actualBranch: string, sameRepo: boolean, clean: boolean): string | undefined {
  if (!sameRepo) return "target is not a worktree of this repository";
  if (actualBranch !== expectedBranch) return `target must be on ${expectedBranch}`;
  if (!clean) return "target worktree has uncommitted changes";
}

export function cleanupRefusal(branch: string | undefined, currentBranch: string, merged: boolean, clean: boolean): string | undefined {
  if (!branch || branch === "main" || currentBranch !== branch) return "worktree is not on its recorded lane branch";
  if (!merged) return `branch ${branch} is not merged into local main`;
  if (!clean) return "worktree has uncommitted changes";
}

export interface WorktreeInfo { path: string; repo: string; branch: string; baseBranch?: string }

export function createWorktree(repo: string, target: string, lane: string): WorktreeInfo {
  const top = Bun.spawnSync({ cmd: ["git", "-C", repo, "rev-parse", "--show-toplevel"] });
  if (!top.success) fail(`--worktree needs a git repository at ${repo}`);
  const repoRoot = top.stdout.toString().trim();
  const baseBranch = Bun.spawnSync({ cmd: ["git", "-C", repoRoot, "symbolic-ref", "--short", "HEAD"] }).stdout.toString().trim();
  if (!baseBranch) fail("worktree source must be on a branch");
  const path = resolveWorktreeTarget(target);
  const branch = `lane/${lane}`;
  if (existsSync(path)) {
    const probe = (...args: string[]) => Bun.spawnSync({ cmd: ["git", "-C", path, ...args] });
    const common = probe("rev-parse", "--path-format=absolute", "--git-common-dir");
    const sourceCommon = Bun.spawnSync({ cmd: ["git", "-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"] });
    const root = probe("rev-parse", "--show-toplevel");
    const current = probe("symbolic-ref", "--short", "HEAD");
    const status = probe("status", "--porcelain", "--untracked-files=all");
    const sameRepo = common.success && sourceCommon.success && root.success
      && realpathSync(root.stdout.toString().trim()) === realpathSync(path)
      && common.stdout.toString().trim() === sourceCommon.stdout.toString().trim();
    const reason = worktreeReuseRefusal(branch, current.stdout.toString().trim(), sameRepo, status.success && !status.stdout.toString().trim());
    if (reason) fail(`cannot reuse ${path}: ${reason}`);
    console.log(`cdx: reusing clean worktree ${path} on ${branch}`);
    return { path, repo: repoRoot, branch, baseBranch };
  }
  const add = Bun.spawnSync({ cmd: ["git", "-C", repoRoot, "worktree", "add", path, "-b", branch] });
  if (!add.success) {
    fail(`git worktree add failed: ${(add.stderr.toString() || add.stdout.toString()).trim().split("\n").at(-1)}`);
  }
  console.log(`cdx: worktree ${displayPath(path)} on branch ${branch} (from ${displayPath(repoRoot)})`);
  if (config.worktreeSetup) {
    console.log(`cdx: worktree setup: ${config.worktreeSetup}`);
    const setup = Bun.spawnSync({ cmd: ["/bin/sh", "-lc", config.worktreeSetup], cwd: path, env: uncoloredChildEnv() });
    if (!setup.success) {
      const tail = (setup.stderr.toString() || setup.stdout.toString()).trim().split("\n").at(-1) ?? "";
      // Leave the worktree in place for inspection; the caller decides.
      fail(`worktree setup failed in ${path}${tail ? `: ${tail}` : ""}`);
    }
  }
  const repoSetup = `${path}/.cdx-worktree-setup`;
  let isExecutable = false;
  try {
    const st = statSync(repoSetup);
    if (st.isFile() && (st.mode & 0o111) !== 0) {
      isExecutable = true;
    }
  } catch { /* not present */ }
  if (isExecutable) {
    console.log("cdx: repo worktree setup: .cdx-worktree-setup");
    const setup = Bun.spawnSync({ cmd: ["/bin/sh", "-lc", "./.cdx-worktree-setup"], cwd: path, env: uncoloredChildEnv() });
    if (!setup.success) {
      const tail = (setup.stderr.toString() || setup.stdout.toString()).trim().split("\n").at(-1) ?? "";
      fail(`worktree setup failed in ${path}${tail ? `: ${tail}` : ""}`);
    }
  }
  return { path, repo: repoRoot, branch, baseBranch };
}

type WorktreeRecord = Pick<Lane, "worktreeRepo" | "worktreePath" | "branch">;

type GitProbe = (cwd: string, args: string[]) => { success: boolean; stdout: { toString(): string }; stderr: { toString(): string } };

export function closeKeepsWorktree(flags: Set<string>): boolean {
  if (flags.has("keep-worktree") && flags.has("remove-worktree")) throw new CmdError("--keep-worktree and --remove-worktree cannot be combined");
  return flags.has("keep-worktree");
}

export function worktreeCleanupCommands(entry: WorktreeRecord): string[] {
  if (!entry.worktreePath) return [];
  const git = `git -C ${shellQuote(entry.worktreeRepo ?? entry.worktreePath)}`;
  return [
    `${git} worktree remove ${shellQuote(entry.worktreePath)}`,
    ...(entry.branch ? [`${git} merge-base --is-ancestor ${shellQuote(`refs/heads/${entry.branch}`)} refs/heads/main && ${git} branch -D ${shellQuote(entry.branch)}`] : []),
  ];
}

// main owns merge admission; branch -d would apply another check against HEAD or upstream.
export function removeWorktree(entry: WorktreeRecord,
  run: GitProbe = (cwd, args) => Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] }),
  log: (message: string) => void = console.log) {
  const repo = entry.worktreeRepo ?? entry.worktreePath!;
  const probe = (...args: string[]) => run(repo, args);
  const current = run(entry.worktreePath!, ["symbolic-ref", "--short", "HEAD"]);
  const status = run(entry.worktreePath!, ["status", "--porcelain", "--untracked-files=all"]);
  const merged = entry.branch ? probe("merge-base", "--is-ancestor", `refs/heads/${entry.branch}`, "refs/heads/main").success : false;
  const reason = cleanupRefusal(entry.branch, current.stdout.toString().trim(), merged, status.success && !status.stdout.toString().trim());
  if (reason) fail(`not removing worktree: ${reason}`);
  const remove = probe("worktree", "remove", entry.worktreePath!);
  if (!remove.success) fail(`git worktree remove failed: ${remove.stderr.toString().trim()}`);
  const del = probe("branch", "-D", entry.branch!);
  if (!del.success) fail(`worktree removed but branch retained: ${del.stderr.toString().trim()}`);
  log(`cdx: removed worktree ${displayPath(entry.worktreePath!)} and branch ${entry.branch}`);
}

export function landRefusal(entry: Lane, baseDirty: boolean, current?: import("./ledger.ts").GateTree): string | undefined {
  if (laneRunning(entry)) return "lane is still running";
  if (!entry.worktreePath || !entry.worktreeRepo || !entry.branch) return "lane has no managed worktree";
  if (baseDirty) return "base checkout is dirty";
  const receipt = receiptRefusal(entry.gateReceipt, entry.work);
  if (receipt) return receipt;
  if (entry.reviewClosed === false) return "review has unresolved P1/P2 findings";
  if (!current) return "worktree snapshot unavailable";
  if (entry.landingCommit && current.head === entry.landingCommit && current.tree === entry.gateReceipt!.tree) return;
  if (current.head !== entry.gateReceipt!.head || current.tree !== entry.gateReceipt!.tree) return "worktree differs from its green receipt";
}

export function refreshChangedLandReceipt(entry: Lane, baseDirty: boolean, current: import("./ledger.ts").GateTree | undefined,
  run: () => import("./ledger.ts").GateReceipt, save: (update: Pick<Lane, "gateReceipt" | "landingCommit" | "landedCommit">) => void,
  capture: () => import("./ledger.ts").GateTree | undefined): { refusal?: string; current?: import("./ledger.ts").GateTree } {
  let refusal = landRefusal(entry, baseDirty, current);
  if (refusal !== "worktree differs from its green receipt") return { refusal, current };
  const receipt = run();
  const update = { gateReceipt: receipt, landingCommit: undefined, landedCommit: undefined };
  Object.assign(entry, update);
  save(update);
  current = capture();
  refusal = landRefusal(entry, baseDirty, current);
  return { refusal, current };
}

export function landCommand(argv: string[]): void {
  const [lane, extra] = argv;
  if (!lane || extra) fail("usage: cdx land <lane>");
  const entry = readLane(lane);
  requireOwnChild(lane, entry);
  if (!entry.worktreeRepo || !entry.worktreePath || !entry.branch) fail("land requires a managed worktree");
  const base = entry.worktreeRepo;
  const work = entry.worktreePath;
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
    if (!result.success) throw new CmdError(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
    return result.stdout.toString().trim();
  };
  const lock = `${git(base, "rev-parse", "--path-format=absolute", "--git-common-dir")}/cdx-land.lock`;
  try { mkdirSync(lock); } catch { fail(`another landing holds ${lock}`); }
  try {
    const baseBranch = entry.baseBranch ?? "main";
    if (git(base, "symbolic-ref", "--short", "HEAD") !== baseBranch) fail(`base checkout must be on ${baseBranch}`);
    const removed = !existsSync(work);
    if (removed && !entry.landedCommit) fail("lane worktree is missing before merge");
    if (!removed && git(work, "symbolic-ref", "--short", "HEAD") !== entry.branch) fail("lane checkout is not on its recorded branch");
    let current = removed && entry.landingCommit
      ? { head: entry.landingCommit, tree: git(base, "rev-parse", `${entry.landingCommit}^{tree}`) }
      : captureGateTree(work);
    const baseDirty = Boolean(git(base, "status", "--porcelain", "--untracked-files=all"));
    const checked = removed ? { refusal: landRefusal(entry, baseDirty, current), current } : refreshChangedLandReceipt(entry, baseDirty, current,
      () => runFrozenGate(entry.work.round!, work, entry.gateReceipt!.command,
        `${ROOT}/logs/${lane}-r${entry.work.round}.land-gate.log`, lane).receipt,
      (update) => { withLedger((ledger) => { Object.assign(ledger[lane]!, update); }); },
      () => captureGateTree(work));
    current = checked.current;
    const refusal = checked.refusal;
    if (refusal) fail(`cannot land ${lane}: ${refusal}`);
    if (git(base, "status", "--porcelain", "--untracked-files=all")) fail(`cannot land ${lane}: base checkout is dirty`);
    // Catch lane edits made after the receipt was checked.
    const all = removed ? current : captureGateTree(work);
    if (!all || all.tree !== current!.tree) fail("lane changed after its gate receipt was checked");
    if (!entry.landingCommit) {
      git(work, "add", "--all");
      if (git(work, "diff", "--cached", "--name-only")) git(work, "commit", "-m", `Land ${lane}`);
      entry.landingCommit = git(work, "rev-parse", "HEAD");
      if (git(work, "rev-parse", "HEAD^{tree}") !== current!.tree || git(work, "status", "--porcelain", "--untracked-files=all")) fail("commit hooks changed the lane tree; rerun the gate before landing");
      withLedger((ledger) => { ledger[lane]!.landingCommit = entry.landingCommit; });
    }
    if (git(base, "rev-parse", `${entry.landingCommit}^{tree}`) !== entry.gateReceipt!.tree) fail("landing commit differs from its green receipt");
    const merged = Bun.spawnSync({ cmd: ["git", "-C", base, "merge-base", "--is-ancestor", entry.landingCommit!, "HEAD"] });
    if (!merged.success) git(base, "merge", "--no-ff", entry.landingCommit!, "-m", `Merge ${lane}`);
    const landedCommit = git(base, "rev-parse", "HEAD");
    withLedger((ledger) => { ledger[lane]!.landedCommit = landedCommit; });
    git(base, "push");
    if (!removed) git(base, "worktree", "remove", work);
    if (Bun.spawnSync({ cmd: ["git", "-C", base, "show-ref", "--verify", "--quiet", `refs/heads/${entry.branch}`] }).success) git(base, "branch", "-d", entry.branch);
    withLedger((ledger) => {
      const item = ledger[lane]!;
      item.work.state = "closed";
      item.work.note = `landed ${landedCommit}`;
      item.updatedAt = new Date().toISOString();
    });
    console.log(`cdx: landed ${lane} as ${landedCommit}; pushed, removed worktree and branch, closed`);
  } finally { rmdirSync(lock); }
}
