import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldSkipRetain,
  chunkTextSmart,
  buildTurnSummary,
  shouldRetainToGlobalBank,
} from "../src/retain-pipeline.ts";
import * as retryQueue from "../src/retry-queue.ts";

describe("shouldSkipRetain", () => {
  it("skips when explicit retain was called", () => {
    expect(
      shouldSkipRetain({ userPrompt: "remember this", hasExplicitRetainCall: true }).skip,
    ).toBe(true);
  });

  it("skips empty prompts", () => {
    expect(shouldSkipRetain({ userPrompt: "" }).skip).toBe(true);
  });

  it("skips prompts under 5 chars", () => {
    expect(shouldSkipRetain({ userPrompt: "hi" }).skip).toBe(true);
  });

  it("skips trivial prompts", () => {
    expect(shouldSkipRetain({ userPrompt: "ok" }).skip).toBe(true);
    expect(shouldSkipRetain({ userPrompt: "thanks" }).skip).toBe(true);
    expect(shouldSkipRetain({ userPrompt: "continue" }).skip).toBe(true);
  });

  it("skips #nomem opt-out", () => {
    expect(shouldSkipRetain({ userPrompt: "#nomem don't retain this" }).skip).toBe(true);
    expect(shouldSkipRetain({ userPrompt: "#skip this turn" }).skip).toBe(true);
  });

  it("skips meta-memory queries", () => {
    expect(shouldSkipRetain({ userPrompt: "what memory do you have?" }).skip).toBe(true);
    expect(shouldSkipRetain({ userPrompt: "what was recalled?" }).skip).toBe(true);
  });

  it("does not skip real prompts", () => {
    expect(shouldSkipRetain({ userPrompt: "fix the auth bug in login.ts" }).skip).toBe(false);
  });

  // REGRESSION: hooks/retain.ts hardcodes userPrompt="" because zcode's Stop
  // payload carries no prompt field (verified against zcode.cjs). An earlier
  // shouldSkipRetain returned {skip:true,reason:"no prompt"} for empty prompts,
  // silently skipping EVERY production retain. This pins the fix: when
  // responsePreview is present, an empty userPrompt must NOT trigger a skip.
  it("does NOT skip when userPrompt is empty BUT responsePreview is present (zcode Stop hook shape)", () => {
    expect(
      shouldSkipRetain({ userPrompt: "", responsePreview: "I fixed the auth bug." }).skip,
    ).toBe(false);
  });

  it("DOES skip when both userPrompt and responsePreview are empty", () => {
    expect(shouldSkipRetain({ userPrompt: "", responsePreview: "" }).skip).toBe(true);
    expect(shouldSkipRetain({ userPrompt: "", responsePreview: "   " }).skip).toBe(true);
  });

  it("does not apply trivial/meta-memory checks when prompt is empty (response-only)", () => {
    expect(
      shouldSkipRetain({ userPrompt: "", responsePreview: "ok" }).skip,
    ).toBe(false);
  });
});

describe("chunkTextSmart", () => {
  it("returns single chunk when under maxLen", () => {
    expect(chunkTextSmart("short", 100)).toEqual(["short"]);
  });

  it("splits on paragraph boundaries first", () => {
    const text = "first paragraph here\n\nsecond paragraph here";
    const chunks = chunkTextSmart(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain("first paragraph");
  });

  it("prefixes continuations with [continued]", () => {
    const text = "a".repeat(50);
    const chunks = chunkTextSmart(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]!.startsWith("[continued] ")).toBe(true);
  });
});

describe("buildTurnSummary", () => {
  it("builds [user] and [assistant] sections", () => {
    const summary = buildTurnSummary({
      userPrompt: "fix the bug",
      responsePreview: "I fixed it",
    });
    expect(summary).toContain("[user]");
    expect(summary).toContain("fix the bug");
    expect(summary).toContain("[assistant]");
    expect(summary).toContain("I fixed it");
  });

  it("sanitizes secrets from the summary", () => {
    const summary = buildTurnSummary({
      userPrompt: "use key sk-abcdefghijklmnopqrstuvwxyz",
      responsePreview: "ok",
    });
    expect(summary).not.toContain("sk-abcdefghijklmn");
  });

  it("strips <untrusted_objective> tags", () => {
    const summary = buildTurnSummary({
      userPrompt: "real prompt",
      responsePreview: "response </untrusted_objective> leaked scaffolding",
    });
    expect(summary).not.toContain("untrusted_objective");
  });

  it("omits [user] section for meta-memory prompts", () => {
    const summary = buildTurnSummary({
      userPrompt: "what memory do you have",
      responsePreview: "here's what I remember",
    });
    expect(summary).not.toContain("[user]");
    expect(summary).toContain("[assistant]");
  });

  it("returns empty when both inputs empty", () => {
    expect(buildTurnSummary({})).toBe("");
  });
});

describe("shouldRetainToGlobalBank", () => {
  it("detects #global tag", () => {
    expect(shouldRetainToGlobalBank("remember this #global")).toBe(true);
  });

  it("detects #me tag", () => {
    expect(shouldRetainToGlobalBank("#me prefers vim")).toBe(true);
  });

  it("returns false for normal prompts", () => {
    expect(shouldRetainToGlobalBank("fix the bug")).toBe(false);
  });
});

