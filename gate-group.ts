// Runs one gate command as the leader of its own process group and stops the
// whole group on timeout or on a signal. executeGate runs this under
// spawnSync, which can only signal its direct child: a gate shell killed that
// way left its lock holders, lease tickets and test runners under pid 1.
// Usage: bun gate-group.ts <timeout ms> <command>

export const GATE_TIMEOUT_EXIT = 124;
const STOP_GRACE_MS = 5_000;

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch { return false; }
}

// SIGTERM lets the gate release its locks; whatever is left after the grace
// period gets SIGKILL.
async function stopGroup(pgid: number): Promise<void> {
  try { process.kill(-pgid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await Bun.sleep(100);
  try { process.kill(-pgid, "SIGKILL"); } catch { /* group gone */ }
}

async function main(): Promise<never> {
  const [timeoutArg, command] = process.argv.slice(2);
  const timeoutMs = Number(timeoutArg);
  if (!command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error("usage: gate-group.ts <timeout ms> <command>");
    process.exit(2);
  }
  const gate = Bun.spawn({ cmd: ["/bin/sh", "-lc", `exec 2>&1\n${command}`], detached: true, stdio: ["ignore", "inherit", "inherit"] });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= stopGroup(gate.pid);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => { void stop().then(() => process.exit(143)); });
  }
  const timer = setTimeout(() => { void stop().then(() => process.exit(GATE_TIMEOUT_EXIT)); }, timeoutMs);
  const code = await gate.exited;
  clearTimeout(timer);
  if (stopping) await new Promise(() => {});
  process.exit(code ?? 1);
}

if (import.meta.main) await main();
