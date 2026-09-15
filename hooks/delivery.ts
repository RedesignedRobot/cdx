// Delivery buffer and drain rules. Pure module without engine interface calls.
// Evaluated both in Claude Code hooks and in tests.

export interface PendingEvent {
  text: string;
  wake?: boolean;
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
