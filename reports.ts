import { safeText, safeJSON } from "./safe-text.ts";
// Report capture, recovery partials, JSONL framing, and log readers.

import {
  activeStateOf, type Lane, laneRunning, readLane, readLedger, roundExitCodeOf, roundNoteOf, roundReportOf,
  workCwdOf,
} from "./ledger.ts";
import { color, coloredState, fail, pidAlive, ROOT, singleLine, statusText } from "./runtime.ts";
import { toolObservation } from "./visibility.ts";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

export function readTailLines(path: string, limit: number, accept: (line: string) => boolean = () => true): string[] {
  if (!existsSync(path) || limit < 1) return [];
  const fd = openSync(path, "r");
  try {
    let position = statSync(path).size;
    let carry = "";
    const newestFirst: string[] = [];
    while (position > 0 && newestFirst.length < limit) {
      const length = Math.min(65_536, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      const parts = `${chunk.toString("utf8")}${carry}`.split("\n");
      carry = parts.shift() ?? "";
      for (let index = parts.length - 1; index >= 0 && newestFirst.length < limit; index -= 1) {
        const line = parts[index]!;
        if (line && accept(line)) newestFirst.push(line);
      }
    }
    if (position === 0 && carry && newestFirst.length < limit && accept(carry)) newestFirst.push(carry);
    return newestFirst.reverse();
  } finally {
    closeSync(fd);
  }
}

export const reportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.md`;

// A lane may write its own report file during the round (tables, evidence
// appended with a heredoc). The captured final message never replaces that
// text; it lands below it under its own heading.
const cdxWrittenReports = new Map<string, string>();

export function writeCapturedReport(reportPath: string, message: string): void {
  const text = `${message.trim()}\n`;
  const existing = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  const laneWrote = existing.trim() !== "" && existing !== cdxWrittenReports.get(reportPath);
  const content = safeText(laneWrote ? `${existing.trimEnd()}\n\n## Final message\n\n${text}` : text);
  cdxWrittenReports.set(reportPath, content);
  writeFileSync(reportPath, content);
}

export const partialReportPathOf = (lane: string, round: number) => `${ROOT}/reports/${lane}-r${round}.partial.md`;

export function recoveryPartial(transcript: string, status: string, previous = ""): string {
  let lastAction = "No completed tool action recorded.";
  const outstanding = new Map<string, string>();
  const paths = new Set<string>();
  const collectPaths = (text: string) => {
    for (const match of text.matchAll(/(?:^|[\s"'`(=:])((?:\/|~\/|\.\.?\/|[\w.-]+\/)[^\s"'`<>\\),;]+)/g)) {
      const path = match[1]!;
      if (!path.startsWith("//") && (/^(?:\/|~\/|\.\.?\/)/.test(path) || /\.[a-z0-9]+$/i.test(path))) paths.add(path);
    }
  };
  const strings = (value: unknown): void => {
    if (typeof value === "string") collectPaths(value);
    else if (value && typeof value === "object") for (const child of Object.values(value)) strings(child);
  };
  for (const line of transcript.split("\n")) {
    try {
      const event = JSON.parse(line);
      strings(event);
      const action = toolObservation(event);
      if (action?.id) {
        if (action.completed) outstanding.delete(action.id);
        else if (action.command && !outstanding.has(action.id)) outstanding.set(action.id,
          `${action.command} (started-at: ${typeof event.timestamp === "string" ? event.timestamp : "unknown"})`);
      }
      if (!action?.completed) continue;
      const item = event.params?.item ?? event.item;
      const name = event.step_update?.tool_name ?? event.step_update?.tool_info?.name ?? item?.tool ?? item?.type ?? "tool";
      lastAction = statusText(action.command || [name, ...action.files].join(" "), 600) + (action.failed ? " (failed)" : "");
    } catch { collectPaths(line); }
  }
  const bounded = (lines: string[], limit: number) => [
    ...lines.slice(0, limit), ...(lines.length > limit ? [`... ${lines.length - limit} more; inspect the transcript or git status --short.`] : []),
  ];
  const changed = status.split("\n").filter((line) => line.trim());
  return [
    "# Partial recovery", "", `Last completed tool action: ${lastAction}`,
    `Outstanding process: ${outstanding.size ? statusText([...outstanding.values()].join("; "), 600) : "None recorded."}`, "",
    "Changed paths (git status --short):", ...bounded(changed.length ? changed : ["No changed paths."], 16), "",
    "Evidence paths mentioned in transcript:", ...bounded([...paths].length ? [...paths].slice().reverse() : ["None recorded."], 10),
    ...(previous.trim() ? ["", `Previous handoff: ${statusText(previous, 600)}`] : []), "",
  ].join("\n");
}

export function captureRecoveryPartial(lane: string, round: number, cwd: string, force = false): void {
  const full = reportPathOf(lane, round);
  if (!force && existsSync(full) && readFileSync(full, "utf8").trim()) return;
  const transcriptPath = [logPathOf(lane, round, true), logPathOf(lane, round, false)].find(existsSync);
  const transcript = transcriptPath ? readFileSync(transcriptPath, "utf8") : "";
  const status = Bun.spawnSync({ cmd: ["git", "-C", cwd, "status", "--short"] });
  const path = partialReportPathOf(lane, round);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(`${ROOT}/reports`, { recursive: true });
  writeFileSync(path, safeText(recoveryPartial(transcript, status.success ? status.stdout.toString() : "Git status unavailable.", previous)));
}

export function availableReportPath(lane: string, round: number): string | undefined {
  return [reportPathOf(lane, round), partialReportPathOf(lane, round)]
    .find((path) => existsSync(path) && readFileSync(path, "utf8").trim().length > 0);
}

export function writeProtocolEvent(sink: { write(text: string): unknown; flush(): unknown }, event: unknown): void {
  sink.write(`${safeJSON(event)}\n`);
  sink.flush();
}

export const logPathOf = (lane: string, round: number, json: boolean) => `${ROOT}/logs/${lane}-r${round}.${json ? "jsonl" : "log"}`;

// Round progress (steers delivered, retries, auto-continues) goes here, not
// to the feed. A file of its own: other processes append notes while the
// runner's buffered writer owns the round log, and that writer would
// overwrite their bytes.
export function logProgress(lane: string, round: number, text: string): void {
  mkdirSync(`${ROOT}/logs`, { recursive: true });
  appendFileSync(`${ROOT}/logs/${lane}-r${round}.progress.log`, `${new Date().toISOString()} ${singleLine(text)}\n`);
}

export const specPathOf = (lane: string, round: number) => `${ROOT}/specs/${lane}-r${round}.json`;

export const controlPathOf = (lane: string, round: number) => `${ROOT}/control/${lane}-r${round}.jsonl`;

// The runner: executes codex for one round, streams events, keeps the ledger
// live, finalizes state. Shared by foreground and detached lanes.

export function excerpt(item: Record<string, unknown>): string {
  const text = (item.command ?? item.text ?? item.message ?? item.summary ?? "") as string;
  const flat = String(text).replace(/\s+/g, " ").trim();
  const label = flat ? `${item.type}: ${flat}` : String(item.type);
  return label.length > 160 ? `${label.slice(0, 157)}...` : label;
}

export function tailOutput(text: string, count = 20): string {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  return lines.slice(-count).join("\n");
}

export async function* readJsonLines(stream: ReadableStream<Uint8Array>, options: { onChunk?: (chunk: Uint8Array) => void; ignoreMalformed?: boolean } = {}): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch (error) { if (!options.ignoreMalformed) throw error; }
  };
  for await (const chunk of stream) {
    options.onChunk?.(chunk);
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) { const value = parse(line); if (value !== undefined) yield value; }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const value = parse(buffer); if (value !== undefined) yield value; }
}