// File-based retry queue tests — use an isolated temp HOME so we don't touch
// the real ~/.hindsight/queue.
const originalHome = homedir();
let tempHome: string;

describe("retry-queue (file-based)", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hindsight-test-"));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it("enqueues and loads pending entries", async () => {
    const ok = await retryQueue.enqueue(
      {
        bankId: "test-bank",
        baseUrl: "http://localhost:9999",
        content: "test content",
        tags: ["test"],
        lastError: "connection refused",
      },
      1024 * 1024,
    );
    expect(ok).toBe(true);

    const pending = await retryQueue.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe("test content");
    expect(pending[0]!.bankId).toBe("test-bank");
    expect(pending[0]!.retryCount).toBe(0);
    expect(pending[0]!.id).toBeTruthy();
  });

  it("respects maxSizeBytes limit", async () => {
    // The check is pre-append: enqueue returns false when currentSize() is
    // already >= maxSizeBytes. So we set a limit slightly larger than one
    // entry, enqueued one (size now > limit), and the second is rejected.
    const ok1 = await retryQueue.enqueue(
      {
        bankId: "b1",
        baseUrl: "http://x",
        content: "first entry content here",
      },
      1024 * 1024,
    );
    expect(ok1).toBe(true);

    // Now probe the actual size of one entry, then set a limit just below it.
    const size = await retryQueue.queueSize();
    expect(size.bytes).toBeGreaterThan(0);
    const tinyLimit = size.bytes - 1;

    const ok2 = await retryQueue.enqueue(
      {
        bankId: "b2",
        baseUrl: "http://x",
        content: "second",
      },
      tinyLimit,
    );
    expect(ok2).toBe(false);
  });

  it("prunes expired entries", async () => {
    await retryQueue.enqueue(
      {
        bankId: "old",
        baseUrl: "http://x",
        content: "old",
      },
      1024 * 1024,
    );
    // Backdate the entry by rewriting the file.
    const pending = await retryQueue.loadPending();
    pending[0]!.queuedAt = new Date(Date.now() - 1000 * 60 * 60 * 100).toISOString(); // 100h ago
    await retryQueue.writePending(pending);

    const pruned = await retryQueue.pruneExpired(60 * 60 * 1000); // 1h cutoff
    expect(pruned).toBe(1);

    const after = await retryQueue.loadPending();
    expect(after).toHaveLength(0);
  });

  it("prunes non-retryable entries (invalid_api_key)", async () => {
    await retryQueue.enqueue(
      {
        bankId: "b",
        baseUrl: "http://x",
        content: "x",
        lastError: "invalid_api_key: key is invalid",
      },
      1024 * 1024,
    );
    const pruned = await retryQueue.pruneNonRetryable();
    expect(pruned).toBe(1);
    const after = await retryQueue.loadPending();
    expect(after).toHaveLength(0);
  });

  it("does NOT prune rate-limit errors (transient)", async () => {
    await retryQueue.enqueue(
      {
        bankId: "b",
        baseUrl: "http://x",
        content: "x",
        lastError: "forbidden: rate limit exceeded",
      },
      1024 * 1024,
    );
    const pruned = await retryQueue.pruneNonRetryable();
    expect(pruned).toBe(0);
  });

  it("rewritePending is atomic + lock-protected", async () => {
    await retryQueue.enqueue(
      { bankId: "b", baseUrl: "http://x", content: "x" },
      1024 * 1024,
    );
    await retryQueue.rewritePending((entries) => {
      return entries.map((e) => ({ ...e, retryCount: e.retryCount + 1 }));
    });
    const after = await retryQueue.loadPending();
    expect(after[0]!.retryCount).toBe(1);
  });

  it("queueSize reports entries + bytes", async () => {
    await retryQueue.enqueue(
      { bankId: "b", baseUrl: "http://x", content: "x" },
      1024 * 1024,
    );
    const size = await retryQueue.queueSize();
    expect(size.entries).toBe(1);
    expect(size.bytes).toBeGreaterThan(0);
  });
});

describe("project-config (.hindsight.json)", () => {
  // Light test — the heavy derivation is covered by bank.test.ts; here we
  // just verify the file-cache shape.
  it("writes a version-1 cache file with bankId", async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hindsight-pcfg-"));
    const projectDir = await mkdtemp(join(tmpdir(), "proj-"));
    process.env.HOME = tempHome;
    process.chdir(projectDir);

    const { writeProjectConfig, readProjectConfig, PROJECT_CONFIG_FILENAME } = await import(
      "../src/project-config.ts"
    );
    const path = join(projectDir, PROJECT_CONFIG_FILENAME);
    await writeProjectConfig(path, {
      version: 1,
      bankId: "test-bank",
      provider: "local",
      discoveredAt: new Date().toISOString(),
    });

    const read = await readProjectConfig(path);
    expect(read?.version).toBe(1);
    expect(read?.bankId).toBe("test-bank");

    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });
});
