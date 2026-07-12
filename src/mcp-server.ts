/**
 * Hindsight MCP server for ZCode (zero-dependency stdio JSON-RPC).
 *
 * Exposes the same tools as the pi plugin so the agent can recall, reflect, and
 * retain against the SAME hindsight banks:
 *
 *   hindsight_search   -> recall (raw durable-memory hits)
 *   hindsight_context  -> reflect (synthesized answer across memories)
 *   hindsight_retain   -> retain (store a durable fact)
 *   hindsight_banks    -> list connected banks + fact counts
 *
 * Transport: Model Context Protocol over stdio (JSON-RPC 2.0). Bundled to a single
 * zero-dependency .cjs by esbuild; runs on system Node without node_modules.
 */
import readline from "node:readline";
import { z } from "zod";
import { resolveConfig } from "./config.ts";
import { deriveBankId } from "./bank.ts";
import {
  ensureBank,
  recall,
  reflect,
  retain,
  listBanks,
  getBankProfile,
  fetchTopTags,
  fetchTopEntities,
} from "./client.ts";
import {
  formatHindsightStatus,
  formatRecallResults,
  formatReflectResult,
  formatRetainResult,
} from "./format.ts";
import { asBankId, type BankId, type HindsightConfig, type ToolResult } from "./types.ts";

const SERVER_NAME = "hindsight-zcode-local";
const SERVER_VERSION = "0.2.0";

// ---------- Resolved bank cache ----------

interface Resolved {
  readonly config: HindsightConfig;
  readonly bankId: BankId;
  readonly globalBankId: BankId | undefined;
}

interface Cached {
  cwd: string;
  config: HindsightConfig;
  bank: Promise<Resolved>;
}

let cached: Cached | null = null;

const resolveBank = async (config: HindsightConfig, cwd: string): Promise<Resolved> => {
  const bankId = await deriveBankId(cwd, config.bankStrategy, config);
  await ensureBank(config.baseUrl, config.apiKey, bankId, {
    autoCreateBank: config.autoCreateBank,
    workspace: config.workspace,
  });
  let globalBankId: BankId | undefined;
  if (config.globalBankId && config.globalBankId !== bankId) {
    globalBankId = asBankId(config.globalBankId);
    await ensureBank(config.baseUrl, config.apiKey, globalBankId, {
      autoCreateBank: config.autoCreateBank,
      workspace: config.workspace,
    });
  }
  return { config, bankId, globalBankId };
};

const getResolved = async (cwd: string): Promise<Resolved> => {
  const config = await resolveConfig(cwd);
  if (!config.enabled) {
    throw new Error(
      "Hindsight is disabled. Set HINDSIGHT_ENABLED=true or host.pi.enabled=true in ~/.hindsight/config.json.",
    );
  }
  if (cached?.cwd !== cwd) {
    cached = { cwd, config, bank: resolveBank(config, cwd) };
  } else {
    cached.config = config;
  }
  return cached.bank;
};

// ---------- Tool input schemas (validated, not assumed) ----------

const SearchInput = z.object({
  query: z.string().min(1),
  budget: z.enum(["low", "mid", "high"]).optional(),
  types: z.array(z.enum(["world", "experience", "observation"])).optional(),
  bank: z.string().optional(),
});

const ContextInput = z.object({
  query: z.string().min(1),
  context: z.string().optional(),
  budget: z.enum(["low", "mid", "high"]).optional(),
  bank: z.string().optional(),
});

const RetainInput = z.object({
  content: z.string().min(1),
  context: z.string().optional(),
  tags: z.array(z.string()).optional(),
  bank: z.string().optional(),
});

const BanksInput = z.object({ listAll: z.boolean().optional() });

// ---------- Tool definitions ----------