export function jobPhaseText(tail: string): string {
  return statusText(tail.split("\n").filter((line) => line.trim()).at(-1) ?? "", 80);
}

export function jobPhase(log: string): string {
  try { return jobPhaseText(readTailLines(log, 1, (line) => line.trim().length > 0).join("\n")); }
  catch { return ""; }
}

export function toolLogRecords(raw: string): string[] {
  return raw.split("\n").filter((line) => {
    try { return ["cdx_tool", "cdx_round_end"].includes(JSON.parse(line).type); } catch { return false; }
  });
}

export function renderEventLine(line: string): string | undefined {
  try {
    const event = JSON.parse(line);
    if (event.event === "init") return `[gemini conversation ${event.conversation_id ?? "?"}]`;
    if (event.event === "step_update" && event.step_update) {
      const update = event.step_update;
      if (update.step_type === "tool") return `gemini: ${update.tool_name ?? update.tool_info?.name ?? "tool"}`;
      if (update.step_type === "agent_response" && update.text_delta) return `gemini: ${singleLine(update.text_delta)}`;
      return undefined;
    }
    if (event.event === "result" && event.result) {
      const usage = event.result.usage;
      return `[gemini turn ${String(event.result.status ?? "?").toLowerCase()}: conversation total ${usage?.input_tokens ?? "?"} in / ${usage?.output_tokens ?? "?"} out]`;
    }
    if (event.method === "thread/started") return `[session ${event.params?.thread?.id ?? "?"}]`;
    if (event.method === "turn/completed") return `[turn ${event.params?.turn?.status ?? "done"}]`;
    if (event.method === "item/completed" && event.params?.item) {
      return event.params.item.type === "agentMessage" ? `codex: ${event.params.item.text}` : excerpt(event.params.item);
    }
    if (event.type === "thread.started") return `[session ${event.thread_id}]`;
    if (event.type === "turn.completed") return `[turn done: ${event.usage?.input_tokens ?? "?"} in / ${event.usage?.output_tokens ?? "?"} out]`;
    if (event.type === "item.completed" && event.item) {
      return event.item.type === "agent_message" ? `codex: ${event.item.text}` : excerpt(event.item);
    }
    return undefined;
  } catch { return line; }
}

