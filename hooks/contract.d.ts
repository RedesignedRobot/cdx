export interface LiveRow {
  name: string;
  parent?: string;
  kind: "lane" | "job";
  engine: string;
  model?: string;
  stage: string;
  startedAt: string;
  steps: number;
  files?: number;
  action: string;
  question?: string;
  transcript?: string[];
}

export interface LiveSnapshot { rows: LiveRow[]; now: number }

export interface RolloverState { session: string; compactions: number; blocked: boolean }

declare module "claude-code" {
  // poller: the id of the one module instance whose timer polls cdx.
  interface PluginState { cdx: { live: LiveSnapshot; rollover: RolloverState; poller: string } }
}
