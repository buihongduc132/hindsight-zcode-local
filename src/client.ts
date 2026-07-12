/**
 * Hindsight HTTP client. Talks to the shared Hindsight server
 * (default http://localhost:8888; bhd uses http://100.114.135.99:24300).
 *
 * Every response is parsed through a zod schema at the boundary, so callers
 * receive typed values and malformed server output surfaces as a thrown
 * ZodError instead of silently dropping data (the bug that bit the JS port).
 */
import { z } from "zod";
import {
  BankListResponseSchema,
  BankProfileSchema,
  EntityStatSchema,
  RecallResponseSchema,
  ReflectResponseSchema,
  RetainResponseSchema,
  TagStatSchema,
  type BankId,
  type NormalizedRecallResult,
  type RecallType,
  type SearchBudget,
} from "./types.ts";

// ---------- HTTP ----------

export class HindsightHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "HindsightHttpError";
  }
}

export class HindsightParseError extends Error {
  public override readonly cause: unknown;
  constructor(
    public readonly url: string,
    cause: unknown,
  ) {
    super(`Failed to parse response from ${url}`);
    this.name = "HindsightParseError";
    this.cause = cause;
  }
}

interface FetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** Abortable POST/GET. Throws HindsightHttpError on non-2xx, never returns null. */
const request = async (
  baseUrl: string,
  apiKey: string | undefined,
  path: string,
  init: FetchInit = {},
): Promise<unknown> => {
  const url = path.startsWith("http") ? path : `${baseUrl.replace(/\/+$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30000);
  try {
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    if (init.body) headers["content-type"] = "application/json";
    const fetchInit: RequestInit = {
      method: init.method ?? "GET",
      headers,
      signal: controller.signal,
    };
    if (init.body !== undefined) fetchInit.body = init.body;
    const res = await fetch(url, fetchInit);
    const text = await res.text();
    if (!res.ok) {
      throw new HindsightHttpError(res.status, url, text || res.statusText);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
};

/** Parse a value through a schema or throw HindsightParseError with context. */
const parseOrThrow = <T>(schema: { parse: (v: unknown) => T }, url: string, value: unknown): T => {
  try {
    return schema.parse(value);
  } catch (err) {
    throw new HindsightParseError(url, err);
  }
};

// ---------- Recall / Reflect / Retain ----------

export interface RecallOptions {
  readonly types?: readonly RecallType[];
  readonly budget?: SearchBudget;
  readonly maxTokens?: number;
}

export const recall = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  query: string,
  opts: RecallOptions = {},
): Promise<NormalizedRecallResult> => {
  const path = `/v1/default/banks/${bankId}/memories/recall`;
  const body = JSON.stringify({
    query,
    types: opts.types,
    budget: opts.budget,
    max_tokens: opts.maxTokens,
  });
  const raw = await request(baseUrl, apiKey, path, { method: "POST", body });
  return parseOrThrow(RecallResponseSchema, path, raw);
};

export interface ReflectOptions {
  readonly context?: string;
  readonly budget?: SearchBudget;
}

export const reflect = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  query: string,
  opts: ReflectOptions = {},
) => {
  const path = `/v1/default/banks/${bankId}/memories/reflect`;
  const body = JSON.stringify({ query, context: opts.context, budget: opts.budget });
  const raw = await request(baseUrl, apiKey, path, { method: "POST", body });
  return parseOrThrow(ReflectResponseSchema, path, raw);
};

export interface RetainOptions {
  readonly context?: string;
  readonly tags?: readonly string[];
  readonly asyncRetain?: boolean;
}

export const retain = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  content: string,
  opts: RetainOptions = {},
) => {
  const path = `/v1/default/banks/${bankId}/memories`;
  const body = JSON.stringify({
    content,
    context: opts.context,
    tags: opts.tags,
    async: opts.asyncRetain,
  });
  const raw = await request(baseUrl, apiKey, path, { method: "POST", body });
  return parseOrThrow(RetainResponseSchema, path, raw);
};

// ---------- Bank management ----------

export interface EnsureBankOptions {
  readonly autoCreateBank: boolean;
  readonly workspace: string;
}

/** Get-or-create a bank. No-op if the bank already exists. */
export const ensureBank = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  opts: EnsureBankOptions,
): Promise<void> => {
  if (!opts.autoCreateBank) return;
  const path = `/v1/default/banks/${bankId}`;
  try {
    await request(baseUrl, apiKey, path, { method: "GET", timeoutMs: 10000 });
  } catch (err) {
    if (err instanceof HindsightHttpError && err.status === 404) {
      await request(baseUrl, apiKey, "/v1/default/banks", {
        method: "POST",
        body: JSON.stringify({ bank_id: bankId, workspace: opts.workspace }),
      });
      return;
    }
    // 409 (already exists) or transient errors -> tolerate; recall will surface real issues.
    if (!(err instanceof HindsightHttpError) || (err.status !== 409 && err.status < 500)) {
      throw err;
    }
  }
};

export const listBanks = async (baseUrl: string, apiKey: string | undefined) => {
  const path = "/v1/default/banks";
  const raw = await request(baseUrl, apiKey, path);
  return parseOrThrow(BankListResponseSchema, path, raw);
};

export const getBankProfile = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
) => {
  const path = `/v1/default/banks/${bankId}`;
  const raw = await request(baseUrl, apiKey, path);
  return parseOrThrow(BankProfileSchema, path, raw);
};

export const fetchTopTags = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  limit = 10,
) => {
  const path = `/v1/default/banks/${bankId}/tags?limit=${String(limit)}`;
  const raw = await request(baseUrl, apiKey, path);
  const parsed = parseOrThrow(
    z.object({ tags: z.array(TagStatSchema).optional(), items: z.array(TagStatSchema).optional() }).passthrough(),
    path,
    raw,
  );
  return parsed.tags ?? parsed.items ?? [];
};

export const fetchTopEntities = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  limit = 10,
) => {
  const path = `/v1/default/banks/${bankId}/entities?limit=${String(limit)}`;
  const raw = await request(baseUrl, apiKey, path);
  const parsed = parseOrThrow(
    z
      .object({
        entities: z.array(EntityStatSchema).optional(),
        items: z.array(EntityStatSchema).optional(),
      })
      .passthrough(),
    path,
    raw,
  );
  return parsed.entities ?? parsed.items ?? [];
};
