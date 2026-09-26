// Per-repo context digests keyed to commit, and the foreground consult that builds them.

import { config } from "./config.ts";
import { readLedger } from "./ledger.ts";
import { reportPathOf } from "./reports.ts";
import { fail, parseArgs, ROOT, SELF } from "./runtime.ts";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const CONTEXT_DIGEST_MAX_CHARS = 6_000;
// A digest this many commits behind HEAD still maps the repo well enough to point lanes at.
export const RECENT_ANCESTORS = 20;

type Git = (cwd: string, ...args: string[]) => string | undefined;

const git: Git = (cwd, ...args) => {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stderr: "ignore" });
  return result.success ? result.stdout.toString().trim() : undefined;
};

// Digests live in the main checkout, so every worktree of a repo shares them.
export function contextDir(cwd: string, run: Git = git): string | undefined {
  const common = run(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  return common ? join(dirname(common), ".cdx", "context") : undefined;
}

export type DigestPointer = { path: string; behind: number } | { path: string; stale: true };

export function contextDigest(cwd: string, run: Git = git, exists = existsSync, newest = newestDigest): DigestPointer | undefined {
  if (!exists(cwd)) return;
  const dir = contextDir(cwd, run);
  if (!dir || !exists(dir)) return;
  const ancestors = run(cwd, "rev-list", `--max-count=${RECENT_ANCESTORS + 1}`, "HEAD")?.split("\n").filter(Boolean) ?? [];
  for (const [behind, commit] of ancestors.entries()) {
    const path = join(dir, `${commit}.md`);
    if (exists(path)) return { path, behind };
  }
  const path = newest(dir);
  return path ? { path, stale: true } : undefined;
}

function newestDigest(dir: string): string | undefined {
  return readdirSync(dir).filter((name) => /^[0-9a-f]{40}\.md$/.test(name)).map((name) => join(dir, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

export function digestLine(pointer: DigestPointer | undefined): string | undefined {
  if (!pointer) return;
  if ("stale" in pointer) return `Stale context digest, more than ${RECENT_ANCESTORS} commits old; trust source over it: ${pointer.path}`;
  const age = pointer.behind ? ` (${pointer.behind} commits behind HEAD)` : "";
  return `Context digest${age}: read ${pointer.path} first, then open only the doc sections the task needs.`;
}

export function laneName(prefix: string, label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
  return `${prefix}-${slug || "dir"}`.slice(0, 60);
}

// Runs one consult in the foreground and returns its final report. The lane's
// progress output goes to a log, never to the caller's context.
export async function runConsult(lane: string, cwd: string, question: string, opts: { engine?: string; model?: string; images?: string[] } = {}): Promise<{ report: string; reportPath: string }> {
  const log = `${ROOT}/logs/${lane}.consult.log`;
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  const engine = opts.engine ?? "gpt";
  const model = opts.model ?? (engine === "gpt" ? config.model : undefined);
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, SELF, "consult", lane, "--cd", cwd, "--engine", engine, ...(model ? ["--model", model] : []),
        ...(opts.images ?? []).flatMap((image) => ["--image", image]), question],
      cwd, stdin: "ignore", stdout: fd, stderr: fd,
    });
    if (await proc.exited !== 0) fail(`consult ${lane} failed; log: ${log}`);
  } finally { closeSync(fd); }
  const rounds = readLedger()[lane]?.rounds;
  const reportPath = rounds ? reportPathOf(lane, rounds) : "";
  if (!reportPath || !existsSync(reportPath)) fail(`consult ${lane} left no report; log: ${log}`);
  return { report: readFileSync(reportPath, "utf8").trim(), reportPath };
}

export function digestQuestion(commit: string): string {
  return [
    `Write the context digest for this repository at commit ${commit}. Lanes read it instead of the full doc set, so it replaces reading order lists.`,
    `Your final message is the digest itself: markdown only, under ${CONTEXT_DIGEST_MAX_CHARS - 500} characters, no preamble.`,
    "Sections, in order:",
    "## Repo map: top-level directories and key modules, one line each.",
    "## Commands: install, build, typecheck, single test file, full suite, with exact invocations.",
    "## Gate: the command a lane gate should run, and what it covers.",
    "## Rules: one line per rule doc section as `path#heading-anchor`: what it governs, so a reader opens only the sections a task needs. Cover AGENTS.md, CLAUDE.md, .cdx-rules.md and docs/.",
    "Sources: AGENTS.md, CLAUDE.md, .cdx-rules.md, README, package manifests and docs/ in this repository only; your own lane instructions are not part of it. Write every path relative to the repository root, since lanes read it from other worktrees. Skim headings; read bodies only to confirm commands. Never quote docs at length.",
  ].join("\n");
}

// Keeps digests out of `git status` without touching the tracked .gitignore.
function excludeDigests(cwd: string, run: Git = git): void {
  const exclude = run(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
  if (!exclude) return;
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (text.split("\n").includes("/.cdx/")) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}/.cdx/\n`);
}

export async function contextCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv, ["engine", "model"]);
  const usage = "usage: cdx context <repo> [--model M]";
  const repoArg = parsed.rest[0];
  if (!repoArg || !existsSync(repoArg)) fail(usage);
  if (parsed.flags.engine === "gemini") fail("context digests use a gpt consult; Gemini does not build them");
  const cwd = realpathSync(repoArg);
  const commit = git(cwd, "rev-parse", "HEAD");
  const dir = contextDir(cwd);
  if (!commit || !dir) fail(`${cwd} is not a git repository with a commit`);
  const path = join(dir, `${commit}.md`);
  if (existsSync(path)) { console.log(`cdx: context digest current: ${path}`); return; }
  const lane = laneName("context", `${basename(dirname(dirname(dir)))}-${commit.slice(0, 8)}`);
  const { report, reportPath } = await runConsult(lane, cwd, digestQuestion(commit), { model: parsed.flags.model });
  const digest = `<!-- cdx context digest for ${commit}; built ${new Date().toISOString()} -->\n${report}\n`;
  if (digest.length > CONTEXT_DIGEST_MAX_CHARS) fail(`digest is ${digest.length} chars, over ${CONTEXT_DIGEST_MAX_CHARS}; not written. Report: ${reportPath}`);
  mkdirSync(dir, { recursive: true });
  excludeDigests(cwd);
  writeFileSync(path, digest);
  console.log(`cdx: context digest ${digest.length} chars: ${path}`);
}