export function renderTail(logPath: string, lines: number): string {
  const raw = readFileSync(logPath, "utf8");
  if (!logPath.endsWith(".jsonl")) return raw.split("\n").slice(-lines).join("\n");
  const rendered: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const out = renderEventLine(line);
    if (out !== undefined) rendered.push(out);
  }
  return rendered.slice(-lines).join("\n");
}

export interface Cursor { committedOffset?: number; round: number; path: string; offset: number; buffer: string; json: boolean; decoder: TextDecoder }

export function openCursor(lane: string, entry: Lane, fromEnd: boolean): Cursor | undefined {
  for (let round = entry.rounds; round >= 1; round -= 1) {
    for (const json of [true, false]) {
      const path = logPathOf(lane, round, json);
      if (existsSync(path)) return { round, path, offset: fromEnd ? statSync(path).size : 0, buffer: "", json, decoder: new TextDecoder() };
    }
  }
  return undefined;
}

export function drainCursor(cursor: Cursor, prefix: string, emit = console.log) {
  let size: number;
  try { size = statSync(cursor.path).size; } catch { return; }
  if (size > cursor.offset) {
    const chunk = Buffer.alloc(size - cursor.offset);
    const fd = openSync(cursor.path, "r");
    let bytesRead = 0;
    try {
      while (bytesRead < chunk.length) {
        const count = readSync(fd, chunk, bytesRead, chunk.length - bytesRead, cursor.offset + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
    } finally {
      closeSync(fd);
    }
    cursor.offset += bytesRead;
    cursor.buffer += cursor.decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
  }
  const lines = cursor.buffer.split("\n");
  cursor.buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (cursor.committedOffset !== undefined) cursor.committedOffset += Buffer.byteLength(line + "\n");
    if (!line.trim()) continue;
    const out = cursor.json ? renderEventLine(line) : line;
    if (out !== undefined) emit(prefix + out);
  }
}

export async function followLane(lane: string) {
  let entry = readLane(lane);
  let cursor = openCursor(lane, entry, false);
  if (cursor) {
    const history: string[] = [];
    drainCursor(cursor, "", (line) => history.push(line));
    console.log(history.slice(-15).join("\n"));
  }
  console.log(`--- following ${color.magenta(lane)} live (Ctrl-C to stop) ---`);
  while (true) {
    entry = readLedger()[lane] ?? fail(`lane "${lane}" disappeared from the ledger`);
    if (cursor && entry.rounds > cursor.round) cursor = openCursor(lane, entry, false) ?? cursor;
    if (!cursor) cursor = openCursor(lane, entry, false);
    if (cursor) drainCursor(cursor, "");
    if (!laneRunning(entry)) {
      const state = activeStateOf(entry);
      const exitCode = roundExitCodeOf(entry);
      const note = roundNoteOf(entry);
      console.log(`--- lane ${color.magenta(lane)} ${entry.kind} ${coloredState(state)}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}${note ? `: ${note}` : ""} report=${roundReportOf(entry) ?? "-"} ---`);
      process.exit(state === "failed" || state === "gate-invalid" ? 1 : 0);
    }
    if (!pidAlive(entry.pid)) {
      console.log(`--- lane ${color.magenta(lane)} ${color.red("marked running but its runner is dead")} (cdx doctor --fix) ---`);
      process.exit(1);
    }
    await Bun.sleep(1000);
  }
}

export async function followAll() {
  const cursors = new Map<string, Cursor>();
  console.log("--- following all running lanes (Ctrl-C to stop) ---");
  while (true) {
    const ledger = readLedger();
    for (const [lane, entry] of Object.entries(ledger)) {
      if (!laneRunning(entry) || cursors.has(lane)) continue;
      const cursor = openCursor(lane, entry, true);
      if (cursor) {
        cursors.set(lane, cursor);
        console.log(`${color.magenta(`[${lane}]`)} --- attached (round ${cursor.round}, ${entry.effort}, ${entry.kind === "review" ? entry.review?.cwd ?? workCwdOf(entry) : workCwdOf(entry)}) ---`);
      }
    }
    for (const [lane, cursor] of cursors) {
      const entry = ledger[lane];
      if (entry && laneRunning(entry) && entry.rounds > cursor.round) {
        cursors.set(lane, openCursor(lane, entry, false) ?? cursor);
        continue;
      }
      drainCursor(cursor, `${color.magenta(`[${lane}]`)} `);
      if (!entry || !laneRunning(entry)) {
        console.log(`${color.magenta(`[${lane}]`)} --- ${entry ? coloredState(activeStateOf(entry)) : "gone"}${entry && roundNoteOf(entry) ? `: ${roundNoteOf(entry)}` : ""} ---`);
        cursors.delete(lane);
      }
    }
    if (cursors.size === 0) {
      const running = Object.values(readLedger()).some((entry) => laneRunning(entry));
      if (!running) await Bun.sleep(2000);
    }
    await Bun.sleep(1000);
  }
}

export function latestRoundLog(lane: string): string {
  const entry = readLane(lane);
  for (let round = entry.rounds; round >= 1; round -= 1) {
    for (const json of [true, false]) {
      const path = logPathOf(lane, round, json);
      if (existsSync(path)) return path;
    }
  }
  fail(`no logs for lane "${lane}"`);
}
