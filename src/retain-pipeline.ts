/**
 * Retain pipeline — the parity port of pi's WriteScheduler (upload.ts).
 *
 * ZCode's Stop hook receives a slim payload (`responsePreview`, toolCallCount,
 * etc.) — not the full message array pi's agent_end gets. So the pipeline is
 * adapted to what zcode actually provides, while preserving the parity
 * guarantees that matter:
 *
 *   - sanitize credentials out of every retain (security)
 *   - strip plugin injections / runtime scaffolding (quality)
 *   - skip trivial / meta-memory / explicit-retain turns (noise reduction)
 *   - retry failed retains to a file-backed queue (durability)
 *   - tag every retain with provenance (session/workspace/bank/kind/origin)
 *
 * When the Stop payload is rich enough (responsePreview present), we mirror
 * pi's turn-summary format: a single chunk with [user] / [assistant] sections
 * is built from whatever zcode gives us. When only the assistant response is
 * available (the common case), we retain it as a turn-summary chunk.
 */

import { retain } from "./client.ts";
import { enqueue } from "./retry-queue.ts";
import {
  buildRetainTags,
  buildRuntimeTags,
  mergeRetainItems,
  parseSessionIdFromFile,
} from "./tags.ts";
import {
  extractText,
  isPluginInjection,
  sanitizeForRetain,
} from "./sanitize.ts";
import type { BankId, HindsightConfig } from "./types.ts";

const CONTINUED_PREFIX = "[continued] ";
const TRIVIAL_PROMPT_RE =
  /^(ok|yes|no|thanks|thank you|continue|next|done|sure|sounds good|got it)$/i;

