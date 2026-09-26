import { expect, test } from "bun:test";
import { claudeArgs, claudeLaneRefusal, claudeTokens, parseClaudeResult } from "./claude.ts";
import { claudeProfile } from "./sandbox.ts";
import { HOME, ROOT } from "./runtime.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("claude runs consult lanes only", () => {
  expect(claudeLaneRefusal("claude", "review", true)).toBeUndefined();
  expect(claudeLaneRefusal("claude", "work", false)).toContain("work lane on claude is refused");
  expect(claudeLaneRefusal("claude", "review", false)).toContain("review lane on claude is refused");
  expect(claudeLaneRefusal("gpt", "work", false)).toBeUndefined();
});

test("claude args stay headless and read-only", () => {
  const args = claudeArgs("claude-fable-5-1", "medium");
  expect(args.slice(0, 3)).toEqual(["-p", "--model", "claude-fable-5-1"]);
  expect(args).toContain("--safe-mode");
  expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
  expect(args).toContain("--restricted");
  expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
  expect(claudeArgs("m", "low", ["/state/briefs"]).slice(-2)).toEqual(["--add-dir", "/state/briefs"]);
});

const result = {
  type: "result", subtype: "success", is_error: false, result: "## Recommendation\nKeep it.", session_id: "s1", total_cost_usd: 0.087,
  usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 30 },
  modelUsage: {
    "claude-fable-5-1": { inputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, outputTokens: 30 },
    "claude-opus-5": { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 4 },
  },
};

test("claude tokens sum every model and count cache inside input", () => {
  expect(claudeTokens(result)).toEqual({ input: 135, cached: 100, output: 34 });
  expect(claudeTokens({ usage: result.usage })).toEqual({ input: 125, cached: 100, output: 30 });
  expect(claudeTokens({})).toBeUndefined();
});

test("claude result parsing separates answers from failures", () => {
  expect(parseClaudeResult(JSON.stringify(result))).toEqual({
    report: "## Recommendation\nKeep it.", sessionId: "s1", tokens: { input: 135, cached: 100, output: 34 }, costUsd: 0.087,
  });
  expect(parseClaudeResult("not json").failure).toBe("claude printed no JSON result");
  expect(parseClaudeResult(JSON.stringify({ type: "assistant" })).failure).toBe("claude printed no result message");
  expect(parseClaudeResult(JSON.stringify({ ...result, subtype: "error_max_turns" })).failure).toBe("claude error_max_turns");
  expect(parseClaudeResult(JSON.stringify({ ...result, is_error: true, result: "rate limited" })).failure).toBe("claude error: rate limited");
  expect(parseClaudeResult(JSON.stringify({ ...result, result: "  " })).failure).toBe("claude returned an empty result");
});

// A real seatbelt probe: bash opens each path for append under the
// profile. ": >>" leaves an existing file's bytes alone; a probe file the
// profile wrongly let through is removed before the test fails.
test.skipIf(process.platform !== "darwin")("claude profile denies every write outside TMPDIR and every foreign exec", () => {
  const profile = claudeProfile(["/bin/bash"]);
  mkdirSync(ROOT, { recursive: true });
  const attempt = (path: string) => {
    const existed = existsSync(path);
    const ok = Bun.spawnSync(["sandbox-exec", "-p", profile, "/bin/bash", "-c", ': >> "$1"', "bash", path], { stderr: "pipe" }).success;
    if (ok && !existed) rmSync(path, { force: true });
    return ok;
  };
  const probe = `cdx-probe-${process.pid}`;
  const denied = [
    join(HOME, ".claude.json"), join(HOME, ".claude", "settings.json"), join(HOME, ".claude", "shell-snapshots", probe),
    join(HOME, ".claude", "session-env", probe), join(HOME, ".claude", "hooks", probe), join(HOME, ".claude", "codex-harness", probe),
    join(HOME, ".claude", "skills", probe), `/tmp/claude-${process.getuid!()}/${probe}`, `/tmp/${probe}`, join(ROOT, probe), join(process.cwd(), probe),
  ];
  expect(denied.filter(attempt)).toEqual([]);
  expect(attempt(join(tmpdir(), probe))).toBe(true);
  expect(Bun.spawnSync(["sandbox-exec", "-p", profile, "/bin/bash", "-c", "/usr/bin/true"]).success).toBe(false);
});
