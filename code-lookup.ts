import { realpathSync } from "node:fs";
import { config, geminiConfig } from "./config.ts";
import { requireGeminiAgent } from "./doctor.ts";
import { requireGeminiQuota } from "./gemini-usage.ts";
import { CODEGRAPH_RULE } from "./prompts.ts";
import { fail, uncoloredChildEnv } from "./runtime.ts";
import { safeText } from "./safe-text.ts";
import { geminiProfile } from "./sandbox.ts";

// The runner owns this endpoint outside either engine's Seatbelt sandbox.
// It accepts questions only, never commands or sandbox profiles from workers.
export function serveCodeLookups() {
  const token = crypto.randomUUID();
  const controller = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 120, maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== `/${token}`) return new Response(null, { status: 404 });
      try {
        const { cwd, question } = await request.json();
        if (typeof cwd !== "string" || !cwd || typeof question !== "string" || !question.trim()) return new Response("expected cwd and question", { status: 400 });
        return Response.json({ answer: await runCodeLookup(cwd, question, controller.signal) });
      } catch (error) {
        return Response.json({ error: safeText(String(error)) }, { status: 500 });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/${token}`,
    stop() { controller.abort(); server.stop(true); },
  };
}

export async function codeLookup(cwd: string, question: string): Promise<string> {
  if (process.env.CDX_LANE) {
    const url = process.env.CDX_LOOKUP_URL;
    if (!url) fail("lane lookup runner unavailable; ask the head to resume this lane with the updated runner");
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", body: JSON.stringify({ cwd, question }), signal: AbortSignal.timeout(110_000) });
    } catch {
      fail("lane lookup runner unavailable or timed out");
    }
    const result = await response.json();
    if (!response.ok) fail(result.error ?? "lane lookup failed");
    return result.answer;
  }
  return runCodeLookup(cwd, question);
}

async function runCodeLookup(cwd: string, question: string, signal?: AbortSignal): Promise<string> {
  if (process.env.CODEX_SANDBOX === "seatbelt") fail("read-only ask requires a runner outside Seatbelt");
  cwd = realpathSync(cwd);
  const policy = config.gemini ?? geminiConfig();
  requireGeminiQuota("gemini");
  requireGeminiAgent(policy.reviewAgent, cwd);
  // Keep this request read-only even when its shell tool tries to write.
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) fail("read-only ask requires macOS sandbox-exec");
  const env = uncoloredChildEnv();
  delete env.CDX_LOOKUP_URL;
  const proc = Bun.spawn({ cmd: ["sandbox-exec", "-p", geminiProfile({ cwd, reviewDir: cwd }), "agy", "--print", `Answer this code question with file:line evidence. Read only. ${CODEGRAPH_RULE}\n${question}`,
    "--model", policy.model, "--agent", policy.reviewAgent, "--output-format", "json", "--print-timeout", "90s", "--add-dir", cwd],
    cwd, env, stdout: "pipe", stderr: "pipe" });
  // agy owns the 90s deadline. Give it time to emit its final JSON and exit
  // before the watchdog kills it; equal deadlines caused opaque exit 137s.
  const abort = () => proc.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 95_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (timedOut) fail("Gemini code lookup timed out after 90s plus 5s shutdown grace; use cdx question for head decisions");
    if (exitCode) fail(safeText(stderr || `Gemini ask exited ${exitCode}`));
    const value = JSON.parse(stdout);
    const result = value.result && typeof value.result === "object" ? value.result : value;
    if (result.error || result.status && result.status !== "SUCCESS" || typeof result.response !== "string" || !result.response.trim()) fail("Gemini ask returned no successful answer");
    return safeText(result.response);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
