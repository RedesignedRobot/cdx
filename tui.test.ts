import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { frameOutput, firstExhaustion, liveKey, liveView, renderStatus, renderUsageTable, renderView, terminal, tuiEnabled, type Terminal } from "./tui.ts";
import { usageTable, writeCapturedReport } from "./cdx.ts";

const lane = { name: "portal", active: true, block: "portal  running  r2\n18 steps 4 files" };
const laneView = { title: "lanes", header: ["lane", "round", "state", "last step", "files", "gate"],
  rows: [["portal", "2", "running", "edit", "4", "pending"]], progress: "1 running lane" };
const usageHeader = ["account", "window", "used", "left", "resets in", "burn/h", "at reset", "empty in", "holds"];
const usageRows = [["astra-1", "weekly", "62%", "38%", "3d", "0.5%", "0%", "76h", "10%"]];
const plain = (columns: number): Terminal => ({ columns, color: false, unicode: false });
const ansi = (columns: number): Terminal => ({ ...plain(columns), color: true });

for (const columns of [80, 120]) {
  test(`status at ${columns} columns`, () => {
    expect(stripVTControlCharacters(renderStatus([lane], ansi(columns)))).toMatchInlineSnapshot(`
"cdx  1 lanes  1 running

\`- portal  running  r2
     18 steps 4 files"
`);
  });
  test(`lanes at ${columns} columns`, () => {
    expect(stripVTControlCharacters(renderView(laneView, ansi(columns)))).toMatchInlineSnapshot(`
"/ cdx  lanes
lane    round  state    last step  files  gate
-------------------------------------------------
portal  2      running  edit       4      pending
row 1/1
1 running lane
q quit  j/k move  enter report"
`);
  });
  for (const title of ["wait", "tail"]) {
    test(`${title} at ${columns} columns`, () => {
      const text = renderView({ title, lines: ["Reading source", "Updated renderer"], progress: "portal r2 running 18 steps" }, ansi(columns));
      expect(stripVTControlCharacters(text).replace(`/ cdx  ${title}`, "/ cdx  log")).toMatchInlineSnapshot(`
"/ cdx  log
Reading source
Updated renderer
portal r2 running 18 steps
q quit  j/k move  enter report"
`);
    });
  }
  test(`usage at ${columns} columns`, () => {
    expect(stripVTControlCharacters(renderUsageTable(usageHeader, usageRows, ansi(columns), 0))).toMatchInlineSnapshot(`
"account  window  used  left  resets in  burn/h  at reset  empty in  holds
-------------------------------------------------------------------------
astra-1  weekly   62%   38%         3d    0.5%        0%       76h    10%"
`);
  });
  test(`events at ${columns} columns`, () => {
    expect(stripVTControlCharacters(renderView({ title: "events", lines: ["14:08:02 portal question #4 Which window?"], progress: "1 event" }, ansi(columns)))).toMatchInlineSnapshot(`
"/ cdx  events
14:08:02 portal question #4 Which window?
1 event
q quit  j/k move  enter report"
`);
  });
}

test("narrow tables wrap lane names and preserve quota metrics", () => {
  const name = "a-lane-with-a-name-that-must-never-disappear-even-on-a-narrow-screen";
  const text = stripVTControlCharacters(renderView({ ...laneView, rows: [[name, "2", "running", "Updating a long path", "4", "pending"]] }, plain(80)));
  expect(text.split("\n").every((line) => Bun.stringWidth(line) <= 80)).toBe(true);
  // Read the first column down through its wrapped lines.
  const body = text.split("\n").slice(3, -3);
  expect(body.map((line) => line.split(/ {2,}/)[0]).join("")).toBe(name);
  const quota = renderUsageTable(usageHeader, usageRows, plain(40));
  for (const [index, label] of usageHeader.entries()) expect(quota).toContain(`${label}  ${usageRows[0]![index]}`);
});

