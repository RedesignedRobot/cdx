import { isatty } from "node:tty";
import { stripVTControlCharacters } from "node:util";

import { palette } from "./tui-theme.ts";
import { emitKeypressEvents, type Key } from "node:readline";

type Tone = keyof typeof palette;
export interface Terminal {
  columns: number;
  color: boolean;
  unicode: boolean;
}

// Detection is deliberately passive. A CLI must not consume the caller's stdin.
export function terminal(env = process.env, tty = Boolean(process.stdout.isTTY)): Terminal {
  const usable = tty && env.TERM !== "dumb";
  const kitty = env.TERM_PROGRAM === "ghostty" || /^(xterm-ghostty|xterm-kitty)$/.test(env.TERM ?? "");
  const color = usable && env.NO_COLOR === undefined && (kitty || /^(truecolor|24bit)$/.test(env.COLORTERM ?? ""));
  return {
    columns: Math.max(1, Math.min(process.stdout.columns || 100, 160)), color,
    unicode: usable && env.CDX_TUI_ASCII !== "1",
  };
}

export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function paint(text: string, tone: Tone, term: Terminal): string {
  const value = clean(text);
  return term.color ? `\x1b[38;2;${palette[tone].join(";")}m${value}\x1b[39m` : value;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "", width = 0;
  for (const { segment } of graphemes.segment(clean(text))) {
    const size = Bun.stringWidth(segment);
    if (width + size > columns && line) { lines.push(line); line = ""; width = 0; }
    if (size > columns) { line += "?"; width += 1; continue; }
    line += segment;
    width += size;
  }
  return [...lines, line];
}

export function renderNote(text: string, term = terminal()): string {
  return wrap(text, term.columns).map((line) => paint(line, "muted", term)).join("\n");
}

export interface LaneNode {
  name: string;
  parent?: string;
  active: boolean;
  block: string;
}

// Keep cdx's existing block content. Only hierarchy, spacing and colour change.
export function renderLaneTree(nodes: LaneNode[], term = terminal()): string {
  if (term.columns < 12) return nodes.map((node) => node.block.split("\n")
    .map((line) => renderNote(line, term)).join("\n")).join("\n\n");
  const names = new Set(nodes.map((node) => node.name));
  const seen = new Set<string>();
  const lines: string[] = [];
  const visit = (node: LaneNode, prefix: string, last: boolean) => {
    if (seen.has(node.name)) return;
    seen.add(node.name);
    const elbow = term.unicode ? (last ? "└─ " : "├─ ") : (last ? "`- " : "+- ");
    // Deep trees restart at the margin; the explicit parent field remains visible.
    if (Bun.stringWidth(prefix) + 8 >= term.columns) prefix = "";
    const branch = prefix + elbow;
    const continuation = prefix + (last ? "   " : term.unicode ? "│  " : "|  ");
    const [head = node.name, ...details] = node.block.split("\n");
    const heading = wrap(head, Math.max(1, term.columns - Bun.stringWidth(branch)));
    heading.forEach((line, index) => lines.push(
      paint(index ? continuation : branch, node.active ? "blue" : "muted", term) + paint(line, "text", term),
    ));
    for (const detail of details) {
      for (const line of wrap(detail.trim(), Math.max(1, term.columns - Bun.stringWidth(continuation) - 2))) {
        lines.push(paint(continuation, "muted", term) + "  " + paint(line, "muted", term));
      }
    }
    const children = nodes.filter((child) => child.parent === node.name && !seen.has(child.name));
    children.forEach((child, index) => visit(child, continuation, index === children.length - 1));
  };
  const roots = nodes.filter((node) => !node.parent || !names.has(node.parent));
  roots.forEach((node, index) => visit(node, "", index === roots.length - 1));
  // A malformed parent cycle must not hide lanes or recurse forever.
  for (const node of nodes) if (!seen.has(node.name)) visit(node, "", true);
  return lines.join("\n");
}