const TOOLS = [
  {
    name: "hindsight_search",
    description:
      "Search raw durable memory from Hindsight using recall. Returns matching memories (observations/experiences) ranked by relevance to the query. Use for: 'what happened with X', retrieving facts, finding prior work. Prefer hindsight_context when you need a synthesized answer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural-language query. Use entity names, dates, and symptom words for best results." },
        budget: { type: "string", enum: ["low", "mid", "high"], description: "Recall breadth. low=fast (5-10), mid=balanced (15-25), high=comprehensive (30-50). Default: mid." },
        types: { type: "array", items: { type: "string", enum: ["world", "experience", "observation"] }, description: "Memory types to recall. Default: observation, experience." },
        bank: { type: "string", description: "Optional explicit bank ID. Defaults to the bank resolved for this project (shared with pi)." },
      },
      required: ["query"],
    },
  },
  {
    name: "hindsight_context",
    description:
      "Synthesize a contextual answer from Hindsight memories using reflect. Use for: 'what should I do about X', decision rationale, recommendations across memories. Slower than hindsight_search (involves LLM synthesis) but returns a coherent answer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "The question to synthesize an answer for." },
        context: { type: "string", description: "Optional additional context to ground the synthesis." },
        budget: { type: "string", enum: ["low", "mid", "high"], description: "Reflect breadth. Default: low." },
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
      type: "object" as const,
      properties: {
        content: { type: "string", description: "The fact/memory to store." },
        context: { type: "string", description: "Optional context (e.g. 'When: ...', 'Involving: ...')." },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags (e.g. ['lesson-learned', 'architecture'])." },
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
      type: "object" as const,
      properties: { listAll: { type: "boolean", description: "If true, list ALL banks on the server instead of just this project's banks." } },
    },
  },
];

// ---------- Tool handlers ----------

const handleSearch = async (
  args: Record<string, unknown>,
  resolved: Resolved,
  startedAt: number,
): Promise<string> => {
  const input = SearchInput.parse(args);
  const bank = input.bank ? asBankId(input.bank) : resolved.bankId;
  const result = await recall(resolved.config.baseUrl, resolved.config.apiKey, bank, input.query, {
    types: input.types ?? resolved.config.recallTypes,
    budget: input.budget ?? resolved.config.searchBudget,
  });
  const status = formatHindsightStatus({
    bankId: bank, action: "recall", mode: "sync", result: "success", durationMs: Date.now() - startedAt, count: result.items.length,
  });
  return `${status}\n${formatRecallResults(result, resolved.config.toolPreviewLength)}`;
};

const handleContext = async (
  args: Record<string, unknown>,
  resolved: Resolved,
  startedAt: number,
): Promise<string> => {
  const input = ContextInput.parse(args);
  const bank = input.bank ? asBankId(input.bank) : resolved.bankId;
  const reflectOpts: { budget: "low" | "mid" | "high"; context?: string } = {
    budget: input.budget ?? resolved.config.reflectBudget,
  };
  if (input.context !== undefined) reflectOpts.context = input.context;
  const result = await reflect(resolved.config.baseUrl, resolved.config.apiKey, bank, input.query, reflectOpts);
  const status = formatHindsightStatus({ bankId: bank, action: "reflect", mode: "sync", result: "success", durationMs: Date.now() - startedAt });
  return `${status}\n${formatReflectResult(result)}`;
};

const handleRetain = async (
  args: Record<string, unknown>,
  resolved: Resolved,
  startedAt: number,
): Promise<string> => {
  const input = RetainInput.parse(args);
  const bank = input.bank ? asBankId(input.bank) : resolved.bankId;
  const retainOpts: { tags?: string[]; context?: string } = {};
  if (input.context !== undefined) retainOpts.context = input.context;
  if (input.tags !== undefined) retainOpts.tags = input.tags;
  const result = await retain(resolved.config.baseUrl, resolved.config.apiKey, bank, input.content, retainOpts);
  const status = formatHindsightStatus({ bankId: bank, action: "retain", mode: "async", result: "success", durationMs: Date.now() - startedAt });
  return `${status} ${formatRetainResult(result)}`;
};

