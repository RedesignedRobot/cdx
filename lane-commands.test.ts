import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveCodeLookups } from "./code-lookup.ts";
import { laneChildEnv } from "./runtime.ts";
import { geminiProfile } from "./sandbox.ts";
import * as doctor from "./doctor.ts";
import * as geminiUsage from "./gemini-usage.ts";
import { resumeCommand, spawnCommand } from "./lane-commands.ts";

test("spawn and resume require a positive integer test allowance", async () => {
  for (const command of [spawnCommand, resumeCommand]) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
      await expect(command(["--test-runs", value])).rejects.toThrow("--test-runs must be a positive integer");
    }
    await expect(command(["--test-runs", "6"])).rejects.toThrow("usage:");
  }
});

// Both clients really run inside Seatbelt. Only the runner may launch the
// second sandbox; a nested launch in either client fails with exit 71.
for (const engine of ["gpt", "gemini"] as const) {
  test.skipIf(process.platform !== "darwin")(`${engine} worker lookup uses the runner and remains read-only`, async () => {
    // TMPDIR is writable in the lookup profile, so probe a repository file.
    const repo = mkdtempSync(join(import.meta.dir, ".lookup-probe-"));
    const source = join(repo, "source.txt");
    const forbidden = join(repo, "write.txt");
    writeFileSync(source, "readable source\n");
    const previousSandbox = process.env.CODEX_SANDBOX;
    delete process.env.CODEX_SANDBOX;
    const realSpawn = Bun.spawn;
    const spawn = spyOn(Bun, "spawn").mockImplementation((options: any) => {
      expect(options.cmd.slice(0, 2)).toEqual(["sandbox-exec", "-p"]);
      expect(options.cmd[3]).toBe("agy");
      return realSpawn({ ...options, cmd: [...options.cmd.slice(0, 3), "/bin/sh", "-c",
        `if /bin/cat "$LOOKUP_SOURCE" >/dev/null && ! /usr/bin/touch "$LOOKUP_WRITE" 2>/dev/null; then printf '{"response":"read-only answer"}'; else exit 1; fi`],
        env: { ...options.env, LOOKUP_SOURCE: source, LOOKUP_WRITE: forbidden } });
    });
    const agent = spyOn(doctor, "requireGeminiAgent").mockImplementation(() => {});
    const quota = spyOn(geminiUsage, "requireGeminiQuota").mockImplementation(() => {});
    const lookups = serveCodeLookups();
    try {
      const args = ["--cd", ".", "Where is the parser defined?"];
      const script = `import { codeQuestionCommand } from ${JSON.stringify(join(import.meta.dir, "lane-commands.ts"))}; await codeQuestionCommand(${JSON.stringify(args)});`;
      const worker = realSpawn({
        cmd: ["sandbox-exec", "-p", geminiProfile({ cwd: repo }), process.execPath, "--eval", script],
        cwd: repo, env: { ...laneChildEnv(undefined, { lane: "lookup-worker", round: 1 }, engine),
          CDX_LOOKUP_URL: lookups.url, CODEX_SANDBOX: engine === "gpt" ? "seatbelt" : undefined },
        stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(stdout.trim()).toBe("read-only answer");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(forbidden)).toBe(false);
    } finally {
      lookups.stop();
      spawn.mockRestore(); agent.mockRestore(); quota.mockRestore();
      if (previousSandbox === undefined) delete process.env.CODEX_SANDBOX; else process.env.CODEX_SANDBOX = previousSandbox;
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);
}