export function renderStatus(nodes: LaneNode[], term = terminal()): string {
  const heading = wrap(`cdx  ${nodes.length} lanes  ${nodes.filter((node) => node.active).length} running`, term.columns)
    .map((line) => paint(line, "text", term)).join("\n");
  return `${heading}\n\n${nodes.length ? renderLaneTree(nodes, term) : paint("No lanes", "muted", term)}`;
}

export function firstExhaustion(rows: { hoursToExhaustion: number | null }[]): number {
  return rows.reduce((best, row, index) => row.hoursToExhaustion !== null && Number.isFinite(row.hoursToExhaustion)
    && row.hoursToExhaustion >= 0 && (best < 0 || row.hoursToExhaustion < rows[best]!.hoursToExhaustion!) ? index : best, -1);
}

export function renderUsageTable(header: string[], rows: string[][], term = terminal(), highlight = -1): string {
  return renderTable(header, rows, term, { highlight, numeric: true, empty: "No usage windows" });
}

export function renderTable(header: string[], rows: string[][], term: Terminal, options: { highlight?: number; numeric?: boolean; empty?: string; wrapCells?: boolean; legacy?: boolean } = {}): string {
  const cells = rows.map((row) => header.map((_, index) => options.legacy ? row[index] ?? "-" : clean(row[index] ?? "-")));
  const measure = options.legacy ? (text: string) => text.length : Bun.stringWidth;
  const widths = header.map((label, index) => Math.max(measure(label), ...cells.map((row) => measure(row[index]!))));
  const total = () => widths.reduce((sum, value) => sum + value, 0) + (header.length - 1) * 2;
  if (options.wrapCells) {
    while (total() > term.columns && Math.max(...widths) > 8) {
      const index = widths.indexOf(Math.max(...widths));
      widths[index] -= 1;
    }
  }
  const tone = (index: number) => index === options.highlight ? "blue" : "text";
  if (total() > term.columns) {
    return cells.map((row, rowIndex) => header.map((label, index) =>
      wrap(`${label}  ${row[index]}`, term.columns).map((line) => paint(line, tone(rowIndex), term)).join("\n")
    ).join("\n")).join("\n\n") || (options.empty ?? "No rows");
  }
  const line = (row: string[], rowIndex: number) => {
    const parts = row.map((value, index) => options.legacy ? [value] : wrap(value, widths[index]!));
    return Array.from({ length: Math.max(...parts.map((part) => part.length)) }, (_, rowLine) =>
      parts.map((part, index) => {
        const value = part[rowLine] ?? "";
        const spaces = " ".repeat(Math.max(0, widths[index]! - measure(value)));
        return options.numeric && index >= 2 ? spaces + value : value + spaces;
      }).join("  ").trimEnd()
    ).map((value) => options.legacy ? value : paint(value, rowIndex < 0 ? "muted" : tone(rowIndex), term)).join("\n");
  };
  if (options.legacy) return [line(header, -1), ...cells.map((row, index) => line(row, index))].join("\n");
  return [line(header, -1), paint((term.unicode ? "─" : "-").repeat(total()), "rule", term),
    ...cells.map((row, index) => line(row, index)), ...(rows.length ? [] : [options.empty ?? "No rows"])].join("\n");
}

export function tuiEnabled(env = process.env, tty = isatty(1)): boolean {
  return env.CDX_TUI === "1" && tty && env.TERM !== "dumb";
}

export interface View {
  title: string;
  header?: string[];
  rows?: string[][];
  reports?: (string | undefined)[];
  lines?: string[];
  progress?: string;
  done?: boolean;
  // Runs after a successful write, so event delivery never acknowledges early.
  written?: () => void;
}

