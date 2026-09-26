import { resolve } from "node:path";

export interface CodegraphAction { kind: "graph" | "search"; cwd: string }
export interface CodegraphInput { command?: string; toolName?: string; cwd?: string; args?: unknown }

const graphTools = new Set(["mcp__codegraph__codegraph_explore", "codegraph/codegraph_explore", "codegraph_explore"]);
const sourceExt = /\.(?:[cm]?[jt]sx?|vue|svelte|py|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|sh|bash|zsh|sql)$/i;
const nonCodeExt = /\.(?:md|mdx|txt|log|json|jsonl|ya?ml|toml|csv|tsv|html|css|svg|png|jpg|pdf)$/i;

interface ShellWord { value: string; separator: boolean }

function words(input: string): ShellWord[] | undefined {
  const result: ShellWord[] = [];
  let word = "", quote = "", active = false;
  const flush = () => { if (active) result.push({ value: word, separator: false }); word = ""; active = false; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === "\\" && quote !== "'") {
      if (++i >= input.length) return;
      if (input[i] === "\n") continue;
      word += input[i]; active = true; continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; active = true; }
    else if (char === "\n" || char === ";" || char === "|" || char === "&") {
      flush();
      result.push({ value: char, separator: true });
      if (input[i + 1] === char && char !== ";") i++;
    } else if (/\s/.test(char)) { flush();
    } else { word += char; active = true; }
  }
  if (quote) return;
  flush();
  return result;
}

function sourceSearch(argv: string[], cwd: string): CodegraphAction | undefined {
  let tool = argv[0];
  if (tool === "git" && argv[1] === "grep") { argv = argv.slice(1); tool = "grep"; }
  if (!/^(?:rg|grep|egrep|ag|ack)$/.test(tool ?? "")) return;
  if (argv.some((arg) => ["--fixed-strings", "--files", "--files-with-matches", "--files-without-match", "--quiet", "--count"].includes(arg) || /^-[A-Za-z]+$/.test(arg) && /[FlLqc]/.test(arg.slice(1)))) return;
  const positional: string[] = [];
  const filters: string[] = [];
  let explicitPattern = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (["-e", "--regexp"].includes(arg)) { explicitPattern = true; i++; continue; }
    if (["-g", "--glob", "-t", "--type"].includes(arg)) { if (argv[i + 1]) filters.push(argv[++i]!); continue; }
    if (/^(?:-g|-t).+/.test(arg)) { filters.push(arg.slice(2)); continue; }
    if (/^--(?:glob|type)=/.test(arg)) { filters.push(arg.slice(arg.indexOf("=") + 1)); continue; }
    if (["-g", "--glob", "-t", "--type", "-f", "--file", "--include", "--exclude", "--exclude-dir", "--iglob", "-m", "--max-count"].includes(arg)) { i++; continue; }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  const targets = positional.slice(explicitPattern ? 0 : 1);
  if (!targets.length) return;
  if (filters.length && filters.every((filter) => !filter.startsWith("!") && (nonCodeExt.test(filter) || /^(?:md|markdown|json|yaml|toml|html|css|csv|text|txt)$/i.test(filter) || /^(?:docs?|logs?)\//i.test(filter)))) return;
  if (targets.every((target) => nonCodeExt.test(target) || /(?:^|\/)(?:logs?|docs?|\.codegraph)(?:\/|$)/i.test(target))) return;
  const target = targets.find((item) => sourceExt.test(item) || /^(?:\.|src|lib|app|apps|packages|test|tests|hooks)(?:\/|$)/.test(item));
  return target ? { kind: "search", cwd: resolve(cwd, target) } : undefined;
}

// A hung codegraph call once held a lane for 15 minutes; every call cdx suggests carries this deadline.
export const CODEGRAPH_EXPLORE = "perl -e 'alarm 60; exec @ARGV' codegraph explore";

// Judge the command the deadline wrapper runs, not perl.
function deadlineFree(argv: string[]): string[] {
  return argv[0] === "perl" && argv[1] === "-e" && /^alarm \d+; ?exec @ARGV$/.test(argv[2] ?? "") ? argv.slice(3) : argv;
}

export function codegraphActions(input: CodegraphInput, defaultCwd: string): CodegraphAction[] {
  const base = resolve(input.cwd || defaultCwd);
  const args = input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : {};
  if (graphTools.has(input.toolName ?? "") && !input.command) {
    const path = typeof args.projectPath === "string" ? args.projectPath : base;
    return [{ kind: "graph", cwd: resolve(base, path) }];
  }
  if (typeof input.command !== "string") return [];
  const parsed = words(input.command);
  if (!parsed) return [];
  const actions: CodegraphAction[] = [];
  let cwd = base;
  let segment: string[] = [];
  const visit = () => {
    if (!segment.length) return;
    const argv = deadlineFree(segment);
    segment = [];
    if (argv[0] === "cd" && argv.length === 2 && argv[1]) { cwd = resolve(cwd, argv[1]); return; }
    if (/^(?:\/bin\/)?(?:sh|bash|zsh)$/.test(argv[0] ?? "") && /^-[a-z]*c$/.test(argv[1] ?? "") && argv.length === 3) {
      actions.push(...codegraphActions({ command: argv[2], cwd }, cwd)); return;
    }
    if (argv[0] === "codegraph" && argv[1] === "explore") actions.push({ kind: "graph", cwd });
    else {
      const search = sourceSearch(argv, cwd);
      if (search) actions.push(search);
    }
  };
  for (const token of parsed) {
    if (token.separator) visit();
    else segment.push(token.value);
  }
  visit();
  return actions;
}
