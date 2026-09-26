import { expect, test } from "bun:test";
import { gateFailure, gateOutputForReport, type GateFailureKind } from "./gates.ts";

const diagnostics: Record<GateFailureKind, string> = {
  typecheck: "src/a.ts(7,1): error TS2322: Type 'number' is not assignable to type 'string'.",
  lint: "  7:2  error  Unexpected any  @typescript-eslint/no-explicit-any",
  assertion: "AssertionError: expected true to be false",
  architecture: "error no-runtime-cycles: a.ts -> b.ts -> a.ts",
  formatter: "Format issues found in 4 files",
  "spec cap": "cap breach: test.spec.ts: 2229 over 400",
  "missing spec": "unreadable spec: missing.spec.ts",
  "stale generated": "schema is stale: regenerate the schema",
  "dirty tree": "diff --git a/a.ts b/a.ts",
  setup: "error: Could not resolve package vite-plus",
  "tool crash": "thread 'main' panicked at formatter.rs:7",
};
for (const [kind, diagnostic] of Object.entries(diagnostics) as Array<[GateFailureKind, string]>) {
  test(`first fatal gate diagnostic preserves ${kind} before its tail`, () => {
    const output = `starting gate\nspec cap passed\nAll matched files use the correct format\n${diagnostic}\n${"detail\n".repeat(1000)}AssertionError: later failure`;
    expect(gateFailure(1, output)).toEqual({ kind, diagnostic });
    const report = gateOutputForReport(output, 1);
    expect(report.startsWith(`gate ${kind} failed\n${diagnostic}\n`)).toBe(true);
    expect(report.endsWith("AssertionError: later failure")).toBe(true);
  });
}

import { gateTreeFromGit, makeGateReceipt, repairGateOnce, failureDigest } from "./gates.ts";
import { refreshChangedLandReceipt, resolveWorktreeTarget } from "./worktrees.ts";
import { linkIgnoredEntries, materializeGitTree, runFrozenGate, staleReviewSnapshots, SNAPSHOT_ROOT } from "./snapshots.ts";
import type { GateTree, Lane } from "./ledger.ts";
import { join } from "node:path";
import { reviewBaseTarget } from "./lane-commands.ts";

test("bare worktree names resolve under the managed directory", () => {
  expect(resolveWorktreeTarget("feature")).toBe(join(process.env.HOME ?? "", "code", "wt", "feature"));
  expect(resolveWorktreeTarget("local/feature")).toBe(join(process.cwd(), "local/feature"));
});

test("review materializes the supplied dirty tree in private Git state", () => {
  const expected = { head: "reviewed-head", tree: "dirty-reviewed-tree" };
  let liveHead = "later-commit";
  const privateRepo = { head: "", tree: "", index: "", private: false };
  materializeGitTree(expected, {
    clone: () => { privateRepo.head = liveHead; },
    checkout: (head) => { privateRepo.head = head; },
    readTree: (tree) => { privateRepo.tree = tree; },
    privatizeGit: () => { privateRepo.private = true; },
    resetIndex: (head) => { privateRepo.index = head; },
  });
  liveHead = "another-commit";
  expect(privateRepo).toEqual({ head: expected.head, tree: expected.tree, index: expected.head, private: true });
});

test("frozen gate proves its captured tree despite source movement and cleans up", () => {
  let sourceTree = "original";
  let frozenTree = "original";
  let removals = 0;
  const ops = {
    create: () => ({ path: "/private/tree", cwd: "/private/tree/subdir", tree: { head: "h", tree: frozenTree } }),
    capture: (cwd: string): GateTree => { expect(cwd).toBe("/private/tree/subdir"); return { head: "h", tree: frozenTree }; },
    execute: () => { sourceTree = "later"; return { exitCode: 0, output: "", timedOut: false }; },
    remove: (path: string) => { expect(path).toBe("/private/tree"); removals++; },
    changedPaths: () => ["changed.ts"],
  };
  expect(runFrozenGate(2, "/source/subdir", "check", "/log", "lane", ops).receipt).toMatchObject({ valid: true, cwd: "/source/subdir", head: "h", tree: "original" });
  expect(sourceTree).toBe("later");
  frozenTree = "mutated";
  ops.execute = () => { frozenTree = "mutated-again"; return { exitCode: 0, output: "", timedOut: false }; };
  expect(runFrozenGate(2, "/source/subdir", "check", "/log", "lane", ops).receipt.reason).toContain("tree changed during gate");
  expect(removals).toBe(2);
});

test("frozen gate refuses a mismatched checkout before executing and removes it", () => {
  let executed = 0, removed = 0;
  expect(() => runFrozenGate(2, "/source", "check", "/log", "lane", {
    create: () => ({ path: "/private/tree", cwd: "/private/tree", tree: { head: "h", tree: "intended" } }),
    capture: () => ({ head: "h", tree: "different" }),
    execute: () => { executed++; return { exitCode: 0, output: "", timedOut: false }; },
    remove: () => { removed++; },
  })).toThrow("frozen gate tree differs from captured tree");
  expect([executed, removed]).toEqual([0, 1]);
});

test("doctor discovers dead and incomplete snapshots", () => {
  const stale = staleReviewSnapshots((pid) => pid === 11, {
    exists: () => true,
    entries: () => ["live", "dead", "incomplete"],
    isDirectory: () => true,
    read: (path) => {
      if (path.includes("incomplete")) throw new Error("crashed before metadata");
      return JSON.stringify({ pid: path.includes("live") ? 11 : 12 });
    },
  });
  expect(stale).toEqual([join(SNAPSHOT_ROOT, "dead", "tree"), join(SNAPSHOT_ROOT, "incomplete", "tree")]);
});

