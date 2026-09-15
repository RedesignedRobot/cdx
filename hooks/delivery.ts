// Delivery buffer and drain rules. Pure module without engine interface calls.
// Evaluated both in Claude Code hooks and in tests.

export interface PendingEvent {
  text: string;
  wake?: boolean;
}

export interface DeliveryState {
  pending: PendingEvent[];
  inTurn: boolean;
}

export function initialDeliveryState(): DeliveryState {
  return { pending: [], inTurn: false };
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
): { state: DeliveryState; toasts: string[]; submit?: { text: string } } {
  const toasts = events.filter((e) => Boolean(e.wake)).map((e) => e.text);
  const pending = [...state.pending, ...events];

  if (!state.inTurn && pending.some((e) => Boolean(e.wake))) {
    return {
      state: { ...state, pending: [] },
      toasts,
      submit: { text: formatSubmitText(pending) },
    };
  }

  return {
    state: { ...state, pending },
    toasts,
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

export function onTurnStart(state: DeliveryState): DeliveryState {
  return { ...state, inTurn: true };
}

export function onTurnComplete(state: DeliveryState): DeliveryState {
  return { ...state, inTurn: false };
}

export function clearBuffer(state: DeliveryState): DeliveryState {
  return { ...state, pending: [] };
}
