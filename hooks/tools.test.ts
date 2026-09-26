import { describe, expect, test } from "bun:test";
import { nativeToolResult, formatToolOutput, TOOLS, TOOLS_BY_NAME } from "./tools";

describe("tool rules", () => {
  test("spawn tool argv ends with --bg - and carries the brief on stdin", () => {
    const spawn = TOOLS_BY_NAME.get("spawn");
    expect(spawn).toBeDefined();

    const result = spawn!.run({
      lane: "feature-fix", cd: "/repo",
      brief: "Fix the memory leak in worker thread",
      engine: "gpt",
      effort: "high",
    });

    expect(result.argv).toEqual([
      "spawn",
      "feature-fix",
      "--engine",
      "gpt",
      "--cd",
      "/repo",
      "--effort",
      "high",
      "--bg",
      "-",
    ]);
    expect(result.argv.slice(-2)).toEqual(["--bg", "-"]);
    expect(result.stdin).toBe("Fix the memory leak in worker thread");
  });

  test("spawn, resume, consult, and review always pass --bg", () => {
    const spawn = TOOLS_BY_NAME.get("spawn")!.run({ cd: "/repo", lane: "l1", brief: "b1" });
    expect(spawn.argv).toContain("--bg");

    const resume = TOOLS_BY_NAME.get("resume")!.run({ lane: "l1", fix: "gate", followUp: "f1" });
    expect(resume.argv).toContain("--bg");

    const consult = TOOLS_BY_NAME.get("consult")!.run({ cd: "/repo", lane: "l1", question: "q1" });
    expect(consult.argv).toContain("--bg");

    const reviewWithoutIntent = TOOLS_BY_NAME.get("review")!.run({ cd: "/repo", lane: "l1" });
    expect(reviewWithoutIntent.argv).toContain("--bg");

    const reviewWithIntent = TOOLS_BY_NAME.get("review")!.run({ cd: "/repo", lane: "l1", intent: "check security" });
    expect(reviewWithIntent.argv).toContain("--bg");

  });

  test("spawn, resume, and job tools forward expected minutes", () => {
    expect(TOOLS_BY_NAME.get("spawn")!.run({ lane: "l", cd: "/repo", brief: "b", expect: 12 }).argv).toContain("--expect");
    expect(TOOLS_BY_NAME.get("resume")!.run({ lane: "l", fix: "gate", followUp: "f", expect: 12 }).argv).toContain("12");
    expect(TOOLS_BY_NAME.get("job")!.run({ name: "j", cd: "/repo", cmd: "true", expect: 12 }).argv).toContain("12");
  });

  test("no tool argv contains wait", () => {
    const sampleInputs: Record<string, Record<string, unknown>> = {
      land: { lane: "test-lane" },
      ask: { cd: "/repo", question: "Where is admission?" },
      "gate-receipt": { lane: "test-lane" },
      spawn: { cd: "/repo", lane: "test-lane", brief: "test brief" },
      resume: { lane: "test-lane", fix: "gate", followUp: "test follow-up" },
      consult: { cd: "/repo", lane: "test-lane", question: "test question" },
      review: { cd: "/repo", lane: "test-lane", intent: "test review" },
      events: {},
      send: { lane: "test-lane", text: "test text" },
      reply: { lane: "test-lane", answer: "test answer", id: 1 },
      questions: { lane: "test-lane" },
      status: { all: true },
      report: { lane: "test-lane" },
      tail: { lane: "test-lane", lines: 20 },
      close: { lane: "test-lane", note: "done" },
      kill: { lane: "test-lane" },
      gate: { lane: "test-lane", clear: true },
      job: { cd: "/repo", name: "test-job", cmd: "echo 1" },
      msg: { target: "test-lane", text: "hello" },
      inbox: { lines: 5 },
      usage: {},
      doctor: { fix: true, probe: true },
    };

    for (const tool of TOOLS) {
      expect(tool.name).not.toBe("wait");
      const input = sampleInputs[tool.name] ?? {};
      const runResult = tool.run(input);
      for (const arg of runResult.argv) {
        expect(arg).not.toBe("wait");
      }
    }
  });

  test("non-zero exits append stderr and the code", async () => {
    expect(await formatToolOutput(0, "everything ok", "")).toBe("everything ok");
    expect(await formatToolOutput(1, "some stdout", "some stderr")).toBe(
      "some stdout\nsome stderr\nexit 1",
    );
    expect(await formatToolOutput(2, "", "command failed")).toBe("command failed\nexit 2");
    expect(await formatToolOutput(137, "", "")).toBe("exit 137");
    expect(await formatToolOutput(1, "partial stdout", "")).toBe("partial stdout\nexit 1");
  });

  test("events tool drains the feed; the mod merges its buffer in front", () => {
    const eventsTool = TOOLS_BY_NAME.get("events");
    expect(eventsTool).toBeDefined();
    const result = eventsTool!.run({});
    expect(result.argv).toEqual(["events", "--json"]);
    expect(result.stdin).toBeUndefined();
  });

  test("free text arguments travel via stdin with - in argv", () => {
    const send = TOOLS_BY_NAME.get("send")!.run({ lane: "l1", text: "steer text" });
    expect(send.argv).toEqual(["send", "l1", "-"]);
    expect(send.stdin).toBe("steer text");

    const reply = TOOLS_BY_NAME.get("reply")!.run({ lane: "l1", answer: "my answer", id: 3 });
    expect(reply.argv).toEqual(["reply", "l1", "--id", "3", "-"]);
    expect(reply.stdin).toBe("my answer");

    const job = TOOLS_BY_NAME.get("job")!.run({ name: "build", cmd: "bun run build", cd: "src" });
    expect(job.argv).toEqual(["job", "build", "--cd", "src", "-"]);
    expect(job.stdin).toBe("bun run build");

    const msg = TOOLS_BY_NAME.get("msg")!.run({ target: "worker-1", text: "ready" });
    expect(msg.argv).toEqual(["msg", "worker-1", "-"]);
    expect(msg.stdin).toBe("ready");
  });

  test("doctor tool configures 120s timeout", () => {
    const doctor = TOOLS_BY_NAME.get("doctor");
    expect(doctor).toBeDefined();
    const result = doctor!.run({ probe: true });
    expect(result.timeoutMs).toBe(120000);
  });
});

