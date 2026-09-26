import type { Engine } from "./ledger.ts";
import { basename, dirname, isAbsolute, resolve } from "node:path";

type Routing = Record<string, { model: string }>;

export interface SpawnModelChoice {
  model: string | undefined;
  reason: string;
}

// Git's common directory points at the main checkout's .git even when cwd is
// inside a linked worktree. The caller supplies that fact only when routing
// can apply, so selection stays pure and does not inspect the user's state.
export function chooseSpawnModel(
  baseModel: string | undefined,
  options: {
    engine: Engine;
    cwd: string;
    routing: Routing | undefined;
    commonDir: () => string | undefined;
    explicit: boolean;
    retained: boolean;
    thinking: boolean;
    child: boolean;
  },
): SpawnModelChoice {
  if (options.engine === "gemini") return { model: baseModel, reason: "Gemini engine" };
  if (options.explicit) return { model: baseModel, reason: "explicit --model" };
  if (options.retained) return { model: baseModel, reason: "retained lane model" };
  if (options.thinking) return { model: baseModel, reason: "head thinking model" };
  if (options.child) return { model: baseModel, reason: "child work model" };

  const commonDir = options.commonDir();
  if (commonDir && isAbsolute(commonDir)) {
    const canonical = resolve(commonDir);
    if (basename(canonical) === ".git") {
      const repo = dirname(canonical);
      const route = options.routing?.[repo];
      if (route) return { model: route.model, reason: `repoRouting[${repo}] for ${options.cwd}` };
    }
  }
  return { model: baseModel, reason: "default work model" };
}
