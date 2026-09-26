// Loaded before gate tests so imports cannot migrate or mutate the user's state.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testState = mkdtempSync(join(tmpdir(), "cdx-check-"));
process.env.CDX_HOME = testState;
for (const key of ["CDX_STATE_HOME", "CDX_LANE", "CDX_ROUND", "CDX_OWNER", "CDX_SUPERVISOR"]) delete process.env[key];
process.on("exit", () => rmSync(testState, { recursive: true, force: true }));
