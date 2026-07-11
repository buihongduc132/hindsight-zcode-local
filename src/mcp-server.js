#!/usr/bin/env node
"use strict";
// @ts-check
/**
 * Hindsight MCP server for ZCode (zero-dependency stdio JSON-RPC).
 *
 * Exposes the same three tools as the pi plugin so the agent can recall, reflect,
 * and retain against the SAME hindsight banks:
 *
 *   hindsight_search   -> recall (raw durable-memory hits)
 *   hindsight_context  -> reflect (synthesized answer across memories)
 *   hindsight_retain   -> retain (store a durable fact)
 *   hindsight_banks    -> list connected banks + fact counts
 *
 * Transport: Model Context Protocol over stdio (JSON-RPC 2.0). No SDK dependency —
 * implemented from the spec so it runs on the system Node without `npm install`.
 */

const readline = require("node:readline");
const { resolveConfig } = require("./config");
const { deriveBankId } = require("./bank");
const {
	ensureBank,
	recall,
	reflect,
	retain,
	listBanks,
	getBankProfile,
	fetchTopTags,
	fetchTopEntities,
} = require("./client");
const {
	formatHindsightStatus,
	formatRecallResults,
	formatReflectResult,
	formatRetainResult,
} = require("./format");

const SERVER_NAME = "hindsight-zcode-local";
const SERVER_VERSION = "0.1.0";

/**
 * Resolve config + bank ID for the current working directory.
 * @param {import("./types").HindsightConfig} config
 * @param {string} cwd
 * @returns {Promise<{bankId: string, globalBankId?: string}>}
 */
const resolveBank = async (config, cwd) => {
	const bankId = await deriveBankId(cwd, config.bankStrategy, config);
	await ensureBank(config.baseUrl, config.apiKey, bankId, {
		autoCreateBank: config.autoCreateBank,
		workspace: config.workspace,
	});
	if (config.globalBankId && config.globalBankId !== bankId) {
		await ensureBank(config.baseUrl, config.apiKey, config.globalBankId, {
			autoCreateBank: config.autoCreateBank,
			workspace: config.workspace,
		});
	}
	return { bankId, globalBankId: config.globalBankId };
};

// Cache config + resolved bank per cwd for the process lifetime.
/** @type {{cwd: string, config: import("./types").HindsightConfig, bank: Promise<{bankId: string, globalBankId?: string}>}|null} */
let cached = null;

/**
 * @param {string} cwd
 * @returns {Promise<{config: import("./types").HindsightConfig, bankId: string, globalBankId?: string}>}
 */
const getResolved = async (cwd) => {
	const config = await resolveConfig(cwd);
	if (!config.enabled) {
		throw new Error(
			"Hindsight is disabled. Set HINDSIGHT_ENABLED=true or host.pi.enabled=true in ~/.hindsight/config.json.",
		);
	}
	if (!cached || cached.cwd !== cwd) {
		cached = {
			cwd,
			config,
			bank: resolveBank(config, cwd),
		};
	} else {
		cached.config = config;
	}
	const bank = await cached.bank;
	return { config, bankId: bank.bankId, globalBankId: bank.globalBankId };
};

// ---------- Tool definitions ----------

