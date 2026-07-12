/** Schema + round-trip tests for the zod boundary types. */
import { describe, expect, it } from "vitest";
import {
  asBankId,
  asApiKey,
  BankStrategySchema,
  RecallModeSchema,
  InjectionFrequencySchema,
  RetainModeSchema,
  SearchBudgetSchema,
  UserPromptSubmitPayloadSchema,
  StopPayloadSchema,
  HookOutputSchema,
  ReflectResponseSchema,
  BankListResponseSchema,
} from "../src/types.ts";

describe("branded primitives", () => {
  it("asBankId accepts valid slugs", () => {
    expect(asBankId("my-bank_1")).toBe("my-bank_1");
    expect(asBankId("verifier-loop")).toBe("verifier-loop");
  });
  it("asBankId rejects invalid characters", () => {
    expect(() => asBankId("My Bank!")).toThrow();
    expect(() => asBankId("UPPER")).toThrow();
    expect(() => asBankId("")).toThrow();
  });
  it("asApiKey rejects empty", () => {
    expect(() => asApiKey("")).toThrow();
    expect(() => asApiKey("   ")).toThrow();
    expect(asApiKey("sk-xxx")).toBe("sk-xxx");
  });
});

describe("enum schemas", () => {
  it("BankStrategySchema defaults to per-repo on invalid", () => {
    expect(BankStrategySchema.catch("per-repo").parse("bogus")).toBe("per-repo");
    expect(BankStrategySchema.parse("git-branch")).toBe("git-branch");
  });
  it("RecallMode/InjectionFrequency/RetainMode/SearchBudget validate", () => {
    expect(RecallModeSchema.parse("context")).toBe("context");
    expect(RecallModeSchema.catch("context").parse("nope")).toBe("context");
    expect(InjectionFrequencySchema.parse("every-turn")).toBe("every-turn");
    expect(RetainModeSchema.parse("response")).toBe("response");
    expect(SearchBudgetSchema.parse("mid")).toBe("mid");
  });
});

describe("hook payload parsing", () => {
  it("UserPromptSubmitPayloadSchema parses a real ZCode stdin payload", () => {
    const r = UserPromptSubmitPayloadSchema.safeParse({
      prompt: "how do I deploy",
      cwd: "/home/bhd/ZCodeProject",
      sessionId: "abc-123",
      hookEventName: "UserPromptSubmit",
      mode: "default",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.prompt).toBe("how do I deploy");
  });
  it("StopPayloadSchema parses responsePreview + toolCallCount", () => {
    const r = StopPayloadSchema.safeParse({
      responsePreview: "Done. Created 3 files.",
      toolCallCount: 5,
      cwd: "/tmp",
      hookEventName: "Stop",
    });
    expect(r.success).toBe(true);
  });
  it("HookOutputSchema accepts additionalContext", () => {
    const r = HookOutputSchema.safeParse({
      hookEventName: "UserPromptSubmit",
      additionalContext: "# Memories\n- fact",
    });
    expect(r.success).toBe(true);
  });
});

describe("API response schemas", () => {
  it("ReflectResponseSchema normalizes answer from multiple field names", () => {
    const r = ReflectResponseSchema.parse({ result: "synthesized answer" });
    expect(r.answer).toBe("synthesized answer");
  });
  it("BankListResponseSchema normalizes banks/items", () => {
    const r = BankListResponseSchema.parse({ banks: [{ bank_id: "b1", fact_count: 5 }] });
    expect(r).toHaveLength(1);
    expect(r[0]?.bank_id).toBe("b1");
  });
});
