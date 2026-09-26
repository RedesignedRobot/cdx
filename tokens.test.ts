import { expect, test } from "bun:test";
import { geminiTokens, migrateTokenAccounting } from "./tokens.ts";
import type { Lane } from "./ledger.ts";

const lane = (engine: "gpt" | "gemini", input = 10, cached = 20): Lane => ({
  engine, kind: "work", rounds: 2, work: { state: "done", cwd: "/repo" },
  tokens: { input, cached, output: 3 }, roundTokens: { input, cached, output: 3 },
} as Lane);

test("Gemini total input includes cache and output already includes thinking", () => {
  expect(geminiTokens({ input_tokens: 6135, cache_read_tokens: 16263, output_tokens: 1036, thinking_tokens: 936 }))
    .toEqual({ input: 22398, cached: 16263, output: 1036 });
  expect(geminiTokens({ input_tokens: 1, output_tokens: 2 })).toBeUndefined();
  expect(geminiTokens({ input_tokens: -1, cache_read_tokens: 0, output_tokens: 2 })).toBeUndefined();
});

test("ledger token migration adds only Gemini cache once, including mixed rounds", () => {
  const document = { lanes: {
    marked: { ...lane("gemini", 50), tokenAccounting: 1 as const },
    gemini: lane("gemini"), codex: lane("gpt", 50), mixed: { ...lane("gpt", 30), reviewEngine: "gemini" as const, kind: "review" as const },
    missing: { ...lane("gemini"), reviewEngine: "gpt" as const },
  } };
  const evidence = (name: string) => name === "mixed" ? [{ engine: "gpt" as const }, { engine: "gemini" as const, cached: 12 }] : [];
  migrateTokenAccounting(document, evidence);
  expect(document.lanes.marked.tokens!.input).toBe(50);
  expect(document.lanes.marked.roundTokens!.input).toBe(50);
  expect(document.lanes.gemini.tokens!.input).toBe(30);
  expect(document.lanes.gemini.roundTokens!.input).toBe(30);
  expect(document.lanes.codex.tokens!.input).toBe(50);
  expect(document.lanes.mixed.tokens!.input).toBe(42);
  expect(document.lanes.mixed.roundTokens!.input).toBe(50);
  expect(document.lanes.missing.tokensIncomplete).toBe(true);
  expect(Object.values(document.lanes).every((entry) => entry.tokens!.input >= entry.tokens!.cached)).toBe(true);
  const migrated = JSON.stringify(document);
  migrateTokenAccounting(document, () => { throw new Error("migration repeated"); });
  expect(JSON.stringify(document)).toBe(migrated);
  delete (document as { tokenAccounting?: number }).tokenAccounting;
  migrateTokenAccounting(document, () => { throw new Error("older writer dropped document marker"); });
  expect(JSON.stringify(document)).toBe(migrated);
});
