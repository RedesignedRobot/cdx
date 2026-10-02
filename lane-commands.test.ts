import { expect, test } from "bun:test";
import { resumeCommand, spawnCommand } from "./lane-commands.ts";

test("spawn and resume require a positive integer test allowance", async () => {
  for (const command of [spawnCommand, resumeCommand]) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
      await expect(command(["--test-runs", value])).rejects.toThrow("--test-runs must be a positive integer");
    }
    await expect(command(["--test-runs", "6"])).rejects.toThrow("usage:");
  }
});