test("NO_COLOR removes every escape, including redraw controls", () => {
  const env = { CDX_TUI: "1", TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", NO_COLOR: "" };
  const term = terminal(env, true);
  const injected = "text\x1b[31mred\x1b[0m\x1b]0;title\x07";
  const outputs = [renderStatus([{ ...lane, block: injected }], term), renderView({ ...laneView, lines: [injected] }, term),
    renderUsageTable(usageHeader, usageRows, term)];
  for (const output of outputs) expect(frameOutput(output, "", term, env)).not.toContain("\x1b");
});

test("live keys clamp selection and distinguish quitting from report opening", () => {
  expect(liveKey(0, 2, { name: "up" })).toBe(0);
  expect(liveKey(0, 2, { name: "j" })).toBe(1);
  expect(liveKey(1, 2, { name: "down" })).toBe(1);
  expect(liveKey(1, 2, { name: "k" })).toBe(0);
  expect(liveKey(0, 0, { name: "down" })).toBe(0);
  expect(liveKey(0, 2, { name: "return" })).toBe("report");
  expect(liveKey(0, 2, { name: "q" })).toBe("quit");
  expect(liveKey(0, 2, { name: "c", ctrl: true })).toBe("quit");
});

test("non-TTY command output stays byte-identical with TUI enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-tui-"));
  try {
    mkdirSync(join(root, "logs"));
    const report = join(root, "portal-r1.md");
    const timestamp = "2026-09-22T00:00:00Z";
    writeFileSync(report, "Completed renderer.\n");
    writeFileSync(join(root, "ledger.json"), JSON.stringify({ version: 5, lanes: { portal: {
      engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [report],
      work: { state: "done", cwd: root, round: 1, report, exitCode: 0, updatedAt: timestamp },
      createdAt: timestamp, updatedAt: timestamp, ownerSession: "tui-test",
    } } }));
    writeFileSync(join(root, "logs", "portal-r1.log"), "first\nlast\n");
    writeFileSync(join(root, "feed.log"), JSON.stringify({ id: 1, kind: "terminal", owner: "tui-test", timestamp, message: "portal done" }) + "\n");
    const env = { ...process.env, CDX_HOME: root, CDX_LANE: "", CDX_OWNER: "", CLAUDE_CODE_SESSION_ID: "tui-test", NO_COLOR: "1" };
    const run = (args: string[], enabled: string) => {
      const result = Bun.spawnSync([process.execPath, new URL("./cdx.ts", import.meta.url).pathname, ...args],
        { env: { ...env, CDX_TUI: enabled }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    };
    for (const args of [["status"], ["status", "--json"], ["status", "--brief"], ["lanes"], ["events", "--peek"], ["tail", "portal"], ["wait", "portal", "--report"]]) {
      expect(run(args, "1")).toEqual(run(args, "0"));
    }
    expect(tuiEnabled({ CDX_TUI: "1" }, false)).toBe(false);
    // Usage keeps provider probes out of this witness. Exercise its real formatter.
    expect(usageTable([], 0, tuiEnabled({ CDX_TUI: "1" }, false))).toEqual([
      "account  window  used  left  resets in  burn/h  at reset  empty in  holds",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("quota highlighting chooses the earliest known exhaustion", () => {
  expect(firstExhaustion([{ hoursToExhaustion: null }, { hoursToExhaustion: 4 }, { hoursToExhaustion: 1 }])).toBe(2);
  expect(firstExhaustion([{ hoursToExhaustion: null }])).toBe(-1);
  expect(firstExhaustion([{ hoursToExhaustion: 0 }, { hoursToExhaustion: 1 }])).toBe(0);
});

test("a failed live read restores input and removes its listeners", async () => {
  const raw = process.stdin.isRaw;
  const signals = process.listenerCount("SIGINT");
  const resize = process.stdout.listenerCount("resize");
  const keys = process.stdin.listenerCount("keypress");
  await expect(liveView(() => { throw new Error("ledger unavailable"); })).rejects.toThrow("ledger unavailable");
  expect(process.stdin.isRaw).toBe(raw);
  expect(process.listenerCount("SIGINT")).toBe(signals);
  expect(process.stdout.listenerCount("resize")).toBe(resize);
  expect(process.stdin.listenerCount("keypress")).toBe(keys);
});

test("a report the lane wrote itself survives the captured final message", () => {
  const root = mkdtempSync(join(tmpdir(), "cdx-report-"));
  try {
    const path = join(root, "lane-r1.md");
    writeCapturedReport(path, "first draft");
    expect(readFileSync(path, "utf8")).toBe("first draft\n");
    writeCapturedReport(path, "second draft");
    expect(readFileSync(path, "utf8")).toBe("second draft\n");
    writeFileSync(path, "# Judgement\n\n| a | b |\n");
    writeCapturedReport(path, "Cycle fails.");
    expect(readFileSync(path, "utf8")).toBe("# Judgement\n\n| a | b |\n\n## Final message\n\nCycle fails.\n");
    writeCapturedReport(path, "Cycle fails, restated.");
    expect(readFileSync(path, "utf8")).toBe("Cycle fails, restated.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
