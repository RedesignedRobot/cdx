import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLaneHome } from "./account-sync.ts";
import * as doctor from "./doctor.ts";
import * as geminiUsage from "./gemini-usage.ts";
import { codeQuestionCommand, resumeCommand, spawnCommand } from "./lane-commands.ts";

test("spawn and resume require a positive integer test allowance", async () => {
  for (const command of [spawnCommand, resumeCommand]) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
      await expect(command(["--test-runs", value])).rejects.toThrow("--test-runs must be a positive integer");
    }
    await expect(command(["--test-runs", "6"])).rejects.toThrow("usage:");
  }
});

test.skipIf(process.platform !== "darwin" || !Bun.which("codex"))("worker lookup escapes through a narrow rule and applies a read-only sandbox", async () => {
  const home = mkdtempSync(join(tmpdir(), "cdx-lookup-home-"));
  // The read-only profile permits TMPDIR writes, so probe a repository file.
  const repo = mkdtempSync(join(import.meta.dir, ".lookup-probe-"));
  const source = join(repo, "source.txt");
  const forbidden = join(repo, "write.txt");
  writeFileSync(source, "readable source\n");
  const previous = { CDX_LANE: process.env.CDX_LANE, CODEX_SANDBOX: process.env.CODEX_SANDBOX };
  const realSpawn = Bun.spawn;
  const spawn = spyOn(Bun, "spawn");
  const agent = spyOn(doctor, "requireGeminiAgent").mockImplementation(() => {});
  const quota = spyOn(geminiUsage, "requireGeminiQuota").mockImplementation(() => {});
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const laneHome = installLaneHome(home, "worker instructions");
    const decision = (command: string) => {
      const result = Bun.spawnSync({ cmd: ["codex", "execpolicy", "check", "--rules", join(laneHome, "rules", "cdx.rules"), "--", "cdx", command],
        env: { ...process.env, CODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()).decision;
    };
    expect(decision("ask")).toBe("allow");
    expect(decision("spawn")).not.toBe("allow");

    process.env.CDX_LANE = "worker-lookup";
    process.env.CODEX_SANDBOX = "seatbelt";
    const args = ["--cd", repo, "How can I use the parser to read a quoted argument?"];
    await expect(codeQuestionCommand(args)).rejects.toThrow("cdx ask must run outside Seatbelt");
    expect(spawn).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();

    // Codex's allow rule launches outside Seatbelt. Substitute a local probe
    // for agy while retaining the exact sandbox-exec profile selected by ask.
    delete process.env.CODEX_SANDBOX;
    spawn.mockImplementation((options: any) => {
      expect(options.cmd.slice(0, 2)).toEqual(["sandbox-exec", "-p"]);
      expect(options.cmd[3]).toBe("agy");
      return realSpawn({ ...options, cmd: [...options.cmd.slice(0, 3), "/bin/sh", "-c",
        'if /bin/cat "$LOOKUP_SOURCE" >/dev/null && ! /usr/bin/touch "$LOOKUP_WRITE" 2>/dev/null; then printf \'{"response":"read-only answer"}\'; else exit 1; fi'],
        env: { ...options.env, LOOKUP_SOURCE: source, LOOKUP_WRITE: forbidden } });
    });
    await codeQuestionCommand(args);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith("read-only answer");
    expect(existsSync(forbidden)).toBe(false);
  } finally {
    spawn.mockRestore(); agent.mockRestore(); quota.mockRestore(); output.mockRestore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
