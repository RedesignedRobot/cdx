// Private, frozen checkouts for review and gate execution.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ROOT, CmdError } from "./runtime.ts";
import { captureGateTree, executeGate, verifyGate } from "./gates.ts";
import type { GateTree } from "./ledger.ts";

export const SNAPSHOT_ROOT = join(ROOT, "snapshots");

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args] });
  if (!result.success) throw new CmdError(`snapshot failed: git ${args[0]}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

export interface ReviewSnapshot { path: string; cwd: string; tree: GateTree }

export function materializeGitTree(tree: GateTree, actions: {
  clone(): void; checkout(head: string): void; readTree(tree: string): void; privatizeGit(): void; resetIndex(head: string): void;
}): void {
  actions.clone();
  actions.checkout(tree.head);
  actions.readTree(tree.tree);
  actions.privatizeGit();
  actions.resetIndex(tree.head);
}

function sameTree(left: GateTree | undefined, right: GateTree): boolean {
  return Boolean(left && left.head === right.head && left.tree === right.tree);
}

function escapeIgnorePath(path: string): string {
  return `/${path.replace(/([\\*?\[\]#!])/g, "\\$1")}`;
}

// Ignored dependencies stay shared. Linking the entire entry preserves package
// and .bin link resolution without traversing large node_modules/generated trees.
export function linkIgnoredEntries(source: string, tree: string, entries: string[], io = {
  exists: existsSync,
  mkdir: (path: string) => { mkdirSync(path, { recursive: true }); },
  link: (target: string, path: string) => { symlinkSync(target, path); },
}): string[] {
  const excludes: string[] = [];
  for (const entry of entries) {
    const name = entry.replace(/\/$/, "");
    const origin = join(source, name), destination = join(tree, name);
    if (!io.exists(origin) || io.exists(destination)) continue;
    io.mkdir(dirname(destination));
    io.link(origin, destination);
    // The snapshot entry is a symlink, so a directory-only ignore does not match.
    excludes.push(escapeIgnorePath(name));
  }
  return excludes;
}

export function createReviewSnapshot(cwd: string, lane: string, round: number, expectedTree?: GateTree): ReviewSnapshot {
  const sourceCwd = realpathSync(cwd);
  const source = realpathSync(git(sourceCwd, "rev-parse", "--show-toplevel"));
  const before = expectedTree ?? captureGateTree(sourceCwd);
  if (!before) throw new CmdError("snapshot requires a git tree");
  if (!expectedTree && !sameTree(captureGateTree(sourceCwd), before)) throw new CmdError("source tree moved during snapshot capture");
  mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  const container = join(SNAPSHOT_ROOT, `${lane}-r${round}-${process.pid}-${Date.now()}`);
  const path = join(container, "tree");
  mkdirSync(container, { mode: 0o700 });
  try {
    writeFileSync(join(container, "meta.json"), JSON.stringify({ lane, round, pid: process.pid, source, tree: before }));
    materializeGitTree(before, {
      clone: () => {
        const clone = Bun.spawnSync({ cmd: ["git", "clone", "--shared", "--no-checkout", "--", source, path] });
        if (!clone.success) throw new CmdError(`snapshot clone failed: ${clone.stderr.toString().trim()}`);
      },
      checkout: (head) => { git(path, "checkout", "--detach", head); },
      readTree: (tree) => { git(path, "read-tree", "--reset", "-u", tree); },
      privatizeGit: () => {
        renameSync(join(path, ".git"), join(container, "git"));
        writeFileSync(join(path, ".git"), `gitdir: ${join(container, "git")}\n`);
      },
      resetIndex: (head) => { git(path, "read-tree", head); },
    });
    const ignored = git(source, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z")
      .split("\0").filter(Boolean);
    const excludes = linkIgnoredEntries(source, path, ignored);
    if (excludes.length) writeFileSync(join(container, "git", "info", "exclude"), `${excludes.join("\n")}\n`);
    if (!sameTree(captureGateTree(path), before)) throw new CmdError("snapshot tree differs from captured tree");
    // The private index tracks HEAD, so review tools can inspect the captured diff.
    return { path, cwd: join(path, relative(source, sourceCwd)), tree: before };
  } catch (error) {
    rmSync(container, { recursive: true, force: true });
    throw error;
  }
}

export function removeReviewSnapshot(path: string): void {
  const container = dirname(resolve(path));
  if (dirname(container) !== SNAPSHOT_ROOT || path !== join(container, "tree")) throw new CmdError("snapshot path is outside the managed snapshot directory");
  rmSync(container, { recursive: true, force: true });
}

export function staleReviewSnapshots(alive: (pid: number) => boolean, io = {
  exists: existsSync, entries: (path: string) => readdirSync(path), isDirectory: (path: string) => lstatSync(path).isDirectory(),
  read: (path: string) => readFileSync(path, "utf8"),
}): string[] {
  if (!io.exists(SNAPSHOT_ROOT)) return [];
  return io.entries(SNAPSHOT_ROOT).flatMap((name) => {
    const container = join(SNAPSHOT_ROOT, name);
    if (!io.isDirectory(container)) return [];
    try {
      const record = JSON.parse(io.read(join(container, "meta.json")));
      return Number.isInteger(record.pid) && alive(record.pid) ? [] : [join(container, "tree")];
    } catch { return [join(container, "tree")]; }
  });
}

interface FrozenGateOps {
  create?: typeof createReviewSnapshot;
  capture?: typeof captureGateTree;
  execute?: typeof executeGate;
  remove?: typeof removeReviewSnapshot;
  changedPaths?: (before: GateTree, after: GateTree) => string[];
}

export function runFrozenGate(round: number, cwd: string, command: string, logPath: string, lane: string, ops: FrozenGateOps = {}) {
  const snapshot = (ops.create ?? createReviewSnapshot)(cwd, lane, round);
  try {
    const capture = () => (ops.capture ?? captureGateTree)(snapshot.cwd);
    const initial = capture();
    if (!sameTree(initial, snapshot.tree)) throw new CmdError("frozen gate tree differs from captured tree");
    let first = true;
    const changedPaths = ops.changedPaths ?? ((before: GateTree, after: GateTree) => {
      const diff = Bun.spawnSync({ cmd: ["git", "-C", snapshot.cwd, "diff", "--name-only", before.tree, after.tree] });
      return diff.success ? diff.stdout.toString().trim().split("\n").filter(Boolean) : [];
    });
    return verifyGate(round, cwd, command, () => {
      if (first) { first = false; return initial; }
      return capture();
    }, () => (ops.execute ?? executeGate)(command, snapshot.cwd, logPath), changedPaths);
  } finally { (ops.remove ?? removeReviewSnapshot)(snapshot.path); }
}
