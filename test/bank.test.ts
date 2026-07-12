import { describe, expect, it } from "vitest";
import { sanitizeBankId, deriveBankId } from "../src/bank.ts";

describe("sanitizeBankId", () => {
  it("lowercases, replaces non-alnum, trims dashes", () => {
    expect(sanitizeBankId("My-Bank_1")).toBe("my-bank_1");
    expect(sanitizeBankId("---weird---")).toBe("weird");
    expect(sanitizeBankId("a b c!")).toBe("a-b-c");
  });
  it("falls back to 'default' for all-invalid", () => {
    expect(sanitizeBankId("!!!")).toBe("default");
  });
  it("truncates to 120 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeBankId(long).length).toBe(120);
  });
});

describe("deriveBankId precedence", () => {
  it("mappings[cwd] wins", async () => {
    const id = await deriveBankId("/tmp/proj", "per-repo", {
      bankId: "config-bank",
      globalBankId: undefined,
      mappings: { "/tmp/proj": "mapped-bank" },
    });
    expect(id).toBe("mapped-bank");
  });
  it("config.bankId honored when no mapping/cache (manual strategy path)", async () => {
    const id = await deriveBankId(`/tmp/nonexistent-${String(Date.now())}`, "manual", {
      bankId: "explicit-bank",
      globalBankId: undefined,
      mappings: {},
    });
    expect(id).toBe("explicit-bank");
  });
  it("global strategy uses globalBankId", async () => {
    const id = await deriveBankId("/tmp/x", "global", {
      bankId: undefined,
      globalBankId: undefined,
      mappings: {},
    });
    expect(id).toBe("pi-global-memory");
  });
  it("per-directory is deterministic + hashed", async () => {
    const cwd = `/tmp/dir-test-${String(Date.now())}`;
    const a = await deriveBankId(cwd, "per-directory", { bankId: undefined, globalBankId: undefined, mappings: {} });
    const b = await deriveBankId(cwd, "per-directory", { bankId: undefined, globalBankId: undefined, mappings: {} });
    expect(a).toBe(b);
    expect(a.startsWith("dir-")).toBe(true);
  });
});
