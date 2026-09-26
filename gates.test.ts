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
import { resolveWorktreeTarget } from "./worktrees.ts";
import { linkIgnoredEntries, materializeGitTree, runFrozenGate, staleReviewSnapshots, SNAPSHOT_ROOT } from "./snapshots.ts";
import type { GateTree, Lane } from "./ledger.ts";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

import { attestReview, reviewRefusal } from "./gates.ts";
import { childWorktreeTarget, firstRedPrefix, landLockHolder, landRefusal, overlappingPaths, receiptProves, staleWorktreeAction, statusPaths, takeLandLock } from "./worktrees.ts";
import { reusedLaneProof } from "./rounds.ts";
import { reviewFollowUp } from "./lane-commands.ts";
import { laneInstructions, resumeRefusal } from "./prompts.ts";
import { briefContractRefusal } from "./brief-contract.ts";

test("a review by any lane name attests to the tree it saw and gates land by content", () => {
  const work = { work: { state: "done" }, worktreePath: "/wt/feature", gateReceipt: { tree: "gated" } } as Lane;
  const ledger = { feature: work, other: { work: { state: "done" }, worktreePath: "/wt/other" } as Lane,
    "feature-audit": { work: { state: "adopted" }, reviewTree: { head: "h", tree: "gated" } } as Lane };
  attestReview(ledger, "feature-audit", false, "/r.md", "/wt/feature", (path) => path);
  expect(ledger.other.reviewAttestations).toBeUndefined();
  expect(reviewRefusal(work.reviewAttestations, ["edited", "gated"])).toContain("feature-audit has unresolved P1/P2");
  expect(resumeRefusal("review", work, "h")).toBeUndefined();
  ledger["feature-audit"]!.reviewTree = { head: "h", tree: "gated" };
  attestReview(ledger, "feature-audit", true, undefined, undefined, () => undefined);
  // Head edits after the gate keep the closed review of the gated tree.
  expect(reviewRefusal(work.reviewAttestations, ["edited", "gated"])).toBeUndefined();
  expect(reviewRefusal(work.reviewAttestations, ["worker-fix"])).toContain("not at its current or gated tree");
  expect(reviewRefusal(undefined, ["any"])).toBeUndefined();
});

test("land gates only a merge result that no green receipt already proves", () => {
  const lane = { entry: { gateReceipt: { tree: "gated" } } as Lane };
  expect(receiptProves([lane], "gated")).toBe(true);
  expect(receiptProves([lane], "head-edited")).toBe(false);
  expect(receiptProves([lane, lane], "gated")).toBe(false);
});

test("a dirty base blocks land only where the merge touches the same files", () => {
  const dirty = statusPaths(" M notes.md\0R  new.ts\0old.ts\0?? scratch.txt\0");
  expect(dirty).toEqual(["notes.md", "new.ts", "old.ts", "scratch.txt"]);
  expect(overlappingPaths(dirty, ["src/app.ts"])).toEqual([]);
  expect(overlappingPaths(dirty, ["old.ts", "src/app.ts"])).toEqual(["old.ts"]);
});

test("a red batch names the first breaking lane within log2 extra gates", () => {
  for (const [count, culprit] of [[8, 5], [8, 1], [8, 8], [5, 3]] as const) {
    let gates = 0;
    expect(firstRedPrefix(count, (prefix) => { gates++; return prefix < culprit; })).toBe(culprit);
    expect(gates).toBeLessThanOrEqual(Math.ceil(Math.log2(count)));
  }
});

