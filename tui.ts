import { stripVTControlCharacters } from "node:util";
import { deflateSync } from "node:zlib";

export const palette = {
  background: [0, 0, 0], surface: [10, 10, 10], rule: [38, 38, 38],
  muted: [153, 153, 153], text: [245, 245, 245], blue: [120, 144, 255],
} as const;

type Tone = keyof typeof palette;
export interface Terminal {
  columns: number;
  color: boolean;
  unicode: boolean;
  graphics: boolean;
  motion: boolean;
}

// Detection is deliberately passive. A CLI must not consume the caller's stdin.
export function terminal(env = process.env, tty = Boolean(process.stdout.isTTY)): Terminal {
  const usable = tty && env.TERM !== "dumb";
  const multiplexed = Boolean(env.TMUX || env.STY || env.ZELLIJ || /^(screen|tmux)/.test(env.TERM ?? ""));
  const kitty = env.TERM_PROGRAM === "ghostty" || /^(xterm-ghostty|xterm-kitty)$/.test(env.TERM ?? "");
  const color = usable && env.NO_COLOR === undefined && (kitty || /^(truecolor|24bit)$/.test(env.COLORTERM ?? ""));
  return {
    columns: Math.max(1, Math.min(process.stdout.columns || 100, 160)), color,
    unicode: usable && env.CDX_TUI_ASCII !== "1",
    graphics: color && kitty && !multiplexed && env.CDX_TUI_GRAPHICS !== "0",
    motion: usable && env.CDX_TUI_MOTION !== "0" && !env.CI,
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

export function renderUsageTable(header: string[], rows: string[][], term = terminal()): string {
  const cells = rows.map((row) => header.map((_, index) => clean(row[index] ?? "-")));
  const widths = header.map((label, index) => Math.max(Bun.stringWidth(label), ...cells.map((row) => Bun.stringWidth(row[index]!))));
  const width = widths.reduce((sum, value) => sum + value, 0) + (header.length - 1) * 2;
  if (width > term.columns) {
    // Preserve every metric at phone-sized widths. Never hide quota columns.
    return cells.map((row) => header.map((label, index) =>
      renderNote(`${label}  ${row[index]}`, term)).join("\n")).join("\n\n") || "No usage windows";
  }
  const line = (row: string[], heading = false) => row.map((value, index) => {
    const spaces = " ".repeat(widths[index]! - Bun.stringWidth(value));
    const cell = index < 2 ? value + spaces : spaces + value;
    return paint(cell, heading ? "muted" : "text", term);
  }).join("  ").trimEnd();
  return [line(header, true), paint((term.unicode ? "─" : "-").repeat(width), "rule", term),
    ...cells.map((row) => line(row)), ...(rows.length ? [] : ["No usage windows"])].join("\n");
}

// The two polygons are the ArchitectMark paths in the portal's 32-unit viewBox.
const blades = [[[4, 27], [16, 3], [16, 19], [12, 27]], [[20, 11], [28, 27], [18, 27], [20, 23]]];
function inPrism(x: number, y: number): boolean {
  return blades.some((points) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i]!, [xj, yj] = points[j]!;
      if ((yi! > y) !== (yj! > y) && x < (xj! - xi!) * (y - yi!) / (yj! - yi!) + xi!) inside = !inside;
    }
    return inside;
  });
}

export function prismText(term = terminal()): string {
  if (!term.unicode) return "  /|\n / | /\n/__|/__\\";
  return Array.from({ length: 8 }, (_, row) => paint(Array.from({ length: 16 }, (_, column) => {
    const top = inPrism(column * 2 + 1, row * 4 + 1);
    const bottom = inPrism(column * 2 + 1, row * 4 + 3);
    return top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
  }).join(""), "text", term)).join("\n");
}

// PNG chunks use network byte order and CRC-32 over the type and data.
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

export function prismPng(): Buffer {
  const size = 128, stride = 1 + size * 4;
  const pixels = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let coverage = 0;
    for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) {
      if (inPrism((x + dx) / 4, (y + dy) / 4)) coverage++;
    }
    const offset = y * stride + 1 + x * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 245;
    pixels[offset + 3] = Math.round(255 * coverage / 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

export function inlinePrism(png: Buffer, term = terminal()): string {
  if (!term.graphics || term.columns < 16) return prismText(term) + "\n";
  const encoded = png.toString("base64");
  let output = "";
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const controls = offset === 0 ? "a=T,t=d,f=100,q=2,C=1,c=16,r=8," : "";
    output += `\x1b_G${controls}m=${offset + 4096 < encoded.length ? 1 : 0};${encoded.slice(offset, offset + 4096)}\x1b\\`;
  }
  return output + "\n".repeat(8);
}

export function latticeFrame(frame: number, label: string, term = terminal()): string {
  const tick = Math.max(0, Math.floor(frame));
  const rows = Array.from({ length: 4 }, (_, y) => Array.from({ length: 4 }, (_, x) => {
    const lit = (x + y - tick % 7 + 7) % 7 === 0;
    return paint(term.unicode ? (lit ? "■" : "·") : lit ? "#" : ".", lit ? "blue" : "muted", term);
  }).join(" "));
  rows[1] += "  " + paint(clean(label), "text", term);
  return rows.join("\n");
}

// The caller owns stop(). No timer starts when this module is imported.
export function startLattice(label: string, term = terminal()): () => void {
  if (!term.motion || term.columns < Bun.stringWidth(clean(label)) + 9) {
    process.stdout.write(renderNote(`${label}...`, term) + "\n");
    return () => {};
  }
  let frame = 0, stopped = false;
  process.stdout.write(latticeFrame(frame, label, term) + "\n");
  const timer = setInterval(() => {
    process.stdout.write("\x1b[4F" + latticeFrame(++frame, label, term) + "\n");
  }, 108);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
