#!/usr/bin/env bun

const WORK_VERBS = new Set(["e", "exec", "review", "resume", "fork", "cloud", "apply"]);
const CONTROL_WORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);
const WRAPPERS = new Set(["command", "exec", "env", "nice", "nohup", "sudo", "time"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CODEX_GLOBAL_VALUE_OPTIONS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
const CODEX_TERMINAL_OPTIONS = new Set(["-h", "--help", "-V", "--version", "--"]);

function stripQuotedSegments(command: string): string {
  return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/gs, "");
}

interface Heredoc {
  delimiter: string;
  quoted: boolean;
}

function heredocIn(line: string): Heredoc | undefined {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (quote === '"' && char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<" || line[index + 2] === "<") continue;

    index += 2;
    if (line[index] === "-") index += 1;
    while (/\s/.test(line[index] ?? "")) index += 1;
    const delimiterQuote = line[index] === "'" || line[index] === '"' ? line[index]! : "";
    if (delimiterQuote) {
      const end = line.indexOf(delimiterQuote, index + 1);
      if (end < 0) return undefined;
      return { delimiter: line.slice(index + 1, end), quoted: true };
    }
    const delimiter = /^[^\s;&|<>]+/.exec(line.slice(index))?.[0];
    return delimiter ? { delimiter, quoted: false } : undefined;
  }
  return undefined;
}

function stripHeredocBodies(command: string, original: string): string {
  const kept: string[] = [];
  const lines = command.split("\n");
  const originalLines = original.split("\n");
  let heredoc: Heredoc | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const originalLine = originalLines[index] ?? line;
    if (heredoc) {
      if (originalLine.trim() === heredoc.delimiter) {
        heredoc = undefined;
      } else if (!heredoc.quoted) {
        for (const match of originalLine.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) kept.push(match[0]!);
      }
      continue;
    }
    kept.push(line);
    heredoc = heredocIn(originalLine);
  }
  return kept.join("\n");
}

function codexWorkVerb(words: string[], binaryIndex: number): boolean {
  let index = binaryIndex + 1;
  while (index < words.length) {
    const word = words[index]!;
    if (CODEX_TERMINAL_OPTIONS.has(word)) return false;
    if (!word.startsWith("-")) return WORK_VERBS.has(word);
    index += 1;
    if (!word.includes("=") && CODEX_GLOBAL_VALUE_OPTIONS.has(word)) index += 1;
  }
  return false;
}

function skipRedirections(words: string[], start: number): number {
  let index = start;
  for (;;) {
    const match = /^\d*(?:<>|>>?|<<?|>&|<&)(.*)$/.exec(words[index] ?? "");
    if (!match) return index;
    index += 1;
    if (!match[1]) index += 1;
  }
}

function skipPrefixes(words: string[], start: number): number {
  let index = start;
  for (;;) {
    const before = index;
    index = skipRedirections(words, index);
    while (ASSIGNMENT.test(words[index] ?? "")) index += 1;
    if (index === before) return index;
  }
}

function invokesRawCodex(command: string): boolean {
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/gs)) {
    if (invokesRawCodex(match[1] ?? match[2] ?? "")) return true;
  }
  const withoutArrayData = command.replace(/\b[A-Za-z_][A-Za-z0-9_]*=\([^)]*\)/gs, "");
  for (const segment of withoutArrayData.split(/[;&|()`\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;

    while (CONTROL_WORDS.has(words[index] ?? "")) index += 1;
    index = skipPrefixes(words, index);

    while (WRAPPERS.has((words[index] ?? "").split("/").at(-1) ?? "")) {
      const wrapper = (words[index] ?? "").split("/").at(-1);
      index += 1;
      if (wrapper === "env") {
        while ((words[index] ?? "").startsWith("-")) {
          const option = words[index]!;
          index += 1;
          if (["-u", "--unset", "-C", "--chdir"].includes(option)) index += 1;
        }
        while (ASSIGNMENT.test(words[index] ?? "")) index += 1;
      } else if (wrapper === "sudo") {
        while ((words[index] ?? "").startsWith("-")) {
          const option = words[index]!;
          index += 1;
          if (["-C", "-g", "-h", "-p", "-r", "-t", "-u", "--chdir", "--group", "--host", "--prompt", "--role", "--type", "--user"].includes(option)) index += 1;
        }
      } else if (wrapper === "nice") {
        if (["-n", "--adjustment"].includes(words[index] ?? "")) index += 2;
      } else {
        while ((words[index] ?? "").startsWith("-")) index += 1;
      }
      index = skipPrefixes(words, index);
    }

    const binary = (words[index] ?? "").split("/").at(-1);
    if (binary === "codex" && codexWorkVerb(words, index)) return true;
  }
  return false;
}

try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (typeof input !== "object" || input === null) process.exit(0);

  const toolInput = (input as Record<string, unknown>).tool_input;
  if (typeof toolInput !== "object" || toolInput === null) process.exit(0);

  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string") process.exit(0);
  const unquoted = stripQuotedSegments(command);
  if (!invokesRawCodex(stripHeredocBodies(unquoted, command))) process.exit(0);

  console.error("Use cdx for Codex work. Run 'cdx help'.");
  process.exit(2);
} catch {
  process.exit(0);
}