// A large result must retain the whole safe body before returning excerpts.
test("100 KB native output is bounded and names the retained file", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(`${tmpdir()}/cdx-native-`);
  const path = `${root}/logs/result.log`;
  const secret = "not-a-provider-shaped-fixture";
  const body = `head CONTEXT7_API_KEY=${secret}\n${"é😀".repeat(17000)}\ntail`;
  try {
    const output = await formatToolOutput(0, body, "", async (text) => {
      mkdirSync(`${root}/logs`);
      writeFileSync(path, text);
      return path;
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(20_000);
    expect(output).toContain(path);
    expect(output).toContain("head");
    expect(output).toContain("tail");
    expect(readFileSync(path, "utf8")).toBe(body.replace(secret, "[redacted]"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cwd fallback precedes execution and never retries a thrown command", async () => {
  const { runFromCwd } = await import("./tools");
  const ran: string[] = [];
  const execute = async (cwd: string) => { ran.push(cwd); return "ok"; };
  const missing = async () => { throw Object.assign(new Error("missing cwd"), { code: "ENOENT" }); };
  expect(await runFromCwd("/gone", "/plugin", missing, execute)).toBe("ok");
  expect(ran).toEqual(["/plugin"]);
  ran.length = 0;
  await expect(runFromCwd("/work", "/plugin", async () => {}, async (cwd) => {
    ran.push(cwd);
    throw Object.assign(new Error("transport died after mutation"), { code: "ENOENT" });
  })).rejects.toThrow("transport died after mutation");
  expect(ran).toEqual(["/work"]);
  ran.length = 0;
  await expect(runFromCwd("/work", "/plugin", async () => { throw { code: "EACCES" }; }, execute)).rejects.toEqual({ code: "EACCES" });
  expect(ran).toEqual([]);
});


test("native admission refuses missing fields before argv conversion and reports command errors", () => {
  const spawn = TOOLS_BY_NAME.get("spawn")!;
  for (const brief of [undefined, null, "", " ", "undefined"]) {
    expect(() => spawn.run({ lane: "fix", cd: "/repo", brief })).toThrow("missing required field: brief");
  }
  expect(() => TOOLS_BY_NAME.get("resume")!.run({ lane: "fix", fix: "new-work", followUp: "change scope" })).toThrow("invalid fix");
  expect(nativeToolResult(2, "missing input")).toEqual({ isError: true, result: "missing input" });
  expect(nativeToolResult(0, "answer")).toEqual({ result: "answer" });
  expect(TOOLS_BY_NAME.get("ask")!.run({ cd: "/repo", question: "where?" })).toMatchObject({ argv: ["ask", "--cd", "/repo", "-"], stdin: "where?" });
  expect(TOOLS_BY_NAME.get("land")!.run({ lane: "fix" }).argv).toEqual(["land", "fix"]);
});
