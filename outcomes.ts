import type { Lane, Ledger } from "./ledger.ts";

// First-round-green-landed: the share of finished work lanes that went green
// on their first work round and then landed. A lane records only its latest
// round, so rounds-to-green is the work round count of a lane that ended
// green; review-fix rounds after a green round count too.
export interface OutcomeGroup {
  lanes: number;
  green: number;
  landed: number;
  firstRoundGreenLanded: number;
  firstRoundGreenLandedShare: number;
  meanRoundsToGreen: number | null;
}

export interface Outcomes { byEngine: Record<string, OutcomeGroup>; byRepo: Record<string, OutcomeGroup> }

const MODEL_LABELS: Record<string, string> = { "gpt-6-sol": "sol", "gpt-6-astra": "astra" };

function workRounds(lane: Lane): number {
  return lane.workRounds ?? (lane.kind === "work" ? lane.rounds : 0);
}

function green(lane: Lane): boolean {
  if (lane.landedCommit || lane.gateReceipt?.valid) return true;
  return ["done", "closed"].includes(lane.work.state) && lane.work.exitCode === 0;
}

// Engine label plus role, the split the 740-lane study measured.
export function engineGroup(lane: Lane): string {
  const engine = lane.engine === "gemini" ? "gemini" : MODEL_LABELS[lane.model ?? ""] ?? lane.model ?? "gpt";
  const role = lane.supervisor ? "supervisor" : lane.parent ? "child" : "direct";
  return `${engine} ${role}`;
}

export function laneOutcomes(ledger: Ledger): Outcomes {
  const tallies = { byEngine: new Map<string, { group: OutcomeGroup; rounds: number }>(), byRepo: new Map<string, { group: OutcomeGroup; rounds: number }>() };
  for (const lane of Object.values(ledger)) {
    if (lane.consult || workRounds(lane) < 1 || lane.work.state === "running") continue;
    const isGreen = green(lane);
    const landed = Boolean(lane.landedCommit);
    for (const [map, key] of [[tallies.byEngine, engineGroup(lane)], [tallies.byRepo, lane.worktreeRepo ?? lane.work.cwd]] as const) {
      const tally = map.get(key) ?? { group: { lanes: 0, green: 0, landed: 0, firstRoundGreenLanded: 0, firstRoundGreenLandedShare: 0, meanRoundsToGreen: null }, rounds: 0 };
      tally.group.lanes += 1;
      if (isGreen) { tally.group.green += 1; tally.rounds += workRounds(lane); }
      if (landed) tally.group.landed += 1;
      if (landed && workRounds(lane) === 1) tally.group.firstRoundGreenLanded += 1;
      map.set(key, tally);
    }
  }
  const finish = (map: Map<string, { group: OutcomeGroup; rounds: number }>) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, { group, rounds }]) => [key, {
    ...group,
    firstRoundGreenLandedShare: Math.round((group.firstRoundGreenLanded / group.lanes) * 1000) / 1000,
    meanRoundsToGreen: group.green ? Math.round((rounds / group.green) * 100) / 100 : null,
  }]));
  return { byEngine: finish(tallies.byEngine), byRepo: finish(tallies.byRepo) };
}

export function outcomeLines(outcomes: Outcomes, label: (key: string) => string = (key) => key): string[] {
  const line = (key: string, group: OutcomeGroup) => `  ${label(key)}: lanes ${group.lanes}, green ${group.green}, landed ${group.landed}, `
    + `first-round green and landed ${group.firstRoundGreenLanded} (${Math.round(group.firstRoundGreenLandedShare * 100)}%), `
    + `rounds to green ${group.meanRoundsToGreen ?? "-"}`;
  return [
    "work lanes by engine:", ...Object.entries(outcomes.byEngine).map(([key, group]) => line(key, group)),
    "work lanes by repo:", ...Object.entries(outcomes.byRepo).map(([key, group]) => line(key, group)),
  ];
}
