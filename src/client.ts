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
  readonly context?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly asyncRetain?: boolean | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export const retain = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  content: string,
  opts: RetainOptions = {},
) => {
  // The Hindsight retain API expects {items: MemoryItem[], async: bool} where
  // each MemoryItem has {content, context?, metadata?, tags?, timestamp?, ...}.
  // The older single-content shape ({content, tags, ...} at top level) was
  // rejected with 422 "Field required: items" on the server this user runs
  // (Hindsight 0.7.1). Wrap in an items array of length 1.
  const item: Record<string, unknown> = { content };
  if (opts.context !== undefined) item.context = opts.context;
  if (opts.metadata !== undefined) item.metadata = opts.metadata;
  if (opts.tags !== undefined) item.tags = [...opts.tags];
  const path = `/v1/default/banks/${bankId}/memories`;
  const body = JSON.stringify({
    items: [item],
    async: opts.asyncRetain ?? false,
  });
  const raw = await request(baseUrl, apiKey, path, { method: "POST", body });
  return parseOrThrow(RetainResponseSchema, path, raw);
};

// ---------- Bank management ----------

export interface EnsureBankOptions {
  readonly autoCreateBank: boolean;
  readonly workspace: string;
}

/**
 * Get-or-create a bank. No-op if the bank already exists.
 *
 * Server-version tolerant: older Hindsight servers don't expose
 * `GET /v1/default/banks/{bank_id}` (only PUT/PATCH/DELETE on that path),
 * so probing via GET returns 405 — which we treat as "exists" (the path is
 * valid, the bank is there, just GET isn't supported). We probe via the list
 * endpoint instead, which always works and tells us whether the bank exists.
 *
 * Creation uses `PUT /v1/default/banks/{bank_id}` (the OpenAPI-spec'd create
 * endpoint). POST /v1/default/banks is the LIST endpoint, not create — using
 * POST here would also 405.
 */
export const ensureBank = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: BankId,
  opts: EnsureBankOptions,
): Promise<void> => {
  if (!opts.autoCreateBank) return;

  // Cheap existence check via the list endpoint (single round-trip).
  try {
    const list = await listBanks(baseUrl, apiKey);
    if (list.some((b) => b.bank_id === bankId)) return; // exists, done
  } catch {
    // List failed (network blip, auth issue) — fall through and try create.
    // If the create also fails, ensureBank's caller will surface the error.
  }

  // Not in list → create via PUT (matches OpenAPI spec).
  try {
    await request(baseUrl, apiKey, `/v1/default/banks/${bankId}`, {
      method: "PUT",
      body: JSON.stringify({ bank_id: bankId, name: bankId, workspace: opts.workspace }),
      timeoutMs: 10000,
    });
  } catch (err) {
    // 409 (already exists, race with another process) -> tolerate.
    // Other errors -> propagate.
    if (!(err instanceof HindsightHttpError) || err.status !== 409) {
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
  // Per OpenAPI spec, the profile read endpoint is
  // GET /v1/default/banks/{bank_id}/profile (operationId: get_bank_profile).
  // The bare path GET /v1/default/banks/{bank_id} is PUT/PATCH/DELETE only on
  // older servers and returns 405 on GET. Use /profile explicitly.
  const path = `/v1/default/banks/${bankId}/profile`;
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
