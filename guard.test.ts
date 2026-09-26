import { expect, test } from "bun:test";
import { blockingCdxCommand, blockingCdxRefusal, invokedRawEngine, nativeCdxCommand } from "./guard";

// The head must not block on a lane or job: the shapes the mod denies.
test("blockingCdxCommand catches cdx wait in every spelling the head uses", () => {
  expect(blockingCdxCommand("bun /Users/mas/code/cdx/cdx.ts wait land-main 2>&1 | tail -1")).toBe("wait");
  expect(blockingCdxCommand("cd /x && bun cdx.ts wait a b --report")).toBe("wait");
  expect(blockingCdxCommand("CDX_HOME=/tmp cdx wait a --timeout 60")).toBe("wait");
  expect(blockingCdxCommand("cdx wait a; git status")).toBe("wait");
  expect(blockingCdxCommand("bun cdx.ts status --brief --watch")).toBe("status --watch");
});

test("blockingCdxCommand catches shell loops polling cdx", () => {
  expect(blockingCdxCommand("until bun cdx.ts status | grep -q done; do sleep 5; done")).toBe("poll loop");
  expect(blockingCdxCommand("while true; do cdx events --json; sleep 2; done")).toBe("poll loop");
  expect(blockingCdxCommand("while sleep 5; do cdx status --brief; done")).toBe("poll loop");
  expect(blockingCdxCommand("until cdx status | grep -q done; do sleep 5; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [ \"$(cdx status)\" = \"done\" ]; do sleep 5; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [ \"$(cdx status --brief)\" = \"idle\" ]; do sleep 2; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [[ $(cdx status) =~ done ]]; do sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("until test \"$(cdx status)\" = \"done\"; do sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("until false; do cdx status; sleep 2; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [ -f done ]; do cdx status; sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("! until cdx status; do sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("{ until cdx status; do sleep 1; done; }")).toBe("poll loop");
  expect(blockingCdxCommand("until ./cdx.ts status | grep -q done; do sleep 5; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [ `cdx status` = \"done\" ]; do sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [ \\`cdx status\\` = \"done\" ]; do sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("until [ \"\\`cdx status\\`\" = \"done\" ]; do sleep 1; done")).toBe("poll loop");
  expect(blockingCdxCommand("for ((;;)); do cdx status; done")).toBe("poll loop");
  expect(blockingCdxCommand("for i in $(seq 1 1000); do cdx status; done")).toBe("poll loop");
  expect(blockingCdxCommand("for i in `seq 1 1000`; do cdx status; done")).toBe("poll loop");
  expect(blockingCdxCommand("for i in {1..1000}; do cdx status; done")).toBe("poll loop");
  expect(blockingCdxCommand("for ((;;)); do cdx report; done")).toBe("poll loop");
  expect(blockingCdxCommand("until false; do while false; do echo; done; cdx status; done")).toBe("poll loop");
});

test("blockingCdxCommand catches status --watch variants", () => {
  expect(blockingCdxCommand("cdx status --watch --interval 5")).toBe("status --watch");
  expect(blockingCdxCommand("cdx status --watch=true")).toBe("status --watch");
  expect(blockingCdxCommand("cdx status -w")).toBe("status --watch");
  expect(blockingCdxCommand("cdx -C /repo status --watch")).toBe("status --watch");
  expect(blockingCdxCommand("bun run cdx.ts status --watch")).toBe("status --watch");
  expect(blockingCdxCommand("./cdx.ts status --watch")).toBe("status --watch");
  expect(blockingCdxCommand("watch cdx status")).toBe("status --watch");
  expect(blockingCdxCommand("watch -n 2 cdx status --brief")).toBe("status --watch");
});

test("blockingCdxCommand catches sleep chains polling cdx", () => {
  expect(blockingCdxCommand("cdx status; sleep 5; cdx status")).toBe("sleep chain");
  expect(blockingCdxCommand("sleep 5 && cdx status && sleep 5 && cdx status")).toBe("sleep chain");
  expect(blockingCdxCommand("cdx status; sleep 5")).toBe("sleep chain");
  expect(blockingCdxCommand("sleep 5; cdx status")).toBe("sleep chain");
  expect(blockingCdxCommand("sleep 2 && cdx events --json")).toBe("sleep chain");
  expect(blockingCdxCommand("sleep 3; bun cdx.ts status --brief")).toBe("sleep chain");
  expect(blockingCdxCommand("sleep 5; cdx report my-lane")).toBe("sleep chain");
});

test("blockingCdxCommand catches tail -f and -F on cdx logs and cdx tail follow", () => {
  expect(blockingCdxCommand("tail -f ~/.cdx/logs/lane-r1.log")).toBe("tail -f");
  expect(blockingCdxCommand("tail -F /tmp/.cdx/logs/lane-r2.jsonl")).toBe("tail -f");
  expect(blockingCdxCommand("tail -n 20 -f ~/.cdx/logs/lane-r1.log")).toBe("tail -f");
  expect(blockingCdxCommand("tail -f $(cdx log my-lane)")).toBe("tail -f");
  expect(blockingCdxCommand('tail -f "$(cdx log my-lane)"')).toBe("tail -f");
  expect(blockingCdxCommand('tail -F "$(cdx log)"')).toBe("tail -f");
  expect(blockingCdxCommand("tail -f `cdx log my-lane`")).toBe("tail -f");
  expect(blockingCdxCommand('tail -f "\\`cdx log my-lane\\`"')).toBe("tail -f");
  expect(blockingCdxCommand("cdx tail -f lane")).toBe("tail -f");
  expect(blockingCdxCommand("cdx tail --follow lane")).toBe("tail -f");
  expect(blockingCdxCommand("bun cdx.ts tail -f")).toBe("tail -f");
});

test("blockingCdxCommand lets single reads, launches, and quoted text through", () => {
  expect(blockingCdxCommand("bun cdx.ts status 2>&1 | grep account")).toBeUndefined();
  expect(blockingCdxCommand("cdx events --json")).toBeUndefined();
  expect(blockingCdxCommand("cdx spawn fix --bg \"wait for the gate, then cdx wait yourself\"")).toBeUndefined();
  expect(blockingCdxCommand("cdx job land --cd /repo \"until make; do sleep 1; done\"")).toBeUndefined();
  expect(blockingCdxCommand("cat > brief.md <<'EOF'\nthen run cdx wait child\nEOF\ncdx spawn x --bg - < brief.md")).toBeUndefined();
  expect(blockingCdxCommand("for l in a b; do cdx report $l; done")).toBeUndefined();
  expect(blockingCdxCommand("for l in a b; do cdx brief $l; done")).toBeUndefined();
  expect(blockingCdxCommand("until grep -q Ready dev.log; do sleep 1; done")).toBeUndefined();
  expect(blockingCdxCommand("until grep -q Ready dev.log; do sleep 1; done; cdx status")).toBeUndefined();
  expect(blockingCdxCommand("cdx tail lane")).toBeUndefined();
  expect(blockingCdxCommand("tail -n 30 ~/.cdx/logs/lane-r1.log")).toBeUndefined();
  expect(blockingCdxCommand("tail -f dev.log")).toBeUndefined();
  expect(blockingCdxCommand("tail -F server.log")).toBeUndefined();
  expect(blockingCdxCommand("sleep 1 && git status")).toBeUndefined();
  expect(blockingCdxCommand("cdx spawn fix --bg \"brief\"; sleep 1")).toBeUndefined();
  expect(blockingCdxCommand("git status && bun test")).toBeUndefined();
});

test("blockingCdxRefusal names the shape and the way out", () => {
  const text = blockingCdxRefusal("wait");
  expect(text).toStartWith("cdx wait blocks the head");
  expect(text).toContain("End your turn");
  expect(text).toContain("mcp__cdx__status");
  expect(blockingCdxRefusal("poll loop")).toStartWith("a shell loop polling cdx blocks the head");
  expect(blockingCdxRefusal("status --watch")).toStartWith("cdx status --watch blocks the head");
  expect(blockingCdxRefusal("sleep chain")).toStartWith("a sleep chain polling cdx blocks the head");
  expect(blockingCdxRefusal("tail -f")).toStartWith("tail -f on cdx logs blocks the head");
});

// The shared command-start walk still serves the raw-engine guard.
test("invokedRawEngine survives the shared command-start refactor", () => {
  expect(invokedRawEngine("env -u FOO codex exec 'do it'")).toBe("gpt");
  expect(invokedRawEngine("cd /x && nice -n 5 agy --print=/usage")).toBe("gemini");
  expect(invokedRawEngine("codex --version")).toBeUndefined();
  expect(invokedRawEngine("cdx spawn x --engine gpt \"codex exec\"")).toBeUndefined();
});

// A guard refuses a command only where the shell would run cdx or an engine:
// quoted text and quoted heredoc bodies are data, while a substitution inside
// double quotes or an unquoted heredoc runs.
test("the guards match invocations, not text that mentions them", () => {
  const native = new Set(["land", "status"]);
  const invocations: [string, string | undefined][] = [
    ["cdx land x", "land"],
    ["bun /Users/mas/code/cdx/cdx.ts land x", "land"],
    ["FOO=1 cdx land x", "land"],
    ["git status && cdx land x", "land"],
    ["git diff | cdx land x", "land"],
    ["echo $(cdx land x)", "land"],
    ['git commit -m "Refuse `cdx land x`"', "land"],
    ["cat <<EOF\n$(cdx land x)\nEOF", "land"],
    ['git commit -m "Keep cdx land inside the ceiling"', undefined],
    ["git commit -m 'cdx land, codex exec and cdx wait'", undefined],
    ["git commit -F - <<'EOF'\ncdx land x\ncodex exec y\nwhile true; do cdx status; done\nEOF", undefined],
    ["git commit -F - <<EOF\ncdx land x\nEOF", undefined],
    ['echo "cdx land x" | grep cdx', undefined],
    ["echo cdx land x", undefined],
    ["grep -rn 'cdx land' .", undefined],
  ];
  for (const [command, expected] of invocations) expect([command, nativeCdxCommand(command, native)]).toEqual([command, expected]);
  expect(blockingCdxCommand("git commit -F - <<'EOF'\nwhile true; do cdx status; done\nEOF")).toBeUndefined();
  expect(blockingCdxCommand("git commit -m \"never cdx wait a lane\"")).toBeUndefined();
  expect(invokedRawEngine("git commit -m \"codex exec is banned\"")).toBeUndefined();
  expect(invokedRawEngine("git commit -F - <<'EOF'\ncodex exec y\nEOF")).toBeUndefined();
});
