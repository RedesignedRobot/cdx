// Shared by the CLI and sandboxed hooks; no runtime imports.
export function safeText(text: string): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) text = text.split(value).join("[redacted]");
  }
  return text
    .replace(/(\b[A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*|\b(?:KEY|TOKEN)\s*=\s*|--api-key\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;"']+)/gi, "$1[redacted]")
    .replace(/(\bAuthorization\s*:\s*)(?:Bearer\s+|Basic\s+)?[^\r\n"']+/gi, "$1[redacted]")
    .replace(/\b(key|token|secret|password)\b[^\r\n]*/gi, (line) => line.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]"))
    .replace(/ctx7sk[-_A-Za-z0-9]{8,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{16,}/g, "[redacted]");
}

export function safeJSON(value: unknown, space?: number): string {
  return JSON.stringify(value, (key, item) => {
    if (typeof item !== "string") return item;
    if (/^(?:authorization|(?:api[-_]?|access[-_]?)?key|(?:access[-_]?|auth[-_]?)?token|password|secret)$/i.test(key)) return "[redacted]";
    // Tool arguments may themselves be JSON with escaped shell quotes.
    if (/^\s*[\[{]/.test(item)) {
      try { return safeJSON(JSON.parse(item)); } catch { /* ordinary text */ }
    }
    return safeText(item);
  }, space);
}
