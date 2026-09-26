import { expect, test } from "bun:test";
import { codegraphActions } from "./codegraph-policy.ts";
import { roundProgress, toolObservation } from "./visibility.ts";

const indexed = (path: string) => path === "/repo" || path.startsWith("/repo/") ? "/repo" :
  path === "/other" || path.startsWith("/other/") ? "/other" : undefined;

test("shell order, effective cwd, and exact CLI name decide the first graph per repository", () => {
  const progress = roundProgress("/repo", undefined, undefined, indexed);
  const result = progress({ completed: true, files: [], command: "rg symbol src; cd /other && codegraph explore symbol; cd /repo && codegraph explore symbol; rg next src" });
  expect(result).toMatchObject({ codegraphCalls: 2, codeSearchesBeforeGraph: 1 });
  expect(result.codegraphThrash).toContain("/repo");
  expect(result.codegraphThrash).toContain("codegraph-first: use codegraph explore before code questions");
  expect(result.codegraphThrash).toContain("Exceptions: fixed-string or existence searches, non-code files, logs.");
  expect(progress({ completed: true, files: [], command: "rg later src" })).toMatchObject({ codegraphCalls: 2, codeSearchesBeforeGraph: 1 });
  expect(codegraphActions({ command: "echo 'codegraph explore'; mycodegraph explore; codegraph search x" }, "/repo")).toEqual([]);
  expect(codegraphActions({ command: "rg needle src/a.ts\ncodegraph explore a\nrg next src/b.ts" }, "/repo"))
    .toEqual([{ kind: "search", cwd: "/repo/src/a.ts" }, { kind: "graph", cwd: "/repo" }, { kind: "search", cwd: "/repo/src/b.ts" }]);
  expect(codegraphActions({ command: "rg needle ';' src/a.ts" }, "/repo"))
    .toEqual([{ kind: "search", cwd: "/repo/src/a.ts" }]);
});

test("nested shell and absolute source target use the target repository", () => {
  const progress = roundProgress("/tmp", undefined, undefined, indexed);
  expect(progress({ completed: true, files: [], command: "/bin/zsh -lc 'cd /repo && rg needle src/a.ts; codegraph explore a'" }))
    .toMatchObject({ codegraphCalls: 1, codeSearchesBeforeGraph: 1 });
  expect(progress({ completed: true, files: [], command: "rg needle /other/src/a.ts" }))
    .toMatchObject({ codegraphCalls: 1, codeSearchesBeforeGraph: 2 });
  expect(progress({ completed: true, files: [], command: "cd /tmp && rg needle src/a.ts" }))
    .toMatchObject({ codegraphCalls: 1, codeSearchesBeforeGraph: 2 });
});

test("structured adapters preserve MCP identity, cwd, args, and phases", () => {
  const progress = roundProgress("/tmp", undefined, undefined, indexed);
  const codex = (method: string) => toolObservation({ method, params: { turnId: "t", item: {
    id: "one", type: "mcpToolCall", server: "codegraph", tool: "codegraph_explore", cwd: "/tmp", arguments: { projectPath: "/repo", query: "a" },
  } } })!;
  expect(codex("item/started")).toMatchObject({ toolName: "codegraph/codegraph_explore", cwd: "/tmp", args: { projectPath: "/repo" } });
  expect(progress(codex("item/started")).codegraphCalls).toBe(1);
  expect(progress(codex("item/completed")).codegraphCalls).toBe(1);
  const gemini = (state: string) => toolObservation({ event: "step_update", step_update: {
    step_type: "tool", state, conversation_id: "g", step_index: 2, tool_name: "mcp__codegraph__codegraph_explore",
    tool_info: { parameters: JSON.stringify({ projectPath: "/other", query: "b" }) },
  } })!;
  expect(gemini("ACTIVE")).toMatchObject({ toolName: "mcp__codegraph__codegraph_explore", args: { projectPath: "/other" } });
  expect(progress(gemini("ACTIVE")).codegraphCalls).toBe(2);
  expect(progress(gemini("DONE")).codegraphCalls).toBe(2);
  expect(progress({ completed: true, files: [], toolName: "mcp__other__codegraph_explore" }).codegraphCalls).toBe(2);
  const delayed = roundProgress("/tmp", undefined, undefined, indexed);
  expect(delayed({ id: "late", completed: false, files: [], toolName: "mcp__codegraph__codegraph_explore" }).codegraphCalls).toBe(0);
  expect(delayed({ id: "late", completed: true, files: [], toolName: "mcp__codegraph__codegraph_explore", args: { projectPath: "/repo" } }).codegraphCalls).toBe(1);
  expect(delayed({ id: "search", completed: false, files: [] }).codeSearchesBeforeGraph).toBe(0);
  expect(delayed({ id: "search", completed: true, files: [], command: "rg needle /other/src/a.ts" }).codeSearchesBeforeGraph).toBe(1);
});

test("clear exceptions and uncertain commands do not become source searches", () => {
  const progress = roundProgress("/repo", undefined, undefined, indexed);
  for (const command of ["rg -F needle src/a.ts", "rg -Fn needle src/a.ts", "rg -Fq needle src/a.ts", "rg -ql needle src/a.ts", "rg -g '*.md' needle .", "rg --glob '*.json' needle .", "rg -t md needle .", "rg --type json needle .", "rg needle README.md", "rg needle logs/run.log", "rg --files src", "rg -l needle src", "grep -q needle src/a.ts", "ls src", "test -e src/a.ts", "rg needle", "echo 'rg needle src'", "rg needle docs/"]) {
    expect(progress({ completed: true, files: [], command }).codeSearchesBeforeGraph).toBe(0);
  }
  expect(progress({ completed: true, files: [], command: "rg -n needle src/a.ts" }).codeSearchesBeforeGraph).toBe(1);
  expect(progress({ completed: true, files: [], command: "grep -e needle src/b.ts" }).codeSearchesBeforeGraph).toBe(2);
  expect(progress({ completed: true, files: [], command: "rg -g '*.ts' needle ." }).codeSearchesBeforeGraph).toBe(3);
  expect(progress({ completed: true, files: [], command: "rg needle src/c.ts" })).toMatchObject({ codeSearchesBeforeGraph: 4, codegraphThrash: undefined });
});

test("default resolver stays pure and each round resets accounting", () => {
  const observation = { completed: true, files: [], command: "rg needle src/a.ts; codegraph explore a" };
  expect(roundProgress("/repo")(observation)).toMatchObject({ codegraphCalls: 0, codeSearchesBeforeGraph: 0, codegraphThrash: undefined });
  expect(roundProgress("/repo", undefined, undefined, indexed)(observation)).toMatchObject({ codegraphCalls: 1, codeSearchesBeforeGraph: 1 });
});
