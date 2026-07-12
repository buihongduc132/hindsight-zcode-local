#!/usr/bin/env node
"use strict";
// @ts-check
/**
 * End-to-end smoke test for the hindsight MCP server.
 *
 * Spawns the server, performs the MCP initialize handshake, then calls
 * `hindsight_banks`, `hindsight_search`, `hindsight_context`, and `hindsight_retain`
 * in turn, asserting each returns a non-error result.
 *
 * Requires a reachable Hindsight server (configured via ~/.hindsight/config.json).
 * Exits non-zero on any failure.
 */

const { spawn } = require("node:child_process");
const { resolve: resolvePath } = require("node:path");
const { resolveConfig } = require("../src/config");

const SERVER = resolvePath(__dirname, "..", "src", "mcp-server.js");
const TIMEOUT_MS = 60_000;

/** @param {any} line @returns {any} */
const parse = (line) => {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
};

const main = async () => {
	const config = await resolveConfig(process.cwd());
	if (!config.enabled) {
		console.error("SKIP: hindsight disabled (config.enabled=false).");
		process.exit(0);
	}
	console.error(`[smoke] baseUrl=${config.baseUrl} bankStrategy=${config.bankStrategy} workspace=${config.workspace}`);

	const child = spawn("node", [SERVER], {
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, ZCODE_PROJECT_DIR: process.cwd() },
	});
	child.on("error", (err) => {
		console.error("[smoke] spawn failed:", err);
		process.exit(1);
	});

	let buf = "";
	/** @type {((msg: any) => void)[]} */ const waiters = [];
	child.stdout.on("data", (data) => {
		buf += data.toString("utf8");
		let idx;
		while ((idx = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			const msg = parse(line);
			if (msg && msg.jsonrpc === "2.0") {
				const w = waiters.shift();
				if (w) w(msg);
			}
		}
	});

	/** @param {any} msg @returns {Promise<any>} */
	const send = (msg) =>
		new Promise((res, rej) => {
			waiters.push((reply) => {
				if (reply.error) rej(new Error(JSON.stringify(reply.error)));
				else res(reply.result);
			});
			child.stdin.write(JSON.stringify(msg) + "\n");
		});

	const timer = setTimeout(() => {
		console.error("[smoke] TIMEOUT");
		child.kill("SIGKILL");
		process.exit(2);
	}, TIMEOUT_MS);

	const withTimeout = (p, ms, label) =>
		Promise.race([
			p,
			new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
		]);

	try {
		// 1. initialize
		const init = await withTimeout(
			send({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
			}),
			10_000,
			"initialize",
		);
		if (init.serverInfo.name !== "hindsight-zcode-local") throw new Error(`bad serverInfo: ${JSON.stringify(init)}`);
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
		console.error("[smoke] OK initialize:", init.serverInfo.name, init.serverInfo.version);

		// 2. tools/list
		const list = await withTimeout(
			send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
			10_000,
			"tools/list",
		);
		const names = list.tools.map((t) => t.name).sort();
		const expected = ["hindsight_banks", "hindsight_context", "hindsight_retain", "hindsight_search"];
		if (JSON.stringify(names) !== JSON.stringify(expected)) {
			throw new Error(`tools/list mismatch: got ${JSON.stringify(names)} expected ${JSON.stringify(expected)}`);
		}
		console.error("[smoke] OK tools/list:", names.join(", "));

		// 3. hindsight_banks (this project's banks)
		const banks = await withTimeout(
			send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hindsight_banks", arguments: {} } }),
			30_000,
			"hindsight_banks",
		);
		const banksText = banks.content?.[0]?.text ?? "";
		if (!/Connected Hindsight banks/.test(banksText)) throw new Error(`banks output unexpected: ${banksText.slice(0, 200)}`);
		console.error("[smoke] OK hindsight_banks:\n" + banksText.split("\n").slice(0, 3).join("\n"));

		// 4. hindsight_search (recall) — tolerate embedding-service outages
		try {
			const search = await withTimeout(
				send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "hindsight_search", arguments: { query: "test smoke", budget: "low" } } }),
				40_000,
				"hindsight_search",
			);
			const searchText = search.content?.[0]?.text ?? "";
			if (!/\[hindsight:recall/.test(searchText)) throw new Error(`search output unexpected: ${searchText.slice(0, 200)}`);
			console.error("[smoke] OK hindsight_search");
		} catch (searchErr) {
			const msg = String(searchErr?.message ?? searchErr);
			// Tolerate hindsight-SERVER-side embedding problems (not plugin defects):
			//  - TEI embedding service down / refused
			//  - vector dimension mismatch (server switched embedding models)
			if (/embedding|TEI|Connection refused|vector dimension|DataError/i.test(msg)) {
				console.error("[smoke] WARN hindsight_search skipped (server-side embedding issue):", msg.slice(0, 140));
			} else {
				throw searchErr;
			}
		}

		// 5. hindsight_retain — write then we're done
		const retain = await withTimeout(
			send({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "hindsight_retain", arguments: { content: "hindsight-zcode-local smoke test retained this fact.", context: "When: smoke test, Involving: hindsight-zcode-local", tags: ["smoke", "hindsight-zcode-local"] } },
			}),
			40_000,
			"hindsight_retain",
		);
		const retainText = retain.content?.[0]?.text ?? "";
		if (!/\[hindsight:retain.*result=success/.test(retainText)) throw new Error(`retain output unexpected: ${retainText.slice(0, 200)}`);
		console.error("[smoke] OK hindsight_retain");

		clearTimeout(timer);
		child.kill("SIGTERM");
		console.error("[smoke] ALL PASS");
		process.exit(0);
	} catch (err) {
		clearTimeout(timer);
		console.error("[smoke] FAIL:", err instanceof Error ? err.message : err);
		child.kill("SIGKILL");
		process.exit(1);
	}
};

void main();
