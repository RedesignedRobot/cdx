// Preloaded by bun test: every import resolves ROOT to a temp state home, so
// no test can read or write the owner's live state. runtime.ts refuses the
// live home under test even if this preload is skipped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testState = mkdtempSync(join(tmpdir(), "cdx-check-"));
process.env.CDX_STATE_HOME = testState;
process.env.CDX_HOME = testState;
for (const key of ["CDX_LANE", "CDX_ROUND", "CDX_OWNER", "CDX_SUPERVISOR"]) delete process.env[key];
process.on("exit", () => rmSync(testState, { recursive: true, force: true }));
