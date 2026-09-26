import { expect, test } from "bun:test";
import { parseConfig } from "./config.ts";
import { chooseSpawnModel } from "./repo-routing.ts";

const repo = "/Users/mas/code/hyperscale-portals";
const routing = { [repo]: { model: "gpt-6-astra" } };

function select(overrides: Partial<Parameters<typeof chooseSpawnModel>[1]> = {}) {
  return chooseSpawnModel("gpt-6-sol", {
    engine: "gpt", cwd: `${repo}/src`, routing,
    commonDir: () => `${repo}/.git`, explicit: false, retained: false,
    thinking: false, child: false, ...overrides,
  });
}

test("Sol is the default everywhere; configured routes are validated", () => {
  expect(parseConfig("{}").repoRouting).toEqual({});
  expect(parseConfig("{}").model).toBe("gpt-6-sol");
  expect(parseConfig(JSON.stringify({ repoRouting: routing })).repoRouting).toEqual(routing);
  expect(parseConfig(JSON.stringify({ repoRouting: { "/other/repo": { model: "gpt-6-sol" } } })).repoRouting)
    .toEqual({ "/other/repo": { model: "gpt-6-sol" } });
  for (const bad of [null, [], "repo"]) {
    expect(() => parseConfig(JSON.stringify({ repoRouting: bad }))).toThrow("repoRouting must be an object");
  }
  for (const path of ["relative/repo", "/repo/../other", "/repo/"]) {
    expect(() => parseConfig(JSON.stringify({ repoRouting: { [path]: { model: "gpt-6-sol" } } }))).toThrow("absolute canonical path");
  }
  for (const entry of [null, "gpt-6-sol", {}, { model: "gpt-6-sol", extra: 1 }]) {
    expect(() => parseConfig(JSON.stringify({ repoRouting: { [repo]: entry } }))).toThrow("must contain only a model");
  }
  for (const model of [null, "", "Astra", "bad model"]) {
    expect(() => parseConfig(JSON.stringify({ repoRouting: { [repo]: { model } } }))).toThrow("must be a Codex model id");
  }
});

test("main checkout subdirectories and linked worktrees use the same Git common directory", () => {
  expect(select()).toEqual({ model: "gpt-6-astra", reason: `repoRouting[${repo}] for ${repo}/src` });
  expect(select({ cwd: "/tmp/linked/src", commonDir: () => `${repo}/.git` }).model).toBe("gpt-6-astra");
  expect(select({ cwd: `${repo}-other`, commonDir: () => `${repo}-other/.git` }).model).toBe("gpt-6-sol");
  expect(select({ commonDir: () => undefined }).model).toBe("gpt-6-sol");
  expect(select({ commonDir: () => `${repo}/.git/worktrees/linked` }).model).toBe("gpt-6-sol");
});

test("explicit, retained, thinking, child and Gemini selections bypass repository routing", () => {
  const unavailable = () => { throw new Error("Git should not run"); };
  for (const [flag, reason] of [
    ["explicit", "explicit --model"], ["retained", "retained lane model"],
    ["thinking", "head thinking model"], ["child", "child work model"],
  ] as const) {
    expect(select({ [flag]: true, commonDir: unavailable })).toEqual({ model: "gpt-6-sol", reason });
  }
  expect(select({ engine: "gemini", commonDir: unavailable })).toEqual({ model: "gpt-6-sol", reason: "Gemini engine" });
});
