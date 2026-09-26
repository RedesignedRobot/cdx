import { afterEach, expect, spyOn, test } from "bun:test";
import { pinnedLine, type LiveRow } from "./hooks/delivery.ts";
import { storeJob } from "./jobs.ts";
import { type Lane, startSession, storeLane } from "./ledger.ts";
import { briefCommand, eventsCommand } from "./session-commands.ts";
import { statusCommand } from "./status.ts";
import { db } from "./store.ts";

const callerBefore = process.env.CLAUDE_CODE_SESSION_ID;
afterEach(() => {
  if (callerBefore === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = callerBefore;
});

async function printed(session: string | undefined, run: () => unknown): Promise<string> {
  if (session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = session;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  try { await run(); } finally { log.mockRestore(); }
  return lines.join("\n");
}

function runningLane(name: string, owner?: string): void {
  const at = new Date().toISOString();
  storeLane(name, { engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [], tokenAccounting: 1,
    ...(owner ? { ownerSession: owner } : {}), ownerCwd: "/repo", work: { state: "running", cwd: "/repo", updatedAt: at },
    createdAt: at, updatedAt: at, roundStartedAt: at } as unknown as Lane);
}

function runningJob(name: string, owner?: string): void {
  storeJob(name, { log: `/nonexistent/${name}.log`, startedAt: new Date().toISOString(), state: "running", ...(owner ? { ownerSession: owner } : {}) });
}

const ours = (names: string[]) => names.filter((name) => name.startsWith("view-")).sort();

async function snapshot(session: string): Promise<LiveRow[]> {
  return JSON.parse(await printed(session, () => eventsCommand(["--json", "--peek", "--snapshot"]))).rows;
}

test("each live session sees only its own lanes and jobs; the head also sees unowned and dead-owner work", async () => {
  db().query("DELETE FROM sessions").run();
  const now = Date.now();
  startSession("view-a", now - 2_000, true);
  // view-b drove last, so it is the head.
  startSession("view-b", now - 1_000, true);
  startSession("view-gone", now - 60_000, true);
  runningLane("view-lane-a", "view-a");
  runningJob("view-job-a", "view-a");
  runningLane("view-lane-b", "view-b");
  runningJob("view-job-b", "view-b");
  runningLane("view-lane-terminal");
  runningJob("view-job-terminal", "terminal");
  runningLane("view-lane-gone", "view-gone");

  const rowsA = await snapshot("view-a");
  const rowsB = await snapshot("view-b");
  expect(ours(rowsA.map((row) => row.name))).toEqual(["view-job-a", "view-lane-a"]);
  expect(ours(rowsB.map((row) => row.name))).toEqual(["view-job-b", "view-job-terminal", "view-lane-b", "view-lane-gone", "view-lane-terminal"]);
  const lineA = pinnedLine(rowsA.filter((row) => row.name.startsWith("view-")), now);
  expect(lineA).toStartWith("cdx 1 lane, 1 job");
  expect(lineA).not.toContain("view-lane-b");

  const briefA = await printed("view-a", () => briefCommand([]));
  expect(briefA).toContain("lane=view-lane-a");
  expect(briefA).toContain("job=");
  expect(briefA).toContain("view-job-a");
  expect(briefA).not.toMatch(/view-(lane|job)-(b|terminal|gone)/);
  const briefB = await printed("view-b", () => briefCommand([]));
  for (const name of ["view-lane-b", "view-job-b", "view-lane-terminal", "view-job-terminal", "view-lane-gone"]) expect(briefB).toContain(name);
  expect(briefB).not.toMatch(/view-(lane|job)-a/);

  // Explicit queries keep the whole picture and mark the other live session's lane.
  const status = await printed("view-a", () => statusCommand([]));
  for (const name of ["view-lane-a", "view-lane-b", "view-lane-terminal", "view-lane-gone"]) expect(status).toContain(name);
  const block = (name: string) => status.split("\n\n").find((text) => text.includes(name))!;
  expect(block("view-lane-b")).toContain("owned by another live session");
  expect(block("view-lane-a")).not.toContain("owned by another live session");
  expect(block("view-lane-gone")).not.toContain("owned by another live session");
  const terminalBrief = await printed(undefined, () => briefCommand([]));
  for (const name of ["view-lane-a", "view-lane-b", "view-lane-terminal"]) expect(terminalBrief).toContain(name);
});
