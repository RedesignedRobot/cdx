import { describe, expect, test } from "bun:test";
import { formatToolOutput, TOOLS, TOOLS_BY_NAME } from "./tools";

describe("tool rules", () => {
  test("spawn tool argv ends with --bg - and carries the brief on stdin", () => {
    const spawn = TOOLS_BY_NAME.get("spawn");
    expect(spawn).toBeDefined();

    const result = spawn!.run({
      lane: "feature-fix",
      brief: "Fix the memory leak in worker thread",
      engine: "gpt",
      effort: "high",
    });

    expect(result.argv).toEqual([
      "spawn",
      "feature-fix",
      "--engine",
      "gpt",
      "--effort",
      "high",
      "--bg",
      "-",
    ]);
    expect(result.argv.slice(-2)).toEqual(["--bg", "-"]);
    expect(result.stdin).toBe("Fix the memory leak in worker thread");
  });

  test("spawn, resume, consult, review, and fork always pass --bg", () => {
    const spawn = TOOLS_BY_NAME.get("spawn")!.run({ lane: "l1", brief: "b1" });
    expect(spawn.argv).toContain("--bg");

    const resume = TOOLS_BY_NAME.get("resume")!.run({ lane: "l1", followUp: "f1" });
    expect(resume.argv).toContain("--bg");

    const consult = TOOLS_BY_NAME.get("consult")!.run({ lane: "l1", question: "q1" });
    expect(consult.argv).toContain("--bg");

    const reviewWithoutIntent = TOOLS_BY_NAME.get("review")!.run({ lane: "l1" });
    expect(reviewWithoutIntent.argv).toContain("--bg");

    const reviewWithIntent = TOOLS_BY_NAME.get("review")!.run({ lane: "l1", intent: "check security" });
    expect(reviewWithIntent.argv).toContain("--bg");

    const fork = TOOLS_BY_NAME.get("fork")!.run({ lane: "l2", source: "l1", brief: "b2" });
    expect(fork.argv).toContain("--bg");
  });

  test("no tool argv contains wait", () => {
    const sampleInputs: Record<string, Record<string, unknown>> = {
      spawn: { lane: "test-lane", brief: "test brief" },
      resume: { lane: "test-lane", followUp: "test follow-up" },
      consult: { lane: "test-lane", question: "test question" },
      review: { lane: "test-lane", intent: "test review" },
      fork: { lane: "test-lane-2", source: "test-lane", brief: "test brief" },
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
      job: { name: "test-job", cmd: "echo 1" },
      msg: { target: "test-lane", text: "hello" },
      inbox: { lines: 5 },
      usage: {},
      takeover: { target: "test-lane" },
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

  test("non-zero exits append stderr and the code", () => {
    expect(formatToolOutput(0, "everything ok", "")).toBe("everything ok");
    expect(formatToolOutput(1, "some stdout", "some stderr")).toBe(
      "some stdout\nsome stderr\nexit 1",
    );
    expect(formatToolOutput(2, "", "command failed")).toBe("command failed\nexit 2");
    expect(formatToolOutput(137, "", "")).toBe("exit 137");
    expect(formatToolOutput(1, "partial stdout", "")).toBe("partial stdout\nexit 1");
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
