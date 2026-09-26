import { expect, test } from "bun:test";
import { briefContractRefusal, isNoOpGate, isScopePermissionAsk, scopeExtensions } from "./brief-contract.ts";

const good = `Context first.

## Outcome
cdx usage --totals prints first-round green shares.

## Files
- status.ts

### Acceptance criteria:
The JSON carries outcomes.byEngine.

## Out-of-scope
accounts.ts`;

test("a work brief names outcome, files, acceptance, out of scope and a gate", () => {
  expect(briefContractRefusal(good, true, false)).toBeUndefined();
  expect(briefContractRefusal("Fix the leak.", true, false))
    .toBe('work brief refused, missing "## Outcome", "## Files", "## Acceptance", "## Out of scope"; consults and reviews are exempt');
  expect(briefContractRefusal(good.replace("accounts.ts", ""), false, false))
    .toBe('work brief refused, missing "## Out of scope", a gate (--gate or .cdx-gate); consults and reviews are exempt');
  expect(briefContractRefusal(good, true, true)).toContain('"## Children" with two or more child file sets');
  expect(briefContractRefusal(`${good}\n\n## Children\n- api: server.ts`, true, true)).toContain("## Children");
  expect(briefContractRefusal(`${good}\n\n## Child file sets\n- api: server.ts\n- ui: page.tsx`, true, true)).toBeUndefined();
});

test("scope permission asks are told apart from other questions", () => {
  for (const question of [
    "May I edit outside my files? The fix needs config.ts.",
    "Can I modify runner.ts, which is not in my owned files?",
    "Is it ok to extend scope to cover the hook?",
    "Permission to touch a file beyond the brief list: gates.ts",
  ]) expect(isScopePermissionAsk(question)).toBe(true);
  for (const question of [
    "Which account should the lane use?",
    "The gate fails on main already; should I fix it?",
    "Can I use bun:sqlite transactions here?",
  ]) expect(isScopePermissionAsk(question)).toBe(false);
});

test("scope extensions are the list items of their report section", () => {
  expect(scopeExtensions("# Report\n\n## Scope extensions\n\n- config.ts: default route\n- runner.ts\n\n## Gate\n- not this")).toEqual(["config.ts: default route", "runner.ts"]);
  expect(scopeExtensions("## Scope extensions\n\nNone.")).toEqual([]);
  expect(scopeExtensions("no section")).toEqual([]);
});

test("gates that check nothing are recognized", () => {
  for (const gate of ["true", " : ", "exit 0", "/usr/bin/true", "echo ok", "true;"]) expect(isNoOpGate(gate)).toBe(true);
  for (const gate of ["bun run check", "echo ok && bun test", "test -f out.json", "exit 1"]) expect(isNoOpGate(gate)).toBe(false);
});
