/**
 * Core domain types for hindsight-zcode-local.
 *
 * Design goals:
 *  - Make the silent-drop bug class structurally impossible. The recall endpoint
 *    returns {results:[...]}; older shapes used {memories|items}. All three are
 *    expressed via a single zod schema with a `.transform()` that normalizes to a
 *    canonical `items` array, so consumers can never read the wrong field.
 *  - Branded primitives (BankId, ApiKey) so raw strings can't be passed where a
 *    validated identifier is required.
 *  - Discriminated unions for hook payloads (parse, don't assume).
 */

import { z } from "zod";

// ---------- Branded primitives ----------

declare const __brand: unique symbol;
/** Nominal branding helper — zero runtime cost, compile-time only. */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** A sanitized bank identifier: [a-z0-9_-]{1,120}. */
export type BankId = Brand<string, "BankId">;
/** An opaque API key. */
export type ApiKey = Brand<string, "ApiKey">;
/** A resolved absolute directory path. */
export type AbsolutePath = Brand<string, "AbsolutePath">;

const BANK_ID_PATTERN = /^[a-z0-9_-]{1,120}$/;

/** Runtime guard + brand constructor for BankId. Throws on malformed input. */
export const asBankId = (value: string): BankId => {
  if (!BANK_ID_PATTERN.test(value)) {
    throw new Error(
      `Invalid bank id ${JSON.stringify(value)}: must match ${BANK_ID_PATTERN.source}`,
    );
  }
  return value as BankId;
};

/** Runtime guard + brand constructor for ApiKey. */
export const asApiKey = (value: string): ApiKey => {
  if (!value || value.trim().length === 0) {
    throw new Error("API key must be a non-empty string");
  }
  return value as ApiKey;
};

/** Coerce a string to an absolute path or throw. */
export const asAbsolutePath = (value: string): AbsolutePath => {
  if (!value.startsWith("/")) {
    throw new Error(`Expected an absolute path, got ${JSON.stringify(value)}`);
  }
  return value as AbsolutePath;
};

// ---------- Enums (string-literal unions) ----------

export const BankStrategySchema = z.enum([
  "per-directory",
  "git-branch",
  "pi-session",
  "per-repo",
  "global",
  "manual",
]);
export type BankStrategy = z.infer<typeof BankStrategySchema>;

export const SearchBudgetSchema = z.enum(["low", "mid", "high"]);
export type SearchBudget = z.infer<typeof SearchBudgetSchema>;

export const RecallTypeSchema = z.enum(["world", "experience", "observation"]);
export type RecallType = z.infer<typeof RecallTypeSchema>;

export const RecallModeSchema = z.enum(["hybrid", "context", "tools", "off"]);
export type RecallMode = z.infer<typeof RecallModeSchema>;

export const InjectionFrequencySchema = z.enum(["every-turn", "first-turn"]);
export type InjectionFrequency = z.infer<typeof InjectionFrequencySchema>;

export const RetainModeSchema = z.enum(["response", "step-batch", "both", "off"]);
export type RetainMode = z.infer<typeof RetainModeSchema>;

// ---------- Hindsight API response schemas ----------
//
// The server's recall endpoint returns {results:[...]}. An older shape used
// {memories|items}. Normalizing all three into `items` via .transform() means
// every consumer reads ONE field — the field-name bug class is eliminated.

