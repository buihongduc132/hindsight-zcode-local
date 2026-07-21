/**
 * Regression: ZCode's plugin.json env block expands ${user_config.X} to ""
 * (empty string) when userConfig is unset. Previously, config.ts used `??`
 * which doesn't fall through on "", so empty HINDSIGHT_BASE_URL leaked to
 * normalizeBaseUrl("") → "http://localhost:8888" → every MCP fetch failed
 * with "fetch failed".
 *
 * The fix: envString() + firstNonEmpty() treat empty string as missing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig, normalizeBaseUrl } from "../src/config.ts";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = homedir();
const ORIGINAL_ENV = { ...process.env };
let tempHome: string;

// Static deletes — avoids @typescript-eslint/no-dynamic-delete.
const clearHindsightEnv = (): void => {
  delete process.env.HINDSIGHT_ENABLED;
  delete process.env.HINDSIGHT_BASE_URL;
  delete process.env.HINDSIGHT_API_KEY;
  delete process.env.HINDSIGHT_BANK_ID;
  delete process.env.HINDSIGHT_GLOBAL_BANK_ID;
  delete process.env.HINDSIGHT_BANK_STRATEGY;
  delete process.env.HINDSIGHT_SEARCH_BUDGET;
  delete process.env.HINDSIGHT_REFLECT_BUDGET;
  delete process.env.HINDSIGHT_RECALL_TYPES;
  delete process.env.HINDSIGHT_RECALL_MODE;
  delete process.env.HINDSIGHT_RETAIN_MODE;
  delete process.env.HINDSIGHT_RETAIN_TAGS;
  delete process.env.HINDSIGHT_RETAIN_ASYNC;
  delete process.env.HINDSIGHT_RETAIN_TIMEOUT_MS;
  delete process.env.HINDSIGHT_TAGS;
};

describe("MCP env empty-string bug (regression)", () => {
  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hindsight-mcp-"));
    process.env.HOME = tempHome;
    clearHindsightEnv();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    clearHindsightEnv();
    Object.assign(process.env, ORIGINAL_ENV);
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
  });

  it("EMPTY HINDSIGHT_BASE_URL falls through to config file", async () => {
    // Simulate zcode's env-block expansion: HINDSIGHT_BASE_URL="" (not unset).
    process.env.HINDSIGHT_BASE_URL = "";
    process.env.HINDSIGHT_API_KEY = "";

    // Write a real config file with the actual server URL.
    await mkdir(join(tempHome, ".hindsight"), { recursive: true });
    await writeFile(
      join(tempHome, ".hindsight", "config.json"),
      JSON.stringify({
        baseUrl: "http://100.114.135.99:24300",
        apiKey: "sk-test-123",
      }),
    );

    const config = await resolveConfig("/tmp/anywhere");
    // The bug: this would have been "http://localhost:8888" (DEFAULT_BASE_URL).
    expect(config.baseUrl).toBe("http://100.114.135.99:24300");
    expect(config.apiKey).toBe("sk-test-123");
  });

  it("non-empty HINDSIGHT_BASE_URL wins over config file", async () => {
    process.env.HINDSIGHT_BASE_URL = "http://override:9999";
    process.env.HINDSIGHT_API_KEY = "sk-override";

    await mkdir(join(tempHome, ".hindsight"), { recursive: true });
    await writeFile(
      join(tempHome, ".hindsight", "config.json"),
      JSON.stringify({ baseUrl: "http://from-config:24300", apiKey: "sk-config" }),
    );

    const config = await resolveConfig("/tmp/anywhere");
    expect(config.baseUrl).toBe("http://override:9999");
    expect(config.apiKey).toBe("sk-override");
  });

  it("unset (no env at all) falls through to config file", async () => {
    await mkdir(join(tempHome, ".hindsight"), { recursive: true });
    await writeFile(
      join(tempHome, ".hindsight", "config.json"),
      JSON.stringify({ baseUrl: "http://config-only:24300", apiKey: "sk-config" }),
    );

    const config = await resolveConfig("/tmp/anywhere");
    expect(config.baseUrl).toBe("http://config-only:24300");
  });

  it("nothing set → DEFAULT_BASE_URL (localhost:8888)", async () => {
    const config = await resolveConfig("/tmp/anywhere");
    expect(config.baseUrl).toBe("http://localhost:8888");
  });
});

describe("normalizeBaseUrl", () => {
  it("empty string → DEFAULT_BASE_URL", () => {
    expect(normalizeBaseUrl("")).toBe("http://localhost:8888");
    expect(normalizeBaseUrl("   ")).toBe("http://localhost:8888");
  });

  it("strips trailing slash", () => {
    expect(normalizeBaseUrl("http://x:24300/")).toBe("http://x:24300");
  });

  it("prepends http:// when missing scheme", () => {
    expect(normalizeBaseUrl("x:24300")).toBe("http://x:24300");
  });
});