export function renderView(view: View, term = terminal(), selected = 0, height = 24): string {
  const title = paint(term.unicode ? "◢ cdx" : "/ cdx", "text", term) + "  " + renderNote(view.title, term);
  const parts = [title];
  if (view.rows && view.header) {
    let count = Math.max(1, Math.floor((height - 8) / 4));
    const table = () => renderTable(view.header!, view.rows!.slice(selected, selected + count), term,
      { highlight: 0, wrapCells: true, empty: "No lanes" });
    while (count > 1 && table().split("\n").length > height - 6) count--;
    parts.push(table());
    if (view.rows.length) parts.push(renderNote(`row ${selected + 1}/${view.rows.length}`, term));
  }
  if (view.lines) {
    const room = Math.max(1, height - parts.join("\n").split("\n").length - 5);
    const lines = view.lines.flatMap((line) => line.split("\n").flatMap((part) => wrap(part, term.columns)));
    const end = Math.max(0, lines.length - (view.rows ? 0 : selected));
    parts.push(lines.slice(Math.max(0, end - room), end).map((line) => paint(line, "text", term)).join("\n"));
  }
  if (view.progress) parts.push(renderNote(view.progress, term));
  parts.push(renderNote("q quit  j/k move  enter report", term));
  return parts.join("\n");
}

export function liveKey(selected: number, count: number, key: Key): number | "quit" | "report" {
  if (key.name === "q" || key.ctrl && key.name === "c") return "quit";
  if (key.name === "return") return "report";
  const delta = key.name === "j" || key.name === "down" ? 1 : key.name === "k" || key.name === "up" ? -1 : 0;
  return Math.max(0, Math.min(Math.max(0, count - 1), selected + delta));
}

export function frameOutput(text: string, previous: string, _term: Terminal, env = process.env): string {
  if (text === previous) return "";
  // NO_COLOR also forbids cursor controls. Changed frames append as plain text.
  return (env.NO_COLOR === undefined && env.TERM !== "dumb" ? "\x1b[H\x1b[2J" : "") + text + "\n";
}

export async function liveView(read: () => View, interval = 1000): Promise<"done" | "quit"> {
  let selected = 0, count = 1, previous = "", view: View;
  const input = process.stdin;
  const raw = input.isRaw;
  const paused = input.isPaused();
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const cleanup = () => {
      stopped = true;
      clearInterval(timer);
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      process.stdout.off("resize", draw);
      input.off("keypress", keypress);
      if (input.isTTY) { input.setRawMode(raw); if (paused) input.pause(); }
    };
    const stop = () => { cleanup(); resolve("quit"); };
    const draw = () => {
      if (stopped) return;
      try {
        view = read();
        const term = terminal();
        count = view.rows?.length ?? view.lines?.flatMap((line) => line.split("\n").flatMap((part) => wrap(part, term.columns))).length ?? 1;
        selected = Math.max(0, Math.min(selected, count - 1));
        const text = renderView(view, term, selected, process.stdout.rows || 24);
        const output = frameOutput(text, previous, term);
        if (output) process.stdout.write(output);
        previous = text;
        view.written?.();
        if (view.done) { cleanup(); resolve("done"); }
      } catch (error) { cleanup(); reject(error); }
    };
    const keypress = (_text: string, key: Key) => {
      const movement = !view.rows && (key.name === "up" || key.name === "k") ? { ...key, name: "j" }
        : !view.rows && (key.name === "down" || key.name === "j") ? { ...key, name: "k" } : key;
      const next = liveKey(selected, count, movement);
      if (next === "quit") { stop(); return; }
      if (next === "report") {
        const path = view.reports?.[view.rows ? selected : 0];
        if (!path) return;
        try {
          if (process.env.PAGER && process.env.NO_COLOR === undefined) {
            input.setRawMode(false); input.pause();
            // PAGER is the user's shell command; the report path stays an argument.
            const result = Bun.spawnSync(["sh", "-c", 'exec ' + process.env.PAGER + ' "$1"', "cdx-pager", path],
              { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
            if (!result.success) { process.stdout.write(renderNote(path) + "\n"); stop(); return; }
            input.setRawMode(true); input.resume(); previous = "";
          } else { process.stdout.write(renderNote(path) + "\n"); stop(); return; }
        } catch (error) { cleanup(); reject(error); return; }
      } else selected = next;
      draw();
    };
    try {
      if (input.isTTY) { emitKeypressEvents(input); input.setRawMode(true); input.on("keypress", keypress); input.resume(); }
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      process.stdout.on("resize", draw);
      draw();
      if (!stopped) timer = setInterval(draw, interval);
    } catch (error) { cleanup(); reject(error); }
  });
}

