import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeJSON, safeText } from "./safe-text.ts";
import { executeGate, gateOutputForReport } from "./gates.ts";
import { writeCapturedReport, writeProtocolEvent } from "./reports.ts";

test("synthetic assignment is redacted in protocol, gate, report, feed, and terminal", () => {
  const home = mkdtempSync(join(tmpdir(), "cdx-safe-"));
  const fake = "fixture-value-without-provider-shape";
  const line = `CONTEXT7_API_KEY=${fake}`;
  try {
    const jsonl = join(home, "round.jsonl");
    writeProtocolEvent({ write: (text) => writeFileSync(jsonl, text), flush() {} },
      { step_update: { tool_info: { parameters: { CommandLine: line }, output: line } } });
    expect(JSON.parse(readFileSync(jsonl, "utf8")).step_update.tool_info.output).toBe("CONTEXT7_API_KEY=[redacted]");
    const gatePath = join(home, "gate.log");
    const gate = executeGate(`printf '%s\\n' '${line}'`, home, gatePath);
    expect(gate.exitCode).toBe(0);
    const report = join(home, "report.md");
    writeFileSync(report, line);
    writeCapturedReport(report, `${line}\n${gateOutputForReport(gate.output)}`);
    const cli = new URL("./cdx.ts", import.meta.url).pathname;
    const ledger = new URL("./ledger.ts", import.meta.url).pathname;
    const child = Bun.spawnSync({ cmd: [process.execPath, "--eval",
      `import { feedEvent } from ${JSON.stringify(ledger)}; feedEvent("message", ${JSON.stringify(line)}, "terminal");`],
      env: { ...process.env, CDX_STATE_HOME: home }, cwd: home });
    expect(child.exitCode).toBe(0);
    // CLI error output also crosses the terminal boundary.
    const terminal = Bun.spawnSync({ cmd: [process.execPath, cli, line], env: { ...process.env, CDX_STATE_HOME: home } });
    const shown = terminal.stdout.toString() + terminal.stderr.toString();
    expect(shown).not.toContain(fake);
    const store = new Database(join(home, "state", "cdx.db"), { readonly: true });
    const feed = store.query<{ message: string }, []>("SELECT message FROM events").all().map((row) => row.message).join("\n");
    store.close();
    for (const text of [...[jsonl, gatePath, report].map((path) => readFileSync(path, "utf8")), feed]) {
      expect(text).not.toContain(fake);
      expect(text).toContain("[redacted]");
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("safe text covers provider shapes, quoted assignments, headers, and known environment secrets", () => {
  for (const value of ["ctx7sk-" + "x".repeat(36), "sk-proj-" + "x".repeat(32), "sk-ant-" + "x".repeat(32),
    "AIza" + "x".repeat(35), "ghp_" + "x".repeat(36), "github_pat_" + "x".repeat(40), "npm_" + "x".repeat(36)]) {
    expect(safeText(`output ${value}`)).toBe("output [redacted]");
  }
  for (const assignment of ['KEY="quoted value"', "TOKEN='quoted value'", "MY_API_KEY=unshaped", "NPM_TOKEN=unshaped"]) {
    expect(safeText(assignment)).toMatch(/=\[redacted\]$/);
  }
  expect(safeText("Authorization: Basic abc123\nnext line")).toBe("Authorization: [redacted]\nnext line");
  const nested = JSON.stringify({ CommandLine: 'CONTEXT7_API_KEY="plain quoted secret"' });
  expect(safeJSON({ arguments: nested })).not.toContain("plain quoted secret");
  const key = "CDX_TEST_SECRET";
  const old = process.env[key];
  try {
    process.env[key] = "unshaped-environment-secret";
    expect(JSON.parse(safeJSON({ result: `before ${process.env[key]} after` })).result).toBe("before [redacted] after");
  } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
});

test("stream redaction holds split assignments and UTF-8 before persistence", async () => {
  const { safeLines } = await import("./safe-lines.ts");
  const body = Buffer.from("é CONTEXT7_API_KEY=split-value\nlast TOKEN=tail-value");
  async function* chunks() { for (const byte of body) yield Uint8Array.of(byte); }
  let stored = "";
  for await (const text of safeLines(chunks())) stored += text;
  expect(stored).toBe("é CONTEXT7_API_KEY=[redacted]\nlast TOKEN=[redacted]");
});

import { CAP_HOOK_COMMAND, installLaneHome, laneCodexHome, laneHooks, retiredLaneRule, SUPERVISOR_RULES, withCapHook } from "./account-sync.ts";

test("lane home installation is idempotent and preserves the interactive instruction source", () => {
  const home = mkdtempSync(join(tmpdir(), "cdx-lane-home-"));
  try {
    writeFileSync(join(home, "AGENTS.md"), "interactive instructions");
    writeFileSync(join(home, "config.toml"), 'model = "fixture"\n');
    const original = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "codegraph prompt-hook" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "unrelated-hook" }] }] } };
    writeFileSync(join(home, "hooks.json"), JSON.stringify(original));
    const lane = installLaneHome(home, "lane instructions");
    expect(installLaneHome(home, "lane instructions")).toBe(lane);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("interactive instructions");
    expect(readFileSync(join(lane, "AGENTS.md"), "utf8")).toBe("lane instructions");
    expect(readFileSync(join(lane, "config.toml"), "utf8")).toBe('model = "fixture"\n');
    const installed = JSON.parse(readFileSync(join(lane, "hooks.json"), "utf8"));
    expect(installed).toEqual(withCapHook(laneHooks(original)));
    expect(installed.hooks.PreToolUse.map((group: any) => group.hooks[0].command)).toEqual(["unrelated-hook", CAP_HOOK_COMMAND]);
    expect(existsSync(join(lane, "rules"))).toBe(false);
    const supervisor = installLaneHome(home, "lane instructions", { supervisor: true });
    expect(supervisor).toBe(laneCodexHome(home, { supervisor: true }));
    expect(installLaneHome(home, "review instructions", { review: true })).toBe(join(home, "cdx-review"));
    expect(existsSync(join(home, "cdx-review", "rules"))).toBe(false);
    expect(readFileSync(join(supervisor, "rules", "cdx.rules"), "utf8")).toBe(SUPERVISOR_RULES);
    expect(laneHooks(laneHooks(original))).toEqual(laneHooks(original));
    expect(laneHooks(original).hooks.UserPromptSubmit[0].hooks[0].command).toContain('CDX_LANE');
    expect(retiredLaneRule("Read the repository's AGENTS.md and CLAUDE.md before starting")).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
