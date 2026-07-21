/**
 * Hindsight config resolution for zcode.
 *
 * Reads EXACTLY the same config sources as the pi plugin (hindsight-pi-local) so
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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  BankStrategySchema,
  InjectionFrequencySchema,
  RecallModeSchema,
  RecallTypeSchema,
  RetainModeSchema,
  SearchBudgetSchema,
  type BankStrategy,
  type HindsightConfig,
  type InjectionFrequency,
  type RecallMode,
  type RecallType,
  type RetainMode,
  type SearchBudget,
} from "./types.ts";

/**
 * Path to the global hindsight config. Lazy so tests can override HOME after
 * module load (CONFIG_PATH used to be captured at import, breaking isolation).
 */
const getConfigPath = (): string => join(homedir(), ".hindsight", "config.json");
export const CONFIG_PATH = getConfigPath(); // kept for backwards compat with existing imports
const GLOBAL_TOML_PATH = (): string => join(homedir(), ".hindsight", "config.toml");
export const LOCAL_CONFIG_PATH = ".hindsight/config.json";
export const DEFAULT_BASE_URL = "http://localhost:8888";

// ---------- Coercion helpers ----------

/**
 * Read an env var, treating empty string as missing.
 *
 * Why this exists: ZCode expands `${user_config.X}` in plugin.json's env
 * block to "" (empty string) when the userConfig value is unset, NOT to
 * undefined. The `??` operator only falls through on null/undefined, so
 * `process.env.HINDSIGHT_BASE_URL ?? fallback` returns "" and skips the
 * fallback — sending every fetch to localhost:8888 (the MCP "fetch failed"
 * bug). Using this helper instead of `??` makes the config-file fallback
 * chain work correctly under ZCode's env-block expansion.
 */
const envString = (value: string | undefined): string | undefined => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : value;
};

/** Coalesce a sequence of maybe-empty values, returning the first non-empty one. */
const firstNonEmpty = (...values: readonly unknown[]): unknown => {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return undefined;
};

/** String-typed coalesce (for fields known to be string-valued). */
const firstNonEmptyStr = (...values: readonly unknown[]): string | undefined => {
  const v = firstNonEmpty(...values);
  return typeof v === "string" ? v : undefined;
};

/** Number/string coalesce for numeric config fields (HostConfig allows both). */
const firstNonEmptyNum = (...values: readonly unknown[]): number | string | undefined => {
  const v = firstNonEmpty(...values);
  if (v === undefined) return undefined;
  return typeof v === "number" || typeof v === "string" ? v : undefined;
};

/** Boolean/string coalesce for boolean config fields. */
const firstNonEmptyBool = (...values: readonly unknown[]): string | boolean | undefined => {
  const v = firstNonEmpty(...values);
  if (v === undefined) return undefined;
  return typeof v === "boolean" || typeof v === "string" ? v : undefined;
};

export const normalizeBaseUrl = (value: string | undefined | null): string => {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, "");
  return `http://${trimmed.replace(/\/$/, "")}`;
};

export const intOr = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return fallback;
};

export const boolOr = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return fallback;
};

export const normalizeRecallTypes = (value: unknown): RecallType[] => {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",").map((entry) => entry.trim())
      : [];
  const normalized = values.filter((entry): entry is RecallType => RecallTypeSchema.safeParse(entry).success);
  return normalized.length > 0 ? [...new Set(normalized)] : ["observation"];
};

export const normalizeBankStrategy = (value: unknown): BankStrategy =>
  BankStrategySchema.catch("per-repo").parse(value);

export const normalizeBudget = (value: unknown, fallback: SearchBudget): SearchBudget =>
  SearchBudgetSchema.catch(fallback).parse(value);

export const normalizeRecallMode = (value: unknown, fallback: RecallMode): RecallMode =>
  RecallModeSchema.catch(fallback).parse(value);

export const normalizeInjectionFrequency = (
  value: unknown,
  fallback: InjectionFrequency,
): InjectionFrequency => InjectionFrequencySchema.catch(fallback).parse(value);

// ---------- Config file reading ----------

