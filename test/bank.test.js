"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { sanitizeBankId, deriveBankId } = require("../src/bank");

// Dedicated test root OUTSIDE the project git repo and NOT under /tmp (which has a
// sticky /tmp/.hindsight.json that pins banks during tests — real pi behavior, but
// here we want isolation). Using /var/tmp keeps it clear of both /tmp and the repo.
const TEST_ROOT = mkdtempSync(join("/var/tmp", "hindsight-bank-test-"));
process.on("exit", () => {
	try {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

/** Isolated temp dir under TEST_ROOT (no .hindsight.json in its parent chain). */
const isolatedDir = () => mkdtempSync(join(TEST_ROOT, "d-"));
const cleanup = (dir) => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
};

test("sanitizeBankId lowercases, replaces non-alnum (preserves _ and -), trims dashes", () => {
	// mirrors pi: replace [^a-z0-9_-]+ with "-" — underscore is PRESERVED
	assert.equal(sanitizeBankId("MyRepo_Foo!Bar"), "myrepo_foo-bar");
	assert.equal(sanitizeBankId("---lead---"), "lead");
	assert.equal(sanitizeBankId("UPPER"), "upper");
	assert.equal(sanitizeBankId(""), "pi-memory");
	const long = "a".repeat(200);
	assert.ok(sanitizeBankId(long).length <= 120);
});

test("deriveBankId honors explicit config.bankId (manual)", async () => {
	const cwd = isolatedDir();
	try {
		const config = { mappings: {}, bankId: "my-explicit-bank", bankStrategy: "manual" };
		const id = await deriveBankId(cwd, "manual", config);
		assert.equal(id, "my-explicit-bank");
	} finally {
		cleanup(cwd);
	}
});

test("deriveBankId honors mappings[cwd]", async () => {
	const cwd = isolatedDir();
	try {
		const config = { mappings: { [cwd]: "mapped-bank" }, bankStrategy: "manual" };
		const id = await deriveBankId(cwd, "manual", config);
		assert.equal(id, "mapped-bank");
	} finally {
		cleanup(cwd);
	}
});

test("deriveBankId global strategy uses globalBankId", async () => {
	const cwd = isolatedDir();
	try {
		const config = { mappings: {}, globalBankId: "globe", bankStrategy: "global" };
		const id = await deriveBankId(cwd, "global", config);
		assert.equal(id, "globe");
	} finally {
		cleanup(cwd);
	}
});

test("deriveBankId per-directory is deterministic and hashed", async () => {
	const cwd1 = isolatedDir();
	const cwd2 = isolatedDir();
	try {
		const config = { mappings: {}, bankStrategy: "per-directory" };
		const id1 = await deriveBankId(cwd1, "per-directory", config);
		const id1b = await deriveBankId(cwd1, "per-directory", config);
		const id2 = await deriveBankId(cwd2, "per-directory", config);
		assert.equal(id1, id1b, "same cwd -> same bank");
		assert.notEqual(id1, id2, "different cwd -> different bank");
		assert.match(id1, /^dir-/);
	} finally {
		cleanup(cwd1);
		cleanup(cwd2);
	}
});

test("deriveBankId per-repo falls back to directory key in a non-repo dir", async () => {
	const cwd = isolatedDir();
	try {
		const config = { mappings: {}, bankStrategy: "per-repo" };
		const id = await deriveBankId(cwd, "per-repo", config);
		assert.match(id, /^dir-/);
		const id2 = await deriveBankId(cwd, "per-repo", config);
		assert.equal(id, id2);
	} finally {
		cleanup(cwd);
	}
});

test("deriveBankId .hindsight.json project config wins over config.bankId (mirrors pi precedence)", async () => {
	const cwd = isolatedDir();
	writeFileSync(join(cwd, ".hindsight.json"), JSON.stringify({ version: 1, bankId: "project-pinned-bank" }));
	try {
		// Even with an explicit config.bankId, the project .hindsight.json takes precedence
		// (this matches hindsight-pi-local's deriveBankId ordering).
		const config = { mappings: {}, bankId: "explicit-but-loses", bankStrategy: "manual" };
		const id = await deriveBankId(cwd, "manual", config);
		assert.equal(id, "project-pinned-bank");
	} finally {
		cleanup(cwd);
	}
});

test("deriveBankId in a git repo derives a slug from the remote (matches pi)", async () => {
	// Initialize a tiny git repo with an origin remote and assert the slug is derived
	// from the repo name, matching pi's repoSlug logic.
	const { execSync } = require("node:child_process");
	const cwd = isolatedDir();
	try {
		execSync("git init -q", { cwd });
		execSync('git remote add origin https://github.com/example/my-cool-repo.git', { cwd });
		const config = { mappings: {}, bankStrategy: "per-repo" };
		const id = await deriveBankId(cwd, "per-repo", config);
		assert.equal(id, "my-cool-repo", "per-repo should derive from origin remote name");
	} finally {
		cleanup(cwd);
	}
});
