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