interface HostConfig {
  enabled?: string | boolean;
  workspace?: string;
  peerName?: string;
  aiPeer?: string;
  recallTypes?: string | string[];
  recallPerType?: number | string;
  autoCreateBank?: string | boolean;
  searchBudget?: string;
  reflectBudget?: string;
  toolPreviewLength?: number | string;
  maxMessageLength?: number | string;
  logging?: string | boolean;
  recallMode?: string;
  injectionFrequency?: string;
  contextTokens?: number | string;
  retainMode?: string;
  retainTags?: string;
  // Retain pipeline knobs (parity with pi's hindsight-pi-local).
  retainAsync?: string | boolean;
  retainTimeoutMs?: number | string;
  stepRetainThreshold?: number | string;
  writeFrequency?: string;
  saveMessages?: string | boolean;
  retryQueue?: {
    enabled?: string | boolean;
    maxSizeBytes?: number | string;
    maxRetries?: number | string;
    maxAgeHours?: number | string;
  };
  // Recall synthesis knobs.
  reasoningLevel?: string;
  reasoningLevelCap?: string;
  dialecticDynamic?: string | boolean;
  // UI indicator knobs.
  showRecallIndicator?: string | boolean;
  showRetainIndicator?: string | boolean;
  zcode?: HostConfig;
}

interface ConfigFile {
  apiKey?: string;
  api_key?: string;
  baseUrl?: string;
  api_url?: string;
  bankId?: string;
  bank_id?: string;
  globalBankId?: string;
  global_bank?: string;
  bankStrategy?: string;
  recallTypes?: string | string[];
  recall_types?: string | string[];
  recallMode?: string;
  injectionFrequency?: string;
  host?: { pi?: HostConfig };
  mappings?: Record<string, string>;
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";

const readJsonIfPresent = async (filePath: string): Promise<ConfigFile | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch (error) {
    if (!isMissingFileError(error)) console.error("[hindsight/config] readJsonIfPresent failed:", error);
    return null;
  }
};

/** Minimal TOML reader for the handful of hindsight keys. */
const parseTomlFile = async (filePath: string): Promise<Partial<ConfigFile> | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    const out: Partial<ConfigFile> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([a-zA-Z0-9_]+)\s*=\s*(.+)$/.exec(trimmed);
      if (!match?.[1] || !match[2]) continue;
      const key = match[1];
      const valueRaw = match[2];
      const value = valueRaw.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      if (key === "recall_types") out.recall_types = value;
      else if (key === "api_url") out.api_url = value;
      else if (key === "api_key") out.api_key = value;
      else if (key === "bank_id") out.bank_id = value;
      else if (key === "global_bank") out.global_bank = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (error) {
    if (!isMissingFileError(error)) console.error("[hindsight/config] parseTomlFile failed:", error);
    return null;
  }
};

const mergeConfigFiles = (
  base: ConfigFile | null,
  next: Partial<ConfigFile> | null,
): ConfigFile | null => {
  if (!base && !next) return null;
  const b = base ?? {};
  const n = next ?? {};
  return {
    ...b,
    ...n,
    host: {
      ...(b.host ?? {}),
      ...(n.host ?? {}),
      pi: {
        ...(b.host?.pi ?? {}),
        ...(n.host?.pi ?? {}),
        zcode: {
          ...(b.host?.pi?.zcode ?? {}),
          ...(n.host?.pi?.zcode ?? {}),
        },
      },
    },
    mappings: {
      ...(b.mappings ?? {}),
      ...(n.mappings ?? {}),
    },
  };
};

export const collectParentDirs = (cwd: string): string[] => {
  const dirs: string[] = [];
  let current = resolvePath(cwd);
  let parent = dirname(current);
  // Walk up until dirname returns the same path (filesystem root).
  dirs.push(current);
  while (parent !== current) {
    current = parent;
    dirs.push(current);
    parent = dirname(current);
  }
  return dirs.reverse();
};

export const readConfigFile = async (cwd?: string): Promise<ConfigFile | null> => {
  let merged = mergeConfigFiles(
    await parseTomlFile(GLOBAL_TOML_PATH()),
    await readJsonIfPresent(getConfigPath()),
  );
  if (cwd) {
    for (const dir of collectParentDirs(cwd)) {
      merged = mergeConfigFiles(merged, await parseTomlFile(join(dir, ".hindsight", "config.toml")));
      merged = mergeConfigFiles(merged, await readJsonIfPresent(join(dir, LOCAL_CONFIG_PATH)));
    }
  }
  return merged;
};

