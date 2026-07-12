/**
 * Regression: the silent-drop bug. The JS port's recall read `result?.memories`
 * / `result?.items` but the server returns `{results:[...]}`. formatRecallResults
 * returned "(no memories recalled)" for real responses — recall delivered NOTHING.
 *
 * This test locks the fix: parseRecallResponse + formatRecallResults MUST read
 * `results` first. If anyone reverts to reading only memories/items, this fails.
 */
import { describe, expect, it } from "vitest";
import { parseRecallResponse } from "../src/types.ts";
import { formatRecallResults } from "../src/format.ts";

describe("silent-drop regression: server returns {results:[...]}", () => {
  it("parseRecallResponse reads the `results` field (canonical server shape)", () => {
    const parsed = parseRecallResponse({
      results: [
        { type: "observation", content: "REAL FACT FROM SERVER", score: 0.9 },
        { type: "experience", content: "Did X", score: 0.8 },
      ],
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.content).toBe("REAL FACT FROM SERVER");
  });

  it("formatRecallResults renders server-shape results (NOT '(no memories recalled)')", () => {
    const parsed = parseRecallResponse({
      results: [{ type: "observation", content: "REAL FACT", score: 0.9 }],
    });
    const out = formatRecallResults(parsed, 500);
    expect(out).not.toBe("(no memories recalled)");
    expect(out).toContain("REAL FACT");
    expect(out).toContain("observation (1)");
  });

  it("still handles legacy {memories:[...]} shape (back-compat)", () => {
    const parsed = parseRecallResponse({ memories: [{ type: "experience", content: "legacy" }] });
    expect(parsed.items).toHaveLength(1);
    expect(formatRecallResults(parsed, 500)).toContain("legacy");
  });

  it("still handles alternate {items:[...]} shape (back-compat)", () => {
    const parsed = parseRecallResponse({ items: [{ type: "world", content: "alt" }] });
    expect(parsed.items).toHaveLength(1);
  });

  it("empty results array -> '(no memories recalled)' (correct no-op)", () => {
    const parsed = parseRecallResponse({ results: [] });
    expect(formatRecallResults(parsed, 500)).toBe("(no memories recalled)");
  });

  it("truly empty object -> no items (no throw)", () => {
    const parsed = parseRecallResponse({});
    expect(parsed.items).toHaveLength(0);
  });

  it("prefers `results` when multiple fields present (results wins)", () => {
    const parsed = parseRecallResponse({
      results: [{ content: "from-results" }],
      memories: [{ content: "from-memories" }],
    });
    expect(parsed.items[0]?.content).toBe("from-results");
  });
});
