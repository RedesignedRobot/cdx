#!/usr/bin/env bun
// Classic PreToolUse hook. Kept only until the function-hooks module in
// hooks/register.ts serves the same guard in-process.
import { invokedRawEngine, rawEngineRefusal } from "../guard.ts";

try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (typeof input !== "object" || input === null) process.exit(0);

  const toolInput = (input as Record<string, unknown>).tool_input;
  if (typeof toolInput !== "object" || toolInput === null) process.exit(0);

  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string") process.exit(0);
  const engine = invokedRawEngine(command);
  if (!engine) process.exit(0);

  console.error(rawEngineRefusal(engine));
  process.exit(2);
} catch {
  process.exit(0);
}