const TOOLS = [
	{
		name: "hindsight_search",
		description:
			"Search raw durable memory from Hindsight using recall. Returns matching memories (observations/experiences) ranked by relevance to the query. Use for: 'what happened with X', retrieving facts, finding prior work. Prefer hindsight_context when you need a synthesized answer.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Natural-language query. Use entity names, dates, and symptom words for best results.",
				},
				budget: {
					type: "string",
					enum: ["low", "mid", "high"],
					description: "Recall breadth. low=fast (5-10), mid=balanced (15-25), high=comprehensive (30-50). Default: mid.",
				},
				types: {
					type: "array",
					items: { type: "string", enum: ["world", "experience", "observation"] },
					description: "Memory types to recall. Default: observation, experience.",
				},
				bank: {
					type: "string",
					description: "Optional explicit bank ID. Defaults to the bank resolved for this project (shared with pi).",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "hindsight_context",
		description:
			"Synthesize a contextual answer from Hindsight memories using reflect. Use for: 'what should I do about X', decision rationale, recommendations across memories. Slower than hindsight_search (involves LLM synthesis) but returns a coherent answer.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "The question to synthesize an answer for." },
				context: { type: "string", description: "Optional additional context to ground the synthesis." },
				budget: {
					type: "string",
					enum: ["low", "mid", "high"],
					description: "Reflect breadth. Default: low.",
				},
				bank: { type: "string", description: "Optional explicit bank ID." },
			},
			required: ["query"],
		},
	},
	{
		name: "hindsight_retain",
		description:
			"Store a durable fact/memory into Hindsight for future recall. Use only when explicitly asked to remember something, or for genuinely durable, reusable knowledge (lessons, decisions, architecture facts). Do not retain transient state.",
		inputSchema: {
			type: "object",
			properties: {
				content: { type: "string", description: "The fact/memory to store." },
				context: { type: "string", description: "Optional context (e.g. 'When: ...', 'Involving: ...')." },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Optional tags (e.g. ['lesson-learned', 'architecture']).",
				},
				bank: { type: "string", description: "Optional explicit bank ID." },
			},
			required: ["content"],
		},
	},
	{
		name: "hindsight_banks",
		description:
			"List the connected Hindsight banks for this project (resolved bank + global bank) with fact counts, top tags, and top entities. Use to understand what memory is available before searching.",
		inputSchema: {
			type: "object",
			properties: {
				listAll: {
					type: "boolean",
					description: "If true, list ALL banks on the server instead of just this project's banks.",
				},
			},
		},
	},
];

// ---------- Tool handlers ----------

/**
 * @param {string} name
 * @param {{[k: string]: any}} args
 * @param {string} cwd
 * @returns {Promise<string>}
 */
const handleTool = async (name, args, cwd) => {
	const startedAt = Date.now();
	const { config, bankId } = await getResolved(cwd);

	if (name === "hindsight_search") {
		const query = String(args.query ?? "");
		if (!query.trim()) throw new Error("query is required");
		const bank = args.bank ? String(args.bank) : bankId;
		const types = Array.isArray(args.types) && args.types.length ? args.types : config.recallTypes;
		const budget = args.budget ? String(args.budget) : config.searchBudget;
		const result = await recall(config.baseUrl, config.apiKey, bank, query, { types, budget });
		const memories = Array.isArray(result?.memories)
			? result.memories
			: Array.isArray(result?.items)
				? result.items
				: [];
		return `${formatHindsightStatus({ bankId: bank, action: "recall", mode: "sync", result: "success", durationMs: Date.now() - startedAt, count: memories.length })}\n${formatRecallResults(result, config.toolPreviewLength)}`;
	}

	if (name === "hindsight_context") {
		const query = String(args.query ?? "");
		if (!query.trim()) throw new Error("query is required");
		const bank = args.bank ? String(args.bank) : bankId;
		const budget = args.budget ? String(args.budget) : config.reflectBudget;
		const result = await reflect(config.baseUrl, config.apiKey, bank, query, {
			context: args.context ? String(args.context) : undefined,
			budget,
		});
		return `${formatHindsightStatus({ bankId: bank, action: "reflect", mode: "sync", result: "success", durationMs: Date.now() - startedAt })}\n${formatReflectResult(result)}`;
	}

	if (name === "hindsight_retain") {
		const content = String(args.content ?? "");
		if (!content.trim()) throw new Error("content is required");
		const bank = args.bank ? String(args.bank) : bankId;
		const result = await retain(config.baseUrl, config.apiKey, bank, content, {
			context: args.context ? String(args.context) : undefined,
			tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
		});
		return `${formatHindsightStatus({ bankId: bank, action: "retain", mode: "async", result: "success", durationMs: Date.now() - startedAt })} ${formatRetainResult(result)}`;
	}

	if (name === "hindsight_banks") {
		if (args.listAll) {
			const all = await listBanks(config.baseUrl, config.apiKey);
			const banks = Array.isArray(all?.banks) ? all.banks : [];
			const lines = banks.slice(0, 100).map(
				(b) => `  ${b.bank_id}: ${b.fact_count ?? 0} facts`,
			);
			return `Hindsight banks (${banks.length} total):\n${lines.join("\n")}`;
		}
		const ids = [bankId, config.globalBankId].filter((v) => Boolean(v));
		const unique = [...new Set(ids)];
		const sections = [];
		for (const id of unique) {
			const profile = await getBankProfile(config.baseUrl, config.apiKey, id).catch(() => null);
			const [tags, entities] = await Promise.all([
				fetchTopTags(config.baseUrl, config.apiKey, id, 10),
				fetchTopEntities(config.baseUrl, config.apiKey, id, 10),
			]);
			const label = id === bankId ? config.workspace : `${config.workspace}:global`;
			const lines = [`[${label}] bank=${id} facts=${profile?.fact_count ?? "?"}`];
			if (tags.length) {
				lines.push(`  Tags: ${tags.slice(0, 8).map((t) => `${t.tag}(${t.count})`).join(", ")}`);
			}
			if (entities.length) {
				lines.push(`  Entities: ${entities.slice(0, 8).map((e) => `${e.canonical_name}(${e.mention_count})`).join(", ")}`);
			}
			sections.push(lines.join("\n"));
		}
		return `Connected Hindsight banks:\n${sections.join("\n\n")}`;
	}

	throw new Error(`Unknown tool: ${name}`);
};

