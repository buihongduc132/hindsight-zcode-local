/**
 * Content sanitization for retain payloads.
 *
 * Direct port of the sanitization logic in hindsight-pi-local's upload.ts:
 *   - sanitizeCredentials: strip API keys / Bearer tokens / passwords before
 *     anything reaches the hindsight bank (security).
 *   - STRIP_PATTERNS: remove plugin injections, reasoning blocks, large base64
 *     blobs (quality — keeps the bank free of noise).
 *   - isPluginInjection / BUILTIN_INJECTION_PATTERNS: drop boilerplate
 *     continuation prompts that plugins inject via sendUserMessage().
 *
 * Without this layer, the bank fills up with `<untrusted_objective>` markers,
 * `Budget:` runtime scaffolding, todo-enforcer continuations, and (worse) live
 * API keys. That contamination is what produced the malformed worktree-feedback
 * memory observed in zcode-configuration.
 */

const REDACT_PLACEHOLDER = "<REDACTED>";

/** Patterns that strip non-memory content from a retain payload. */
const STRIP_PATTERNS: RegExp[] = [
  // pi-style persistent-memory blocks
  /\[Persistent memory\][\s\S]*?(?=\n\[[a-z]+\]|$)/g,
  // reasoning/thinking tags (Anthropic + generic)
  /<(?:antThinking|thinking|reasoning)>[\s\S]*?<\/(?:antThinking|thinking|reasoning)>/g,
  // large base64 blobs (data URIs over 100 chars)
  /data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g,
  // zcode goal/runtime scaffolding that leaks into retain payloads
  /<\/?untrusted_objective>/g,
  /^Budget:[\s\S]*?(?=\n[A-Z][\w-]*:|\n---|\n##|# Hindsight|$)/gm,
];

/** Patterns that match live secrets. */
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?([^\s'"`,;}{]{8,})['"]?/gi,
  /\bsk-[A-Za-z0-9-]{20,}\b/g,
  /\bhch-v\d+-[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
];

/** Redact secrets in a text blob. Returns text with secrets replaced. */
export const sanitizeCredentials = (text: string): string => {
  let result = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, REDACT_PLACEHOLDER);
  }
  return result;
};

/** Strip plugin injections / reasoning / base64 / runtime scaffolding. */
export const stripNonMemoryContent = (text: string): string => {
  let result = text;
  for (const re of STRIP_PATTERNS) {
    re.lastIndex = 0;
    result = result.replace(re, "");
  }
  return result;
};

/** Full pipeline: strip then redact. Apply before retaining any content. */
export const sanitizeForRetain = (text: string): string =>
  sanitizeCredentials(stripNonMemoryContent(text));

/** Built-in patterns for known plugin injections (todo-enforcer templates). */
const BUILTIN_INJECTION_PATTERNS: RegExp[] = [
  /^You have incomplete tasks\. Continue working on them\./,
  /^Pick up where you left off\./,
];

/** Default custom message types to exclude from retain summaries. */
const DEFAULT_EXCLUDE_CUSTOM_TYPES = new Set(["todo-enforcer"]);

/**
 * Check if a message is a plugin-injected boilerplate (should never be retained).
 * Mirrors pi's isPluginInjection() in upload.ts.
 */
export const isPluginInjection = (
  message: { role?: string; content?: unknown; customType?: string },
  extraPatterns: RegExp[] = [],
  excludeCustomTypes: Set<string> = DEFAULT_EXCLUDE_CUSTOM_TYPES,
): boolean => {
  if (
    excludeCustomTypes.size > 0 &&
    message.customType &&
    excludeCustomTypes.has(message.customType)
  ) {
    return true;
  }
  if (message.role !== "user") return false;
  const text = extractText(message.content).substring(0, 200);
  for (const re of BUILTIN_INJECTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  for (const re of extraPatterns) {
    if (re.test(text)) return true;
  }
  return false;
};

/** Extract visible text from a message content (string or content-block array). */
export const extractText = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (
        entry &&
        typeof entry === "object" &&
        "type" in entry &&
        "text" in entry
      ) {
        const block = entry as { type?: string; text?: string };
        if (block.type === "text" && typeof block.text === "string") {
          return [block.text];
        }
      }
      return [] as string[];
    })
    .join("\n")
    .trim();
};
