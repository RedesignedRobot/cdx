// Head rollover. GLOBAL.md says to start a fresh session before a third
// compaction; heads crossed hundreds anyway. After the second compaction of a
// session, the next Stop blocks once and tells the head to hand off.

import type { RolloverState } from "./contract";

export const ROLL_AFTER_COMPACTIONS = 2;

export const ROLLOVER_REASON = `cdx: this session has compacted ${ROLL_AFTER_COMPACTIONS} times and a third summary loses more than it keeps. `
  + "Update the run's BATCH.md under ~/.cdx/reports/ so a fresh session can resume from it, "
  + 'push the owner "roll session", then end the turn.';

export function afterCompaction(state: RolloverState | undefined, session: string): RolloverState {
  const current = state?.session === session ? state : { session, compactions: 0, blocked: false };
  return { ...current, compactions: current.compactions + 1 };
}

export function stopOutcome(state: RolloverState | undefined, session: string): { state: RolloverState; block: string } | undefined {
  if (!state || state.session !== session || state.blocked || state.compactions < ROLL_AFTER_COMPACTIONS) return;
  return { state: { ...state, blocked: true }, block: ROLLOVER_REASON };
}
