// Worktree creation, reuse, directory persistence, and cleanup.

import { config } from "./config.ts";
import { readLane, requireOwnChild, supervisorLane, withLedger, laneRunning, type Lane, type Ledger, type Spec } from "./ledger.ts";
import { captureGateTree, gateFailure, receiptRefusal, reviewRefusal } from "./gates.ts";
import { createReviewSnapshot, runFrozenGate } from "./snapshots.ts";
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

// A supervisor's writers never share a tree: each child gets a worktree cut
// from the checkout the supervisor runs in, which is its own lane branch.
export function childWorktreeTarget(lane: string, requested: string | undefined, parent: string | undefined, respawn: boolean): string | undefined {
  return requested ?? (parent && !respawn ? lane : undefined);
}

type WorktreeRecord = Pick<Lane, "worktreeRepo" | "worktreePath" | "branch" | "baseBranch">;

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
    ...(entry.branch ? [`${git} merge-base --is-ancestor ${shellQuote(`refs/heads/${entry.branch}`)} ${shellQuote(`refs/heads/${entry.baseBranch ?? "main"}`)} && ${git} branch -D ${shellQuote(entry.branch)}`] : []),
  ];
}

export function cleanupRefusal(branch: string | undefined, currentBranch: string, clean: boolean): string | undefined {
  if (!branch || branch === "main" || currentBranch !== branch) return "worktree is not on its recorded lane branch";
  if (!clean) return "worktree has uncommitted changes";
}

// The base branch owns merge admission; branch -d would apply another check
// against HEAD or upstream. An unmerged branch survives so commits are kept.
export function removeWorktree(entry: WorktreeRecord,
  run: GitProbe = (cwd, args) => Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] }),
  log: (message: string) => void = console.log) {
  const repo = entry.worktreeRepo ?? entry.worktreePath!;
  const probe = (...args: string[]) => run(repo, args);
  const current = run(entry.worktreePath!, ["symbolic-ref", "--short", "HEAD"]);
  const status = run(entry.worktreePath!, ["status", "--porcelain", "--untracked-files=all"]);
  const reason = cleanupRefusal(entry.branch, current.stdout.toString().trim(), status.success && !status.stdout.toString().trim());
  if (reason) fail(`not removing worktree: ${reason}`);
  const merged = probe("merge-base", "--is-ancestor", `refs/heads/${entry.branch}`, `refs/heads/${entry.baseBranch ?? "main"}`).success;
  const remove = probe("worktree", "remove", entry.worktreePath!);
  if (!remove.success) fail(`git worktree remove failed: ${remove.stderr.toString().trim()}`);
  if (!merged) {
    log(`cdx: removed worktree ${displayPath(entry.worktreePath!)}; kept unmerged branch ${entry.branch}`);
    return;
  }
  const del = probe("branch", "-D", entry.branch!);
  if (!del.success) fail(`worktree removed but branch retained: ${del.stderr.toString().trim()}`);
  log(`cdx: removed worktree ${displayPath(entry.worktreePath!)} and branch ${entry.branch}`);
}

function gitRaw(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
  if (!result.success) throw new CmdError(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

function git(cwd: string, ...args: string[]): string {
  return gitRaw(cwd, ...args).trim();
}

function gitOk(cwd: string, ...args: string[]): boolean {
  return Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] }).success;
}

export function landRefusal(entry: Lane): string | undefined {
  if (laneRunning(entry)) return "lane is still running";
  if (!entry.worktreePath || !entry.worktreeRepo || !entry.branch) return "lane has no managed worktree";
  return receiptRefusal(entry.gateReceipt, entry.work);
}

// Prefix gates are assumed monotonic: once a merge breaks the gate, longer
// prefixes stay red. The caller knows the full prefix is red.
export function firstRedPrefix(count: number, green: (prefix: number) => boolean): number {
  let low = 1, high = count;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (green(middle)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function statusPaths(porcelainZ: string): string[] {
  const records = porcelainZ.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2)) && records[index + 1]) paths.push(records[++index]!);
  }
  return paths;
}

export function overlappingPaths(dirty: string[], changed: string[]): string[] {
  const touched = new Set(changed);
  return [...new Set(dirty.filter((path) => touched.has(path)))].sort();
}

interface LandLane { lane: string; entry: Lane; commit: string; tree: string }

