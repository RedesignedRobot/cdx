// Drives the head rollover through the engine's own hook chains. `bun test`
// cannot load claude-code/testing, so run.sh copies this file into a plugin
// root of its own and runs `claude plugin test` there.
import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

const SUMMARY = [{ role: "user" as const, text: "summary", toolUses: [] }];

function engine(on: On, settingsStop: () => { block?: string }) {
  mock.clock(on);
  on("session.id", () => ({ value: "head" }));
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("tool.register", () => ({ value: undefined }) as never);
  on("command.register", () => ({ value: undefined }) as never);
  on("process.run", () => ({ value: { exitCode: 0, stdout: "", stderr: "" } }) as never);
  on("session.compact", (_$, e) => ({ messages: e.messages }));
  on("classic.Stop", settingsStop);
}

test("the Stop after the third head compaction blocks once with the hand-off line", async ($, on) => {
  engine(on, () => ({}));
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  const stop = () => $.classic.Stop({ stop_hook_active: false } as never);
  const compact = (e: object) => $.session.compact({ messages: SUMMARY, ...e } as never);

  await compact({ trigger: "auto" });
  expect(await stop()).toEqual({});
  await compact({ trigger: "precompute" });
  await compact({ trigger: "auto", agentId: "subagent" });
  expect(await stop()).toEqual({});
  await compact({ trigger: "manual" });
  expect(await stop()).toEqual({});
  await compact({ trigger: "auto" });
  const blocked = await stop();
  expect(blocked.block).toContain("BATCH.md under ~/.cdx/reports/");
  expect(blocked.block).toContain('push the owner "roll session"');
  expect(await stop()).toEqual({});
});

test("a settings Stop hook beneath still runs and its block travels with the rollover", async ($, on) => {
  let settingsRuns = 0;
  engine(on, () => ({ block: `push guard ${++settingsRuns}` }));
  await $.session.start({ cwd: "/tmp", surface: null, isInteractive: false });
  await $.session.compact({ trigger: "auto", messages: SUMMARY } as never);
  await $.session.compact({ trigger: "auto", messages: SUMMARY } as never);
  await $.session.compact({ trigger: "auto", messages: SUMMARY } as never);
  const blocked = await $.classic.Stop({ stop_hook_active: false } as never);
  expect(blocked.block).toStartWith("push guard 1\n\ncdx: this session has compacted 3 times");
  expect(await $.classic.Stop({ stop_hook_active: true } as never)).toEqual({ block: "push guard 2" });
});
