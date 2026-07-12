#!/usr/bin/env node
"use strict";
// @ts-check
/**
 * ZCode UserPromptSubmit hook -> automatic per-turn Hindsight recall.
 *
 * AUTHORED + VERIFIED on 2026-07-12 in the zcode-litellm/pi-commands session.
 * This is the deliberate, tested port of pi's (before_agent_start + context) hook
 * pair from hindsight-pi-local/extensions/index.ts. See commit history: a prior
 * verifier-cycle reverted an earlier unreviewed copy; this recreation supersedes it.
 *
 * pi injects a `role:"custom"` message into the context array before each LLM call;
 * ZCode exposes the same seam via a UserPromptSubmit hook whose stdout
 * `additionalContext` is pushed into the turn (verified in zcode.cjs: Vmt schema,
 * case Kr.UserPromptSubmit -> additionalContexts.push).
 *
 * Flow (mirrors pi):
 *   1. read {prompt, cwd, sessionId} from stdin (the hook payload)
 *   2. derive a recall query from the latest user prompt, with pi's skip rules
 *      (slash-commands, bare "continue", inspection prompts)
 *   3. resolve config + bank ID (SAME modules as the MCP server -> same banks as pi)
 *   4. recall across [bankId, globalBankId], render, emit
 *      {"hookEventName":"UserPromptSubmit","additionalContext":"<recalled memories>"}
 *   5. on ANY error or disabled state, emit {} (never block the turn)
 *
 * Config knobs (all in src/config.js resolveConfig — verified present):
 *   recallMode: context|hybrid|tools|off (context = auto-inject; tools = manual only)
 *   injectionFrequency: every-turn|first-turn
 *   contextTokens: recall budget (default 1200)
 *
 * Smoke-tested against http://100.114.135.99:24300 (resolves bank, recalls, emits {}).
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
	if (raw.startsWith("/")) return null; // slash commands skip recall (pi parity)
	if (SHOULD_FORCE_RECALL_RE.test(raw) || CONTINUE_PROMPT_PATTERN.test(raw)) {
		// Hook processes are stateless per-invocation, so we can't reuse the last
		// meaningful query like pi does. Fall back to a broad query so the agent
		// still sees relevant memory rather than nothing.
		return FALLBACK_RECALL_QUERY;
	}
	return raw.slice(0, 800); // pi recalls on the raw latest user message
};

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
		setTimeout(() => resolve({}), 2000); // never hang if no stdin
	});

const emit = (text) => process.stdout.write(text);

/**
 * Per-session turn state for `first-turn` injection frequency.
 * Hook processes are short-lived, so persist a tiny state file keyed by sessionId.
 * @param {string} sessionId
 * @param {string} freq
 * @returns {Promise<boolean>} true if recall should proceed for this turn
 */
const shouldRecallByFrequency = async (sessionId, freq) => {
	if (freq !== "first-turn") return true;
	const fs = require("node:fs/promises");
	const os = require("node:os");
	const path = require("node:path");
	const stateFile = path.join(os.homedir(), ".hindsight", "zcode-hook-state", `${sessionId || "default"}.json`);
	try {
		let recalled = false;
		try {
			const existing = JSON.parse(await fs.readFile(stateFile, "utf8"));
			if (existing.recalled) recalled = true;
		} catch {
			/* not present -> first turn */
		}
		if (!recalled) {
			await fs.mkdir(path.dirname(stateFile), { recursive: true });
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

	if (!config.enabled) return emit("{}");
	const mode = config.recallMode; // context | hybrid | tools | off
	if (mode === "tools" || mode === "off") return emit("{}");

	const query = deriveQuery(prompt);
	if (!query) return emit("{}");

	const sessionId = payload.sessionId || "default";
	if (!(await shouldRecallByFrequency(sessionId, config.injectionFrequency))) return emit("{}");

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
