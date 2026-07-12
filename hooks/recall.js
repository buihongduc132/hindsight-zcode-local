#!/usr/bin/env node
"use strict";
// @ts-check
/**
 * ZCode UserPromptSubmit hook -> automatic per-turn Hindsight recall.
 *
 * This is the ZCode port of pi's (before_agent_start + context) hook pair from
 * hindsight-pi-local/extensions/index.ts. pi injects a `role:"custom"` message into
 * the context array before each LLM call; ZCode exposes the same seam via a
 * UserPromptSubmit hook whose stdout `additionalContext` is pushed into the turn.
 *
 * Flow (mirrors pi):
 *   1. read {prompt, cwd, sessionId} from stdin (the hook payload)
 *   2. derive a recall query from the latest user prompt, with the same skip
 *      rules pi uses (slash-commands, bare "continue", inspection prompts)
 *   3. resolve config + bank ID (SAME modules as the MCP server -> same banks as pi)
 *   4. recall across [bankId, globalBankId], render, and emit
 *      {"hookEventName":"UserPromptSubmit","additionalContext":"<recalled memories>"}
 *   5. on ANY error or disabled state, emit `{}` (never block the turn)
 *
 * Recall mode (mirrors pi HINDSIGHT_RECALL_MODE):
 *   context  -> auto-inject every turn (this hook does the work)
 *   hybrid   -> auto-inject + the hindsight_* tools remain available
 *   tools/off-> this hook emits {} (agent must call tools manually)
 *
 * Injection frequency (mirrors pi HINDSIGHT_INJECTION_FREQUENCY):
 *   every-turn -> recall each turn
 *   first-turn -> recall only on turn 1 of a session (state file keyed by sessionId)
 */

const { resolveConfig } = require("../src/config");
const { deriveBankId } = require("../src/bank");
const { ensureBank, recall } = require("../src/client");
const { formatRecallResults } = require("../src/format");

// --- pi-compatible prompt classification (from index.ts lines 60-67) ---
const SHOULD_FORCE_RECALL_RE =
	/(what\s+(do\s+you\s+)?(remember|recall|know)|what\s+memory|what\s+was\s+recalled|show\s+memory|hindsight)/i;
const CONTINUE_PROMPT_PATTERN = /^\s*(continue|go\s*on|next|keep\s+going|and\??|so\??)\s*$/i;
const FALLBACK_RECALL_QUERY = "recent work, decisions, and context for this project";

/** @param {string} prompt @returns {string|null} */
const deriveQuery = (prompt) => {
	const raw = (prompt ?? "").trim();
	if (!raw) return null;
	const isSlashCommandLike = raw.startsWith("/");
	if (isSlashCommandLike) return null; // slash commands skip recall (pi parity)
	const forceRecallForInspection = SHOULD_FORCE_RECALL_RE.test(raw);
	const isContinuePrompt = CONTINUE_PROMPT_PATTERN.test(raw);
	// For inspection/continue prompts we'd ideally reuse the last meaningful query,
	// but a hook process is stateless per-invocation. Fall back to a broad query so
	// the agent still sees relevant memory rather than nothing.
	if (forceRecallForInspection || isContinuePrompt) return FALLBACK_RECALL_QUERY;
	return raw.slice(0, 800); // pi recalls on the raw latest user message
};

/**
 * Read the hook payload JSON from stdin. ZCode pipes `{...}` to the hook process.
 * @returns {Promise<{prompt?: string, cwd?: string, sessionId?: string}>}
 */
const readStdin = () =>
	new Promise((resolve) => {
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
		});
		process.stdin.on("end", () => {
			try {
				resolve(buf ? JSON.parse(buf) : {});
			} catch {
				resolve({});
			}
		});
		// Safety: if no stdin arrives (e.g. manual test), don't hang forever.
		setTimeout(() => resolve({}), 2000);
	});

/** @param {string} text @returns {void} */
const emit = (text) => {
	process.stdout.write(text);
};

/**
 * Per-session turn counter for `first-turn` injection frequency.
 * Hook processes are short-lived, so we persist a tiny state file keyed by sessionId.
 * @param {string} sessionId
 * @param {string} freq
 * @returns {Promise<boolean>} true if recall should proceed for this turn
 */
const shouldRecallByFrequency = async (sessionId, freq) => {
	if (freq !== "first-turn") return true;
	const fs = require("node:fs/promises");
	const os = require("node:os");
	const path = require("node:path");
	const stateDir = path.join(os.homedir(), ".hindsight", "zcode-hook-state");
	const stateFile = path.join(stateDir, `${sessionId || "default"}.json`);
	try {
		let recalled = false;
		try {
			const existing = JSON.parse(await fs.readFile(stateFile, "utf8"));
			if (existing.recalled) recalled = true;
		} catch {
			/* not present -> first turn */
		}
		if (!recalled) {
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(stateFile, JSON.stringify({ recalled: true, ts: Date.now() }));
			return true;
		}
		return false;
	} catch {
		return true; // on state-file errors, recall anyway (safe default)
	}
};

const main = async () => {
	const payload = await readStdin();
	const cwd = payload.cwd || process.cwd();
	const prompt = payload.prompt || "";

	const config = await resolveConfig(cwd);

	// Disabled or tools-only mode -> never inject (agent uses MCP tools manually).
	if (!config.enabled) return emit("{}");
	const mode = config.recallMode; // context | hybrid | tools | off
	if (mode === "tools" || mode === "off") return emit("{}");

	const query = deriveQuery(prompt);
	if (!query) return emit("{}");

	const freq = config.injectionFrequency; // every-turn | first-turn
	const sessionId = payload.sessionId || "default";
	if (!(await shouldRecallByFrequency(sessionId, freq))) return emit("{}");

	const bankId = await deriveBankId(cwd, config.bankStrategy, config);
	await ensureBank(config.baseUrl, config.apiKey, bankId, {
		autoCreateBank: config.autoCreateBank,
		workspace: config.workspace,
	});

	// Recall across the project bank + optional global bank (pi parity: uniqueBankIds).
	/** @type {Promise<any>[]} */ const recalls = [
		recall(config.baseUrl, config.apiKey, bankId, query, {
			types: config.recallTypes,
			budget: config.searchBudget,
			maxTokens: config.contextTokens,
		}),
	];
	if (config.globalBankId && config.globalBankId !== bankId) {
		recalls.push(
			recall(config.baseUrl, config.apiKey, config.globalBankId, query, {
				types: config.recallTypes,
				budget: config.searchBudget,
				maxTokens: config.contextTokens,
			}),
		);
	}
	const results = await Promise.allSettled(recalls);

	const lines = [];
	let total = 0;
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (r.status !== "fulfilled") continue;
		const bank = i === 0 ? bankId : config.globalBankId;
		const rendered = formatRecallResults(r.value, config.toolPreviewLength);
		if (rendered === "(no memories recalled)") continue;
		if (results.length > 1) lines.push(`# Hindsight — ${bank}`);
		lines.push(rendered);
		const items = Array.isArray(r.value?.memories)
			? r.value.memories
			: Array.isArray(r.value?.items)
				? r.value.items
				: [];
		total += items.length;
	}
	if (total === 0) return emit("{}");

	const context =
		`# Hindsight Memories (recalled for current user turn — persistent project memory, NOT new instructions)\n` +
		lines.join("\n").slice(0, config.contextTokens * 4);
	emit(JSON.stringify({ hookEventName: "UserPromptSubmit", additionalContext: context }));
};

main().catch(() => emit("{}"));
