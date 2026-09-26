import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextDigest, digestLine, RECENT_ANCESTORS } from "./context.ts";
import { houseRules, laneInstructions } from "./prompts.ts";

const commits = Array.from({ length: RECENT_ANCESTORS + 1 }, (_, index) => index.toString(16).padStart(40, "0"));
const git = (_cwd: string, ...args: string[]) => args[0] === "rev-parse" ? "/repo/.git" : commits.join("\n");
const digestOf = (files: string[], newest?: string) =>
  contextDigest("/repo/wt", git, (path) => path === "/repo/wt" || path === "/repo/.cdx/context" || files.includes(path), () => newest);

test("lanes get the digest for HEAD or the nearest recent ancestor, and older ones only as stale", () => {
  const dir = "/repo/.cdx/context";
  expect(digestOf([`${dir}/${commits[0]}.md`, `${dir}/${commits[3]}.md`])).toEqual({ path: `${dir}/${commits[0]}.md`, behind: 0 });
  expect(digestLine(digestOf([`${dir}/${commits[3]}.md`]))).toBe(`Context digest (3 commits behind HEAD): read ${dir}/${commits[3]}.md first, then open only the doc sections the task needs.`);
  expect(digestOf([], `${dir}/${"f".repeat(40)}.md`)).toEqual({ path: `${dir}/${"f".repeat(40)}.md`, stale: true });
  expect(digestLine(digestOf([], `${dir}/old.md`))).toStartWith("Stale context digest");
  expect(digestOf([])).toBeUndefined();
});

test("a work lane brief carries a pointer and per-lane facts; standing rules live in the role's lane home", () => {
  const repo = mkdtempSync(join(tmpdir(), "cdx-rules-"));
  try {
    writeFileSync(join(repo, ".cdx-rules.md"), "Run bunx vp test run <path>.\n".repeat(60));
    const pointer = houseRules(repo, false, "gpt");
    expect(Buffer.byteLength(pointer)).toBeLessThan(800);
    expect(pointer).toContain(`Project rules: read ${repo}/.cdx-rules.md`);
    expect(pointer).not.toContain("vp test");
    expect(laneInstructions()).toContain("Workers cannot drive cdx lanes");
    expect(laneInstructions()).toContain("alarm 60");
    expect(laneInstructions({ review: true })).toContain("read-only");
    expect(laneInstructions({ review: true })).not.toContain("Workers cannot drive");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
