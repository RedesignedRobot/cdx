// Fault suite for the SQLite store: real processes against a temp state
// home. The one test file allowed to spawn processes; each case stays well
// under a second.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./cdx.ts", import.meta.url).pathname;
const LEDGER = JSON.stringify(new URL("./ledger.ts", import.meta.url).pathname);

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "cdx-faults-"));
}

function childEnv(home: string, extra: Record<string, string> = {}) {
  return { ...process.env, CDX_STATE_HOME: home, CDX_TEST: "1", CLAUDE_CODE_SESSION_ID: "", NO_COLOR: "1", ...extra };
}

function evalIn(home: string, code: string) {
  const result = Bun.spawnSync({ cmd: [process.execPath, "--eval", code], env: childEnv(home), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function cdx(home: string, args: string[], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], env: childEnv(home, extra), stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function inspect<T>(home: string, read: (store: Database) => T): T {
  const store = new Database(join(home, "state", "cdx.db"), { readonly: true });
  try { return read(store); } finally { store.close(); }
}

const lane = (state: string, extra: object = {}) => ({
  engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [], tokenAccounting: 1,
  work: { state, cwd: "/repo", round: 1, updatedAt: "2026-09-20T00:00:00.000Z" },
  createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...extra,
});

const seed = (home: string, name: string) => evalIn(home, `import { withLedger } from ${LEDGER};
withLedger((ledger) => { ledger[${JSON.stringify(name)}] = ${JSON.stringify(lane("running", { roundSteps: 0 }))}; });`);

test("concurrent writers from several processes lose no update", async () => {
  const home = tempHome();
  try {
    seed(home, "shared");
    const writers = 4, increments = 40;
    const code = `import { feedEvent, withLedger } from ${LEDGER};
for (let i = 0; i < ${increments}; i++) {
  withLedger((ledger) => { ledger.shared.roundSteps += 1; });
  feedEvent("message", "tick", "terminal");
}`;
    const children = Array.from({ length: writers }, () => Bun.spawn({ cmd: [process.execPath, "--eval", code], env: childEnv(home), stdout: "ignore", stderr: "pipe" }));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual(Array(writers).fill(0));
    const { steps, events, distinct } = inspect(home, (store) => ({
      steps: JSON.parse(store.query<{ data: string }, []>("SELECT data FROM lanes WHERE name = 'shared'").get()!.data).roundSteps,
      events: store.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n,
      distinct: store.query<{ n: number }, []>("SELECT COUNT(DISTINCT id) AS n FROM events").get()!.n,
    }));
    expect(steps).toBe(writers * increments);
    expect(events).toBe(writers * increments);
    expect(distinct).toBe(events);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("kill -9 inside a write transaction leaves the store consistent and writable", async () => {
  const home = tempHome();
  try {
    seed(home, "victim");
    const code = `import { feedEvent, withLedger } from ${LEDGER};
withLedger((ledger) => {
  ledger.victim.roundSteps = 99;
  feedEvent("message", "never committed", "terminal");
  console.log("inside");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});`;
    const child = Bun.spawn({ cmd: [process.execPath, "--eval", code], env: childEnv(home), stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("inside")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("child exited before entering the transaction");
      seen += new TextDecoder().decode(value);
    }
    child.kill("SIGKILL");
    expect(await child.exited).not.toBe(0);
    const after = evalIn(home, `import { feedEvent, findLane, withLedger } from ${LEDGER};
withLedger((ledger) => { ledger.victim.roundSteps += 1; });
feedEvent("message", "after kill", "terminal");
console.log(findLane("victim").roundSteps);`);
    expect(after.trim()).toBe("1");
    const messages = inspect(home, (store) => store.query<{ message: string }, []>("SELECT message FROM events").all().map((row) => row.message));
    expect(messages).toEqual(["after kill"]);
    expect(inspect(home, (store) => store.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check)).toBe("ok");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a delivery that dies before acknowledging replays after restart, then never again", () => {
  const home = tempHome();
  try {
    const deliver = (failing: boolean) => evalIn(home, `import { deliverEvents } from ${LEDGER};
try {
  deliverEvents("s1", Date.now(), false, (events) => {
    ${failing ? 'throw new Error("stdout closed");' : ""}
    console.log(JSON.stringify(events.map((event) => event.text)));
  });
} catch { console.log("failed"); }`);
    evalIn(home, `import { feedEvent, markDriver, startSession } from ${LEDGER};
startSession("s1");
markDriver("s1");
feedEvent("question", "[cdx] q1", "terminal", { lane: "a", round: 1 });
feedEvent("gate-finished", "[cdx] gate", "terminal", { lane: "a", round: 1 });
feedEvent("stalled", "[cdx] s1", "terminal", { lane: "a", round: 1 });`);
    expect(deliver(true).trim()).toBe("failed");
    expect(JSON.parse(deliver(false))).toEqual(["[cdx] q1", "[cdx] s1"]);
    expect(JSON.parse(deliver(false))).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a session that starts after the head never takes its wakes, and the head's owner cursor moves only on receipt", () => {
  const home = tempHome();
  try {
    const deliver = (session: string, failing = false) => evalIn(home, `import { deliverEvents } from ${LEDGER};
try {
  deliverEvents(${JSON.stringify(session)}, Date.now(), false, (events) => {
    ${failing ? 'throw new Error("stdout closed");' : ""}
    console.log(JSON.stringify(events.map((event) => event.text)));
  });
} catch { console.log("failed"); }`);
    evalIn(home, `import { markDriver, startSession } from ${LEDGER};
startSession("head", Date.now() - 20_000);
markDriver("head");
startSession("teammate");`);
    evalIn(home, `import { feedEvent } from ${LEDGER};
feedEvent("question", "[cdx] q1", "terminal", { lane: "a", round: 1 });`);
    expect(JSON.parse(deliver("teammate"))).toEqual([]);
    expect(deliver("head", true).trim()).toBe("failed");
    expect(JSON.parse(deliver("teammate"))).toEqual([]);
    expect(JSON.parse(deliver("head"))).toEqual(["[cdx] q1"]);
    expect(JSON.parse(deliver("head"))).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("migrate imports a synthetic 9.x home once, archives closed lanes, and nothing migrates on read", () => {
  const home = tempHome();
  try {
    const at = "2026-09-20T00:00:00.000Z";
    writeFileSync(join(home, "ledger.json"), JSON.stringify({ version: 5, tokenAccounting: 1, lanes: {
      live: lane("running"), finished: lane("done"), shelved: lane("closed"),
    } }));
    const feed = [
      { id: 1, timestamp: at, kind: "started", owner: "head", lane: "live", round: 1, message: "[cdx] started" },
      { id: 2, timestamp: at, kind: "terminal", owner: "head", lane: "finished", round: 1, message: "[cdx] finished done" },
      { id: 3, timestamp: at, kind: "progress", owner: "head", message: "[cdx] progress" },
      { id: 4, timestamp: at, kind: "message", owner: "head", recipient: "head", from: "live", message: "hello" },
    ].map((event) => JSON.stringify(event));
    writeFileSync(join(home, "feed.log"), [...feed, "[cdx] a 4.x free-text line"].join("\n") + "\n");
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ wall: { state: "done", log: "/tmp/wall.log", startedAt: at, exitCode: 0 } }));
    writeFileSync(join(home, "sessions.json"), JSON.stringify({ sequence: 4, bindings: {}, lanes: {}, sessions: {} }));
    mkdirSync(join(home, "questions"));
    writeFileSync(join(home, "questions", "live-r1-1.json"), JSON.stringify({ lane: "live", round: 1, seq: 1, question: "Which file?", askedAt: at, answered: false }));

    const before = cdx(home, ["status"]);
    expect(before.stderr).toContain("run cdx migrate");
    expect(inspect(home, (store) => store.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lanes").get()!.n)).toBe(0);

    const migrated = cdx(home, ["migrate"]);
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toContain("migrated 3 lanes (2 active, 1 archived), 2 events (2 lifecycle events dropped), 1 jobs, 1 questions");
    const counts = inspect(home, (store) => Object.fromEntries(["lanes", "archive", "events", "jobs", "questions"]
      .map((table) => [table, store.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n])));
    expect(counts).toEqual({ lanes: 2, archive: 1, events: 2, jobs: 1, questions: 1 });
    expect(existsSync(join(home, "ledger.json"))).toBe(false);
    expect(readdirSync(join(home, "state", "legacy")).sort()).toEqual(["feed.log", "jobs.json", "ledger.json", "questions", "sessions.json"]);

    expect(cdx(home, ["migrate"]).stderr).toContain("already migrated");
    const status = cdx(home, ["status"]);
    expect(status.stderr).not.toContain("run cdx migrate");
    expect(status.stdout).toContain("finished");
    expect(status.stdout).not.toContain("shelved");
    expect(cdx(home, ["status", "--all"]).stdout).toContain("shelved");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the store refuses the live state home under test", () => {
  const fakeHome = tempHome();
  try {
    const result = cdx(join(fakeHome, ".cdx"), ["status"], { HOME: fakeHome });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("refusing the live state home");
    expect(existsSync(join(fakeHome, ".cdx"))).toBe(false);
  } finally { rmSync(fakeHome, { recursive: true, force: true }); }
});
