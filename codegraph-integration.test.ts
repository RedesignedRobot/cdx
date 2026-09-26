import { expect, test } from "bun:test";
import { codegraphRoot, roundTools } from "./engines.ts";
import { laneProgress } from "./status.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import type { Lane } from "./ledger.ts";

test("index lookup ascends subdirectories but never crosses a nested checkout", () => {
  const paths = new Set(["/repo/.codegraph", "/repo/nested/.git"]);
  expect(codegraphRoot("/repo/src/ui", (path) => paths.has(path))).toBe("/repo");
  expect(codegraphRoot("/repo/nested/src", (path) => paths.has(path))).toBeUndefined();
  expect(codegraphRoot("/outside", (path) => paths.has(path))).toBeUndefined();
});

test("structured round accounting reaches the status counters", () => {
  const track = roundTools("/repo", VISIBILITY_DEFAULTS, () => null, undefined, () => "/repo");
  const progress = track({ method: "item/completed", params: { item: {
    id: "search", type: "commandExecution", command: "rg 'export.*function' src/api.ts", exitCode: 0,
  } } }, "2026-09-26T10:00:00Z")!;
  expect(progress.codeSearchesBeforeGraph).toBe(1);
  expect(progress.codegraphThrash).toBeTruthy();
  const entry = {
    roundCodegraphCalls: progress.codegraphCalls,
    roundCodeSearchesBeforeGraph: progress.codeSearchesBeforeGraph,
  } as Lane;
  expect(laneProgress(entry, undefined)).toContain("codegraph=0 code-before-graph=1");
});
