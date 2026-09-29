// A hot reload runs the module afresh with empty variables and may skip
// session.start. Each test here loads the plugin without calling it, which is
// that state; run.sh runs these.
import { expect, mock, test } from "claude-code/testing";
import type { On, ProcessRunInit } from "claude-code";

type Run = { argv: readonly string[]; init?: ProcessRunInit };

function engine(on: On, runs: Run[], sessionId: string | (() => string) = "head") {
  const clock = mock.clock(on);
  on("session.id", () => ({ value: typeof sessionId === "string" ? sessionId : sessionId() }));
  on("session.cwd", () => ({ value: "/tmp" }));
  on("session.surfaces", () => ({ value: ["terminal"] }) as never);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("tool.register", () => ({ value: undefined }) as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("fs.stat", () => ({ value: { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 } }) as never);
  on("process.run", (_$, e) => {
    runs.push(e);
    return { value: { exitCode: 0, stdout: "", stderr: "" } } as never;
  });
  return clock;
}

const job = { tool: "mcp__cdx__job", name: "j", cmd: "true", cd: "/repo" };
const polls = (runs: Run[]) => runs.filter((run) => run.argv.at(2) === "events").map((run) => run.init?.env?.CLAUDE_CODE_SESSION_ID);

test("after a reload with no session.start the next tool call and poll carry the session id", async ($, on) => {
  const runs: Run[] = [];
  const clock = engine(on, runs);
  await $.tool.call(job as never);
  expect(runs.map((run) => [run.argv.at(2), run.init?.env?.CLAUDE_CODE_SESSION_ID])).toEqual([["job", "head"]]);
  await clock.advance(2000);
  expect(polls(runs)).toEqual(["head"]);
});

test("a session.start after the lazy start leaves one poll timer", async ($, on) => {
  const runs: Run[] = [];
  const clock = engine(on, runs);
  await $.tool.call({ tool: "mcp__cdx__status" } as never);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await $.tool.call({ tool: "mcp__cdx__status" } as never);
  await clock.advance(6000);
  expect(polls(runs)).toEqual(["head", "head", "head"]);
});

test("a newer instance's claim stops this instance's poller", async ($, on) => {
  const runs: Run[] = [];
  let newer: string | undefined;
  const clock = engine(on, runs);
  on("state.get", { plugin: "cdx", key: "poller" }, (_$, e, next) =>
    newer ? ({ value: { value: newer, version: 99 } }) as never : next(e));
  await $.tool.call({ tool: "mcp__cdx__status" } as never);
  await clock.advance(2000);
  newer = "reloaded";
  await clock.advance(6000);
  expect(polls(runs)).toEqual(["head"]);
});

// The host holds $.state per session, so the session a /clear or /resume
// moves the process to starts with no poller claim.
function stateBySession(on: On, current: () => string) {
  const claims = new Map<string, string>();
  on("state.set", { plugin: "cdx", key: "poller" }, (_$, e) => {
    claims.set(current(), e.value);
    return { value: { isSet: true, version: 1 } } as never;
  });
  on("state.get", { plugin: "cdx", key: "poller" }, () =>
    ({ value: { value: claims.get(current()), version: claims.has(current()) ? 1 : 0 } }) as never);
}

test("a /resume into a session with no poller claim keeps the poll running under the new id", async ($, on) => {
  const runs: Run[] = [];
  let id = "fresh";
  const clock = engine(on, runs, () => id);
  stateBySession(on, () => id);
  on("command.run", { command: ["clear", "resume"] }, () => ({ text: "" }) as never);
  await $.session.start({ cwd: "/tmp", surface: "terminal", isInteractive: true });
  await clock.advance(2000);
  id = "head";
  await $.command.run({ command: "resume", args: "" } as never);
  await clock.advance(6000);
  expect(polls(runs)).toEqual(["fresh", "head", "head", "head"]);
});

test("a lane or job tool with no session id is refused, a read runs", async ($, on) => {
  const runs: Run[] = [];
  engine(on, runs, "");
  expect(await $.tool.call(job as never)).toMatchObject({ isError: true, result: expect.stringContaining("no session id") });
  expect(await $.tool.call({ tool: "mcp__cdx__spawn", lane: "l", cd: "/repo", brief: "b" } as never)).toMatchObject({ isError: true });
  await $.tool.call({ tool: "mcp__cdx__status" } as never);
  expect(runs.map((run) => run.argv.at(2))).toEqual(["status"]);
});
