// Raw engine guard: recognises a shell command that runs Codex or Antigravity
// directly instead of through cdx. Pure; shared by the Claude Code hooks
// module and by tests. No Bun or Node API here.

const WORK_VERBS = new Set(["e", "exec", "review", "resume", "fork", "cloud", "apply"]);
const CONTROL_WORDS = new Set(["if", "then", "elif", "else", "while", "until", "for", "do", "!", "{"]);
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
export type BlockingCdx = "wait" | "status --watch" | "poll loop" | "sleep chain" | "tail -f";

const POLLING_SUBCOMMANDS = new Set([
  "status", "events", "report", "brief", "log", "tail", "questions", "feed",
]);

// The cdx subcommand a segment runs, as `cdx ...` or `bun .../cdx.ts ...`.
function cdxInvocation(words: string[], index: number): { subcommand: string; args: string[] } | undefined {
  const binary = (words[index] ?? "").split("/").at(-1) ?? "";
  let next = index + 1;

  if (binary === "bun" || binary === "node") {
    while ((words[next] ?? "").startsWith("-")) next += 1;
    if (words[next] === "run") {
      next += 1;
      while ((words[next] ?? "").startsWith("-")) next += 1;
    }
    const target = (words[next] ?? "").split("/").at(-1) ?? "";
    if (target !== "cdx.ts" && target !== "cdx") return undefined;
    next += 1;
  } else if (binary === "bunx" || binary === "npx") {
    while ((words[next] ?? "").startsWith("-")) next += 1;
    const target = (words[next] ?? "").split("/").at(-1) ?? "";
    if (target !== "cdx" && target !== "cdx.ts") return undefined;
    next += 1;
  } else if (binary !== "cdx" && binary !== "cdx.ts") {
    return undefined;
  }

  while ((words[next] ?? "").startsWith("-")) {
    next += ["-C", "--cd", "--cwd"].includes(words[next]!) ? 2 : 1;
  }
  const subcommand = words[next];
  return subcommand === undefined ? undefined : { subcommand, args: words.slice(next + 1) };
}

function isStatusWatch(invocation: { subcommand: string; args: string[] }): boolean {
  if (invocation.subcommand !== "status") return false;
  return invocation.args.some((arg) => arg === "--watch" || arg.startsWith("--watch=") || arg === "-w" || arg.startsWith("-w="));
}

function isTailFollow(invocation: { subcommand: string; args: string[] }): boolean {
  if (invocation.subcommand !== "tail") return false;
  return invocation.args.some((arg) => arg === "-f" || arg === "--follow" || arg.startsWith("--follow=") || /^-[a-zA-Z]*f/.test(arg));
}

function hasFollowFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-f" || arg === "-F" || arg === "--follow" || arg.startsWith("--follow=") || /^-[a-zA-Z]*[fF]/.test(arg));
}

function isCdxLogPath(arg: string): boolean {
  if (/(?:\.cdx|CDX_HOME|CDX_STATE_HOME)[/\\](?:logs[/\\])?.*(?:\.log|\.jsonl)\b/i.test(arg)) return true;
  if (/(?:^|[/\\])\.cdx[/\\]logs\b/i.test(arg)) return true;
  if (arg === "__CDX_LOG__" || /\$\{(?:CDX_HOME|CDX_STATE_HOME)\}[/\\]logs[/\\]/.test(arg)) return true;
  return false;
}

function watchCdxTarget(words: string[], index: number): { subcommand: string; args: string[] } | undefined {
  let next = index + 1;
  while (next < words.length) {
    const word = words[next]!;
    if (word === "-n" || word === "--interval") {
      next += 2;
      continue;
    }
    if (word.startsWith("-")) {
      next += 1;
      continue;
    }
    break;
  }
  return cdxInvocation(words, next);
}

type LoopKind = "while" | "until" | "for-finite-batch" | "for-poll";

function loopKindAtStart(words: string[]): LoopKind | undefined {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === "while") return "while";
    if (word === "until") return "until";
    if (word === "for") {
      const items = words.slice(i + 3);
      if (words[i + 2] === "in" && items.length > 0 && items.every((item) => !/[$`{}]/.test(item))) {
        return "for-finite-batch";
      }
      return "for-poll";
    }
    if (!CONTROL_WORDS.has(word) && !ASSIGNMENT.test(word)) break;
  }
  return undefined;
}

function hasDoneKeywordAtStart(words: string[]): boolean {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === "done") return true;
    if (!CONTROL_WORDS.has(word) && !ASSIGNMENT.test(word)) break;
  }
  return false;
}

function isCdxLogSubstitution(sub: string): boolean {
  return /\bcdx(?:\.ts)?\s+log\b/.test(sub);
}

function extractSubstitutions(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(/\$\(([^()]*)\)|(?:\\`|`)([^`]*?)(?:\\`|`)/gs)) {
    const inner = (match[1] ?? match[2] ?? "").replace(/^\\+/, "").replace(/\\+$/, "").trim();
    if (inner) result.push(inner);
  }
  return result;
}

