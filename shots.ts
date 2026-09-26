// `cdx shots grade`: one consult judges a screenshot directory against a rubric, so
// the head reads a verdict file and opens only the failed shots.

import { laneName, runConsult } from "./context.ts";
import { fail, parseArgs } from "./runtime.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// Wide enough to read UI text, a third of the tokens of a 1440x900 capture.
export const DOWNSCALE_PX = 1000;
const IMAGE = /\.(?:png|jpe?g)$/i;

export interface ScreenVerdict { name: string; verdict: "pass" | "fail"; reason: string }

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

export async function shotsCommand(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const usage = "usage: cdx shots grade <dir> --rubric <file> [--engine gpt|gemini] [--model M] [--downscale]";
  if (sub !== "grade") fail(usage);
  const parsed = parseArgs(rest, ["rubric", "engine", "model", "downscale"]);
  const dirArg = parsed.rest[0];
  const rubricPath = parsed.flags.rubric;
  if (!dirArg || !existsSync(dirArg) || !rubricPath || !existsSync(rubricPath)) fail(usage);
  const dir = realpathSync(dirArg);
  const shots = readdirSync(dir).filter((name) => IMAGE.test(name)).sort().map((name) => join(dir, name));
  if (!shots.length) fail(`no png or jpg screenshots in ${dir}`);
  const engine = parsed.flags.engine ?? "gpt";
  const images = engine === "gpt" ? shots : [];
  const { report, reportPath } = await runConsult(laneName("shots", basename(dir)), dir, gradeQuestion(readFileSync(rubricPath, "utf8"), shots),
    { engine, model: parsed.flags.model, images });
  const screens = parseVerdicts(report, shots.map((shot) => basename(shot)));
  const verdictPath = join(dir, "verdict.json");
  writeFileSync(verdictPath, `${JSON.stringify({ gradedAt: new Date().toISOString(), rubric: realpathSync(rubricPath), engine, report: reportPath, screens }, null, 2)}\n`);
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
