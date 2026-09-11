import { expect, test } from "bun:test";
import { jobPhaseText, laneProgress, porcelainFileCount, statusBrief } from "./cdx.ts";

const now = Date.parse("2026-09-11T12:10:00Z");
const lane = (patch: Record<string, unknown> = {}) => ({
  kind: "work", work: { state: "running", cwd: "/work" }, roundSteps: 12,
  stage: "working", lastAction: "read src/main.ts", lastActionAt: "2026-09-11T12:09:55Z",
  ...patch,
} as Parameters<typeof laneProgress>[0]);

test("porcelain count treats renamed paths as one file and preserves newline names", () => {
  expect(porcelainFileCount(" M one\0R  new\0old\0?? line\nname\0 C copy\0source\0")).toBe(4);
  expect(porcelainFileCount("")).toBe(0);
});

test("progress retains stage age and action age separately and skips unavailable git counts", () => {
  expect(laneProgress(lane({ stage: "gate", stageStartedAt: "2026-09-11T12:08:00Z" }), 3, now))
    .toBe("12 steps 3 files gate running 2m last 5s read src/main.ts");
  expect(laneProgress(lane({ stage: "reporting", lastActionAt: undefined, lastEventAt: "2026-09-11T12:09:50Z" }), undefined, now))
    .toBe("12 steps reporting last 10s read src/main.ts");
});

test("job phase uses the last nonempty line and removes terminal control characters", () => {
  expect(jobPhaseText("train: land 10/15\n\u001b[32mtrain: running the wall\u001b[0m\n \n"))
    .toBe("train: running the wall");
  expect(jobPhaseText("\n \n")).toBe("");
  expect(jobPhaseText("x".repeat(200))).toHaveLength(80);
});

test("brief includes all running lanes but only owned running jobs, with bounded single lines", () => {
  const job = { state: "running", log: "/job.log", startedAt: "2026-09-11T12:00:00Z", ownerSession: "head" };
  const filesRead: string[] = [];
  const phasesRead: string[] = [];
  const output = statusBrief({ live: lane(), review: lane({ kind: "review", review: { state: "running", cwd: "/review" }, lastAction: "x".repeat(160) }),
    finished: lane({ work: { state: "done", cwd: "/done" } }) }, {
    own: job, foreign: { ...job, ownerSession: "other" }, done: { ...job, state: "done" },
  } as Parameters<typeof statusBrief>[1], {
    files: (cwd) => { filesRead.push(cwd); return 2; },
    phase: (log) => { phasesRead.push(log); return "wall\n" + "x".repeat(150); },
    ownsJob: (entry) => entry.ownerSession === "head", now,
  });
  expect(output.split("\n")).toHaveLength(3);
  expect(output.split("\n").every((line) => line.length < 100 && !line.includes("\u001b"))).toBe(true);
  expect(output).toContain("live 12 steps 2 files working last 5s read src/main.ts");
  expect(output).toContain("job own 10m wall");
  expect(filesRead).toEqual(["/work", "/review"]);
  expect(phasesRead).toEqual(["/job.log"]);
  expect(statusBrief({}, {}, { files: () => 0, phase: () => "", ownsJob: () => true, now })).toBe("");
});