// ---------- JSON-RPC stdio transport ----------

const log = (level, msg) => {
	// MCP: all logs go to stderr; stdout is reserved for protocol messages.
	process.stderr.write(`[${SERVER_NAME}] ${level}: ${msg}\n`);
};

/** @param {any} id @param {any} result */ const sendResult = (id, result) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
/** @param {any} id @param {{code: number, message: string, data?: any}} err */ const sendError = (id, err) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: err }) + "\n");

let initialized = false;

const handleMessage = async (msg) => {
	const { id, method, params } = msg;
	try {
		if (method === "initialize") {
			initialized = true;
			sendResult(id, {
				protocolVersion: "2024-11-05",
				capabilities: {
					tools: { listChanged: false },
				},
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			});
			return;
		}
		if (method === "initialized" || method === "notifications/initialized") {
			return;
		}
		if (method === "ping") {
			sendResult(id, {});
			return;
		}
		if (method === "tools/list") {
			sendResult(id, { tools: TOOLS });
			return;
		}
		if (method === "tools/call") {
			const name = params?.name;
			const args = params?.arguments ?? {};
			const cwd = process.env.ZCODE_PROJECT_DIR || process.env.CWD || process.cwd();
			try {
				const text = await handleTool(name, args, cwd);
				sendResult(id, {
					content: [{ type: "text", text }],
					isError: false,
				});
			} catch (toolErr) {
				const message = toolErr instanceof Error ? toolErr.message : String(toolErr);
				log("error", `tool ${name} failed: ${message}`);
				sendResult(id, {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				});
			}
			return;
		}
		if (id !== undefined) {
			sendError(id, { code: -32601, message: `Method not found: ${method}` });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log("error", `handleMessage ${method}: ${message}`);
		if (id !== undefined) {
			sendError(id, { code: -32603, message: `Internal error: ${message}` });
		}
	}
};

const main = () => {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	let buffer = "";
	rl.on("line", (line) => {
		buffer = line;
		if (!buffer.trim()) return;
		let msg;
		try {
			msg = JSON.parse(buffer);
		} catch {
			log("error", "non-JSON line on stdin, ignoring");
			return;
		}
		void handleMessage(msg);
	});
	rl.on("close", () => {
		log("info", "stdin closed, shutting down");
		process.exit(0);
	});
	process.on("SIGTERM", () => process.exit(0));
	process.on("SIGINT", () => process.exit(0));
	log("info", `${SERVER_NAME} v${SERVER_VERSION} stdio server ready`);
};

if (require.main === module) {
	main();
}

module.exports = { handleTool, TOOLS, SERVER_NAME, SERVER_VERSION };
