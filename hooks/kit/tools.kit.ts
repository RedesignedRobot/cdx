// The native tools through the engine's tool.call chain; see rollover.kit.ts.
import { expect, mock, test } from "claude-code/testing";
import type { On, ProcessRunInit } from "claude-code";

function engine(on: On, runs: { argv: readonly string[]; init?: ProcessRunInit }[]) {
  mock.clock(on);
  on("session.id", () => ({ value: "head" }));
  on("session.cwd", () => ({ value: "/tmp" }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("tool.register", () => ({ value: undefined }) as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("fs.stat", () => ({ value: { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 } }) as never);
  on("process.run", (_$, e) => {
    runs.push(e);
    return { value: { exitCode: 0, stdout: "ok", stderr: "" } } as never;
  });
}

test("land with neither lane nor lanes is refused before any cdx command runs", async ($, on) => {
  const runs: { argv: readonly string[] }[] = [];
  engine(on, runs);
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  runs.length = 0;
  const result = await $.tool.call({ tool: "mcp__cdx__land" } as never);
  expect(result).toMatchObject({ isError: true, result: expect.stringContaining("lane or lanes") });
  expect(runs).toEqual([]);
});

test("a tool with no bound of its own runs at the ten minute ceiling, ask keeps its own", async ($, on) => {
  const runs: { argv: readonly string[]; init?: ProcessRunInit }[] = [];
  engine(on, runs);
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  runs.length = 0;
  await $.tool.call({ tool: "mcp__cdx__spawn", lane: "l", cd: "/repo", brief: "b" } as never);
  await $.tool.call({ tool: "mcp__cdx__ask", cd: "/repo", question: "q" } as never);
  expect(runs.map((run) => [run.argv.at(2), run.init?.timeoutMs])).toEqual([["spawn", 600_000], ["ask", 100_000]]);
});

test("an interactive start claims the head with brief --head, a headless start only reads the brief", async ($, on) => {
  const runs: { argv: readonly string[] }[] = [];
  engine(on, runs);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  expect(runs.map((run) => run.argv.slice(2))).toEqual([["brief", "--head"], ["brief"]]);
});
