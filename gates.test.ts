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

test("scoped receipts ignore sibling edits and still reject owned edits", () => {
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
  expect(makeGateReceipt(1, "/repo", "check", 0, "now", before, snapshot(["own.ts"])).valid).toBe(true);
  owned = "changed";
  expect(makeGateReceipt(1, "/repo", "check", 0, "now", before, snapshot(["own.ts"])).valid).toBe(false);
  expect(snapshot([]).tree).toBe("original");
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
