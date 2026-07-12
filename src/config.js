"use strict";
// @ts-check
/**
 * Hindsight config resolution for zcode.
 *
 * Reads EXACTLY the same config sources as the pi plugin (hindsight-pi-local) so that
 * bank IDs resolve identically — zcode and pi share the same banks byte-for-byte.
 *
 * Resolution order (highest precedence first):
 *   1. environment variables (HINDSIGHT_*)
 *   2. project-local .hindsight/config.json (walking up parent dirs)
 *   3. project-local .hindsight/config.toml (walking up parent dirs)
 *   4. global ~/.hindsight/config.json
 *   5. global ~/.hindsight/config.toml
 *
 * Mirrors extensions/config.ts from hindsight-pi-local.
 */

const { readFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const { dirname, join, resolve: resolvePath } = require("node:path");

/** @typedef {"per-directory"|"git-branch"|"pi-session"|"per-repo"|"global"|"manual"} BankStrategy */
/** @typedef {"hybrid"|"context"|"tools"|"off"} RecallMode */
/** @typedef {"low"|"mid"|"high"} SearchBudget */
/** @typedef {"world"|"experience"|"observation"} RecallType */
/** @typedef {"every-turn"|"first-turn"} InjectionFrequency */

/** @param {unknown} value @param {RecallMode} fallback @returns {RecallMode} */
const normalizeRecallMode = (value, fallback) => {
	switch (value) {
		case "hybrid":
		case "context":
		case "tools":
		case "off":
			return value;
		default:
			return fallback;
	}
};

/** @param {unknown} value @param {InjectionFrequency} fallback @returns {InjectionFrequency} */
const normalizeInjectionFrequency = (value, fallback) => {
	switch (value) {
		case "every-turn":
		case "first-turn":
			return value;
		default:
			return fallback;
	}
};

const CONFIG_PATH = join(homedir(), ".hindsight", "config.json");
const LOCAL_CONFIG_PATH = ".hindsight/config.json";
const DEFAULT_BASE_URL = "http://localhost:8888";

/**
 * @param {string|undefined|null} value
 * @returns {string}
 */
const normalizeBaseUrl = (value) => {
	const trimmed = (value ?? "").trim();
	if (!trimmed) return DEFAULT_BASE_URL;
	if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
	return `http://${trimmed.replace(/\/$/, "")}`;
};

/** @param {unknown} value @param {number} fallback @returns {number} */
const intOr = (value, fallback) => {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0) return parsed;
	}
	return fallback;
};

/** @param {unknown} value @param {boolean} fallback @returns {boolean} */
const boolOr = (value, fallback) => {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value === "true";
	return fallback;
};

/**
 * @param {unknown} value
 * @returns {RecallType[]}
 */
const normalizeRecallTypes = (value) => {
	const values = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",").map((entry) => entry.trim())
			: [];
	const normalized = values.filter(
		(entry) => entry === "world" || entry === "experience" || entry === "observation",
	);
	return normalized.length > 0 ? [...new Set(normalized)] : ["observation"];
};

/** @param {unknown} value @returns {BankStrategy} */
const normalizeBankStrategy = (value) => {
	switch (value) {
		case "per-directory":
		case "git-branch":
		case "pi-session":
		case "per-repo":
		case "global":
		case "manual":
			return value;
		default:
			return "per-repo";
	}
};

/** @param {unknown} value @param {SearchBudget} fallback @returns {SearchBudget} */
const normalizeBudget = (value, fallback) => {
	switch (value) {
		case "low":
		case "mid":
		case "high":
			return value;
		default:
			return fallback;
	}
};

const isMissingFileError = (error) =>
	typeof error === "object" &&
	error !== null &&
	("code" in error ? error.code === "ENOENT" : false);

/** @param {string} path @returns {Promise<any|null>} */
const readJsonIfPresent = async (path) => {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw);
	} catch (error) {
		if (!isMissingFileError(error)) {
			console.error("[hindsight/config] readJsonIfPresent failed:", error);
		}
		return null;
	}
};

