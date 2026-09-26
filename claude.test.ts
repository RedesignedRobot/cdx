import { expect, test } from "bun:test";
import { claudeArgs, claudeLaneRefusal, claudeTokens, parseClaudeResult } from "./claude.ts";
import { claudeProfile } from "./sandbox.ts";

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
  expect(args[args.indexOf("--tools") + 1]).not.toMatch(/Edit|Write/);
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

test("claude profile allows only claude scratch state and denies owner config", () => {
  const profile = claudeProfile();
  const [allow, deny] = profile.split(")(deny file-write* ");
  expect(profile.startsWith("(version 1)(allow default)(deny file-write*)(allow file-write* ")).toBe(true);
  for (const dir of ["shell-snapshots", "session-env", "sessions", "backups"]) expect(allow).toContain(`/.claude/${dir}"`);
  expect(allow).toContain('(regex #"^/private/tmp/claude-")');
  expect(allow).toContain("\\.claude\\.json");
  expect(allow).not.toMatch(/\.claude"\)/);
  for (const entry of ["codex-harness", "hooks", "skills", "plugins", "CLAUDE.md"]) expect(deny).toContain(`/.claude/${entry}"`);
  expect(deny).toContain("/settings[^/]*\\.json$");
  expect(profile).not.toContain(process.cwd());
});
