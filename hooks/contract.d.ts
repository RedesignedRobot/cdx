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

declare module "claude-code" {
  interface PluginState { cdx: { live: LiveSnapshot } }
}