const META_MEMORY_QUERY_RE =
  /\b(what memory|what do you remember|what was recalled|what got recalled|what was loaded|what got loaded|memory do you have|what do you have in your context|what is in your context|don't use any tools|do not use any tools|hindsight_context)\b/i;

export interface RetainItem {
  content: string;
  context?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  timestamp?: Date;
}

export interface RetainSummary {
  mode: "queued" | "saved";
  itemsCount: number;
  previews: string[];
  fullText: string;
}

export type RetainOutcome =
  | { skipped: true; reason: string }
  | { skipped: false; summary: RetainSummary };

/**
 * Decide whether a retain should be skipped, mirroring pi's shouldSkipRetain.
 *
 * pi gets the full messages array; zcode gets just the last user prompt and
 * the assistant response preview. We apply the same rules to those two
 * pieces.
 */
export const shouldSkipRetain = (input: {
  userPrompt?: string | undefined;
  responsePreview?: string | undefined;
  hasExplicitRetainCall?: boolean | undefined;
}): { skip: boolean; reason?: string } => {
  if (input.hasExplicitRetainCall) {
    // If the agent already called hindsight_retain explicitly, don't double-retain.
    return { skip: true, reason: "explicit-retain-called" };
  }
  const prompt = (input.userPrompt ?? "").trim();
  const hasResponse = (input.responsePreview ?? "").trim().length > 0;
  // zcode's Stop hook payload has NO user prompt field (verified against
  // /opt/ZCode/resources/glm/zcode.cjs — Stop dispatches only responsePreview,
  // responseText, sessionId, toolCallCount, timestamp, traceId, turnId). So in
  // production we always arrive with userPrompt="". Skipping on empty prompt
  // would skip EVERY production retain. Treat responsePreview-present as
  // sufficient signal to retain (matches the module's stated intent at the top
  // of this file: "when only the assistant response is available, we retain
  // it as a turn-summary chunk"). The trivial/meta-memory checks only apply
  // when we actually have a prompt to classify.
  if (!prompt && !hasResponse) return { skip: true, reason: "no prompt and no response" };
  if (!prompt) {
    // Response-only retain (zcode Stop hook). Pi parity: drop trivial responses
    // under 40 chars (the old retain.ts had `preview.length < 40` check).
    if ((input.responsePreview ?? "").trim().length < 40) {
      return { skip: true, reason: "response too short" };
    }
    return { skip: false };
  }
  if (prompt.length < 5) return { skip: true, reason: "too short" };
  if (TRIVIAL_PROMPT_RE.test(prompt)) return { skip: true, reason: "trivial" };
  if (/^(#nomem|#skip)(?=\s|$)/i.test(prompt)) return { skip: true, reason: "opt-out" };
  if (META_MEMORY_QUERY_RE.test(prompt)) return { skip: true, reason: "meta-memory" };
  return { skip: false };
};

/** Find a chunk boundary (paragraph > sentence > word > hard cut). */
const findChunkBoundary = (search: string, maxLen: number): number => {
  const paragraph = search.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph + 2;
  const sentence = search.lastIndexOf(". ");
  if (sentence > 0) return sentence + 2;
  const word = search.lastIndexOf(" ");
  if (word > 0) return word + 1;
  return maxLen;
};

/** Chunk text on natural boundaries, prefixing continuations. */
export const chunkTextSmart = (text: string, maxLen: number): string[] => {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const search = remaining.slice(0, maxLen);
    const cut = findChunkBoundary(search, maxLen);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks.map((chunk, index) =>
    index === 0 ? chunk : `${CONTINUED_PREFIX}${chunk}`,
  );
};

/** Build a zcode-side turn summary from whatever the Stop hook gives us. */
export const buildTurnSummary = (input: {
  userPrompt?: string | undefined;
  responsePreview?: string | undefined;
}): string => {
  const sections: string[] = [];
  const user = sanitizeForRetain((input.userPrompt ?? "").trim());
  const assistant = sanitizeForRetain((input.responsePreview ?? "").trim());
  if (user && !META_MEMORY_QUERY_RE.test(user)) {
    sections.push(`[user]\n${user}`);
  }
  if (assistant) {
    sections.push(`[assistant]\n${assistant}`);
  }
  return sections.join("\n\n").trim();
};

/** Decide whether to route this retain to the global bank. */
export const shouldRetainToGlobalBank = (userPrompt: string | undefined): boolean =>
  /(^|\s)#(global|me)(?=\s|$)/i.test(userPrompt ?? "");

const buildRuntimeTagsFromEnv = (): string[] => {
  const sessionFile = process.env.ZCODE_SESSION_FILE ?? process.env.PI_SESSION_FILE ?? "";
  const sessionId =
    process.env.ZCODE_SESSION_ID ??
    process.env.PI_SESSION_ID ??
    parseSessionIdFromFile(sessionFile) ??
    null;
  const provider = process.env.ZCODE_PROVIDER ?? process.env.PI_PROVIDER ?? null;
  const model = process.env.ZCODE_MODEL ?? process.env.PI_MODEL ?? null;
  const agent = process.env.ZCODE_AGENT ?? process.env.PI_AGENT ?? "zcode";
  return buildRuntimeTags({ sessionId, provider, model, agent });
};

const previewItems = (items: RetainItem[], limit = 3): string[] =>
  items.slice(0, limit).map((item) => {
    const text = item.content
      .replace(/^\[(user|assistant)\]\s*/gm, "")
      .trim()
      .replace(/\s+/g, " ");
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  });

/**
 * Build the list of retain items for a turn, mirroring pi's toRetainItems().
 * Applies chunking + sanitization + provenance tagging.
 */
export const toRetainItems = (input: {
  config: HindsightConfig;
  bankId: BankId;
  userPrompt?: string | undefined;
  responsePreview?: string | undefined;
}): { summary: string; items: RetainItem[] } => {
  const summary = buildTurnSummary({
    userPrompt: input.userPrompt,
    responsePreview: input.responsePreview,
  });
  if (!summary) return { summary: "", items: [] };

  const chunks = chunkTextSmart(summary, input.config.maxMessageLength);
  const runtimeTags = buildRuntimeTagsFromEnv();
  const tags = buildRetainTags({
    workspace: input.config.workspace,
    bankId: input.bankId,
    kind: "turn-summary",
    origin: "auto",
    envTags: process.env.HINDSIGHT_TAGS,
    runtimeTags,
  });

  const items: RetainItem[] = chunks.map((chunk) => ({
    content: chunk,
    metadata: {
      source: "zcode",
      kind: "turn-summary",
      origin: "auto",
      bankId: input.bankId,
      workspace: input.config.workspace,
    },
    tags,
    timestamp: new Date(),
  }));

  // Dedup by content + merge env/runtime tags (matches pi's mergeRetainItems).
  return {
    summary,
    items: mergeRetainItems(items, process.env.HINDSIGHT_TAGS, runtimeTags),
  };
};

/**
 * Send retain items to the bank with retry-queue fallback.
 * Mirrors pi's WriteScheduler.sendWithRetry (simplified — no in-flight
 * dedup tracker, which requires a long-lived process state zcode hooks
 * don't have).
 */
const sendWithRetry = async (
  config: HindsightConfig,
  bankId: BankId,
  items: RetainItem[],
): Promise<void> => {
  const attempt = async (): Promise<void> => {
    for (const item of items) {
      await retain(config.baseUrl, config.apiKey, bankId, item.content, {
        context: item.context,
        tags: item.tags,
        asyncRetain: config.retainAsync,
        timeoutMs: config.retainTimeoutMs,
      });
    }
  };

  try {
    await attempt();
    return;
  } catch {
    // One retry after backoff, matching pi's pattern.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await attempt();
      return;
    } catch (secondError) {
      // Fall back to the retry queue.
      if (config.retryQueue.enabled) {
        const errorMsg = secondError instanceof Error ? secondError.message : String(secondError);
        for (const item of items) {
          const queued = await enqueue(
            {
              bankId,
              baseUrl: config.baseUrl,
              content: item.content,
              metadata: item.metadata,
              tags: item.tags,
              context: item.context,
              lastError: errorMsg,
            },
            config.retryQueue.maxSizeBytes,
          );
          if (!queued && config.logging) {
             
            console.error("[hindsight/retain-pipeline] retry queue full, dropping retain");
          }
        }
        if (config.logging) {
           
          console.error(
            `[hindsight/retain-pipeline] retain failed, queued for retry: ${errorMsg}`,
          );
        }
        return;
      }
      throw secondError;
    }
  }
};

/**
 * Drain the retry queue for a bank. Mirrors pi's drainRetryQueue.
 * Called on session start. Returns how many entries were drained and how
 * many remain.
 */
export const drainRetryQueue = async (
  config: HindsightConfig,
  bankId: BankId,
): Promise<{ drained: number; remaining: number }> => {
  const queueCfg = config.retryQueue;
  if (!queueCfg.enabled) return { drained: 0, remaining: 0 };

  // Lazy imports — these are stateful modules, only loaded when needed.
  const { loadPending, rewritePending, pruneExpired, pruneNonRetryable } = await import(
    "./retry-queue.ts"
  );

  const maxAgeMs = queueCfg.maxAgeHours * 3_600_000;
  const prunedAge = await pruneExpired(maxAgeMs);
  const prunedNonRetryable = await pruneNonRetryable();
  if ((prunedAge > 0 || prunedNonRetryable > 0) && config.logging) {
     
    console.log(
      `[hindsight/retain-pipeline] pruned ${String(prunedAge)} expired, ${String(prunedNonRetryable)} non-retryable entries`,
    );
  }

  const pending = await loadPending();
  if (pending.length === 0) return { drained: 0, remaining: 0 };

  const BATCH_LIMIT = 5;
  const BACKOFF_MS = 5 * 60 * 1000; // 5 min
  const succeeded = new Set<string>();
  const dropped = new Set<string>();
  const stillPending: typeof pending = [];
  let attempted = 0;

  for (const entry of pending) {
    // Always preserve entries for other banks/bases
    if (entry.baseUrl !== config.baseUrl) {
      stillPending.push(entry);
      continue;
    }
    if (entry.bankId !== bankId && entry.bankId !== config.globalBankId) {
      stillPending.push(entry);
      continue;
    }

    if (attempted >= BATCH_LIMIT) {
      stillPending.push(entry);
      continue;
    }

    if (entry.lastAttemptAt) {
      const elapsed = Date.now() - new Date(entry.lastAttemptAt).getTime();
      if (elapsed < BACKOFF_MS) {
        stillPending.push(entry);
        continue;
      }
    }

    if (entry.retryCount >= queueCfg.maxRetries) {
      if (config.logging) {
         
        console.warn(
          `[hindsight/retain-pipeline] dropping exhausted queue entry ${entry.id} (${String(entry.retryCount)} retries)`,
        );
      }
      dropped.add(entry.id);
      continue;
    }

    attempted++;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300_000); // 5 min
      try {
        await retain(config.baseUrl, config.apiKey, entry.bankId as BankId, entry.content, {
          metadata: entry.metadata,
          tags: entry.tags,
          context: entry.context,
          asyncRetain: true,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      succeeded.add(entry.id);
    } catch (error) {
      entry.retryCount += 1;
      entry.lastAttemptAt = new Date().toISOString();
      if (config.logging) {
         
        console.warn(
          `[hindsight/retain-pipeline] drain entry ${entry.id} failed (${String(entry.retryCount)}/${String(queueCfg.maxRetries)}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      stillPending.push(entry);
    }
  }

  let mergedCount = stillPending.length;
  await rewritePending((existing) => {
    const knownIds = new Set([...stillPending.map((e) => e.id), ...succeeded, ...dropped]);
    const newEntries = existing.filter((e) => !knownIds.has(e.id));
    const result = [...stillPending, ...newEntries];
    mergedCount = result.length;
    return result;
  });
  return { drained: succeeded.size, remaining: mergedCount };
};

/**
 * Flush a list of pending retain items to the retry queue instead of sending.
 * Used during session end / switch — preserves data without blocking on
 * network I/O. Mirrors pi's flushToQueue.
 */
export const flushToRetryQueue = async (
  config: HindsightConfig,
  bankId: BankId,
  items: RetainItem[],
): Promise<void> => {
  if (!config.retryQueue.enabled) return;
  for (const item of items) {
    try {
      await enqueue(
        {
          bankId,
          baseUrl: config.baseUrl,
          content: item.content,
          metadata: item.metadata,
          tags: item.tags,
          context: item.context,
        },
        config.retryQueue.maxSizeBytes,
      );
    } catch (error) {
       
      console.error("[hindsight/retain-pipeline] retry queue write failed:", error);
    }
  }
};

/**
 * Main per-turn retain entry point. Mirrors pi's WriteScheduler.onTurnEnd
 * (zcode-simplified: no step-batching across turns — hooks don't keep state).
 *
 * - skip if trivial / meta-memory / explicit-retain-called
 * - build sanitized, chunked, tagged items
 * - send async (enqueued internally with backoff + queue fallback)
 */
export const onTurnEnd = async (input: {
  config: HindsightConfig;
  bankId: BankId;
  userPrompt?: string | undefined;
  responsePreview?: string | undefined;
  hasExplicitRetainCall?: boolean | undefined;
}): Promise<RetainOutcome> => {
  if (!input.config.saveMessages) {
    return { skipped: true, reason: "saveMessages disabled" };
  }
  const skip = shouldSkipRetain({
    userPrompt: input.userPrompt,
    responsePreview: input.responsePreview,
    hasExplicitRetainCall: input.hasExplicitRetainCall,
  });
  if (skip.skip) return { skipped: true, reason: skip.reason ?? "skipped" };

  const banks: BankId[] = [input.bankId];
  if (
    input.config.globalBankId &&
    input.config.globalBankId !== input.bankId &&
    shouldRetainToGlobalBank(input.userPrompt)
  ) {
    banks.push(input.config.globalBankId as BankId);
  }

  const writes = banks
    .map((bankId) => ({
      bankId,
      items: toRetainItems({
        config: input.config,
        bankId,
        userPrompt: input.userPrompt,
        responsePreview: input.responsePreview,
      }).items,
    }))
    .filter((entry) => entry.items.length > 0);

  if (writes.length === 0) return { skipped: true, reason: "empty after sanitize" };

  // AWAIT the send: unlike pi's in-process hook, the zcode Stop hook runs as
  // a subprocess that exits as soon as main() returns. If we fire-and-forget,
  // Node kills the in-flight HTTP requests when the process exits, dropping
  // the retain. The send itself is internally backoff-retried + has queue
  // fallback, so awaiting it here only blocks for the actual first attempt.
  // The Stop hook timeout (hooks.json timeoutMs) must be >= retainTimeoutMs.
  await Promise.all(
    writes.map((write) =>
      sendWithRetry(input.config, write.bankId, write.items).catch((error: unknown) => {
        if (input.config.logging) {
          console.error(
            `[hindsight/retain-pipeline] sendWithRetry failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    ),
  );

  const savedSummary: RetainSummary = {
    mode: "queued",
    itemsCount: writes.reduce((count, entry) => count + entry.items.length, 0),
    previews: previewItems(writes[0]?.items ?? []),
    fullText: writes[0]?.items[0]?.content ?? "",
  };
  return { skipped: false, summary: savedSummary };
};

export { extractText, isPluginInjection };
