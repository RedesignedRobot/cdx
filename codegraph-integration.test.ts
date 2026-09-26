import { expect, test } from "bun:test";
import { roundTools } from "./engines.ts";
import { codegraphRoot } from "./sandbox.ts";
import { laneProgress } from "./status.ts";
import { VISIBILITY_DEFAULTS } from "./visibility.ts";
import type { Lane } from "./ledger.ts";

test("index lookup never climbs past the checkout or outside one, and a linked worktree borrows its primary's index", () => {
  const paths = new Set(["/repo/.codegraph/codegraph.db", "/repo/.git", "/repo/nested/.git", "/code/.codegraph/codegraph.db",
    "/code/wt/lane/.git", "/code/wt/lane/.codegraph", "/code/wt/own/.git", "/code/wt/own/.codegraph/codegraph.db", "/repo/pkg/.codegraph/codegraph.db"]);
  const exists = (path: string) => paths.has(path);
  const gitFile = (path: string) => path.startsWith("/code/wt/") ? `gitdir: /repo/.git/worktrees/${path.split("/")[3]}\n` : undefined;
  expect(codegraphRoot("/repo/src/ui", exists, gitFile)).toBe("/repo");
  expect(codegraphRoot("/repo/nested/src", exists, gitFile)).toBeUndefined();
  expect(codegraphRoot("/code/wt/lane/src", exists, gitFile)).toBe("/repo");
  expect(codegraphRoot("/code/wt/own/src", exists, gitFile)).toBe("/code/wt/own");
  expect(codegraphRoot("/outside", exists, gitFile)).toBeUndefined();
  expect(codegraphRoot("/code/scratch", exists, gitFile)).toBeUndefined();
  expect(codegraphRoot("/repo/pkg/src", exists, gitFile)).toBe("/repo/pkg");
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
