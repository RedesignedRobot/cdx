#!/usr/bin/env bun
// Sample data only. This script does not import cdx or access its state.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inlinePrism, prismPng, renderStatus, renderUsageTable, startLattice, terminal, renderNote } from "./tui.ts";

const term = terminal();
const output = new URL("./docs/tui-prism.png", import.meta.url);
const png = prismPng();
writeFileSync(output, png);
process.stdout.write(inlinePrism(png, term));
console.log(renderNote("cdx terminal prototype. Sample data.", term));
console.log("");
console.log(renderStatus([
  { name: "portal", active: true, block: "portal  running  work r2  gpt  supervisor\nowner  demo session\nlane  /workspace/portal\nprogress  18 steps 4 files working last 9s\nlast  Aligning the account page" },
  { name: "usage", parent: "portal", active: true, block: "usage  running  work r1  gemini  parent=portal\nprogress  8 steps 2 files working last 3s\nquestion  #4 waiting for the reset-window rule" },
  { name: "routes", parent: "portal", active: false, block: "routes  done  work r1  gemini  parent=portal\nreview  pending\nlast  report /workspace/reports/routes.md" },
  { name: "quota", active: false, block: "quota  failed  work r1  gemini\nlast  provider unavailable\nreport  /workspace/reports/quota.md" },
], term));
console.log("");
console.log(renderUsageTable(
  ["account", "window", "used", "left", "resets in", "burn/h", "at reset", "empty in", "holds"],
  [["astra-1", "weekly", "62.4%", "37.6%", "3d 4h", "0.5%", "0.0%", "75.2h", "10%"],
    ["gemini", "5h", "?", "?", "blocked 23m", "?", "?", "-", "0%"]], term));
console.log(renderNote("gemini: usage unknown; quota hold. No values inferred.", term));
console.log("");
const stop = startLattice("Reading the lane report", term);
const finish = () => { stop(); process.exitCode = 130; };
process.once("SIGINT", finish);
process.once("SIGTERM", finish);
try {
  if (term.motion) await new Promise<void>((resolve) => setTimeout(resolve, 864));
} finally {
  stop();
  process.removeListener("SIGINT", finish);
  process.removeListener("SIGTERM", finish);
}
console.log(renderNote(`PNG written to ${fileURLToPath(output)}`, term));
