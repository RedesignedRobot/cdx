// Worktree creation, reuse, directory persistence, and cleanup.

import { config } from "./config.ts";
import { type Lane, type Spec } from "./ledger.ts";
import { specPathOf } from "./reports.ts";
import { CmdError, displayPath, fail, shellQuote, uncoloredChildEnv } from "./runtime.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";

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

export interface WorktreeInfo { path: string; repo: string; branch: string }

export function createWorktree(repo: string, target: string, lane: string): WorktreeInfo {
  const top = Bun.spawnSync({ cmd: ["git", "-C", repo, "rev-parse", "--show-toplevel"] });
  if (!top.success) fail(`--worktree needs a git repository at ${repo}`);
  const repoRoot = top.stdout.toString().trim();
  const path = target.startsWith("/") ? target : `${process.cwd()}/${target}`;
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
    return { path, repo: repoRoot, branch };
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
  return { path, repo: repoRoot, branch };
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
