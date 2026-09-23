// Delivery buffer and drain rules. Pure module without engine interface calls.
// Evaluated both in Claude Code hooks and in tests.

import type { LiveRow } from "./contract";
export type { LiveRow, LiveSnapshot } from "./contract";

export interface PendingEvent {
  text: string;
  wake?: boolean;
  kind?: string;
}

function routineProgress(event: PendingEvent): boolean {
  return event.kind === "progress" && (event.text === "[cdx] progress" || event.text.startsWith("[cdx] progress\n"));
}

export function headEvents(events: readonly PendingEvent[]): PendingEvent[] {
  return events.filter((event) => !routineProgress(event));
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

export function bandRow(row: LiveRow, now: number, columns: number): string {
  const mark = row.question ? "?" : row.stage === "outage" || row.stage === "stalled" ? "!" : row.stage === "gate" ? "◆" : row.stage === "queued" ? "○" : "●";
  const indent = row.parent ? "  " : "";
  const model = row.model ? `${row.engine}/${row.model}` : row.engine;
  const count = row.kind === "job" ? "" : ` ${row.steps} steps${row.files === undefined ? "" : ` ${row.files} files`}`;
  const detail = row.question ? `question: ${row.question.replace(/\s+/g, " ")}` : actionWords(row.action);
  const line = `${indent}${mark} ${row.name} ${model} ${row.stage} ${elapsed(row.startedAt, now)}${count} ${detail}`;
  return Array.from(line).length > columns ? `${cut(line, columns - 1)}…` : line;
}

export function pinnedLine(rows: readonly LiveRow[], now: number, wakesOff = false): string {
  if (!rows.length) return wakesOff ? "wakes off" : "";
  const busiest = [...rows].sort((a, b) => b.steps - a.steps || Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]!;
  const lanes = rows.filter((row) => row.kind === "lane").length;
  const jobs = rows.length - lanes;
  const count = `${lanes} ${lanes === 1 ? "lane" : "lanes"}${jobs ? `, ${jobs} ${jobs === 1 ? "job" : "jobs"}` : ""}`;
  return cut(`${wakesOff ? "wakes off · " : ""}cdx ${count} · ${busiest.name} ${busiest.stage} ${elapsed(busiest.startedAt, now)} · ${actionWords(busiest.action)}`, 120);
}

export interface DeliveryState {
  pending: PendingEvent[];
  progress: PendingEvent[];
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
  return { pending: [], progress: [], inTurn: false, submits: 0, budgetSpent: false };
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
  const delivered = headEvents(events);
  const toasts = delivered.filter((e) => Boolean(e.wake)).map((e) => e.text);
  const pending = [...state.pending, ...delivered];
  state = { ...state, progress: [...state.progress, ...events.filter(routineProgress)].slice(-20) };
  const wakePending = pending.some((e) => Boolean(e.wake));

  if (state.inTurn || !wakePending) {
    return { state: { ...state, pending }, toasts };
  }

  // No prompt left: the events wait for the next tool result or typed
  // prompt, and a fresh wake goes into the prompt box as a suggestion.
  if (state.budgetSpent) {
    const fresh = delivered.some((e) => Boolean(e.wake));
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
  return { ...state, pending: [], progress: [] };
}