const handleBanks = async (args: Record<string, unknown>, resolved: Resolved): Promise<string> => {
  const input = BanksInput.parse(args);
  if (input.listAll) {
    const banks = await listBanks(resolved.config.baseUrl, resolved.config.apiKey);
    const lines = banks.slice(0, 100).map((b) => `  ${b.bank_id}: ${String(b.fact_count ?? 0)} facts`);
    return `Hindsight banks (${String(banks.length)} total):\n${lines.join("\n")}`;
  }
  const ids = [resolved.bankId, resolved.globalBankId].filter((v): v is BankId => v !== undefined);
  const unique = [...new Set(ids)];
  const sections: string[] = [];
  for (const id of unique) {
    const profile = await getBankProfile(resolved.config.baseUrl, resolved.config.apiKey, id).catch(() => null);
    const [tags, entities] = await Promise.all([
      fetchTopTags(resolved.config.baseUrl, resolved.config.apiKey, id, 10),
      fetchTopEntities(resolved.config.baseUrl, resolved.config.apiKey, id, 10),
    ]);
    const label = id === resolved.bankId ? resolved.config.workspace : `${resolved.config.workspace}:global`;
    const lines = [`[${label}] bank=${id} facts=${String(profile?.fact_count ?? "?")}`];
    if (tags.length) lines.push(`  Tags: ${tags.slice(0, 8).map((t) => `${t.tag}(${String(t.count ?? 0)})`).join(", ")}`);
    if (entities.length) lines.push(`  Entities: ${entities.slice(0, 8).map((e) => `${e.canonical_name ?? e.name ?? "?"}(${String(e.mention_count ?? e.count ?? 0)})`).join(", ")}`);
    sections.push(lines.join("\n"));
  }
  return `Connected Hindsight banks:\n${sections.join("\n\n")}`;
};

const HANDLERS: Record<string, (args: Record<string, unknown>, resolved: Resolved, startedAt: number) => Promise<string>> = {
  hindsight_search: handleSearch,
  hindsight_context: handleContext,
  hindsight_retain: handleRetain,
  // Banks ignores startedAt.
  hindsight_banks: async (args, resolved) => handleBanks(args, resolved),
};

const handleTool = async (name: string, args: Record<string, unknown>, cwd: string): Promise<string> => {
  const startedAt = Date.now();
  const resolved = await getResolved(cwd);
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args, resolved, startedAt);
};

// ---------- JSON-RPC stdio transport ----------

const log = (level: string, msg: string): void => {
  process.stderr.write(`[${SERVER_NAME}] ${level}: ${msg}\n`);
};

const sendResult = (id: unknown, result: unknown): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const sendError = (id: unknown, code: number, message: string): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
};

interface JsonRpcMessage {
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const handleMessage = async (msg: JsonRpcMessage): Promise<void> => {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    if (method === "initialized" || method === "notifications/initialized") return;
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
      if (typeof name !== "string") {
        sendResult(id, { content: [{ type: "text", text: "Error: missing tool name" }], isError: true });
        return;
      }
      const args = params?.arguments ?? {};
      const cwd = process.env.ZCODE_PROJECT_DIR ?? process.env.CWD ?? process.cwd();
      try {
        const text = await handleTool(name, args, cwd);
        sendResult(id, { content: [{ type: "text", text }], isError: false });
      } catch (toolErr) {
        const message = toolErr instanceof Error ? toolErr.message : String(toolErr);
        log("error", `tool ${name} failed: ${message}`);
        sendResult(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
      return;
    }
    if (id !== undefined) sendError(id, -32601, `Method not found: ${method ?? "(none)"}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `handleMessage ${method ?? "(none)"}: ${message}`);
    if (id !== undefined) sendError(id, -32603, `Internal error: ${message}`);
  }
};

const main = (): void => {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
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

main();

export { handleTool, HANDLERS, TOOLS, SERVER_NAME, SERVER_VERSION };
export type { ToolResult };
