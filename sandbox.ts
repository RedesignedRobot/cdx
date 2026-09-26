// OS write boundaries for lane engines. Codex enforces its sandbox policy on
// every command it runs; agy runs whole under a sandbox-exec profile built from
// the same roots. Seatbelt does not nest, so supervisors reach cdx through a
// Codex exec-policy rule instead (account-sync.ts).
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { HOME, ROOT } from "./runtime.ts";
import type { Spec } from "./ledger.ts";

// Lane-side cdx writes (cdx ask, Gemini hooks) land in these directories.
// Gemini hooks also write the round's partial report and progress log, which
// the runner names as files. Supervisors' cdx calls run outside the sandbox.
export const CLI_STATE_DIRS = [join(ROOT, "state"), join(ROOT, "control")];
export const AGY_HOME = join(HOME, ".gemini", "antigravity-cli");

export const spillDirOf = (lane: string, round: number) => join(ROOT, "logs", `${lane}-r${round}.out`);

type SandboxSpec = Pick<Spec, "cwd" | "additionalDirectories" | "reviewDir"> & { lane?: string; round?: number };

// Probed under both sandboxes: bun install fails with EPERM on ~/.bun/install/cache,
// so lane shells keep their package cache under TMPDIR, which every role may write.
export const LANE_TOOL_ENV = { BUN_INSTALL_CACHE_DIR: join(tmpdir(), "cdx-bun-cache") };

// An index counts only at or below the enclosing checkout; a cwd outside any
// checkout gets none, so no lane reaches a shared parent index such as ~/code.
function indexedAncestor(start: string, exists: (path: string) => boolean): { index?: string; checkout?: string } {
  let index: string | undefined;
  for (let path = start; ; path = dirname(path)) {
    index ??= exists(join(path, ".codegraph", "codegraph.db")) ? path : undefined;
    if (exists(join(path, ".git"))) return { index, checkout: path };
    if (dirname(path) === path) return {};
  }
}

function gitPointer(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

// The index codegraph should answer from for a lane cwd. Codegraph counts a
// directory only when .codegraph/codegraph.db exists (cdx tracks a bare
// .codegraph/.gitignore) and would climb past the checkout into an unrelated
// parent index such as ~/code. A linked worktree without its own index borrows the primary checkout's index
// at the same relative path.
export function codegraphRoot(cwd: string, exists: (path: string) => boolean = existsSync, readGit = gitPointer): string | undefined {
  const start = resolve(cwd);
  const own = indexedAncestor(start, exists);
  if (own.index || !own.checkout) return own.index;
  const primary = /^gitdir: (.+)\/\.git\/worktrees\/[^/\n]+\s*$/.exec(readGit(join(own.checkout, ".git")) ?? "")?.[1];
  return primary ? indexedAncestor(join(primary, relative(own.checkout, start)), exists).index : undefined;
}

// Codegraph opens its SQLite index read-write, so a lane that queries it needs
// the index directory writable. It holds the graph cache, never source.
// A review snapshot links the source's ignored index, and SQLite writes its
// -wal and -shm files beside the resolved database file.
function codegraphDirs(spec: SandboxSpec): string[] {
  const root = codegraphRoot(spec.cwd);
  if (!root) return [];
  const dir = join(root, ".codegraph");
  return [...new Set([resolvedPath(dir), dirname(resolvedPath(join(dir, "codegraph.db")))])];
}

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

export const REVIEW_PROFILE = "cdx-review";

// Spread into thread/start (thread), turn/start (turn) and the thread config
// overrides (config). A lane with reviewDir set is read-only: reviews, consults,
// and consult supervisors. Every sandbox mode writes the cwd, so reviews use a
// permissions profile that writes only TMPDIR and the codegraph index. Codex
// 0.156 fails every turn with "failed to load workspace requirements" when the
// profile is selected through the thread/start or turn/start `permissions`
// field, so the profile comes from the default_permissions config override.
// The review profile arrives only through a config override that an account
// config could outrank, so the runner checks what thread/start or thread/resume
// reports and refuses a thread that could write the checkout.
export function reviewSandboxRefusal(thread: { activePermissionProfile?: { id?: string } | null; sandbox?: { type?: string; writableRoots?: string[] } }, cwd: string): string | undefined {
  const profile = thread.activePermissionProfile?.id;
  if (profile !== REVIEW_PROFILE) return `review thread runs permissions profile ${profile ?? "none"}, not ${REVIEW_PROFILE}`;
  const at = resolvedPath(cwd);
  const writesCwd = thread.sandbox?.type === "dangerFullAccess" || thread.sandbox?.type === "externalSandbox"
    || (thread.sandbox?.writableRoots ?? []).some((root) => !relative(resolvedPath(root), at).startsWith(".."));
  return writesCwd ? `review thread may write ${cwd}: ${JSON.stringify(thread.sandbox)}` : undefined;
}

export function codexSandbox(spec: SandboxSpec) {
  if (spec.reviewDir) {
    const filesystem = { ":root": "read", ":tmpdir": "write", ...Object.fromEntries(codegraphDirs(spec).map((dir) => [dir, "write"])) };
    return { thread: {}, turn: {}, config: { default_permissions: REVIEW_PROFILE,
      permissions: { [REVIEW_PROFILE]: { filesystem, network: { enabled: true } } } } };
  }
  // Codex adds the turn cwd as the first writable root and keeps .git read-only.
  const writableRoots = [...(spec.additionalDirectories ?? []), ...laneStateDirs(spec), ...codegraphDirs(spec)].map(resolvedPath);
  return { thread: { sandbox: "workspace-write" }, config: {}, turn: { sandboxPolicy: { type: "workspaceWrite", writableRoots,
    networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } } };
}

// agy writes its home, TMPDIR, the codegraph index, and the files named by the
// caller. Gemini hooks run inside agy and write cdx state and spilled output, so
// read-only lanes keep those too; only work lanes get the checkout and /tmp.
export function geminiProfile(spec: SandboxSpec, files: string[] = []): string {
  const work = spec.reviewDir ? [] : [spec.cwd, ...(spec.additionalDirectories ?? []), "/tmp"];
  const subpaths = [AGY_HOME, tmpdir(), "/dev", ...laneStateDirs(spec), ...codegraphDirs(spec), ...work].map(resolvedPath);
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