const MemoryItemSchema = z
  .object({
    type: z.string().optional(),
    content: z.string().optional(),
    text: z.string().optional(),
    score: z.number().optional(),
    tags: z.array(z.string()).optional(),
    createdAt: z.union([z.string(), z.number(), z.date()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/** Extract a display text from an item that may use any of several field names. */
export const itemText = (item: z.infer<typeof MemoryItemSchema>): string =>
  item.content ?? item.text ?? JSON.stringify(item);

/** Canonical normalized recall result: always an `items` array. */
export interface NormalizedRecallResult {
  readonly items: z.infer<typeof MemoryItemSchema>[];
  readonly raw: unknown;
}

/**
 * Parse a recall response into the canonical NormalizedRecallResult.
 * Accepts {results}, {memories}, or {items} shapes; throws ZodError on garbage.
 * This single chokepoint replaces the three ad-hoc `Array.isArray(result?.X)`
 * branches that caused the silent-drop bug.
 */
export const parseRecallResponse = (value: unknown): NormalizedRecallResult => {
  const parsed = z
    .object({
      results: z.array(MemoryItemSchema).optional(),
      memories: z.array(MemoryItemSchema).optional(),
      items: z.array(MemoryItemSchema).optional(),
    })
    .passthrough()
    .parse(value);
  const items = parsed.results ?? parsed.memories ?? parsed.items ?? [];
  return { items, raw: parsed };
};

/** Convenience schema wrapper for use in pipelines. */
export const RecallResponseSchema = z
  .object({
    results: z.array(MemoryItemSchema).optional(),
    memories: z.array(MemoryItemSchema).optional(),
    items: z.array(MemoryItemSchema).optional(),
  })
  .passthrough()
  .transform(parseRecallResponse);

export const ReflectResponseSchema = z
  .object({
    answer: z.string().optional(),
    result: z.string().optional(),
    summary: z.string().optional(),
    output: z.string().optional(),
    context: z.string().optional(),
    items: z.array(MemoryItemSchema).optional(),
    memories: z.array(MemoryItemSchema).optional(),
  })
  .passthrough()
  .transform((parsed): { answer: string; items: z.infer<typeof MemoryItemSchema>[] } => {
    const answer = parsed.answer ?? parsed.result ?? parsed.summary ?? parsed.output ?? parsed.context ?? "";
    const items = parsed.items ?? parsed.memories ?? [];
    return { answer, items };
  });

export const RetainResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    success: z.boolean().optional(),
    status: z.string().optional(),
    bankId: z.string().optional(),
    fact_count: z.number().optional(),
  })
  .passthrough();

export const BankListItemSchema = z
  .object({
    bank_id: z.string(),
    fact_count: z.number().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const BankListResponseSchema = z
  .object({
    banks: z.array(BankListItemSchema).optional(),
    items: z.array(BankListItemSchema).optional(),
  })
  .passthrough()
  .transform((parsed) => parsed.banks ?? parsed.items ?? []);

export const BankProfileSchema = z
  .object({
    fact_count: z.number().optional(),
    bank_id: z.string().optional(),
    name: z.string().optional(),
    memory_count: z.number().optional(),
  })
  .passthrough();

export const TagStatSchema = z
  .object({ tag: z.string(), count: z.number().optional() })
  .passthrough();

export const EntityStatSchema = z
  .object({
    canonical_name: z.string().optional(),
    name: z.string().optional(),
    mention_count: z.number().optional(),
    count: z.number().optional(),
  })
  .passthrough();

// ---------- Hook payloads (discriminated by hookEventName) ----------

export const HookEventNameSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
]);
// Note: zcode.cjs only dispatches these 7 hook events to plugins (verified
// against the runtime binary). SessionEnd / SessionShutdown / SessionSwitch
// are NOT exposed — see hooks/session-start.ts for the implications.

/** The shape ZCode pipes to a hook process on stdin. */
const BaseHookPayloadSchema = z.object({
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  hookEventName: HookEventNameSchema.optional(),
  mode: z.string().optional(),
});

export const UserPromptSubmitPayloadSchema = BaseHookPayloadSchema.extend({
  prompt: z.string().optional(),
}).passthrough();
export type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmitPayloadSchema>;

export const StopPayloadSchema = BaseHookPayloadSchema.extend({
  responsePreview: z.string().optional(),
  toolCallCount: z.number().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  agentName: z.string().optional(),
}).passthrough();
export type StopPayload = z.infer<typeof StopPayloadSchema>;

/** The JSON a hook prints on stdout. additionalContext is consumed by ZCode. */
export const HookOutputSchema = z
  .object({
    hookEventName: HookEventNameSchema.optional(),
    additionalContext: z.string().optional(),
    additional_context: z.string().optional(),
    continue: z.boolean().optional(),
    reason: z.string().optional(),
    suppressOutput: z.boolean().optional(),
    systemMessage: z.string().optional(),
  })
  .passthrough();
export type HookOutput = z.infer<typeof HookOutputSchema>;

// ---------- Resolved config ----------

export interface RetryQueueConfig {
  readonly enabled: boolean;
  readonly maxSizeBytes: number;
  readonly maxRetries: number;
  readonly maxAgeHours: number;
}

export interface HindsightConfig {
  readonly enabled: boolean;
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly bankId: string | undefined;
  readonly globalBankId: string | undefined;
  readonly bankStrategy: BankStrategy;
  readonly workspace: string;
  readonly peerName: string;
  readonly aiPeer: string;
  readonly recallTypes: RecallType[];
  readonly recallPerType: number;
  readonly autoCreateBank: boolean;
  readonly searchBudget: SearchBudget;
  readonly reflectBudget: SearchBudget;
  readonly toolPreviewLength: number;
  readonly maxMessageLength: number;
  readonly logging: boolean;
  readonly mappings: Record<string, string>;
  // Per-turn auto-recall knobs (mirror pi's hindsight-pi-local).
  readonly recallMode: RecallMode;
  readonly injectionFrequency: InjectionFrequency;
  readonly contextTokens: number;
  readonly retainMode: RetainMode;
  readonly retainTags: string[];
  // Retain pipeline knobs (parity with pi's WriteScheduler / upload.ts).
  readonly retainAsync: boolean;
  readonly retainTimeoutMs: number;
  readonly stepRetainThreshold: number;
  readonly writeFrequency: "async" | "session" | number;
  readonly saveMessages: boolean;
  readonly retryQueue: RetryQueueConfig;
  // Recall synthesis knobs (parity with pi's tools.ts dynamicBudget).
  readonly reasoningLevel: "low" | "medium" | "high";
  readonly reasoningLevelCap: "low" | "medium" | "high" | null;
  readonly dialecticDynamic: boolean;
  // Show UI status indicators (parity with pi's indicatorsInContext).
  readonly showRecallIndicator: boolean;
  readonly showRetainIndicator: boolean;
}

// ---------- MCP tool call types ----------

export interface ToolCallParams {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly cwd: string;
}

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError: boolean;
}
