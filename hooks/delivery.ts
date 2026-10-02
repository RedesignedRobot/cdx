// Delivery buffer and drain rules. Pure module without engine interface calls.
// Evaluated both in Claude Code hooks and in tests.

import type { LiveRow } from "./contract";
export type { LiveRow, LiveSnapshot } from "./contract";

export interface PendingEvent {
  text: string;
  wake?: boolean;
  kind?: string;
}

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000) || 0);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s`
    : `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
}

function cut(text: string, length: number): string {
  return Array.from(text).slice(0, Math.max(0, length)).join("");
}

function actionWords(action: string): string {
  const plain = action.replace(/\s+/g, " ").trim();
  const command = plain.match(/(?:"(?:command|cmd)"\s*:\s*"|^|:\s*)(bun(?:x)?|npm|git|vp|claude|tsc|rg|grep)\s+([^"}]*)/i);
  if (command) return `running ${command[1]} ${command[2]}`.trim();
  const path = plain.match(/(?:"(?:file_path|path)"\s*:\s*")([^"}]+)|\b([\w./-]+\.(?:ts|tsx|js|md|json))\b/);
  if (/edit|patch|write|fileChange|file_change/i.test(plain) && path) return `editing ${path[1] ?? path[2]}`;
  if (/read|cat|sed|rg|grep/i.test(plain) && path) return `reading ${path[1] ?? path[2]}`;
  return cut(plain.replace(/[{}"\\]/g, ""), 64) || "working";
}

export function orderedRows(rows: readonly LiveRow[]): LiveRow[] {
  const children = new Map<string, LiveRow[]>();
  for (const row of rows) {
    const parent = row.parent && rows.some((item) => item.name === row.parent) ? row.parent : "";
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const ordered: LiveRow[] = [];
  const visit = (parent: string) => {
    for (const row of children.get(parent) ?? []) { ordered.push(row); visit(row.name); }
  };
  visit("");
  return ordered;
}

// One styled run of a band line; its text carries the padding and the gap
// after it, so the texts of a line joined are the line as drawn.
export interface BandCell {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

interface BandColumn {
  title: string;
  value: (row: LiveRow, now: number) => string;
  style: (row: LiveRow) => Omit<BandCell, "text">;
  gap: number;
  max?: number;
  right?: boolean;
}

const STAGE_COLORS: Record<string, string> = {
  working: "green", gate: "cyan", review: "cyan", question: "yellow", stalled: "yellow", outage: "red",
};

export function stageColor(stage: string): string | undefined {
  return STAGE_COLORS[stage];
}

function markOf(row: LiveRow): string {
  return row.question ? "?" : row.stage === "outage" || row.stage === "stalled" ? "!" : row.stage === "gate" ? "◆" : row.stage === "queued" ? "○" : "●";
}

const plain = () => ({});
const staged = (row: LiveRow) => ({ color: stageColor(row.stage) });
const dim = () => ({ dim: true });

const BAND_COLUMNS: BandColumn[] = [
  { title: "", value: markOf, style: staged, gap: 1 },
  { title: "NAME", value: (row) => `${row.parent ? "  " : ""}${row.name}`, style: () => ({ bold: true }), gap: 2, max: 28 },
  { title: "KIND", value: (row) => row.kind, style: plain, gap: 2 },
  { title: "ENGINE", value: (row) => row.kind === "job" ? "-" : row.model ?? row.engine, style: plain, gap: 2, max: 18 },
  { title: "EFFORT", value: (row) => row.kind === "job" ? "-" : row.effort ?? "-", style: dim, gap: 2 },
  { title: "ACCOUNT", value: (row) => row.kind === "lane" && row.engine === "gpt" ? row.account ?? "-" : "-", style: dim, gap: 2 },
  { title: "TIER", value: (row) => row.kind === "lane" && row.engine === "gpt" ? row.serviceTier === "priority" ? "fast" : row.serviceTier === "default" ? "std" : "-" : "-", style: dim, gap: 2 },
  { title: "STAGE", value: (row) => row.stage, style: staged, gap: 2 },
  { title: "AGE", value: (row, now) => elapsed(row.startedAt, now), style: dim, gap: 2 },
  { title: "STEPS", value: (row) => row.kind === "job" ? "-" : String(row.steps), style: plain, gap: 2, right: true },
  { title: "FILES", value: (row) => row.files === undefined ? "-" : String(row.files), style: plain, gap: 2, right: true },
];

// Below this many columns for NOW the band drops TIER, ACCOUNT, EFFORT, ENGINE, KIND.
const NOW_MIN = 20;

function width(text: string): number {
  return Array.from(text).length;
}

function ellipsis(text: string, size: number): string {
  if (size <= 0) return "";
  return width(text) > size ? `${cut(text, size - 1)}…` : text;
}

function detailOf(row: LiveRow): string {
  return row.question ? `question: ${row.question.replace(/\s+/g, " ")}` : actionWords(row.action);
}

// The band as a table: a header line, then one line per row in the order
// given. Fixed columns fit the widest value shown (NAME and ENGINE capped),
// NOW takes the rest of the width, and no line is wider than columns.
export function bandTable(rows: readonly LiveRow[], now: number, columns: number): BandCell[][] {
  let layout = BAND_COLUMNS.map((column) => {
    const widest = Math.max(width(column.title), ...rows.map((row) => width(column.value(row, now))));
    return { column, size: Math.min(widest, column.max ?? widest) };
  });
  const rest = () => columns - layout.reduce((sum, { column, size }) => sum + size + column.gap, 0);
  for (const dropped of ["TIER", "ACCOUNT", "EFFORT", "ENGINE", "KIND"]) {
    if (rest() < NOW_MIN) layout = layout.filter(({ column }) => column.title !== dropped);
  }
  const nowSize = Math.max(0, rest());
  const pad = (text: string, size: number, right?: boolean) => {
    const shown = ellipsis(text, size);
    const fill = " ".repeat(size - width(shown));
    return right ? fill + shown : shown + fill;
  };
  const header = [...layout.map(({ column, size }) => ({ text: pad(column.title, size) + " ".repeat(column.gap), dim: true })),
    { text: ellipsis("NOW", nowSize), dim: true }];
  const lines = rows.map((row) => [
    ...layout.map(({ column, size }) => ({ text: pad(column.value(row, now), size, column.right) + " ".repeat(column.gap), ...column.style(row) })),
    { text: ellipsis(detailOf(row), nowSize), dim: true },
  ]);
  return [header, ...lines].map((line) => clip(line, columns));
}

// A terminal too narrow for the fixed columns still gets lines no wider
// than it: the cell at the edge is cut and the rest dropped.
function clip(line: BandCell[], columns: number): BandCell[] {
  const kept: BandCell[] = [];
  let left = columns;
  for (const cell of line) {
    if (left <= 0) break;
    const text = cut(cell.text, left);
    kept.push({ ...cell, text });
    left -= width(text);
  }
  return kept.filter((cell) => cell.text);
}

export function bandText(line: readonly BandCell[]): string {
  return line.map((cell) => cell.text).join("");
}

export interface DeliveryState {
  pending: PendingEvent[];
  inTurn: boolean;
  // When the first undelivered wake event arrived while idle; the submit
  // waits WAKE_COALESCE_MS from then so one burst costs one prompt.
  wakeSince?: number;
  // Prompts the engine accepted this session.
  submits: number;
  // The engine refused a submit on its per-session prompt budget; no submit
  // is tried again this session.
  budgetSpent: boolean;
}

// The engine caps a plugin's prompts per session (50 in Claude Code 2.1.x),
// so wake events are held this long and sent as one prompt.
export const WAKE_COALESCE_MS = 15_000;

export function initialDeliveryState(): DeliveryState {
  return { pending: [], inTurn: false, submits: 0, budgetSpent: false };
}

export function formatSubmitText(events: readonly PendingEvent[]): string {
  const joined = events.map((e) => e.text).join("\n");
  return joined.startsWith("[cdx]") ? joined : `[cdx] ${joined}`;
}

export function formatContextText(events: readonly PendingEvent[]): string {
  return ["[cdx] events", ...events.map((e) => e.text)].join("\n");
}

export function afterPoll(
  state: DeliveryState,
  events: readonly PendingEvent[],
  now = Date.now(),
): { state: DeliveryState; toasts: string[]; submit?: { text: string }; suggest?: { text: string } } {
  // cdx events already filters to the kinds the head acts on.
  const toasts = events.filter((e) => Boolean(e.wake)).map((e) => e.text);
  const pending = [...state.pending, ...events];
  const wakePending = pending.some((e) => Boolean(e.wake));

  if (state.inTurn || !wakePending) {
    return { state: { ...state, pending }, toasts };
  }

  // No prompt left: the events wait for the next tool result or typed
  // prompt, and a fresh wake goes into the prompt box as a suggestion.
  if (state.budgetSpent) {
    const fresh = events.some((e) => Boolean(e.wake));
    return {
      state: { ...state, pending },
      toasts,
      ...(fresh ? { suggest: { text: formatSubmitText(pending) } } : {}),
    };
  }

  const wakeSince = state.wakeSince ?? now;
  if (now - wakeSince < WAKE_COALESCE_MS) {
    return { state: { ...state, pending, wakeSince }, toasts };
  }

  return {
    state: { ...state, pending: [], wakeSince: undefined, submits: state.submits + 1 },
    toasts,
    submit: { text: formatSubmitText(pending) },
  };
}

// A refused submit puts its events back. A budget refusal ends submitting
// for the session; any other refusal is retried after the coalesce window.
export function onSubmitRefused(
  state: DeliveryState,
  drained: readonly PendingEvent[],
  message: string,
): DeliveryState {
  return {
    ...state,
    pending: [...drained, ...state.pending],
    wakeSince: undefined,
    submits: Math.max(0, state.submits - 1),
    budgetSpent: state.budgetSpent || /budget/i.test(message),
  };
}

export function afterToolCall(
  state: DeliveryState,
  options?: { isSubagent?: boolean } | boolean,
): { state: DeliveryState; context?: string } {
  const isSubagent = typeof options === "boolean" ? options : Boolean(options?.isSubagent);
  if (isSubagent || state.pending.length === 0) {
    return { state };
  }

  return {
    state: { ...state, pending: [] },
    context: formatContextText(state.pending),
  };
}

export function onPromptSubmit(
  state: DeliveryState,
): { state: DeliveryState; context?: string } {
  if (state.pending.length === 0) {
    return { state };
  }

  return {
    state: { ...state, pending: [] },
    context: formatContextText(state.pending),
  };
}

// A running turn drains the buffer through tool results, so a held wake
// stops waiting for its prompt.
export function onTurnStart(state: DeliveryState): DeliveryState {
  return { ...state, inTurn: true, wakeSince: undefined };
}

export function onTurnComplete(state: DeliveryState): DeliveryState {
  return { ...state, inTurn: false };
}

export function clearBuffer(state: DeliveryState): DeliveryState {
  return { ...state, pending: [] };
}
