import { describe, it, expect } from "vitest";
import {
  sanitizeCredentials,
  stripNonMemoryContent,
  sanitizeForRetain,
  isPluginInjection,
  extractText,
} from "../src/sanitize.ts";

describe("sanitizeCredentials", () => {
  it("redacts sk- style API keys", () => {
    const input = "the key is sk-abcdefghijklmnopqrstuvwxyz for openai";
    const out = sanitizeCredentials(input);
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("<REDACTED>");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890";
    const out = sanitizeCredentials(input);
    expect(out).not.toContain("Bearer abcdef");
    expect(out).toContain("<REDACTED>");
  });

  it("redacts api_key= assignments", () => {
    const input = 'config = { api_key: "secret-key-1234567890" }';
    const out = sanitizeCredentials(input);
    expect(out).not.toContain("secret-key-1234567890");
  });

  it("leaves normal text untouched", () => {
    const input = "just some normal text about zcode configuration";
    expect(sanitizeCredentials(input)).toBe(input);
  });
});

describe("stripNonMemoryContent", () => {
  it("strips <thinking> blocks", () => {
    const input = "before <thinking>internal reasoning</thinking> after";
    const out = stripNonMemoryContent(input);
    expect(out).not.toContain("<thinking>");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips <untrusted_objective> tags", () => {
    const input = "text </untrusted_objective> trailing";
    const out = stripNonMemoryContent(input);
    expect(out).not.toContain("</untrusted_objective>");
  });

  it("strips Budget: scaffolding blocks", () => {
    const input = "real content\nBudget:\n- Time: 0s\nNext: real work";
    const out = stripNonMemoryContent(input);
    expect(out).not.toContain("Budget:");
  });

  it("strips base64 data URIs over 100 chars", () => {
    const long64 = "A".repeat(150);
    const input = `image data:image/png;base64,${long64} end`;
    const out = stripNonMemoryContent(input);
    expect(out).not.toContain(long64);
  });
});

describe("sanitizeForRetain", () => {
  it("applies strip then redact in order", () => {
    const input = "<thinking>sk-secret123456789012345678</thinking> visible";
    const out = sanitizeForRetain(input);
    expect(out).not.toContain("<thinking>");
    expect(out).not.toContain("sk-secret");
  });
});

describe("isPluginInjection", () => {
  it("flags the todo-enforcer continuation template", () => {
    expect(
      isPluginInjection({
        role: "user",
        content: "You have incomplete tasks. Continue working on them.",
      }),
    ).toBe(true);
  });

  it("flags 'Pick up where you left off.'", () => {
    expect(
      isPluginInjection({ role: "user", content: "Pick up where you left off." }),
    ).toBe(true);
  });

  it("does not flag real user prompts", () => {
    expect(
      isPluginInjection({ role: "user", content: "fix the bug in auth.ts" }),
    ).toBe(false);
  });

  it("flags custom messages with excluded customType", () => {
    expect(isPluginInjection({ customType: "todo-enforcer", content: "x" })).toBe(true);
  });

  it("does not flag assistant messages", () => {
    expect(
      isPluginInjection({ role: "assistant", content: "You have incomplete tasks." }),
    ).toBe(false);
  });
});

describe("extractText", () => {
  it("returns strings trimmed", () => {
    expect(extractText("  hello  ")).toBe("hello");
  });

  it("joins content-block arrays", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractText(content)).toBe("first\nsecond");
  });

  it("ignores non-text blocks", () => {
    const content = [
      { type: "image", source: "..." },
      { type: "text", text: "only" },
    ];
    expect(extractText(content)).toBe("only");
  });

  it("returns empty string for nullish input", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });
});
