"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Test the MCP server's tool registration and handler logic without a live server.
 * We stub fetch and use an ISOLATED temp dir (under the project's own test root, NOT
 * under /tmp which has a sticky /tmp/.hindsight.json) plus explicit env overrides so
 * handleTool runs deterministically and matches pi's bank-resolution precedence.
 */

const TEST_ROOT = mkdtempSync(join(__dirname, ".tmp-mcp-"));
process.on("exit", () => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

const stubFetch = (responses = {}) => {
	const original = global.fetch;
	global.fetch = async (url, opts) => {
		// Strip query string for response-key matching (tags/entities use ?limit=).
		const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
		const key = `${opts?.method ?? "GET"} ${path}`;
		if (responses[key]) {
			const r = responses[key];
			if (r instanceof Error) throw r;
			return { ok: true, text: async () => (typeof r === "string" ? r : JSON.stringify(r)) };
		}
		return { ok: true, text: async () => JSON.stringify({ ok: true }) };
	};
	return () => (global.fetch = original);
};

/** Isolated cwd under TEST_ROOT so its parent chain has no .hindsight.json. */
const isolatedCwd = () => {
	const dir = mkdtempSync(join(TEST_ROOT, "cwd-"));
	return {
		path: dir,
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		},
	};
};

/** Load a fresh copy of the mcp-server module so its internal cache is empty. */
const freshServer = () => {
	delete require.cache[require.resolve("../src/mcp-server")];
	delete require.cache[require.resolve("../src/config")];
	return require("../src/mcp-server");
};

test("TOOLS exposes the three hindsight tools + banks helper", () => {
	const { TOOLS } = freshServer();
	const names = TOOLS.map((t) => t.name).sort();
	assert.deepEqual(names, ["hindsight_banks", "hindsight_context", "hindsight_retain", "hindsight_search"]);
	for (const t of TOOLS) {
		assert.equal(typeof t.description, "string");
		assert.ok(t.description.length > 20);
		assert.equal(t.inputSchema.type, "object");
		assert.ok(t.inputSchema.properties);
	}
});

test("hindsight_search tool has required query + optional budget/types/bank", () => {
	const { TOOLS } = freshServer();
	const t = TOOLS.find((x) => x.name === "hindsight_search");
	assert.deepEqual(t.inputSchema.required, ["query"]);
	assert.deepEqual(t.inputSchema.properties.budget.enum, ["low", "mid", "high"]);
});

test("handleTool hindsight_search returns recall block (stubbed)", async () => {
	const restore = stubFetch({
		"GET /v1/default/banks/b1/profile": { bank_id: "b1", fact_count: 5 },
		"POST /v1/default/banks/b1/memories/recall": {
			memories: [{ type: "observation", content: "stubbed fact", score: 0.5 }],
		},
	});
	const cwd = isolatedCwd();
	process.env.HINDSIGHT_ENABLED = "true";
	process.env.HINDSIGHT_BANK_ID = "b1";
	process.env.HINDSIGHT_BANK_STRATEGY = "manual";
	try {
		const { handleTool } = freshServer();
		const out = await handleTool("hindsight_search", { query: "stub", budget: "low" }, cwd.path);
		assert.match(out, /\[hindsight:recall/);
		assert.match(out, /result=success/);
		assert.match(out, /stubbed fact/);
	} finally {
		restore();
		cwd.cleanup();
		delete process.env.HINDSIGHT_ENABLED;
		delete process.env.HINDSIGHT_BANK_ID;
		delete process.env.HINDSIGHT_BANK_STRATEGY;
	}
});

test("handleTool hindsight_retain returns retain block (stubbed)", async () => {
	const restore = stubFetch({
		"GET /v1/default/banks/b1/profile": { bank_id: "b1", fact_count: 5 },
		"POST /v1/default/banks/b1/memories": { operation_id: "op-99", status: "queued" },
	});
	const cwd = isolatedCwd();
	process.env.HINDSIGHT_ENABLED = "true";
	process.env.HINDSIGHT_BANK_ID = "b1";
	process.env.HINDSIGHT_BANK_STRATEGY = "manual";
	try {
		const { handleTool } = freshServer();
		const out = await handleTool("hindsight_retain", { content: "a fact", tags: ["t"] }, cwd.path);
		assert.match(out, /\[hindsight:retain/);
		assert.match(out, /result=success/);
		assert.match(out, /operation_id=op-99/);
	} finally {
		restore();
		cwd.cleanup();
		delete process.env.HINDSIGHT_ENABLED;
		delete process.env.HINDSIGHT_BANK_ID;
		delete process.env.HINDSIGHT_BANK_STRATEGY;
	}
});

test("handleTool hindsight_banks lists connected banks (stubbed)", async () => {
	const restore = stubFetch({
		"GET /v1/default/banks/b1/profile": { bank_id: "b1", fact_count: 7 },
		"GET /v1/default/banks/b1/tags": { items: [{ tag: "scope:project", count: 3 }] },
		"GET /v1/default/banks/b1/entities": { items: [{ canonical_name: "ent", mention_count: 2 }] },
	});
	const cwd = isolatedCwd();
	process.env.HINDSIGHT_ENABLED = "true";
	process.env.HINDSIGHT_BANK_ID = "b1";
	process.env.HINDSIGHT_BANK_STRATEGY = "manual";
	try {
		const { handleTool } = freshServer();
		const out = await handleTool("hindsight_banks", {}, cwd.path);
		assert.match(out, /Connected Hindsight banks/);
		assert.match(out, /bank=b1/);
		assert.match(out, /facts=7/);
		assert.match(out, /scope:project\(3\)/);
	} finally {
		restore();
		cwd.cleanup();
		delete process.env.HINDSIGHT_ENABLED;
		delete process.env.HINDSIGHT_BANK_ID;
		delete process.env.HINDSIGHT_BANK_STRATEGY;
	}
});

test("handleTool unknown tool throws", async () => {
	const restore = stubFetch({
		"GET /v1/default/banks/b1/profile": { bank_id: "b1", fact_count: 1 },
	});
	const cwd = isolatedCwd();
	process.env.HINDSIGHT_ENABLED = "true";
	process.env.HINDSIGHT_BANK_ID = "b1";
	process.env.HINDSIGHT_BANK_STRATEGY = "manual";
	try {
		const { handleTool } = freshServer();
		await assert.rejects(handleTool("nope", {}, cwd.path), /Unknown tool/);
	} finally {
		restore();
		cwd.cleanup();
		delete process.env.HINDSIGHT_ENABLED;
		delete process.env.HINDSIGHT_BANK_ID;
		delete process.env.HINDSIGHT_BANK_STRATEGY;
	}
});