// Commits the lane checkout so the merge carries exactly the tree its receipt
// and reviews saw. Undefined means the lane is already in the base branch.
function prepareLane(lane: string, entry: Lane, repo: string, baseRef: string): LandLane | undefined {
  const work = entry.worktreePath;
  if (laneRunning(entry)) fail(`cannot land ${lane}: lane is still running`);
  if (!work || !entry.branch) fail(`cannot land ${lane}: lane has no managed worktree`);
  if (!existsSync(work)) {
    if (entry.landedCommit && gitOk(repo, "merge-base", "--is-ancestor", entry.landedCommit, baseRef)) return;
    fail(`cannot land ${lane}: worktree ${displayPath(work)} is missing`);
  }
  if (git(work, "symbolic-ref", "--short", "HEAD") !== entry.branch) fail(`cannot land ${lane}: checkout is not on ${entry.branch}`);
  const current = captureGateTree(work);
  if (!current) fail(`cannot land ${lane}: worktree snapshot unavailable`);
  const clean = () => !git(work, "status", "--porcelain", "--untracked-files=all");
  if (clean() && gitOk(repo, "merge-base", "--is-ancestor", current.head, baseRef)) return;
  const refusal = landRefusal(entry) ?? reviewRefusal(entry.reviewAttestations, [current.tree, entry.gateReceipt!.tree!]);
  if (refusal) fail(`cannot land ${lane}: ${refusal}`);
  if (!clean()) {
    git(work, "add", "--all");
    git(work, "commit", "--quiet", "-m", `Land ${lane}`);
  }
  const commit = git(work, "rev-parse", "HEAD");
  const tree = git(work, "rev-parse", "HEAD^{tree}");
  if (tree !== current.tree || !clean()) fail(`cannot land ${lane}: commit hooks changed the lane tree; check the change and land again`);
  return { lane, entry, commit, tree };
}

function mergeCandidate(repo: string, base: string, target: LandLane): string {
  if (gitOk(repo, "merge-base", "--is-ancestor", target.commit, base)) return base;
  const merge = Bun.spawnSync({ cmd: ["git", "-C", repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, target.commit] });
  const [tree, ...conflicts] = merge.stdout.toString().trim().split("\n");
  if (merge.exitCode === 1) fail(`cannot land ${target.lane}: it conflicts with the base in ${[...new Set(conflicts.filter(Boolean))].join(", ")}; rebase the lane branch`);
  if (!merge.success || !tree) fail(`git merge-tree failed: ${merge.stderr.toString().trim()}`);
  return git(repo, "commit-tree", tree, "-p", base, "-p", target.commit, "-m", `Merge ${target.lane}`);
}

function mergeGateCommand(targets: LandLane[]): string {
  const commands = [...new Set(targets.map((target) => target.entry.gateReceipt!.command))];
  return commands.length === 1 ? commands[0]! : commands.map((command) => `(/bin/sh -lc ${shellQuote(command)})`).join(" && ");
}

// A tree with a green receipt for its own lane needs no gate; any other merge
// result, head edits included, runs the gate once in a frozen snapshot.
export function receiptProves(targets: Array<Pick<LandLane, "entry">>, tree: string): boolean {
  return targets.length === 1 && targets[0]!.entry.gateReceipt?.tree === tree;
}

function proveMerge(repo: string, commit: string, targets: LandLane[]): string | undefined {
  const tree = git(repo, "rev-parse", `${commit}^{tree}`);
  if (receiptProves(targets, tree)) return;
  const first = targets[0]!;
  const log = `${ROOT}/logs/${first.lane}-land-${tree.slice(0, 12)}.gate.log`;
  console.log(`cdx: gating merge result ${commit.slice(0, 12)} of ${targets.map((target) => target.lane).join(", ")}`);
  const { gate, receipt } = runFrozenGate(first.entry.work.round!, first.entry.worktreePath!, mergeGateCommand(targets), log, first.lane,
    { create: (cwd, lane, round) => createReviewSnapshot(cwd, lane, round, { head: commit, tree }) });
  if (receipt.valid) {
    const regated = targets.filter((target) => target.tree === tree && target.entry.gateReceipt!.tree !== tree);
    if (regated.length) withLedger((ledger) => { for (const target of regated) ledger[target.lane]!.gateReceipt = receipt; });
    return;
  }
  const failure = gate.exitCode !== 0 ? gateFailure(gate.exitCode, gate.output).diagnostic : receipt.reason;
  return `gate red on the merge result: ${failure} (log ${displayPath(log)})`;
}

