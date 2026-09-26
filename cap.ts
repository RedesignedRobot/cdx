// Output cap for lane shell commands. Lane hooks rewrite each shell command to
// run through this file. Output over CAP_BYTES goes to a spill file under the
// lane's log dir; the model sees the head, the tail, the byte count, and the
// path. Standalone on purpose: it starts once per lane command.
import { mkdirSync, openSync, writeSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";

export const CAP_BYTES = 4096;
const HEAD_BYTES = 2048;
const TAIL_BYTES = 1536;
const SCRIPT = import.meta.path;

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// Supervisors' cdx calls must reach Codex unwrapped: its exec-policy rule runs
// them outside the sandbox, and a wrapped command no longer matches that rule.
export function invokesCdx(command: string): boolean {
  return /(?:^|[;&|(\n]|\bthen|\bdo)\s*cdx(?:\s|$)/.test(command);
}

export function spillPathOf(env: Record<string, string | undefined>): string | undefined {
  if (!env.CDX_LANE || !env.CDX_HOME || !env.CDX_ROUND) return undefined;
  return `${env.CDX_HOME}/logs/${env.CDX_LANE}-r${env.CDX_ROUND}.out/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.log`;
}

export function cappedCommand(command: string, spillPath: string, bun = process.execPath, script = SCRIPT): string {
  return `${quote(bun)} ${quote(script)} run ${quote(spillPath)} ${quote(command)}`;
}

function wrappable(command: unknown): command is string {
  return typeof command === "string" && Boolean(command.trim()) && !command.includes(`${quote(SCRIPT)} run `) && !invokesCdx(command);
}

// Codex PreToolUse output for a Bash call, or undefined to leave it alone.
export function codexPreTool(input: any, env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const command = input?.tool_input?.command;
  const spill = spillPathOf(env);
  if (input?.tool_name !== "Bash" || !spill || !wrappable(command)) return undefined;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { ...input.tool_input, command: cappedCommand(command, spill) } } };
}

// agy run_command arguments with the command wrapped, or undefined. agy 1.2.11
// replaces tool arguments with a pre-tool hook's `overwrite` field; the field
// is in its hook proto but not in its docs.
export function geminiOverwrite(call: any, env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const command = call?.args?.CommandLine;
  const spill = spillPathOf(env);
  if (call?.name !== "run_command" || !spill || !wrappable(command)) return undefined;
  return { ...call.args, CommandLine: cappedCommand(command, spill) };
}

// Largest prefix length at or below limit that does not split a UTF-8 sequence.
export function utf8Boundary(bytes: Uint8Array, limit: number): number {
  let end = Math.min(limit, bytes.length);
  if (end === bytes.length) return end;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

export function capNotice(total: number, headBytes: number, tailBytes: number, spillPath: string | undefined): string {
  const saved = spillPath
    ? `Full output: ${spillPath}. Read slices with sed -n or rg; do not cat it.`
    : "The sandbox kept the full output from being saved; narrow the command.";
  return `\n[cdx: output capped at ${CAP_BYTES} bytes. ${total} bytes total; first ${headBytes} and last ${tailBytes} shown. ${saved}]\n`;
}

async function runCapped(spillPath: string, command: string): Promise<number> {
  const shell = process.env.SHELL || "/bin/sh";
  const child = Bun.spawn({ cmd: [shell, "-c", command], stdin: "inherit", stdout: "pipe", stderr: "pipe" });
  let total = 0;
  let shown = 0;
  let buffered: Uint8Array[] = [];
  let spill: number | undefined;
  let spillFailed = false;
  let tail: Uint8Array = new Uint8Array();
  // The head streams live. Everything stays buffered until the total passes
  // the cap; past it, bytes go to the spill file and a rolling tail.
  const take = (chunk: Uint8Array) => {
    if (shown === total && shown < HEAD_BYTES) {
      const room = utf8Boundary(chunk, HEAD_BYTES - shown);
      if (room > 0) { writeSync(1, chunk.subarray(0, room)); shown += room; }
    }
    total += chunk.length;
    if (total <= CAP_BYTES) { buffered.push(chunk); return; }
    if (spill === undefined && !spillFailed) {
      try {
        mkdirSync(dirname(spillPath), { recursive: true });
        spill = openSync(spillPath, "w", 0o600);
        for (const part of buffered) writeSync(spill, part);
      } catch { spillFailed = true; }
    }
    if (buffered.length) { tail = Buffer.concat([...buffered, chunk]); buffered = []; }
    else tail = Buffer.concat([tail, chunk]);
    if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    if (spill !== undefined) writeSync(spill, chunk);
  };
  const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) take(chunk); };
  await Promise.all([drain(child.stdout), drain(child.stderr)]);
  const exitCode = await child.exited;
  if (total <= CAP_BYTES) {
    const rest = Buffer.concat(buffered).subarray(shown);
    if (rest.length) writeSync(1, rest);
  } else {
    // Start the tail on a line, or at least on a character.
    let start = tail.indexOf(10) + 1;
    if (start === 0 || start === tail.length) start = 0;
    while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start += 1;
    const visibleTail = tail.subarray(start);
    writeSync(1, capNotice(total, shown, visibleTail.length, spill === undefined ? undefined : spillPath));
    writeSync(1, visibleTail);
  }
  if (child.signalCode) return 128 + (constants.signals[child.signalCode as keyof typeof constants.signals] ?? 0);
  return exitCode;
}

if (import.meta.main) {
  const [mode, ...rest] = Bun.argv.slice(2);
  if (mode === "run" && rest.length === 2) process.exit(await runCapped(rest[0]!, rest[1]!));
  if (mode === "codex-pre-tool") {
    let output: Record<string, unknown> | undefined;
    try { output = codexPreTool(JSON.parse(await Bun.stdin.text()), process.env); } catch { /* leave the call unchanged */ }
    if (output) console.log(JSON.stringify(output));
    process.exit(0);
  }
  console.error("usage: cap.ts run <spill-file> <command> | cap.ts codex-pre-tool");
  process.exit(2);
}
