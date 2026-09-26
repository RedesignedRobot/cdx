import { expect, test } from "bun:test";
import { cappedEffort, parseConfig } from "./config.ts";

test("shipped Astra cap is medium and configured caps can raise or lower defaults", () => {
  const defaults = parseConfig("{}");
  expect(defaults.effortCaps).toEqual({ "gpt-6-astra": "medium", "gpt-6-sol": "high" });
  expect(cappedEffort("astra", "high", false, defaults)).toBe("medium");
  expect(() => cappedEffort("astra", "high", true, defaults)).toThrow("max medium");

  const configured = parseConfig(JSON.stringify({ effortCaps: {
    "gpt-6-astra": "xhigh", "gpt-6-sol": "low", "gpt-6-luna": "max",
  } }));
  expect(configured.effortCaps).toEqual({ "gpt-6-astra": "xhigh", "gpt-6-sol": "low", "gpt-6-luna": "max" });
  expect(cappedEffort("astra", "xhigh", true, configured)).toBe("xhigh");
  expect(cappedEffort("sol", "medium", false, configured)).toBe("low");
  expect(() => cappedEffort("sol", "medium", true, configured)).toThrow("max low");
});

test("effort caps require model ids and supported effort values", () => {
  expect(() => parseConfig('{"effortCaps":{"Bad Alias":"high"}}')).toThrow("is not a Codex model id");
  expect(() => parseConfig('{"effortCaps":{"gpt-6-astra":"ultra"}}')).toThrow("must be one of");
});

test("expected duration defaults to 15 minutes and requires a positive number", () => {
  expect(parseConfig("{}").expectMinutes).toBe(15);
  expect(parseConfig('{"expectMinutes":2.5}').expectMinutes).toBe(2.5);
  for (const value of [0, -1, "15", null]) {
    expect(() => parseConfig(JSON.stringify({ expectMinutes: value }))).toThrow("expectMinutes must be a positive number");
  }
});