function branchCheckout(repo: string, ref: string): string | undefined {
  let path: string | undefined;
  for (const line of git(repo, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch ${ref}`) return path;
  }
}

function refuseOverlap(checkout: string, repo: string, from: string, to: string): void {
  const dirty = statusPaths(gitRaw(checkout, "status", "--porcelain=v1", "-z", "--untracked-files=all"));
  const changed = gitRaw(repo, "diff", "--name-only", "-z", from, to).split("\0").filter(Boolean);
  const overlap = overlappingPaths(dirty, changed);
  if (overlap.length) fail(`base checkout ${displayPath(checkout)} has uncommitted changes in files the merge touches: ${overlap.join(", ")}`);
}

function pushBranch(repo: string, branch: string): string {
  const config = (key: string) => Bun.spawnSync({ cmd: ["git", "-C", repo, "config", key] }).stdout.toString().trim();
  const remote = config(`branch.${branch}.remote`);
  if (!remote) return `not pushed, ${branch} has no upstream`;
  git(repo, "push", "--quiet", remote, `refs/heads/${branch}:${config(`branch.${branch}.merge`) || `refs/heads/${branch}`}`);
  return `pushed to ${remote}`;
}

function retireLane(lane: string, entry: Lane, repo: string, baseRef: string, note: string): void {
  if (entry.worktreePath && existsSync(entry.worktreePath)) git(repo, "worktree", "remove", entry.worktreePath);
  if (entry.branch && gitOk(repo, "merge-base", "--is-ancestor", `refs/heads/${entry.branch}`, baseRef)) git(repo, "branch", "-D", entry.branch);
  withLedger((ledger) => {
    const item = ledger[lane]!;
    item.work.state = "closed";
    item.work.note = note;
    item.updatedAt = new Date().toISOString();
  });
}

function landLanes(lanes: string[], entries: Lane[], repo: string, baseBranch: string): void {
  const baseRef = `refs/heads/${baseBranch}`;
  const baseHead = git(repo, "rev-parse", baseRef);
  const pending: LandLane[] = [];
  const merged: string[] = [];
  for (const [index, lane] of lanes.entries()) {
    const target = prepareLane(lane, entries[index]!, repo, baseRef);
    if (target) pending.push(target);
    else merged.push(lane);
  }
  const merges: string[] = [];
  let candidate = baseHead;
  for (const target of pending) merges.push(candidate = mergeCandidate(repo, candidate, target));
  const checkout = branchCheckout(repo, baseRef);
  if (checkout && candidate !== baseHead) refuseOverlap(checkout, repo, baseHead, candidate);
  let landed = pending;
  let culprit: string | undefined;
  const failure = pending.length ? proveMerge(repo, candidate, pending) : undefined;
  if (failure && pending.length === 1) fail(`cannot land ${pending[0]!.lane}: ${failure}`);
  if (failure) {
    const failures = new Map([[pending.length, failure]]);
    const red = firstRedPrefix(pending.length, (prefix) => {
      const result = proveMerge(repo, merges[prefix - 1]!, pending.slice(0, prefix));
      if (result) failures.set(prefix, result);
      return !result;
    });
    culprit = `merging ${pending[red - 1]!.lane} turned the batch red: ${failures.get(red)}`;
    landed = pending.slice(0, red - 1);
    candidate = red > 1 ? merges[red - 2]! : baseHead;
  }
  if (candidate !== baseHead) {
    if (!checkout) git(repo, "update-ref", baseRef, candidate, baseHead);
    else {
      refuseOverlap(checkout, repo, baseHead, candidate);
      git(checkout, "merge", "--ff-only", "--quiet", candidate);
    }
    withLedger((ledger) => { for (const target of landed) ledger[target.lane]!.landedCommit = candidate; });
  }
  const retiring = [...merged, ...landed.map((target) => target.lane)];
  const pushed = retiring.length ? pushBranch(repo, baseBranch) : "nothing pushed";
  for (const lane of retiring) retireLane(lane, entries[lanes.indexOf(lane)]!, repo, baseRef, `landed ${candidate}`);
  if (retiring.length) console.log(`cdx: landed ${retiring.join(", ")} on ${baseBranch} as ${candidate}; ${pushed}; removed worktrees and branches, closed`);
  if (culprit) fail(`${culprit}${landed.length ? "" : "; nothing landed"}`);
}

export function landCommand(argv: string[]): void {
  const batch = argv[0] === "--batch";
  const lanes = batch ? argv.slice(1) : argv;
  if (!lanes.length || !batch && lanes.length > 1 || lanes.some((lane) => lane.startsWith("-"))) fail("usage: cdx land <lane> | cdx land --batch <lane>...");
  if (new Set(lanes).size !== lanes.length) fail("cdx land --batch names a lane twice");
  const entries = lanes.map((lane) => {
    const entry = readLane(lane);
    requireOwnChild(lane, entry);
    return entry;
  });
  const repo = entries[0]!.worktreeRepo;
  const baseBranch = entries[0]!.baseBranch ?? "main";
  if (!repo) fail(`cannot land ${lanes[0]}: lane has no managed worktree`);
  if (entries.some((entry) => entry.worktreeRepo !== repo || (entry.baseBranch ?? "main") !== baseBranch)) fail("cdx land --batch needs lanes from one repository and base branch");
  const supervisor = supervisorLane();
  if (supervisor && readLane(supervisor).branch !== baseBranch) fail(`supervisor ${supervisor} lands children only into its own worktree branch; the liaison lands the rest`);
  const lock = `${git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")}/cdx-land.lock`;
  try { mkdirSync(lock); } catch { fail(`another landing holds ${lock}`); }
  try { landLanes(lanes, entries, repo, baseBranch); } finally { rmdirSync(lock); }
}

export interface StaleWorktree { repo: string; path: string; branch: string; action: "remove" | "remove-worktree"; ageDays: number }

// Merged worktrees go with their branch. A closed or unrecorded lane keeps an
// unmerged branch so committed work survives; git itself refuses dirty trees.
export function staleWorktreeAction(item: { running: boolean; closed: boolean; merged: boolean; ageDays: number }, days: number): StaleWorktree["action"] | undefined {
  if (item.running || item.ageDays < days) return;
  if (item.merged) return "remove";
  if (item.closed) return "remove-worktree";
}

export function staleWorktrees(ledger: Ledger, days: number, now = Date.now()): StaleWorktree[] {
  const repos = new Map<string, string>();
  for (const entry of Object.values(ledger)) {
    if (!entry.worktreeRepo || !existsSync(entry.worktreeRepo)) continue;
    const common = Bun.spawnSync({ cmd: ["git", "-C", entry.worktreeRepo, "rev-parse", "--path-format=absolute", "--git-common-dir"] });
    if (common.success) repos.set(common.stdout.toString().trim(), entry.worktreeRepo);
  }
  const stale: StaleWorktree[] = [];
  for (const repo of repos.values()) {
    const blocks = git(repo, "worktree", "list", "--porcelain").split("\n\n");
    const primaryRef = blocks[0]?.match(/^branch (.+)$/m)?.[1];
    for (const block of blocks.slice(1)) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      const ref = block.match(/^branch (refs\/heads\/lane\/.+)$/m)?.[1];
      if (!path || !ref) continue;
      const branch = ref.slice("refs/heads/".length);
      const entry = ledger[branch.slice("lane/".length)];
      const bases = [entry?.baseBranch ? `refs/heads/${entry.baseBranch}` : undefined, primaryRef].filter((base): base is string => Boolean(base));
      const committed = Number(Bun.spawnSync({ cmd: ["git", "-C", repo, "log", "-1", "--format=%ct", ref] }).stdout.toString().trim()) * 1000;
      const ageDays = (now - Math.max(committed || 0, entry ? Date.parse(entry.updatedAt) : 0)) / 86_400_000;
      const action = staleWorktreeAction({
        running: Boolean(entry && laneRunning(entry)), closed: !entry || entry.work.state === "closed",
        merged: bases.some((base) => gitOk(repo, "merge-base", "--is-ancestor", ref, base)), ageDays,
      }, days);
      if (action) stale.push({ repo, path, branch, action, ageDays });
    }
  }
  return stale;
}

export function removeStaleWorktree(item: StaleWorktree): string {
  const remove = Bun.spawnSync({ cmd: ["git", "-C", item.repo, "worktree", "remove", item.path] });
  if (!remove.success) throw new CmdError(`kept ${displayPath(item.path)}: ${remove.stderr.toString().trim().split("\n").at(-1)}`);
  if (item.action === "remove-worktree") return `removed ${displayPath(item.path)}; kept unmerged branch ${item.branch}`;
  git(item.repo, "branch", "-D", item.branch);
  return `removed ${displayPath(item.path)} and branch ${item.branch}`;
}
