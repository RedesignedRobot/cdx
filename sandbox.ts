// OS write boundaries for lane engines. Codex enforces its sandbox policy on
// every command it runs; agy runs whole under a sandbox-exec profile built from
// the same roots. Seatbelt does not nest, so supervisors reach cdx through a
// Codex exec-policy rule instead (account-sync.ts).
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HOME, ROOT } from "./runtime.ts";
import type { Spec } from "./ledger.ts";

// Lane-side cdx writes (cdx ask, Gemini hooks) land in these directories.
// Gemini hooks also write the round's partial report and progress log, which
// the runner names as files. Supervisors' cdx calls run outside the sandbox.
export const CLI_STATE_DIRS = [join(ROOT, "state"), join(ROOT, "control")];
export const AGY_HOME = join(HOME, ".gemini", "antigravity-cli");

export const spillDirOf = (lane: string, round: number) => join(ROOT, "logs", `${lane}-r${round}.out`);

type SandboxSpec = Pick<Spec, "cwd" | "additionalDirectories" | "reviewDir"> & { lane?: string; round?: number };

// Seatbelt matches resolved paths (/tmp is /private/tmp), and some roots do
// not exist until the lane writes them.
export function resolvedPath(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolvedPath(parent), basename(path));
  }
}

function laneStateDirs(spec: SandboxSpec): string[] {
  return spec.lane && spec.round ? [...CLI_STATE_DIRS, spillDirOf(spec.lane, spec.round)] : [];
}

export function prepareSandboxDirs(spec: SandboxSpec): void {
  for (const dir of laneStateDirs(spec)) mkdirSync(dir, { recursive: true });
}

// A lane with reviewDir set is read-only: reviews, consults, and consult supervisors.
export function codexSandbox(spec: SandboxSpec) {
  if (spec.reviewDir) return { mode: "read-only", policy: { type: "readOnly", networkAccess: true } } as const;
  // Codex adds the turn cwd as the first writable root and keeps .git read-only.
  const writableRoots = [...(spec.additionalDirectories ?? []), ...laneStateDirs(spec)].map(resolvedPath);
  return { mode: "workspace-write", policy: { type: "workspaceWrite", writableRoots, networkAccess: true,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false } } as const;
}

// agy writes its home, TMPDIR, and the files named by the caller.
// Gemini hooks run inside agy and write cdx state and spilled output, so
// read-only lanes keep those too; only work lanes get the checkout and /tmp.
export function geminiProfile(spec: SandboxSpec, files: string[] = []): string {
  const work = spec.reviewDir ? [] : [spec.cwd, ...(spec.additionalDirectories ?? []), "/tmp"];
  const subpaths = [AGY_HOME, tmpdir(), "/dev", ...laneStateDirs(spec), ...work].map(resolvedPath);
  const rules = [...subpaths.map((path) => `(subpath ${JSON.stringify(path)})`),
    ...files.map((path) => `(literal ${JSON.stringify(resolvedPath(path))})`)];
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${rules.join(" ")})`;
}

const regexQuote = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Scratch state `claude -p` writes, found with --debug-file under a profile
// that denied all of ~/.claude: shell snapshots for the Bash tool, the
// session env and registry, and ~/.claude.json with its backups.
const CLAUDE_SCRATCH = ["shell-snapshots", "session-env", "sessions", "backups"];
// Owner configuration and live cdx state (~/.cdx links into ~/.claude). The
// denies come last so they win over any allow above them.
const CLAUDE_PROTECTED = ["codex-harness", "hooks", "skills", "plugins", "CLAUDE.md"];

// claude runs only read-only consults. Its Bash tool writes a scratch dir and
// a cwd file under /tmp/claude-*; the checkout stays read-only.
export function claudeProfile(): string {
  const claudeDir = resolvedPath(join(HOME, ".claude"));
  const allowed = [tmpdir(), "/dev", ...CLAUDE_SCRATCH.map((dir) => join(claudeDir, dir))].map(resolvedPath);
  const allowRules = [
    ...allowed.map((path) => `(subpath ${JSON.stringify(path)})`),
    `(regex #"^${regexQuote(resolvedPath("/tmp"))}/claude-")`,
    `(regex #"^${regexQuote(resolvedPath(HOME))}/\\.claude\\.json")`,
  ];
  const denied = [...new Set([ROOT, ...CLAUDE_PROTECTED.map((entry) => join(claudeDir, entry))].map(resolvedPath))];
  const denyRules = [
    ...denied.map((path) => `(subpath ${JSON.stringify(path)})`),
    `(regex #"^${regexQuote(claudeDir)}/settings[^/]*\\.json$")`,
  ];
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${allowRules.join(" ")})(deny file-write* ${denyRules.join(" ")})`;
}
