"use strict";
// @ts-check
/**
 * Bank ID derivation — mirrors extensions/session.ts (deriveBankId) from
 * hindsight-pi-local EXACTLY so zcode resolves to the same bank IDs as pi and
 * therefore reuses the same banks.
 *
 * @typedef {import("./types").HindsightConfig} HindsightConfig
 * @typedef {import("./types").BankStrategy} BankStrategy
 */

const { createHash } = require("node:crypto");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { execGit } = require("./git");
const { collectParentDirs } = require("./config");

/** @param {string} value @returns {string} */
const hash = (value) =>
	createHash("sha256").update(value).digest("hex").slice(0, 10);

/**
 * @param {string} value
 * @returns {string}
 */
const sanitizeBankId = (value) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120) || "pi-memory";

/**
 * @param {string} cwd
 * @returns {string}
 */
const directoryKey = (cwd) =>
	sanitizeBankId(`dir-${cwd.split(/[\\/]/).pop() ?? "project"}-${hash(cwd)}`);

/**
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
const repoRoot = async (cwd) => {
	const result = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (result?.code === 0) {
		const root = result.stdout.trim();
		return root ? root : null;
	}
	return null;
};

/**
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
const repoSlug = async (cwd) => {
	const remote = await execGit(cwd, ["remote", "get-url", "origin"]);
	if (remote?.code === 0 && remote.stdout.trim()) {
		const url = remote.stdout.trim().replace(/\.git$/, "");
		const name = url.split(/[/:]/).pop();
		if (name) return sanitizeBankId(name);
	}
	const root = await repoRoot(cwd);
	if (!root) return null;
	const name = root.split(/[\\/]/).pop() ?? "repo";
	return sanitizeBankId(`${name}-${hash(root)}`);
};

/**
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
const branchName = async (cwd) => {
	const result = await execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = result?.code === 0 ? result.stdout.trim() : "";
	if (!branch || branch === "HEAD") return null;
	return sanitizeBankId(branch);
};

/** @returns {string} */
const sessionSlug = () => sanitizeBankId(`session-${Date.now().toString(36)}`);

/**
 * Read a `.hindsight.json` (or `.hindsight/config.json` bankId) project config,
 * walking up parent directories. Mirrors findProjectConfig from project-config.ts.
 * @param {string} cwd
 * @param {number} [maxParents]
 * @returns {Promise<{bankId?: string}|null>}
 */
const findProjectConfig = async (cwd, maxParents = 3) => {
	const dirs = collectParentDirs(cwd).slice(-maxParents);
	for (const dir of [...dirs].reverse()) {
		// .hindsight.json in project root
		try {
			const raw = await readFile(join(dir, ".hindsight.json"), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && parsed.bankId) return { bankId: parsed.bankId };
		} catch {
			/* ignore */
		}
		// .hindsight/config.json bankId
		try {
			const raw = await readFile(join(dir, ".hindsight", "config.json"), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && parsed.bankId) return { bankId: parsed.bankId };
		} catch {
			/* ignore */
		}
	}
	return null;
};

/**
 * Derive the bank ID. Mirrors deriveBankId from hindsight-pi-local.
 * @param {string} cwd
 * @param {BankStrategy} strategy
 * @param {HindsightConfig} config
 * @returns {Promise<string>}
 */
const deriveBankId = async (cwd, strategy, config) => {
	const mapped = config.mappings[cwd];
	if (mapped) return sanitizeBankId(mapped);

	const projectCfg = await findProjectConfig(cwd);
	if (projectCfg?.bankId) return sanitizeBankId(projectCfg.bankId);

	if (config.bankId) return sanitizeBankId(config.bankId);
	if (strategy === "global") return sanitizeBankId(config.globalBankId ?? "pi-global-memory");
	if (strategy === "pi-session") return sessionSlug();
	if (strategy === "per-directory") return directoryKey(cwd);

	const repo = await repoSlug(cwd);
	if (strategy === "per-repo") return repo ?? directoryKey(cwd);

	const root = repo ?? directoryKey(cwd);
	const branch = await branchName(cwd);
	return branch ? sanitizeBankId(`${root}--${branch}`) : root;
};

module.exports = { sanitizeBankId, deriveBankId, findProjectConfig };
