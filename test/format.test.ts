import { describe, expect, it } from "vitest";
import {
  formatHindsightStatus,
  formatRecallResults,
  formatReflectResult,
  formatRetainResult,
} from "../src/format.ts";
import { parseRecallResponse } from "../src/types.ts";

describe("formatHindsightStatus", () => {
  it("includes action, bank, result, duration, count", () => {
    const out = formatHindsightStatus({
      bankId: "b1",
      action: "recall",
      mode: "sync",
      result: "success",
      durationMs: 42,
      count: 3,
    });
    expect(out).toContain("bank=b1");
    expect(out).toContain("action=recall");
    expect(out).toContain("success");
    expect(out).toContain("n=3");
  });
});

describe("formatRecallResults", () => {
  it("groups by type and includes content", () => {
    const parsed = parseRecallResponse({
      results: [
        { type: "observation", content: "fact A" },
        { type: "observation", content: "fact B" },
        { type: "experience", content: "did X" },
      ],
    });
    const out = formatRecallResults(parsed, 500);
    expect(out).toContain("observation (2)");
    expect(out).toContain("experience (1)");
    expect(out).toContain("fact A");
  });
  it("truncates long content to preview length", () => {
    const long = "x".repeat(600);
    const parsed = parseRecallResponse({ results: [{ type: "observation", content: long }] });
    const out = formatRecallResults(parsed, 100);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(long.length);
  });
  it("handles items missing a type (defaults to 'memory')", () => {
    const parsed = parseRecallResponse({ results: [{ content: "no type" }] });
    const out = formatRecallResults(parsed, 500);
    expect(out).toContain("memory (1)");
  });
});

describe("formatReflectResult", () => {
  it("prefers a non-empty answer", () => {
    const out = formatReflectResult({ answer: "synthesis", items: [] });
    expect(out).toBe("synthesis");
  });
  it("lists sources when items present", () => {
    const out = formatReflectResult({
      answer: "ans",
      items: [{ content: "src1" }, { content: "src2" }],
    });
    expect(out).toContain("Sources (2)");
  });
});

describe("formatRetainResult", () => {
  it("reports retained with id", () => {
    expect(formatRetainResult({ id: 99, success: true })).toContain("retained");
    expect(formatRetainResult({ id: 99, success: true })).toContain("id=99");
  });
  it("reports failure when success=false", () => {
    expect(formatRetainResult({ success: false })).toContain("failed");
  });
});
