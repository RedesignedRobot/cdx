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

// claude runs only read-only consults with Read, Grep and Glob. Probed with
// --debug-file: `claude -p` answers with every write outside TMPDIR denied
// (it logs and skips its ~/.claude and ~/.claude.json bookkeeping), and it
// execs only itself, the keychain `security` tool for auth, and git. The
// state root is denied even when it sits inside TMPDIR.
export function claudeProfile(executables: string[]): string {
  const writable = [tmpdir(), "/dev"].map((path) => `(subpath ${JSON.stringify(resolvedPath(path))})`);
  const runnable = [...new Set(executables.flatMap((path) => [path, resolvedPath(path)]))].map((path) => `(literal ${JSON.stringify(path)})`);
  return `(version 1)(allow default)(deny file-write*)(allow file-write* ${writable.join(" ")})`
    + `(deny file-write* (subpath ${JSON.stringify(resolvedPath(ROOT))}))`
    + `(deny process-exec*)(allow process-exec* ${runnable.join(" ")})`;
}