test("supervisors and their children get their own worktree, and children land into the supervisor branch", () => {
  expect(childWorktreeTarget("child", undefined, "parent", false)).toBe("child");
  expect(childWorktreeTarget("child", "custom", "parent", false)).toBe("custom");
  expect(childWorktreeTarget("child", undefined, "parent", true)).toBeUndefined();
  expect(childWorktreeTarget("lane", undefined, undefined, false)).toBeUndefined();
  expect(childWorktreeTarget("sup", undefined, undefined, false, true)).toBe("sup");
  expect(childWorktreeTarget("sup", undefined, undefined, true, true)).toBeUndefined();
  const rules = laneInstructions({ supervisor: true });
  for (const heading of briefContractRefusal("", true, false)!.match(/## [A-Za-z ]+/g)!) expect(rules).toContain(heading);
  expect(rules).toContain("cdx land <child>");
  expect(rules).toContain("plain call");
  expect(rules).not.toContain("shared-tree");
});

test("doctor removes merged worktrees and keeps unmerged branches of abandoned lanes", () => {
  const old = { running: false, closed: true, merged: true, ageDays: 9 };
  expect(staleWorktreeAction(old, 7)).toBe("remove");
  expect(staleWorktreeAction({ ...old, merged: false }, 7)).toBe("remove-worktree");
  expect(staleWorktreeAction({ ...old, merged: false, closed: false }, 7)).toBeUndefined();
  expect(staleWorktreeAction({ ...old, running: true }, 7)).toBeUndefined();
  expect(staleWorktreeAction({ ...old, ageDays: 2 }, 7)).toBeUndefined();
});

test("a migrated 9.x lane with an open review cannot land until a review attests its tree", () => {
  const lane = { work: { state: "done", round: 1, exitCode: 0 }, worktreePath: "/wt/a", worktreeRepo: "/repo", branch: "lane/a",
    gateReceipt: { valid: true, round: 1, exitCode: 0, head: "h", tree: "t" }, reviewClosed: false } as Lane;
  expect(landRefusal(lane)).toContain("9.x review has unresolved P1/P2");
  expect(landRefusal({ ...lane, reviewClosed: true })).toBeUndefined();
  expect(landRefusal({ ...lane, reviewAttestations: [{ tree: "t", head: "h", reviewer: "a", closed: true, at: "" }] })).toBeUndefined();
});

test("a spawn under a closed lane's name drops the old landing and review proof; other rounds keep it", () => {
  const attestation = { tree: "t", head: "h", reviewer: "r", closed: false, at: "" };
  const closed = { work: { state: "closed" }, reviewAttestations: [attestation], landedCommit: "c", reviewClosed: false } as Lane;
  expect(reusedLaneProof("work", true, closed)).toEqual({ reviewAttestations: undefined, reviewClosed: undefined, landedCommit: undefined });
  expect(reusedLaneProof("work", false, closed)).toEqual({ reviewAttestations: [attestation], reviewClosed: false, landedCommit: "c" });
  const done = { ...closed, work: { state: "done" } } as Lane;
  expect(reusedLaneProof("work", true, done).reviewAttestations).toEqual([attestation]);
  expect(reusedLaneProof("review", false, done)).toEqual({ reviewAttestations: [attestation], reviewClosed: undefined, landedCommit: "c" });
});

test("a closed review allows a fresh review of a changed tree and refuses the same tree", () => {
  const [old, next] = [{ head: "h", tree: "old" }, { head: "h2", tree: "new" }];
  expect(reviewFollowUp("P2 overflow", false, old, next)).toContain("git diff old new");
  expect(reviewFollowUp("no findings", true, old, next)).toBe("");
  expect(() => reviewFollowUp("no findings", true, old, { head: "h2", tree: "old" })).toThrow("reuse its report");
  expect(reviewFollowUp("", true, old, next)).toBe("");
});

test("a land lock left by a dead lander is taken over; a live or pid-less one refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdx-land-lock-"));
  const lock = join(dir, "cdx-land.lock");
  try {
    writeFileSync(lock, "4242\n");
    expect(() => takeLandLock(lock, () => true)).toThrow("pid 4242");
    takeLandLock(lock, () => false);
    expect(landLockHolder(lock)).toBe(process.pid);
    rmSync(lock);
    mkdirSync(lock);
    expect(() => takeLandLock(lock, () => false)).toThrow("doctor --fix");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
