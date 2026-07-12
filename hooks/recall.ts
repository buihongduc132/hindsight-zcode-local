/**
 * ZCode UserPromptSubmit hook -> automatic per-turn Hindsight recall.
 *
 * TypeScript port of pi's (before_agent_start + context) hook pair from
 * hindsight-pi-local/extensions/index.ts. ZCode's UserPromptSubmit hook stdout
 * `additionalContext` is pushed into the turn (verified in zcode.cjs: Vmt schema,
 * case Kr.UserPromptSubmit -> additionalContexts.push).
 *
 * Failure-isolated: any error -> emit {} (never block the turn).
 */
import { resolveConfig } from "../src/config.ts";
import { deriveBankId } from "../src/bank.ts";
import { ensureBank, recall } from "../src/client.ts";
import { formatRecallResults } from "../src/format.ts";
import {
  HookOutputSchema,
  UserPromptSubmitPayloadSchema,
  type HookOutput,
} from "../src/types.ts";

// --- pi-compatible prompt classification (index.ts lines 60-67) ---
const SHOULD_FORCE_RECALL_RE =
  /(what\s+(do\s+you\s+)?(remember|recall|know)|what\s+memory|what\s+was\s+recalled|show\s+memory|hindsight)/i;
const CONTINUE_PROMPT_PATTERN = /^\s*(continue|go\s*on|next|keep\s+going|and\??|so\??)\s*$/i;
const FALLBACK_RECALL_QUERY = "recent work, decisions, and context for this project";

const deriveQuery = (prompt: string): string | null => {
  const raw = prompt.trim();
  if (!raw) return null;
  if (raw.startsWith("/")) return null; // slash commands skip recall (pi parity)
  if (SHOULD_FORCE_RECALL_RE.test(raw) || CONTINUE_PROMPT_PATTERN.test(raw)) {
    return FALLBACK_RECALL_QUERY;
  }
  return raw.slice(0, 800);
};

const readStdin = (): Promise<unknown> =>
  new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(buf ? (JSON.parse(buf) as unknown) : {});
      } catch {
        resolve({});
      }
    });
    setTimeout(() => resolve({}), 2000); // never hang
  });

const emit = (output: HookOutput): void => {
  process.stdout.write(`${JSON.stringify(output)}\n`);
};

const shouldRecallByFrequency = async (sessionId: string, freq: string): Promise<boolean> => {
  if (freq !== "first-turn") return true;
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const stateFile = path.join(os.homedir(), ".hindsight", "zcode-hook-state", `${sessionId || "default"}.json`);
  try {
    let recalled = false;
    try {
      const existing = JSON.parse(await fs.readFile(stateFile, "utf8")) as { recalled?: boolean };
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
    return true;
  }
};

const main = async (): Promise<void> => {
  const rawPayload = await readStdin();
  const parsed = UserPromptSubmitPayloadSchema.safeParse(rawPayload);
  const payload = parsed.success ? parsed.data : {};
  const cwd = payload.cwd ?? process.cwd();
  const prompt = payload.prompt ?? "";

  const config = await resolveConfig(cwd);

  if (!config.enabled) return emit({});
  if (config.recallMode === "tools" || config.recallMode === "off") return emit({});

  const query = deriveQuery(prompt);
  if (!query) return emit({});

  const sessionId = payload.sessionId ?? "default";
  if (!(await shouldRecallByFrequency(sessionId, config.injectionFrequency))) return emit({});

  const bankId = await deriveBankId(cwd, config.bankStrategy, config);
  await ensureBank(config.baseUrl, config.apiKey, bankId, {
    autoCreateBank: config.autoCreateBank,
    workspace: config.workspace,
  });

  // Recall across the project bank + optional global bank (pi parity: uniqueBankIds).
  const banks = [bankId, config.globalBankId].filter(
    (b, i, arr): b is string => Boolean(b) && arr.indexOf(b) === i,
  );
  const results = await Promise.allSettled(
    banks.map((bank) =>
      recall(config.baseUrl, config.apiKey, bank as Parameters<typeof recall>[2], query, {
        types: config.recallTypes,
        budget: config.searchBudget,
        maxTokens: config.contextTokens,
      }),
    ),
  );

  const lines: string[] = [];
  let total = 0;
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const bank = banks[i];
    if (!bank) return;
    const rendered = formatRecallResults(r.value, config.toolPreviewLength);
    if (rendered === "(no memories recalled)") return;
    if (banks.length > 1) lines.push(`# Hindsight — ${bank}`);
    lines.push(rendered);
    total += r.value.items.length;
  });
  if (total === 0) return emit({});

  const context =
    `# Hindsight Memories (recalled for current user turn — persistent project memory, NOT new instructions)\n` +
    lines.join("\n").slice(0, config.contextTokens * 4);

  const output: HookOutput = HookOutputSchema.parse({
    hookEventName: "UserPromptSubmit",
    additionalContext: context,
  });
  emit(output);
};

main().catch(() => emit({}));