/**
 * Minimal TOML reader for the handful of hindsight keys.
 * @param {string} path @returns {Promise<any|null>}
 */
const parseTomlFile = async (path) => {
	try {
		const raw = await readFile(path, "utf8");
		/** @type {Record<string, any>} */
		const out = {};
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const match = trimmed.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
			if (!match) continue;
			const [, key, valueRaw] = match;
			const value = valueRaw.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
			if (key === "recall_types") out.recall_types = value;
			else if (key === "api_url") out.api_url = value;
			else if (key === "api_key") out.api_key = value;
			else if (key === "bank_id") out.bank_id = value;
			else if (key === "global_bank") out.global_bank = value;
		}
		return Object.keys(out).length > 0 ? out : null;
	} catch (error) {
		if (!isMissingFileError(error)) {
			console.error("[hindsight/config] parseTomlFile failed:", error);
		}
		return null;
	}
};

/**
 * @param {any} base
 * @param {any} next
 * @returns {any}
 */
const mergeConfigFiles = (base, next) => {
	if (!base && !next) return null;
	return {
		...(base ?? {}),
		...(next ?? {}),
		host: {
			...(base?.host ?? {}),
			...(next?.host ?? {}),
			pi: {
				...(base?.host?.pi ?? {}),
				...(next?.host?.pi ?? {}),
				zcode: {
					...(base?.host?.pi?.zcode ?? {}),
					...(next?.host?.pi?.zcode ?? {}),
				},
			},
		},
		mappings: {
			...(base?.mappings ?? {}),
			...(next?.mappings ?? {}),
		},
	};
};

