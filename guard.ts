// Raw engine guard: recognises a shell command that runs Codex or Antigravity
// directly instead of through cdx. Pure; shared by the Claude Code hooks
// module and by tests. No Bun or Node API here.

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
const AGY_HEADLESS_OPTIONS = new Set([
  "--print", "-p", "--prompt", "--prompt-interactive", "-i", "--input-format",
  "--continue", "-c", "--conversation",
]);

export type RawEngine = "gpt" | "gemini";

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

// The index of the binary a segment runs, past control words, assignments,
// redirections, and wrappers such as env, nice, or sudo.
function commandStart(words: string[]): number {
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
  return index;
}

function invokedRawEngineIn(command: string): RawEngine | undefined {
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/gs)) {
    const nested = invokedRawEngineIn(match[1] ?? match[2] ?? "");
    if (nested) return nested;
  }
  const withoutArrayData = command.replace(/\b[A-Za-z_][A-Za-z0-9_]*=\([^)]*\)/gs, "");
  for (const segment of withoutArrayData.split(/[;&|()`\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const index = commandStart(words);

    const binary = (words[index] ?? "").split("/").at(-1);
    if (binary === "codex" && codexWorkVerb(words, index)) return "gpt";
    if (binary === "agy") {
      const headless = words.slice(index + 1).some((word) => AGY_HEADLESS_OPTIONS.has(word.split("=")[0]!));
      if (headless) return "gemini";
    }
  }
  return undefined;
}

// Which engine a shell command would run directly, if any. Quoted text and
// heredoc bodies are ignored on the first pass; a second pass with quotes and
// backslash escapes collapsed catches agy "--print=x" and \agy --print=x.
export function invokedRawEngine(command: string): RawEngine | undefined {
  const unquoted = stripQuotedSegments(command);
  const collapsed = command.replace(/\\(.)/g, "$1").replace(/["']/g, "");
  return invokedRawEngineIn(stripHeredocBodies(unquoted, command))
    ?? invokedRawEngineIn(stripHeredocBodies(collapsed, command));
}

export function rawEngineRefusal(engine: RawEngine): string {
  return engine === "gemini"
    ? "Use cdx --engine gemini for Antigravity work. Run 'cdx help'."
    : "Use cdx for Codex work. Run 'cdx help'.";
}

// The head of a Claude Code session must never block on a lane or job (owner
// ruling 2026-09-15): the cdx mod wakes it with a [cdx] event. These are the
// shell shapes that block anyway.
export type BlockingCdx = "wait" | "status --watch" | "poll loop";

// The cdx subcommand a segment runs, as `cdx ...` or `bun .../cdx.ts ...`.
function cdxInvocation(words: string[], index: number): { subcommand: string; args: string[] } | undefined {
  const binary = (words[index] ?? "").split("/").at(-1);
  let next = index + 1;
  if (binary === "bun") {
    while ((words[next] ?? "").startsWith("-")) next += 1;
    if (!(words[next] ?? "").endsWith("cdx.ts")) return undefined;
    next += 1;
  } else if (binary !== "cdx") {
    return undefined;
  }
  const args = words.slice(next);
  const subcommand = args.find((word) => !word.startsWith("-"));
  return subcommand === undefined ? undefined : { subcommand, args };
}

export function blockingCdxCommand(command: string): BlockingCdx | undefined {
  const text = stripHeredocBodies(stripQuotedSegments(command), command);
  let loop = false;
  let cdxInsideCommand = false;
  for (const segment of text.split(/[;&|()`\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words[0] === "while" || words[0] === "until") loop = true;
    const invocation = cdxInvocation(words, commandStart(words));
    if (!invocation) continue;
    if (invocation.subcommand === "wait") return "wait";
    if (invocation.subcommand === "status" && invocation.args.includes("--watch")) return "status --watch";
    cdxInsideCommand = true;
  }
  return loop && cdxInsideCommand ? "poll loop" : undefined;
}

export function blockingCdxRefusal(kind: BlockingCdx): string {
  const what = kind === "wait" ? "cdx wait" : kind === "status --watch" ? "cdx status --watch" : "a shell loop polling cdx";
  return `${what} blocks the head; the head never blocks on a lane or job (owner ruling 2026-09-15). `
    + "End your turn: a [cdx] event wakes you when it finishes, asks, stalls, or fails. "
    + "To check right now, call mcp__cdx__status or mcp__cdx__events. "
    + "If nothing else is pending, ending the turn is the correct move, not a wait.";
}
