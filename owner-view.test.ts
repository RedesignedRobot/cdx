import { afterEach, expect, spyOn, test } from "bun:test";
import type { LiveRow } from "./hooks/delivery.ts";
import { storeJob } from "./jobs.ts";
import { type Lane, readLedger, startSession, storeLane } from "./ledger.ts";
import { briefCommand, eventsCommand } from "./session-commands.ts";
import { liveRows, statusCommand } from "./status.ts";
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

function runningLane(name: string, owner?: string, stage?: Lane["stage"]): void {
  const at = new Date().toISOString();
  storeLane(name, { engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [], tokenAccounting: 1,
    ...(owner ? { ownerSession: owner } : {}), ownerCwd: "/repo", work: { state: "running", cwd: "/repo", updatedAt: at },
    createdAt: at, updatedAt: at, roundStartedAt: at, ...(stage ? { stage } : {}) } as unknown as Lane);
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

test("the brief shows a running lane's stage, so a lane past its last turn reads as gating", async () => {
  runningLane("stage-lane", undefined, "gate");
  runningLane("stage-new");
  const brief = await printed(undefined, () => briefCommand([]));
  expect(brief).toContain("lane=stage-lane round=1 kind=work state=running report=- stage=gate");
  expect(brief).toContain("lane=stage-new round=1 kind=work state=running report=- stage=working");
});

test("live rows use the current GPT round's account and stored tier", () => {
  const name = "round-metadata";
  runningLane(name);
  const entry = readLedger()[name]!;
  const row = () => liveRows().find((item) => item.name === name)!;
  storeLane(name, { ...entry, account: "codex-2", serviceTier: "priority" });
  expect(row()).toMatchObject({ account: "codex-2", serviceTier: "priority" });
  storeLane(name, { ...entry, account: "codex-1", kind: "review", reviewEngine: "gpt",
    review: { state: "running", cwd: "/repo" }, roundAccount: { name: "codex-2", home: "/unused", demand: "light" }, serviceTier: "default" });
  expect(row()).toMatchObject({ account: "codex-2", serviceTier: "default" });
  storeLane(name, { ...entry, account: "codex-2" });
  expect(row().serviceTier).toBeUndefined();
  storeLane(name, { ...entry, engine: "gemini", account: "codex-2", serviceTier: "priority" });
  expect(row().account).toBeUndefined();
  expect(row().serviceTier).toBeUndefined();
  runningJob("round-metadata-job");
  const job = liveRows().find((item) => item.name === "round-metadata-job")!;
  expect(job.account).toBeUndefined();
  expect(job.serviceTier).toBeUndefined();
});