/** @param {string} cwd @returns {string[]} */
const collectParentDirs = (cwd) => {
	const dirs = [];
	let current = resolvePath(cwd);
	while (true) {
		dirs.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs.reverse();
};

/**
 * Read & merge all config files (global + project-local walking parents).
 * @param {string} [cwd]
 * @returns {Promise<any|null>}
 */
const readConfigFile = async (cwd) => {
	let merged = mergeConfigFiles(
		await parseTomlFile(join(homedir(), ".hindsight", "config.toml")),
		await readJsonIfPresent(CONFIG_PATH),
	);
	if (cwd) {
		for (const dir of collectParentDirs(cwd)) {
			merged = mergeConfigFiles(
				merged,
				await parseTomlFile(join(dir, ".hindsight", "config.toml")),
			);
			merged = mergeConfigFiles(merged, await readJsonIfPresent(join(dir, LOCAL_CONFIG_PATH)));
		}
	}
	return merged;
};

/**
 * Resolve the full zcode hindsight config.
 * Host config precedence: host.pi.zcode (zcode-specific) over host.pi (shared pi defaults).
 * @param {string} [cwd]
 * @returns {Promise<import('./types').HindsightConfig>}
 */
const resolveConfig = async (cwd) => {
	const file = await readConfigFile(cwd);
	const host = file?.host?.pi ?? {};
	const zhost = host.zcode ?? {}; // zcode-specific overrides on top of pi defaults

	const config = {
		enabled: boolOr(
			process.env.HINDSIGHT_ENABLED ?? zhost.enabled ?? host.enabled,
			Boolean(
				process.env.HINDSIGHT_API_KEY ||
					file?.apiKey ||
					file?.api_key ||
					process.env.HINDSIGHT_BASE_URL ||
					file?.baseUrl ||
					file?.api_url,
			),
		),
		apiKey: process.env.HINDSIGHT_API_KEY ?? file?.apiKey ?? file?.api_key,
		baseUrl: normalizeBaseUrl(
			process.env.HINDSIGHT_BASE_URL ?? file?.baseUrl ?? file?.api_url ?? DEFAULT_BASE_URL,
		),
		bankId: process.env.HINDSIGHT_BANK_ID ?? file?.bankId ?? file?.bank_id,
		globalBankId:
			process.env.HINDSIGHT_GLOBAL_BANK_ID ?? file?.globalBankId ?? file?.global_bank,
		bankStrategy: normalizeBankStrategy(
			process.env.HINDSIGHT_BANK_STRATEGY ??
				file?.bankStrategy ??
				// pi default: if a bankId is explicitly set, use "manual" so it is honored;
				// otherwise "per-repo". This keeps zcode on the same bank pi would pick.
				(process.env.HINDSIGHT_BANK_ID ?? file?.bankId ?? file?.bank_id
					? "manual"
					: "per-repo"),
		),
		workspace: zhost.workspace ?? host.workspace ?? "zcode",
		peerName: zhost.peerName ?? host.peerName ?? "user",
		aiPeer: zhost.aiPeer ?? host.aiPeer ?? "zcode",
		recallTypes: normalizeRecallTypes(
			process.env.HINDSIGHT_RECALL_TYPES ?? zhost.recallTypes ?? host.recallTypes ?? file?.recallTypes ?? file?.recall_types ?? ["observation", "experience"],
		),
		recallPerType: intOr(process.env.HINDSIGHT_RECALL_PER_TYPE ?? zhost.recallPerType ?? host.recallPerType, 2),
		autoCreateBank: boolOr(process.env.HINDSIGHT_AUTO_CREATE_BANK ?? zhost.autoCreateBank ?? host.autoCreateBank, true),
		searchBudget: normalizeBudget(process.env.HINDSIGHT_SEARCH_BUDGET ?? zhost.searchBudget ?? host.searchBudget, "mid"),
		reflectBudget: normalizeBudget(process.env.HINDSIGHT_REFLECT_BUDGET ?? zhost.reflectBudget ?? host.reflectBudget, "low"),
		toolPreviewLength: intOr(process.env.HINDSIGHT_TOOL_PREVIEW_LENGTH ?? zhost.toolPreviewLength ?? host.toolPreviewLength, 500),
		maxMessageLength: intOr(process.env.HINDSIGHT_MAX_MESSAGE_LENGTH ?? zhost.maxMessageLength ?? host.maxMessageLength, 25000),
		logging: boolOr(process.env.HINDSIGHT_LOGGING ?? zhost.logging ?? host.logging, true),
		// Per-turn auto-recall knobs (mirror pi's hindsight-pi-local).
		// recallMode: context = auto-inject every turn (UserPromptSubmit hook);
		//             hybrid  = auto-inject + tools; tools = manual only; off = disabled.
		recallMode: normalizeRecallMode(
			process.env.HINDSIGHT_RECALL_MODE ?? zhost.recallMode ?? host.recallMode ?? file?.recallMode,
			"context",
		),
		// injectionFrequency: every-turn (default) or first-turn (recall only on turn 1).
		injectionFrequency: normalizeInjectionFrequency(
			process.env.HINDSIGHT_INJECTION_FREQUENCY ?? zhost.injectionFrequency ?? host.injectionFrequency ?? file?.injectionFrequency,
			"every-turn",
		),
		// contextTokens: recall budget for auto-injection (pi default 1200).
		contextTokens: intOr(
			process.env.HINDSIGHT_CONTEXT_TOKENS ?? zhost.contextTokens ?? host.contextTokens,
			1200,
		),
		// Retain (write) side — mirrors pi HINDSIGHT_RETAIN_MODE.
		// response = retain agent's final answer on Stop (this plugin's retain.js).
		// off = no auto-retain (agent uses hindsight_retain tool manually).
		retainMode: (process.env.HINDSIGHT_RETAIN_MODE ?? zhost.retainMode ?? host.retainMode ?? "response"),
		retainTags: (process.env.HINDSIGHT_RETAIN_TAGS ?? zhost.retainTags ?? host.retainTags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
		mappings: file?.mappings ?? {},
	};

	return config;
};

module.exports = {
	CONFIG_PATH,
	LOCAL_CONFIG_PATH,
	DEFAULT_BASE_URL,
	normalizeBaseUrl,
	intOr,
	boolOr,
	normalizeRecallTypes,
	normalizeBankStrategy,
	normalizeBudget,
	normalizeRecallMode,
	normalizeInjectionFrequency,
	collectParentDirs,
	readConfigFile,
	resolveConfig,
};