test("land reruns one gate for a changed green tree and refuses red", () => {
  const receipt = makeGateReceipt(1, "/work", "check", 0, "now", { head: "h", tree: "old" }, { head: "h", tree: "old" });
  const entry = { worktreePath: "/work", worktreeRepo: "/base", branch: "lane/x", work: { state: "done", round: 1, exitCode: 0 }, gateReceipt: receipt } as Lane;
  let runs = 0;
  const run = (exitCode: number) => refreshChangedLandReceipt(entry, false, { head: "h", tree: "new" },
    () => { runs++; return makeGateReceipt(1, "/work", "check", exitCode, "now", { head: "h", tree: "new" }, { head: "h", tree: "new" }); },
    () => {}, () => ({ head: "h", tree: "new" }));
  expect(run(0).refusal).toBeUndefined();
  expect(runs).toBe(1);
  entry.gateReceipt = receipt;
  expect(run(1).refusal).toBe("gate failed");
  expect(runs).toBe(2);
});

test("gate receipts prove the full tree even when paths are supplied", () => {
  let owned = "original", sibling = "before";
  const snapshot = (paths?: string[]) => {
    let selected: string[] = [];
    return gateTreeFromGit("/repo", (_cwd, verb, ...args) => {
      if (verb === "rev-parse") return "head";
      if (verb === "add") selected = args.slice(2);
      if (verb === "write-tree") return selected.includes(".") ? owned + sibling : selected.includes("own.ts") ? owned : "original";
      return "";
    }, paths);
  };
  const before = snapshot(["own.ts"]);
  sibling = "changed";
  expect(makeGateReceipt(1, "/repo", "check", 0, "now", before, snapshot(["own.ts"])).valid).toBe(false);
  owned = "changed";
  expect(makeGateReceipt(1, "/repo", "check", 0, "now", before, snapshot(["own.ts"])).valid).toBe(false);
  expect(snapshot([]).tree).toBe(owned + sibling);
});

test("a red gate gets one same-conversation repair with only sixty log lines", async () => {
  let runs = 0, fixes = 0;
  const run = () => ({ gate: { exitCode: 1, output: Array.from({ length: 100 }, (_, n) => `line ${n}`).join("\n") },
    receipt: { ...makeGateReceipt(1, "/repo", "check", 1, "now", { head: "h", tree: "t" }, { head: "h", tree: "t" }), round: ++runs } });
  const result = await repairGateOnce(run, async (prompt) => {
    fixes++;
    expect(prompt).toContain("same diff");
    expect(prompt).toContain("line 40\n");
    expect(prompt).not.toContain("line 39\n");
    return true;
  });
  expect(result.gate.exitCode).toBe(1);
  expect([runs, fixes]).toEqual([2, 1]);
  for (const [code, reason] of [[0, undefined], [1, "tree changed during gate: own.ts"]] as const) {
    await repairGateOnce(() => ({ ...run(), gate: { exitCode: code, output: "" }, receipt: { ...run().receipt, reason } }), async () => { throw new Error("repair must not run"); });
  }
  const output = "setup\nerror TS2322: wrong type\n" + "detail\n".repeat(100);
  expect(failureDigest(output).split("\n")).toHaveLength(40);
  expect(failureDigest(output).startsWith("error TS2322")).toBe(true);
});


test("ignored dependency roots stay linked so nested CLI symlinks retain package resolution", () => {
  const links: [string, string][] = [];
  const excludes = linkIgnoredEntries("/source", "/snapshot", ["node_modules/", "generated/"], {
    exists: (path) => path === "/source/node_modules" || path === "/source/generated",
    mkdir: () => {},
    link: (target, path) => { links.push([target, path]); },
  });
  expect(links).toEqual([
    ["/source/node_modules", "/snapshot/node_modules"],
    ["/source/generated", "/snapshot/generated"],
  ]);
  // Directory-only ignore patterns would expose these symlinks to git add.
  expect(excludes).toEqual(["/node_modules", "/generated"]);
});

test("a refreshed land receipt clears prior landing commits in memory and persistence", () => {
  const old = { head: "C1", tree: "T1" }, fresh = { head: "C1", tree: "T2" };
  const entry = { worktreePath: "/work", worktreeRepo: "/base", branch: "lane/x",
    work: { state: "done", round: 1, exitCode: 0 }, landingCommit: "C1", landedCommit: "old-merge",
    gateReceipt: makeGateReceipt(1, "/work", "check", 0, "before", old, old) } as Lane;
  const stored = { ...entry };
  const green = makeGateReceipt(1, "/work", "check", 0, "after", fresh, fresh);
  const result = refreshChangedLandReceipt(entry, false, fresh, () => green,
    (update) => { Object.assign(stored, update); }, () => fresh);
  expect(result.refusal).toBeUndefined();
  for (const state of [entry, stored]) {
    expect(state.gateReceipt).toEqual(green);
    expect(state.landingCommit).toBeUndefined();
    expect(state.landedCommit).toBeUndefined();
  }
});

test("review bases resolve in the source repo before the snapshot prompt is built", () => {
  const commit = "a".repeat(40);
  const target = reviewBaseTarget("/source/feature", "review-base", (cwd, ...args) => {
    expect(cwd).toBe("/source/feature");
    expect(args).toEqual(["rev-parse", "--verify", "--end-of-options", "review-base^{commit}"]);
    return commit;
  });
  expect(target).toBe(`Review git diff ${commit}...HEAD.`);
  expect(target).not.toContain("review-base");
});
