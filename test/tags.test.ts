import { describe, it, expect } from "vitest";
import {
  normalizeTag,
  parseTagString,
  mergeTags,
  buildScopedTag,
  parseSessionIdFromFile,
  buildRuntimeTags,
  buildRetainTags,
  mergeRetainItems,
} from "../src/tags.ts";

describe("normalizeTag", () => {
  it("lowercases and slugifies", () => {
    expect(normalizeTag("Hello World!")).toBe("hello-world");
  });

  it("preserves scoped colon syntax", () => {
    expect(normalizeTag("Workspace:ZCode")).toBe("workspace:zcode");
  });

  it("drops empty input", () => {
    expect(normalizeTag("")).toBe("");
    expect(normalizeTag(null)).toBe("");
  });

  it("truncates to 64 chars", () => {
    const long = "a".repeat(100);
    expect(normalizeTag(long).length).toBe(64);
  });
});

describe("parseTagString", () => {
  it("splits on commas and newlines", () => {
    expect(parseTagString("a,b\nc")).toEqual(["a", "b", "c"]);
  });

  it("filters empty and invalid", () => {
    expect(parseTagString("a,,  ,b")).toEqual(["a", "b"]);
  });
});

describe("mergeTags", () => {
  it("dedupes across lists preserving order", () => {
    expect(mergeTags(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("normalizes while merging", () => {
    expect(mergeTags(["Hello World"], ["hello-world"])).toEqual(["hello-world"]);
  });
});

describe("buildScopedTag", () => {
  it("produces namespace:value", () => {
    expect(buildScopedTag("workspace", "zcode")).toBe("workspace:zcode");
  });

  it("returns null for empty namespace or value", () => {
    expect(buildScopedTag("", "value")).toBeNull();
    expect(buildScopedTag("ns", "")).toBeNull();
  });
});

describe("parseSessionIdFromFile", () => {
  it("extracts UUID from zcode sess_*.json path", () => {
    const path = "/home/user/.zcode/cli/agents/sess_1a44852a-2cd8-41f9-a5fa-724f076bbf62.json";
    expect(parseSessionIdFromFile(path)).toBe("1a44852a-2cd8-41f9-a5fa-724f076bbf62");
  });

  it("extracts UUID from pi _*.jsonl path", () => {
    const path = "/path/_1a44852a-2cd8-41f9-a5fa-724f076bbf62.jsonl";
    expect(parseSessionIdFromFile(path)).toBe("1a44852a-2cd8-41f9-a5fa-724f076bbf62");
  });

  it("returns null for non-session paths", () => {
    expect(parseSessionIdFromFile("/random/file.txt")).toBeNull();
    expect(parseSessionIdFromFile("")).toBeNull();
  });
});

describe("buildRuntimeTags", () => {
  it("emits session/provider/model/agent scoped tags", () => {
    const tags = buildRuntimeTags({
      sessionId: "abc-123",
      provider: "zai",
      model: "glm-5",
      agent: "zcode",
    });
    expect(tags).toContain("session:abc-123");
    expect(tags).toContain("provider:zai");
    expect(tags).toContain("model:glm-5");
    expect(tags).toContain("agent:zcode");
  });

  it("omits empty fields", () => {
    const tags = buildRuntimeTags({ sessionId: "abc" });
    expect(tags).toEqual(["session:abc"]);
  });
});

describe("buildRetainTags", () => {
  it("emits the standard provenance set for zcode retains", () => {
    const tags = buildRetainTags({
      workspace: "my-ws",
      bankId: "projects",
      kind: "turn-summary",
      origin: "auto",
    });
    expect(tags).toContain("source:zcode");
    expect(tags).toContain("workspace:my-ws");
    expect(tags).toContain("bank:projects");
    expect(tags).toContain("kind:turn-summary");
    expect(tags).toContain("origin:auto");
  });

  it("merges env tags when provided", () => {
    const tags = buildRetainTags({
      workspace: "ws",
      bankId: "b",
      kind: "explicit",
      origin: "explicit",
      envTags: "custom:tag,another",
    });
    expect(tags).toContain("custom:tag");
    expect(tags).toContain("another");
  });
});

describe("mergeRetainItems", () => {
  it("dedupes by content (whitespace-normalized)", () => {
    const items = [
      { content: "hello world", tags: ["a"] },
      { content: "hello   world", tags: ["b"] }, // dup after normalize
      { content: "different", tags: ["c"] },
    ];
    const out = mergeRetainItems(items, null, []);
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toBe("hello world");
  });

  it("merges env + runtime tags into each item", () => {
    const out = mergeRetainItems(
      [{ content: "x", tags: ["base"] }],
      "env-tag",
      ["rt-tag"],
    );
    expect(out[0]!.tags).toContain("base");
    expect(out[0]!.tags).toContain("env-tag");
    expect(out[0]!.tags).toContain("rt-tag");
  });
});
