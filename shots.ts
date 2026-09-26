// `cdx shots grade`: consults judge a screenshot directory against a rubric in
// batches, so the head reads one verdict file and opens only the failed shots.
// The grade runs as a cdx job: a folder of 60-70 shots takes longer than the
// ten minutes a tool call lives, and the job's exit is the one event that
// wakes the head. The batch consults stay quiet.

import { laneName, runConsult } from "./context.ts";
import { jobCommand } from "./jobs.ts";
import { CmdError, fail, parseArgs, SELF, shellQuote } from "./runtime.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Wide enough to read UI text, a third of the tokens of a 1440x900 capture.
export const DOWNSCALE_PX = 1000;
const IMAGE = /\.(?:png|jpe?g)$/i;
// A runshot folder holds 60-70 shots; one consult with all of them overruns the
// grader's context, so each consult sees at most this many images.
export const SHOTS_PER_CONSULT = 8;

export interface ScreenVerdict { name: string; verdict: "pass" | "fail"; reason: string }

// Job names allow no dots, which a directory slug may carry.
export const gradeJobName = (lanePrefix: string) => lanePrefix.replace(/[^A-Za-z0-9_-]/g, "-");

export function batchShots<T>(shots: T[], size = SHOTS_PER_CONSULT): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < shots.length; start += size) batches.push(shots.slice(start, start + size));
  return batches;
}

export function gradeQuestion(rubric: string, shots: string[]): string {
  return [
    "Grade each attached screenshot against the rubric. Judge only what the image shows; a screen you cannot see or read fails.",
    `Rubric:\n${rubric.trim()}`,
    `Screens (the attachments, in this order):\n${shots.map((shot) => `- ${basename(shot)}: ${shot}`).join("\n")}`,
    'Your final message is JSON only, no fence: {"screens":[{"name":"<file name>","verdict":"pass"|"fail","reason":"<one line>"}]} with every screen listed once.',
  ].join("\n\n");
}

// Every screen gets a verdict: one the grader skipped or mangled fails.
export function parseVerdicts(report: string, names: string[]): ScreenVerdict[] {
  const json = report.slice(report.indexOf("{"), report.lastIndexOf("}") + 1);
  let screens: unknown[] = [];
  try { screens = (JSON.parse(json) as { screens?: unknown[] }).screens ?? []; } catch { /* graded below as missing */ }
  const byName = new Map<string, ScreenVerdict>();
  for (const item of screens) {
    const screen = item as Partial<ScreenVerdict>;
    if (typeof screen.name !== "string" || !names.includes(screen.name)) continue;
    const reason = typeof screen.reason === "string" ? screen.reason.split("\n")[0]!.trim() : "";
    byName.set(screen.name, { name: screen.name, verdict: screen.verdict === "pass" ? "pass" : "fail", reason: reason || "no reason given" });
  }
  return names.map((name) => byName.get(name) ?? { name, verdict: "fail", reason: "grader returned no verdict for this screen" });
}

const USAGE = "usage: cdx shots grade <dir> --rubric <file> [--engine gpt|gemini] [--model M] [--downscale]";

export async function shotsCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "grade" && sub !== "_grade") fail(USAGE);
  const parsed = parseArgs(rest, ["rubric", "engine", "model", "downscale"]);
  const dirArg = parsed.rest[0];
  const rubricPath = parsed.flags.rubric;
  if (!dirArg || !existsSync(dirArg) || !rubricPath || !existsSync(rubricPath)) fail(USAGE);
  const dir = realpathSync(dirArg);
  const shots = readdirSync(dir).filter((name) => IMAGE.test(name)).sort().map((name) => join(dir, name));
  if (!shots.length) fail(`no png or jpg screenshots in ${dir}`);
  // One fresh lane per batch: resuming a single thread would carry every earlier batch's images.
  const lanePrefix = laneName("shots", basename(dir)).slice(0, 55);
  if (sub === "grade") {
    const args = [dir, "--rubric", realpathSync(rubricPath), ...(parsed.flags.engine ? ["--engine", parsed.flags.engine] : []),
      ...(parsed.flags.model ? ["--model", parsed.flags.model] : []), ...(parsed.bools.has("downscale") ? ["--downscale"] : [])];
    await jobCommand([gradeJobName(lanePrefix), "--cd", dir, [process.execPath, SELF, "shots", "_grade", ...args].map(shellQuote).join(" ")]);
    return;
  }
  const engine = parsed.flags.engine ?? "gpt";
  const rubric = readFileSync(rubricPath, "utf8");
  const screens: ScreenVerdict[] = [];
  const reports: string[] = [];
  for (const [index, batch] of batchShots(shots).entries()) {
    const names = batch.map((shot) => basename(shot));
    try {
      const { report, reportPath } = await runConsult(`${lanePrefix}-${index + 1}`, dir, gradeQuestion(rubric, batch),
        { engine, model: parsed.flags.model, images: engine === "gpt" ? batch : [], batch: lanePrefix });
      reports.push(reportPath);
      screens.push(...parseVerdicts(report, names));
    } catch (error) {
      if (!(error instanceof CmdError)) throw error;
      screens.push(...names.map((name) => ({ name, verdict: "fail" as const, reason: `grader consult failed: ${error.message}` })));
    }
  }
  const verdictPath = join(dir, "verdict.json");
  writeFileSync(verdictPath, `${JSON.stringify({ gradedAt: new Date().toISOString(), rubric: realpathSync(rubricPath), engine, reports, screens }, null, 2)}\n`);
  const failed = screens.filter((screen) => screen.verdict === "fail").map((screen) => screen.name);
  console.log(`failed: ${failed.length ? failed.join(", ") : "none"}`);
  console.log(`verdict: ${verdictPath}`);
  if (!parsed.bools.has("downscale") || !failed.length) return;
  const small = join(dir, "downscaled");
  mkdirSync(small, { recursive: true });
  for (const name of failed) {
    const result = Bun.spawnSync({ cmd: ["sips", "-Z", String(DOWNSCALE_PX), join(dir, name), "--out", join(small, name)], stdout: "ignore", stderr: "pipe" });
    if (!result.success) fail(`sips could not downscale ${name}: ${result.stderr.toString().trim()}`);
  }
  console.log(`downscaled: ${small}`);
}
