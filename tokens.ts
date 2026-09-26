import type { Engine, Lane, Tokens } from "./ledger.ts";

// agy input excludes cache reads; output already includes thinking tokens.
export function geminiTokens(usage: any): Tokens | undefined {
  if (!usage || ![usage.input_tokens, usage.cache_read_tokens, usage.output_tokens]
    .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return;
  return { input: usage.input_tokens + usage.cache_read_tokens, cached: usage.cache_read_tokens, output: usage.output_tokens };
}

export interface TokenRoundEvidence { engine: Engine; cached?: number }

// Old ledgers retain only cumulative and latest-round totals. Mixed lanes need
// the cache deltas of their Gemini rounds, never the Codex cache deltas.
export function migrateLaneTokens(lane: Lane, evidence: TokenRoundEvidence[]): void {
  const engines = new Set<Engine>([lane.engine, ...evidence.map((round) => round.engine)]);
  if (lane.reviewEngine) engines.add(lane.reviewEngine);
  if (lane.tokens && engines.has("gemini")) {
    if (engines.size === 1) lane.tokens.input += lane.tokens.cached;
    else {
      const known = evidence.filter((round) => round.engine === "gemini");
      const cached = known.reduce((sum, round) => sum + (round.cached ?? 0), 0);
      lane.tokens.input += Math.min(lane.tokens.cached, cached);
      if (evidence.length < lane.rounds || known.some((round) => round.cached === undefined)) lane.tokensIncomplete = true;
      // Missing archives cannot identify every old cache delta. Keep a lower
      // bound and expose incompleteness instead of inventing engine allocation.
      if (lane.tokens.input < lane.tokens.cached) {
        lane.tokens.input = lane.tokens.cached;
        lane.tokensIncomplete = true;
      }
    }
  }
  const engine = lane.kind === "review" ? lane.reviewEngine ?? lane.engine : lane.engine;
  if (lane.roundTokens && engine === "gemini") lane.roundTokens.input += lane.roundTokens.cached;
}

export function migrateTokenAccounting(document: { tokenAccounting?: number; lanes: Record<string, Lane> },
  evidence: (name: string, lane: Lane) => TokenRoundEvidence[]): void {
  for (const [name, lane] of Object.entries(document.lanes)) {
    if (lane.tokenAccounting === 1) continue;
    if (document.tokenAccounting !== 1) migrateLaneTokens(lane, evidence(name, lane));
    lane.tokenAccounting = 1;
  }
  document.tokenAccounting = 1;
}