/**
 * Resolve the full zcode hindsight config.
 * Host config precedence: host.pi.zcode (zcode-specific) over host.pi (shared pi defaults).
 *
 * Uses `envString` / `firstNonEmpty*` rather than `??` for every env-or-file
 * coalesce: ZCode expands `${user_config.X}` in plugin.json's env block to
 * "" when unset, and `??` doesn't fall through on "". See envString docs.
 */
export const resolveConfig = async (cwd?: string): Promise<HindsightConfig> => {
  const file = await readConfigFile(cwd);
  const host: HostConfig = file?.host?.pi ?? {};
  const zhost: HostConfig = host.zcode ?? {};

  const apiKey = firstNonEmptyStr(envString(process.env.HINDSIGHT_API_KEY), file?.apiKey, file?.api_key);
  const baseUrlRaw = firstNonEmptyStr(envString(process.env.HINDSIGHT_BASE_URL), file?.baseUrl, file?.api_url);
  const bankId = firstNonEmptyStr(envString(process.env.HINDSIGHT_BANK_ID), file?.bankId, file?.bank_id);
  const hasKey = Boolean(apiKey);
  const hasUrl = Boolean(baseUrlRaw);

  const bankStrategy = normalizeBankStrategy(
    firstNonEmptyStr(
      envString(process.env.HINDSIGHT_BANK_STRATEGY),
      file?.bankStrategy,
      bankId ? "manual" : "per-repo",
    ) ?? "per-repo",
  );

  const writeFrequencyRaw = firstNonEmptyStr(
    envString(process.env.HINDSIGHT_WRITE_FREQUENCY),
    zhost.writeFrequency,
    host.writeFrequency,
  );
  const writeFrequency: "async" | "session" | number =
    writeFrequencyRaw === "session" ? "session" : writeFrequencyRaw === "async" ? "async" : (() => {
      const n = Number(writeFrequencyRaw);
      return Number.isInteger(n) && n > 0 ? n : "async";
    })();

  const reasoningLevelRaw = firstNonEmptyStr(
    envString(process.env.HINDSIGHT_REASONING_LEVEL),
    zhost.reasoningLevel,
    host.reasoningLevel,
    "low",
  ) as "low" | "medium" | "high";
  const reasoningLevel: "low" | "medium" | "high" =
    reasoningLevelRaw === "medium" || reasoningLevelRaw === "high" ? reasoningLevelRaw : "low";
  const reasoningLevelCapRaw = firstNonEmptyStr(
    envString(process.env.HINDSIGHT_REASONING_LEVEL_CAP),
    zhost.reasoningLevelCap,
    host.reasoningLevelCap,
  );
  const reasoningLevelCap: "low" | "medium" | "high" | null =
    reasoningLevelCapRaw === "low" || reasoningLevelCapRaw === "medium" || reasoningLevelCapRaw === "high"
      ? reasoningLevelCapRaw
      : null;

  const retryQueueHost = zhost.retryQueue ?? host.retryQueue;
  const retryQueue = {
    enabled: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_RETRY_QUEUE_ENABLED), retryQueueHost?.enabled),
      true,
    ),
    maxSizeBytes: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_RETRY_QUEUE_MAX_SIZE_BYTES), retryQueueHost?.maxSizeBytes),
      10_485_760, // 10 MiB — matches pi default
    ),
    maxRetries: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_RETRY_QUEUE_MAX_RETRIES), retryQueueHost?.maxRetries),
      5,
    ),
    maxAgeHours: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_RETRY_QUEUE_MAX_AGE_HOURS), retryQueueHost?.maxAgeHours),
      72,
    ),
  };

  const config: HindsightConfig = {
    enabled: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_ENABLED), zhost.enabled, host.enabled),
      hasKey || hasUrl,
    ),
    apiKey,
    baseUrl: normalizeBaseUrl(baseUrlRaw ?? DEFAULT_BASE_URL),
    bankId,
    globalBankId: firstNonEmptyStr(envString(process.env.HINDSIGHT_GLOBAL_BANK_ID), file?.globalBankId, file?.global_bank),
    bankStrategy,
    workspace: firstNonEmptyStr(zhost.workspace, host.workspace) ?? "zcode",
    peerName: firstNonEmptyStr(zhost.peerName, host.peerName) ?? "user",
    aiPeer: firstNonEmptyStr(zhost.aiPeer, host.aiPeer) ?? "zcode",
    recallTypes: normalizeRecallTypes(
      firstNonEmpty(
        envString(process.env.HINDSIGHT_RECALL_TYPES),
        zhost.recallTypes,
        host.recallTypes,
        file?.recallTypes,
        file?.recall_types,
      ) ?? ["observation", "experience"],
    ),
    recallPerType: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_RECALL_PER_TYPE), zhost.recallPerType, host.recallPerType),
      2,
    ),
    autoCreateBank: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_AUTO_CREATE_BANK), zhost.autoCreateBank, host.autoCreateBank),
      true,
    ),
    searchBudget: normalizeBudget(
      firstNonEmptyStr(envString(process.env.HINDSIGHT_SEARCH_BUDGET), zhost.searchBudget, host.searchBudget),
      "mid",
    ),
    reflectBudget: normalizeBudget(
      firstNonEmptyStr(envString(process.env.HINDSIGHT_REFLECT_BUDGET), zhost.reflectBudget, host.reflectBudget),
      "low",
    ),
    toolPreviewLength: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_TOOL_PREVIEW_LENGTH), zhost.toolPreviewLength, host.toolPreviewLength),
      500,
    ),
    maxMessageLength: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_MAX_MESSAGE_LENGTH), zhost.maxMessageLength, host.maxMessageLength),
      25000,
    ),
    logging: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_LOGGING), zhost.logging, host.logging),
      true,
    ),
    recallMode: normalizeRecallMode(
      firstNonEmptyStr(envString(process.env.HINDSIGHT_RECALL_MODE), zhost.recallMode, host.recallMode, file?.recallMode),
      "context",
    ),
    injectionFrequency: normalizeInjectionFrequency(
      firstNonEmptyStr(
        envString(process.env.HINDSIGHT_INJECTION_FREQUENCY),
        zhost.injectionFrequency,
        host.injectionFrequency,
        file?.injectionFrequency,
      ),
      "every-turn",
    ),
    contextTokens: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_CONTEXT_TOKENS), zhost.contextTokens, host.contextTokens),
      1200,
    ),
    retainMode: RetainModeSchema.catch("response").parse(
      firstNonEmptyStr(envString(process.env.HINDSIGHT_RETAIN_MODE), zhost.retainMode, host.retainMode) ?? "response",
    ) satisfies RetainMode,
    retainTags: (firstNonEmptyStr(envString(process.env.HINDSIGHT_RETAIN_TAGS), zhost.retainTags, host.retainTags) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mappings: file?.mappings ?? {},
    // New parity fields
    retainAsync: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_RETAIN_ASYNC), zhost.retainAsync, host.retainAsync),
      true,
    ),
    retainTimeoutMs: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_RETAIN_TIMEOUT_MS), zhost.retainTimeoutMs, host.retainTimeoutMs),
      300_000, // 5 min — matches pi default
    ),
    stepRetainThreshold: intOr(
      firstNonEmptyNum(envString(process.env.HINDSIGHT_STEP_RETAIN_THRESHOLD), zhost.stepRetainThreshold, host.stepRetainThreshold),
      5,
    ),
    writeFrequency,
    saveMessages: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_SAVE_MESSAGES), zhost.saveMessages, host.saveMessages),
      true,
    ),
    retryQueue,
    reasoningLevel,
    reasoningLevelCap,
    dialecticDynamic: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_DIALECTIC_DYNAMIC), zhost.dialecticDynamic, host.dialecticDynamic),
      true,
    ),
    showRecallIndicator: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_SHOW_RECALL_INDICATOR), zhost.showRecallIndicator, host.showRecallIndicator),
      true,
    ),
    showRetainIndicator: boolOr(
      firstNonEmptyBool(envString(process.env.HINDSIGHT_SHOW_RETAIN_INDICATOR), zhost.showRetainIndicator, host.showRetainIndicator),
      true,
    ),
  };

  return config;
};
