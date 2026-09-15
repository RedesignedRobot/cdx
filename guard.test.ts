import { expect, test } from "bun:test";
import { blockingCdxCommand, blockingCdxRefusal, invokedRawEngine } from "./guard";

// The head must not block on a lane or job: the shapes the mod denies.
test("blockingCdxCommand catches cdx wait in every spelling the head uses", () => {
  expect(blockingCdxCommand("bun /Users/mas/code/cdx/cdx.ts wait land-main 2>&1 | tail -1")).toBe("wait");
  expect(blockingCdxCommand("cd /x && bun cdx.ts wait a b --report")).toBe("wait");
  expect(blockingCdxCommand("CDX_HOME=/tmp cdx wait a --timeout 60")).toBe("wait");
  expect(blockingCdxCommand("cdx wait a; git status")).toBe("wait");
  expect(blockingCdxCommand("cdx status --watch --interval 5")).toBe("status --watch");
  expect(blockingCdxCommand("bun cdx.ts status --brief --watch")).toBe("status --watch");
});

test("blockingCdxCommand catches shell loops polling cdx", () => {
  expect(blockingCdxCommand("until bun cdx.ts status | grep -q done; do sleep 5; done")).toBe("poll loop");
  expect(blockingCdxCommand("while true; do cdx events --json; sleep 2; done")).toBe("poll loop");
  expect(blockingCdxCommand("while sleep 5; do cdx status --brief; done")).toBe("poll loop");
});

test("blockingCdxCommand lets single reads, launches, and quoted text through", () => {
  expect(blockingCdxCommand("bun cdx.ts status 2>&1 | grep account")).toBeUndefined();
  expect(blockingCdxCommand("cdx events --json")).toBeUndefined();
  expect(blockingCdxCommand("cdx spawn fix --bg \"wait for the gate, then cdx wait yourself\"")).toBeUndefined();
  expect(blockingCdxCommand("cdx job land --cd /repo \"until make; do sleep 1; done\"")).toBeUndefined();
  expect(blockingCdxCommand("cat > brief.md <<'EOF'\nthen run cdx wait child\nEOF\ncdx spawn x --bg - < brief.md")).toBeUndefined();
  expect(blockingCdxCommand("for l in a b; do cdx report $l; done")).toBeUndefined();
  expect(blockingCdxCommand("until grep -q Ready dev.log; do sleep 1; done")).toBeUndefined();
  expect(blockingCdxCommand("git status && bun test")).toBeUndefined();
});

test("blockingCdxRefusal names the shape and the way out", () => {
  const text = blockingCdxRefusal("wait");
  expect(text).toStartWith("cdx wait blocks the head");
  expect(text).toContain("End your turn");
  expect(text).toContain("mcp__cdx__status");
  expect(blockingCdxRefusal("poll loop")).toStartWith("a shell loop polling cdx blocks the head");
});

// The shared command-start walk still serves the raw-engine guard.
test("invokedRawEngine survives the shared command-start refactor", () => {
  expect(invokedRawEngine("env -u FOO codex exec 'do it'")).toBe("gpt");
  expect(invokedRawEngine("cd /x && nice -n 5 agy --print=/usage")).toBe("gemini");
  expect(invokedRawEngine("codex --version")).toBeUndefined();
  expect(invokedRawEngine("cdx spawn x --engine gpt \"codex exec\"")).toBeUndefined();
});
