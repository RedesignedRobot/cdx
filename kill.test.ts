import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "./commands.ts";
import { findLane, type Lane, storeLane } from "./ledger.ts";
import { pidAlive } from "./runtime.ts";

// A detached stand-in for the lane runner while it gates: the gate runs
// under spawnSync, so the runner's SIGTERM handler, which finalizes the
// round, cannot run until the gate exits.
function gatingRunner(lane: string, gatePidFile: string) {
  const script = `
    import { withLedger } from ${JSON.stringify(join(import.meta.dir, "ledger.ts"))};
    process.on("SIGTERM", () => {
      withLedger((ledger) => { ledger[${JSON.stringify(lane)}].work.state = "failed"; });
      process.exit(143);
    });
    Bun.spawnSync({ cmd: ["/bin/sh", "-c", ${JSON.stringify(`echo $$ > ${gatePidFile}; exec sleep 300`)}] });
    await Bun.sleep(60_000);
  `;
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

test("kill stops a gating lane's gate process, not only its runner", async () => {
  const lane = "kill-gating";
  const cwd = mkdtempSync(join(tmpdir(), "cdx-kill-"));
  const gatePidFile = join(cwd, "gate.pid");
  const at = new Date().toISOString();
  const pid = gatingRunner(lane, gatePidFile);
  storeLane(lane, { engine: "gpt", kind: "work", effort: "medium", rounds: 1, reports: [], tokenAccounting: 1, pid, stage: "gate",
    work: { state: "running", cwd, updatedAt: at }, createdAt: at, updatedAt: at } as unknown as Lane);
  const deadline = Date.now() + 5_000;
  while (!existsSync(gatePidFile) || !readFileSync(gatePidFile, "utf8").trim()) {
    if (Date.now() > deadline) throw new Error("the stand-in gate never started");
    await Bun.sleep(20);
  }
  const gatePid = Number(readFileSync(gatePidFile, "utf8").trim());

  try {
    await dispatch("kill", [lane]);
    expect(findLane(lane)?.work.state).toBe("failed");
    expect(pidAlive(gatePid)).toBe(false);
  } finally {
    for (const orphan of [gatePid, pid]) try { process.kill(orphan, "SIGKILL"); } catch { /* already gone */ }
  }
}, 15_000);
