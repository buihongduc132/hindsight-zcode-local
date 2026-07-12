import { describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  normalizeRecallTypes,
  normalizeBankStrategy,
  normalizeBudget,
  normalizeRecallMode,
  normalizeInjectionFrequency,
  intOr,
  boolOr,
} from "../src/config.ts";

describe("normalizeBaseUrl", () => {
  it("adds http:// prefix and strips trailing slash", () => {
    expect(normalizeBaseUrl("100.114.135.99:24300")).toBe("http://100.114.135.99:24300");
    expect(normalizeBaseUrl("https://api.x.com/")).toBe("https://api.x.com");
  });
  it("returns default for empty", () => {
    expect(normalizeBaseUrl("")).toBe("http://localhost:8888");
    expect(normalizeBaseUrl(undefined)).toBe("http://localhost:8888");
  });
});

describe("normalizeRecallTypes", () => {
  it("filters invalid + dedupes", () => {
    expect(normalizeRecallTypes(["observation", "observation", "bogus"])).toEqual(["observation"]);
  });
  it("accepts comma string", () => {
    expect(normalizeRecallTypes("observation, experience")).toEqual(["observation", "experience"]);
  });
  it("defaults to observation when empty", () => {
    expect(normalizeRecallTypes([])).toEqual(["observation"]);
    expect(normalizeRecallTypes("bogus")).toEqual(["observation"]);
  });
});

describe("coercion helpers", () => {
  it("normalizeBankStrategy defaults to per-repo", () => {
    expect(normalizeBankStrategy("bogus")).toBe("per-repo");
    expect(normalizeBankStrategy("git-branch")).toBe("git-branch");
  });
  it("normalizeBudget falls back", () => {
    expect(normalizeBudget("bogus", "mid")).toBe("mid");
    expect(normalizeBudget("high", "mid")).toBe("high");
  });
  it("normalizeRecallMode / normalizeInjectionFrequency", () => {
    expect(normalizeRecallMode("nope", "context")).toBe("context");
    expect(normalizeRecallMode("tools", "context")).toBe("tools");
    expect(normalizeInjectionFrequency("nope", "every-turn")).toBe("every-turn");
    expect(normalizeInjectionFrequency("first-turn", "every-turn")).toBe("first-turn");
  });
  it("intOr parses positive integers", () => {
    expect(intOr("1200", 0)).toBe(1200);
    expect(intOr(500, 0)).toBe(500);
    expect(intOr(-1, 7)).toBe(7);
    expect(intOr("bogus", 7)).toBe(7);
  });
  it("boolOr handles bool/string", () => {
    expect(boolOr(true, false)).toBe(true);
    expect(boolOr("true", false)).toBe(true);
    expect(boolOr("false", true)).toBe(false);
    expect(boolOr(1, false)).toBe(false);
  });
});
