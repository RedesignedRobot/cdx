// Local read-only browser dashboard and event stream.

import { jobDuration, readJobs } from "./jobs.ts";
import {
  activeStateOf, type Lane, laneEngine, type Ledger, parseFeedEvent, readEvents, readLedger, renderEvent,
  roundEngine, withEvents,
} from "./ledger.ts";
import { questionFiles } from "./questions.ts";
import { type Cursor, drainCursor, logPathOf, readTailLines } from "./reports.ts";
import { CmdError, parseArgs, ROOT } from "./runtime.ts";
import { existsSync, readFileSync, statSync } from "node:fs";

import { safeText } from "./safe-text.ts";

function viewJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "string"
    ? safeText(item).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") : item);
}

function viewStatusGroup(state: string): "running" | "done" | "failed" | "other" {
  if (state === "running" || state === "done") return state;
  return state === "failed" || state === "gate-invalid" ? "failed" : "other";
}

function viewActivityOrder(a: { statusGroup: string; lastActivityAt: string }, b: { statusGroup: string; lastActivityAt: string }) {
  return Number(b.statusGroup === "running") - Number(a.statusGroup === "running")
    || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

function viewLaneSummary(name: string, entry: Lane) {
  const startedAt = entry.roundStartedAt ?? entry.createdAt;
  const statusGroup = viewStatusGroup(activeStateOf(entry));
  const lastActivityAt = [startedAt, entry.updatedAt, entry.lastEventAt, entry.review?.updatedAt]
    .filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
  return { ...entry, name, engine: roundEngine(entry), startedAt, lastActivityAt, statusGroup,
    model: entry.kind === "review" && entry.reviewModel ? entry.reviewModel : roundEngine(entry) === laneEngine(entry) ? entry.model : undefined,
    stalled: statusGroup === "running" && Date.now() - Date.parse(entry.lastEventAt ?? startedAt) >= 300_000,
  };
}

function viewState() {
  return {
    lanes: Object.entries(readLedger()).map(([name, entry]) => viewLaneSummary(name, entry)).sort(viewActivityOrder),
    jobs: Object.entries(readJobs()).map(([name, job]) => {
      let activity = Date.parse(job.finishedAt ?? job.startedAt);
      try { activity = Math.max(activity, statSync(job.log).mtimeMs); } catch { /* A job may not have written output yet. */ }
      return { ...job, name, engine: "job", statusGroup: viewStatusGroup(job.state), lastActivityAt: new Date(activity).toISOString(),
        duration: jobDuration(job), lastLines: readTailLines(job.log, 20),
      };
    }).sort(viewActivityOrder),
    feed: withEvents(() => readEvents().slice(-200).map(renderEvent), false),
  };
}

function viewLane(name: string, ledger = readLedger()) {
  const entry = Object.hasOwn(ledger, name) ? ledger[name] : undefined;
  if (!entry) return undefined;
  return { ...viewLaneSummary(name, entry),
    roundList: Array.from({ length: entry.rounds }, (_, index) => index + 1),
    reports: entry.reports.map((path) => ({ path, text: existsSync(path) ? readFileSync(path, "utf8") : null })),
    parent: entry.parent ? { name: entry.parent, entry: ledger[entry.parent] ?? null } : null,
    children: Object.entries(ledger).filter(([, lane]) => lane.parent === name).map(([name, lane]) => ({ ...lane, name })),
    questions: existsSync(`${ROOT}/questions`) ? questionFiles(name).map(({ record }) => record) : [],
  };
}

function viewTranscript(name: string, round: number, after = "") {
  const path = [true, false].map((json) => logPathOf(name, round, json)).find(existsSync);
  if (!path) return { round, lines: [] as string[], cursor: "", reset: after !== "" };
  const stat = statSync(path);
  const identity = `${round}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  let offset = 0;
  if (after) {
    const parts = after.split("@");
    if (parts[0] === identity && /^\d+$/.test(parts[1] ?? "") && Number(parts[1]) <= stat.size) offset = Number(parts[1]);
  }
  const cursor: Cursor = { round, path, offset, committedOffset: offset, buffer: "", json: path.endsWith(".jsonl"), decoder: new TextDecoder() };
  const lines: string[] = [];
  drainCursor(cursor, "", (line) => { lines.push(line); });
  return { round, lines, cursor: `${identity}@${cursor.committedOffset}`, reset: Boolean(after && offset === 0) };
}

export function viewCommand(argv: string[]) {
  const parsed = parseArgs(argv, ["port", "open"]);
  if (parsed.rest.length) throw new CmdError("usage: cdx view [--port N] [--open]");
  const port = Number(parsed.flags.port ?? 7477);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CmdError("--port must be an integer from 0 to 65535");
  if (parsed.bools.has("open") && process.platform !== "darwin") throw new CmdError("--open requires macOS; run cdx view and open the printed URL");
  const html = readFileSync(new URL("./assets/view.html", import.meta.url), "utf8");
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  };
  type Client = { send: (event: string, value: unknown) => void; close: () => void; lane?: string; round?: number; cursor: string; detail: string };
  const clients = new Set<Client>();
  let previous = "";
  const feedPath = `${ROOT}/feed.log`;
  let feedIdentity = "";
  const feedCursor: Cursor = { round: 0, path: feedPath, offset: 0, buffer: "", json: false, decoder: new TextDecoder() };
  withEvents(() => {
    if (!existsSync(feedPath)) return;
    const stat = statSync(feedPath);
    feedCursor.offset = stat.size;
    feedIdentity = `${stat.dev}:${stat.ino}`;
  }, false);
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    fetch(request, server) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      const response = (value: unknown, status = 200) => new Response(viewJSON(value), { status, headers: { ...headers, "Content-Type": "application/json" } });
      // Reject cross-origin browser reads and DNS rebinding to the loopback listener.
      if (request.headers.get("host") !== `127.0.0.1:${server.port}` || (request.headers.get("origin") && request.headers.get("origin") !== origin)
        || request.headers.get("sec-fetch-site") === "cross-site") return response({ error: "Local requests only" }, 403);
      if (request.method !== "GET") return response({ error: "View only" }, 405);
      try {
        if (url.pathname === "/") return new Response(html, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
        if (url.pathname === "/api/state") return response(viewState());
        const match = url.pathname.match(/^\/api\/lanes\/([a-z0-9._-]+)(\/transcript)?$/i);
        if (match) {
          const name = match[1]!;
          const ledger = readLedger();
          if (!Object.hasOwn(ledger, name)) return response({ error: "Lane not found" }, 404);
          if (!match[2]) return response(viewLane(name, ledger));
          const round = Number(url.searchParams.get("round") ?? ledger[name]!.rounds);
          if (!Number.isInteger(round) || round < 1 || round > ledger[name]!.rounds) return response({ error: "Round not found" }, 404);
          return response(viewTranscript(name, round, url.searchParams.get("after") ?? ""));
        }
        if (url.pathname !== "/events") return response({ error: "Not found" }, 404);
        const lane = url.searchParams.get("lane") ?? undefined;
        const ledger = readLedger();
        if (lane && (!/^[a-z0-9][a-z0-9._-]*$/i.test(lane) || !Object.hasOwn(ledger, lane))) return response({ error: "Lane not found" }, 404);
        const round = url.searchParams.has("round") ? Number(url.searchParams.get("round")) : undefined;
        if (round !== undefined && (!lane || !Number.isInteger(round) || round < 1 || round > ledger[lane]!.rounds)) return response({ error: "Round not found" }, 404);
        server.timeout(request, 0);
        let client: Client;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            client = { lane, round, cursor: "", detail: "",
              close() { clients.delete(client); request.signal.removeEventListener("abort", client.close); try { controller.close(); } catch {} },
              send(event, value) {
                if ((controller.desiredSize ?? 0) < -1_048_576) { client.close(); return; }
                try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${viewJSON(value)}\n\n`)); } catch { client.close(); }
              },
            };
            clients.add(client);
            request.signal.addEventListener("abort", client.close, { once: true });
            try { client.send("state", viewState()); updateLane(client, ledger, true); }
            catch { client.send("notice", "State is temporarily unreadable. Retrying."); }
          },
          cancel() { client.close(); },
        }, { highWaterMark: 1_048_576, size: (chunk: any) => chunk?.byteLength ?? 0 });
        return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream", "Connection": "keep-alive" } });
      } catch { return response({ error: "State is temporarily unreadable" }, 503); }
    },
  });
  function updateLane(client: Client, ledger: Ledger, initial = false) {
    if (!client.lane) return;
    const detail = viewLane(client.lane, ledger);
    const serialized = viewJSON(detail ?? null);
    if (serialized !== client.detail) { client.send("lane", detail ?? null); client.detail = serialized; }
    if (!detail) return;
    const transcript = viewTranscript(client.lane, client.round ?? detail.rounds, client.cursor);
    if (initial || transcript.cursor !== client.cursor || transcript.reset) client.send(`transcript:${client.lane}`, transcript);
    client.cursor = transcript.cursor;
  }
  const timer = setInterval(() => {
    if (!clients.size) return;
    try {
      const state = viewState();
      const serialized = viewJSON(state);
      if (serialized !== previous) { for (const client of clients) client.send("state", state); previous = serialized; }
      withEvents(() => {
        if (!existsSync(feedPath)) return;
        const stat = statSync(feedPath);
        const identity = `${stat.dev}:${stat.ino}`;
        if (identity !== feedIdentity || stat.size < feedCursor.offset) {
          feedCursor.offset = 0; feedCursor.buffer = ""; feedCursor.decoder = new TextDecoder();
        }
        feedIdentity = identity;
        drainCursor(feedCursor, "", (line) => {
          const event = parseFeedEvent(line);
          if (event) for (const client of clients) client.send("feed", renderEvent(event));
        });
      }, false);
      const ledger = readLedger();
      for (const client of clients) {
        try { updateLane(client, ledger); }
        catch { client.send("notice", "Lane files are temporarily unreadable. Retrying."); }
      }
    } catch { for (const client of clients) client.send("notice", "State is temporarily unreadable. Retrying."); }
  }, 1000);
  const stop = () => { clearInterval(timer); for (const client of clients) client.close(); void server.stop(true); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const url = `http://127.0.0.1:${server.port}`;
  console.log(`cdx: ${url} (view only; Ctrl-C to stop)`);
  if (parsed.bools.has("open")) Bun.spawn(["open", url], { stdout: "ignore", stderr: "inherit" });
}
