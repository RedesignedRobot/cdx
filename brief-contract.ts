// The work brief contract and the scope policy. Pure: the MCP tool table
// imports it to render briefs, so it must not reach the state store.

// Lanes asked 477 questions over 740 lanes; half were "may I edit outside my
// files". A work brief now names its scope up front and the policy answers
// that question before it is asked.
export type ScopePolicy = "ask" | "extend" | "stop";
export const SCOPE_POLICIES: readonly ScopePolicy[] = ["ask", "extend", "stop"];

export interface BriefFields {
  outcome?: string;
  files?: string[];
  acceptance?: string;
  outOfScope?: string;
  children?: string[];
}

type Section = "outcome" | "files" | "acceptance" | "outOfScope" | "children";

const HEADINGS: Record<Section, string> = {
  outcome: "Outcome", files: "Files", acceptance: "Acceptance", outOfScope: "Out of scope", children: "Children",
};

// First match wins, so "Out of scope files" is out of scope and "Child file
// sets" is children, never files.
const CLASSIFIERS: [Section, RegExp][] = [
  ["outOfScope", /\bout of scope\b|\bnon goals?\b/],
  ["children", /\bchild(?:ren)?\b/],
  ["acceptance", /\bacceptance\b/],
  ["outcome", /\boutcome\b/],
  ["files", /\bfiles?\b/],
];

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

// Markdown headings of any level split the brief. A section counts only when
// its body has text.
export function briefSections(brief: string): Partial<Record<Section, string>> {
  const sections: Partial<Record<Section, string>> = {};
  let current: Section | undefined;
  for (const line of brief.split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const title = heading[1]!.toLowerCase().replace(/[-_:]/g, " ").replace(/\s+/g, " ");
      current = CLASSIFIERS.find(([, pattern]) => pattern.test(title))?.[0];
      if (current) sections[current] ??= "";
      continue;
    }
    if (current) sections[current] += `${line}\n`;
  }
  for (const key of Object.keys(sections) as Section[]) {
    const body = sections[key]!.trim();
    if (body) sections[key] = body;
    else delete sections[key];
  }
  return sections;
}

export function childFileSets(brief: string): number {
  return (briefSections(brief).children ?? "").split("\n").filter((line) => LIST_ITEM.test(line)).length;
}

// One line naming every missing element, or undefined when the brief holds.
export function briefContractRefusal(brief: string, hasGate: boolean, supervisor: boolean): string | undefined {
  const sections = briefSections(brief);
  const missing = (["outcome", "files", "acceptance", "outOfScope"] as const)
    .filter((key) => !sections[key]).map((key) => `"## ${HEADINGS[key]}"`);
  if (!hasGate) missing.push("a gate (--gate or .cdx-gate)");
  if (supervisor && childFileSets(brief) < 2) missing.push(`"## ${HEADINGS.children}" with two or more child file sets, one list item each`);
  if (missing.length === 0) return;
  return `work brief refused, missing ${missing.join(", ")}; consults and reviews are exempt`;
}

export function renderBrief(fields: BriefFields, body: string): string {
  const list = (items: string[] | undefined) => items?.map((item) => `- ${item}`).join("\n");
  const sections: [Section, string | undefined][] = [
    ["outcome", fields.outcome], ["files", list(fields.files)], ["acceptance", fields.acceptance],
    ["outOfScope", fields.outOfScope], ["children", list(fields.children)],
  ];
  const rendered = sections.filter(([, text]) => text?.trim()).map(([key, text]) => `## ${HEADINGS[key]}\n\n${text!.trim()}`);
  return [...rendered, body.trim()].filter(Boolean).join("\n\n");
}

// Commands that pass no matter what the tree holds.
export function isNoOpGate(command: string): boolean {
  return /^(?:true|:|exit(?:\s+0)?|\/(?:usr\/)?bin\/true|echo\b[^;&|`$]*)\s*;?$/.test(command.trim());
}

export function scopeRule(policy: ScopePolicy): string {
  if (policy === "extend") return 'Scope policy extend: edit any file the outcome needs, inside or outside the Files section, without asking. List every file outside it under "## Scope extensions" in your report, one line each with the reason.';
  if (policy === "stop") return "Scope policy stop: if the outcome needs a file outside the Files section, do not edit it and do not ask. Stop, name the file and the reason in your report, and end the round.";
  return "Scope policy ask: before editing a file outside the Files section, ask with cdx ask and wait for the answer.";
}

export function scopeAnswer(policy: ScopePolicy): string {
  return policy === "extend"
    ? 'cdx answered from the scope policy (extend): yes. Edit what the outcome needs and list each file outside your Files section under "## Scope extensions" in your report. Do not ask again.'
    : "cdx answered from the scope policy (stop): no. Do not edit outside your Files section. Stop, name the file and the reason in your report, and end the round.";
}

const PERMISSION = /\b(?:may i|can i|could i|should i|shall i|am i (?:allowed|permitted)|is it (?:ok|okay|fine)|ok to|okay to|permission|approve|authori[sz]e|allowed to)\b/i;
const SCOPE = /\b(?:outside|beyond|not (?:in|on|part of|listed in)|extend|expand|widen)\b[^.?!]*\b(?:scope|files?|file set|owned|ownership|brief|list)\b|\bout of scope\b|\bscope extension\b/i;

// Keyword classifier: a permission word plus a scope phrase.
export function isScopePermissionAsk(question: string): boolean {
  return PERMISSION.test(question) && SCOPE.test(question);
}

// List items under "## Scope extensions"; "None" and prose do not count.
export function scopeExtensions(report: string): string[] {
  const lines = report.split("\n");
  const start = lines.findIndex((line) => /^\s{0,3}#{1,6}\s+scope extensions\b/i.test(line));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) break;
    if (LIST_ITEM.test(line)) items.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim());
  }
  return items;
}
