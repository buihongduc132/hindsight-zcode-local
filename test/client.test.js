"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

/**
 * Verify the client targets EXACTLY the same endpoints as the pi plugin
 * (@vectorize-io/hindsight-client v0.6.2), so zcode reuses the same banks.
 * We stub global fetch and capture method + url + body.
 */

/** @returns {{calls: any[], restore: () => void}} */
const stubFetch = () => {
	const calls = [];
	const original = global.fetch;
	global.fetch = async (url, opts) => {
		calls.push({ url: String(url), method: opts?.method ?? "GET", body: opts?.body });
		const path = String(url).replace(/^https?:\/\/[^/]+/, "");
		if (path === "/v1/default/banks") {
			return { ok: true, text: async () => JSON.stringify({ banks: [] }) };
		}
		if (/\/banks\/[^/]+$/.test(path)) {
			return { ok: true, text: async () => JSON.stringify({ bank_id: "x", fact_count: 1 }) };
		}
		if (/\/(tags|entities)/.test(path)) {
			return { ok: true, text: async () => JSON.stringify({ items: [] }) };
		}
		return { ok: true, text: async () => JSON.stringify({ ok: true }) };
	};
	return { calls, restore: () => (global.fetch = original) };
};

test("recall hits POST /v1/default/banks/{id}/memories/recall with correct body", async () => {
	const { calls, restore } = stubFetch();
	try {
		const { recall } = require("../src/client");
		await recall("http://h:24300", "key", "mybank", "the query", { types: ["observation"], budget: "high" });
		const c = calls[0];
		assert.equal(c.method, "POST");
		assert.match(c.url, /\/v1\/default\/banks\/mybank\/memories\/recall$/);
		const body = JSON.parse(c.body);
		assert.equal(body.query, "the query");
		assert.deepEqual(body.types, ["observation"]);
		assert.equal(body.budget, "high");
	} finally {
		restore();
	}
});

test("reflect hits POST /v1/default/banks/{id}/reflect with correct body", async () => {
	const { calls, restore } = stubFetch();
	try {
		const { reflect } = require("../src/client");
		await reflect("http://h:24300", undefined, "mybank", "q", { context: "ctx", budget: "mid" });
		const c = calls[0];
		assert.equal(c.method, "POST");
		assert.match(c.url, /\/v1\/default\/banks\/mybank\/reflect$/);
		const body = JSON.parse(c.body);
		assert.equal(body.query, "q");
		assert.equal(body.context, "ctx");
		assert.equal(body.budget, "mid");
	} finally {
		restore();
	}
});

test("retain hits POST /v1/default/banks/{id}/memories (create) with items[]", async () => {
	const { calls, restore } = stubFetch();
	try {
		const { retain } = require("../src/client");
		await retain("http://h:24300", undefined, "mybank", "the fact", { tags: ["x"], context: "c" });
		const c = calls[0];
		assert.equal(c.method, "POST");
		assert.match(c.url, /\/v1\/default\/banks\/mybank\/memories$/);
		const body = JSON.parse(c.body);
		assert.ok(Array.isArray(body.items));
		assert.equal(body.items.length, 1);
		assert.equal(body.items[0].content, "the fact");
		assert.deepEqual(body.items[0].tags, ["x"]);
		assert.equal(body.items[0].context, "c");
	} finally {
		restore();
	}
});

test("listBanks hits GET /v1/default/banks", async () => {
	const { calls, restore } = stubFetch();
	try {
		const { listBanks } = require("../src/client");
		await listBanks("http://h:24300", "k");
		assert.equal(calls[0].method, "GET");
		assert.match(calls[0].url, /\/v1\/default\/banks$/);
	} finally {
		restore();
	}
});

test("createBank hits PUT /v1/default/banks/{id}", async () => {
	const { calls, restore } = stubFetch();
	try {
		const { createBank } = require("../src/client");
		await createBank("http://h:24300", undefined, "newbank", { name: "newbank", background: "bg" });
		assert.equal(calls[0].method, "PUT");
		assert.match(calls[0].url, /\/v1\/default\/banks\/newbank$/);
	} finally {
		restore();
	}
});

test("ensureBank auto-creates on 404", async () => {
	const restore = (() => {
		const original = global.fetch;
		let first = true;
		global.fetch = async (url, opts) => {
			if (first) {
				first = false;
				const e = new Error("404 not found");
				// @ts-ignore
				e.statusCode = 404;
				throw e;
			}
			return { ok: true, text: async () => JSON.stringify({ ok: true }) };
		};
		return () => (global.fetch = original);
	})();
	try {
		const { ensureBank } = require("../src/client");
		await ensureBank("http://h:24300", undefined, "missing", { autoCreateBank: true, workspace: "zcode" });
	} finally {
		restore();
	}
});

test("apiRequest throws on non-ok with detail", async () => {
	const restore = (() => {
		const original = global.fetch;
		global.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ detail: "boom" }) });
		return () => (global.fetch = original);
	})();
	try {
		const { apiRequest } = require("../src/client");
		await assert.rejects(apiRequest("http://h", "k", "/v1/default/banks", {}), /boom/);
	} finally {
		restore();
	}
});