function replaceUnquotedSubstitutions(text: string): string {
  return text.replace(/\$\(([^()]*)\)|(?:\\`|`)([^`]*?)(?:\\`|`)/gs, (_, p1, p2) => {
    const inner = (p1 ?? p2 ?? "").replace(/^\\+/, "").replace(/\\+$/, "").trim();
    if (!inner) return " ";
    return isCdxLogSubstitution(inner) ? ` __CDX_LOG__ ; ${inner} ; ` : ` ; ${inner} ; `;
  });
}

function stripQuotedPreservingSubstitutions(command: string): string {
  const withoutSingle = command.replace(/'([^']*)'/gs, (_, content: string) => isCdxLogPath(content) ? " __CDX_LOG__ " : " ");
  const withoutDouble = withoutSingle.replace(/"((?:\\.|[^"\\])*)"/gs, (_, content: string) => {
    const subs = extractSubstitutions(content);
    if (subs.length > 0) {
      const hasLog = subs.some(isCdxLogSubstitution);
      const prefix = hasLog ? " __CDX_LOG__ ; " : " ";
      return `${prefix} ; ${subs.join(" ; ")} ; `;
    }
    return isCdxLogPath(content) ? " __CDX_LOG__ " : " ";
  });
  return replaceUnquotedSubstitutions(withoutDouble);
}

export function blockingCdxCommand(command: string): BlockingCdx | undefined {
  const clean = stripHeredocBodies(stripQuotedPreservingSubstitutions(command), command);
  const loopStack: LoopKind[] = [];
  let cdxInLoop = false;
  let hasSleepOutsideLoop = false;
  let hasPollingOutsideLoop = false;

  for (const segment of clean.split(/[;&|()\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const loopKind = loopKindAtStart(words);
    if (loopKind) {
      loopStack.push(loopKind);
    }

    const start = commandStart(words);
    const binary = (words[start] ?? "").split("/").at(-1) ?? "";

    if (binary === "watch") {
      const target = watchCdxTarget(words, start);
      if (target) {
        if (isStatusWatch(target) || target.subcommand === "status") return "status --watch";
        if (target.subcommand === "wait") return "wait";
        if (POLLING_SUBCOMMANDS.has(target.subcommand)) return "poll loop";
      }
    } else if (binary === "tail") {
      const tailArgs = words.slice(start + 1);
      if (hasFollowFlag(tailArgs)) {
        if (tailArgs.some(isCdxLogPath) || (/cdx\s+log\b/.test(command) && tailArgs.some((arg) => arg.includes("$")))) {
          return "tail -f";
        }
      }
    } else if (binary === "sleep") {
      if (loopStack.length === 0) {
        hasSleepOutsideLoop = true;
      }
    } else {
      const invocation = cdxInvocation(words, start);
      if (invocation) {
        if (invocation.subcommand === "wait") return "wait";
        if (isStatusWatch(invocation)) return "status --watch";
        if (isTailFollow(invocation)) return "tail -f";
        if (loopStack.length > 0) {
          const isFiniteBatch = loopStack.every((k) => k === "for-finite-batch")
            && (!POLLING_SUBCOMMANDS.has(invocation.subcommand) || invocation.subcommand === "report" || invocation.subcommand === "brief");
          if (!isFiniteBatch) {
            cdxInLoop = true;
          }
        } else if (POLLING_SUBCOMMANDS.has(invocation.subcommand)) {
          hasPollingOutsideLoop = true;
        }
      }
    }

    if (hasDoneKeywordAtStart(words)) {
      loopStack.pop();
    }
  }

  if (cdxInLoop) return "poll loop";
  if (hasSleepOutsideLoop && hasPollingOutsideLoop) return "sleep chain";
  return undefined;
}

export function blockingCdxRefusal(kind: BlockingCdx): string {
  const what = kind === "wait"
    ? "cdx wait"
    : kind === "status --watch"
      ? "cdx status --watch"
      : kind === "sleep chain"
        ? "a sleep chain polling cdx"
        : kind === "tail -f"
          ? "tail -f on cdx logs"
          : "a shell loop polling cdx";
  return `${what} blocks the head; the head never blocks on a lane or job (owner ruling 2026-09-15). `
    + "End your turn: a [cdx] event wakes you when it finishes, asks, stalls, or fails. "
    + "To check right now, call mcp__cdx__status or mcp__cdx__events. "
    + "If nothing else is pending, ending the turn is the correct move, not a wait.";
}

// Inside Claude Code every cdx command with a native tool goes through the
// plugin: the tool runs in the session directory and its result lands in
// the transcript, while a shell invocation guesses a cwd and drifts with the
// last `cd`. The shell form stays for lanes and terminals outside Claude Code.
export function nativeCdxCommand(command: string, nativeTools: ReadonlySet<string>): string | undefined {
  const clean = stripHeredocBodies(stripQuotedPreservingSubstitutions(command), command);
  for (const segment of clean.split(/[;&|()\n]+/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const invocation = cdxInvocation(words, commandStart(words));
    if (invocation && nativeTools.has(invocation.subcommand)) return invocation.subcommand;
  }
  return undefined;
}

export function nativeCdxRefusal(subcommand: string): string {
  return `cdx ${subcommand} from the shell is refused inside Claude Code; call mcp__cdx__${subcommand} instead. `
    + "The native tool runs in the session directory and keeps the result in the transcript; "
    + "the shell form is for lanes and terminals outside Claude Code.";
}
