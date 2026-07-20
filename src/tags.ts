/**
 * Tag construction + runtime-tag derivation.
 *
 * Direct port of hindsight-pi-local's tag-merge.ts, adapted to zcode
 * conventions (no .js import extensions, ESM). Used so every retain carries
 * provenance tags: source:zcode, workspace:X, bank:Y, session:Z, etc.
 *
 * Without these tags, retains in the bank are untraceable — you can't tell
 * which session/provider/model produced a given memory, and you can't filter
 * by workspace when querying.
 */

const MAX_TAG_LENGTH = 64;

const normalizeSegment = (value: string | null | undefined): string =>
  (value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

export const normalizeTag = (value: string | null | undefined): string => {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const namespace = normalizeSegment(raw.slice(0, colon));
    const tagValue = normalizeSegment(raw.slice(colon + 1));
    if (!namespace || !tagValue) return "";
    return `${namespace}:${tagValue}`.slice(0, MAX_TAG_LENGTH).replace(/:+$/g, "");
  }
  return normalizeSegment(raw).slice(0, MAX_TAG_LENGTH);
};

export const parseTagString = (value: string | null | undefined): string[] =>
  (value ?? "")
    .split(/[\n,]/g)
    .map((entry) => normalizeTag(entry))
    .filter(Boolean);

/** Merge tag lists, normalizing + deduplicating. Order preserved. */
export const mergeTags = (
  ...lists: ((string | null | undefined)[] | undefined)[]
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of lists.flatMap((list) => list ?? [])) {
    const normalized = normalizeTag(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

/** Build a scoped tag like "workspace:zcode" or "bank:projects". */
export const buildScopedTag = (
  namespace: string,
  value: string | null | undefined,
): string | null => {
  const ns = normalizeSegment(namespace);
  const tagValue = normalizeSegment(value);
  if (!ns || !tagValue) return null;
  return normalizeTag(`${ns}:${tagValue}`);
};

/** Parse a sessionId from a zcode session file path (e.g. sess_<uuid>.json). */
export const parseSessionIdFromFile = (
  sessionFile: string | null | undefined,
): string | null => {
  const value = (sessionFile ?? "").trim();
  if (!value) return null;
  // zcode uses sess_<uuid>.json; pi uses _<uuid>.jsonl. Match both.
  const match = /(?:sess_)?([0-9a-f]{8}-[0-9a-f-]{27,})\.json[l]?$/i.exec(value);
  return match?.[1] ?? null;
};

export const mergeTagEnv = (
  existing: string | null | undefined,
  additions: string | null | undefined,
): string => mergeTags(parseTagString(existing), parseTagString(additions)).join(",");

/** Build the standard runtime provenance tag set. */
export const buildRuntimeTags = (input: {
  sessionId?: string | null;
  provider?: string | null;
  model?: string | null;
  agent?: string | null;
}): string[] =>
  mergeTags([
    buildScopedTag("session", input.sessionId ?? null),
    buildScopedTag("provider", input.provider ?? null),
    buildScopedTag("model", input.model ?? null),
    buildScopedTag("agent", input.agent ?? null),
  ]);

/** Merge plugin-defined tags + HINDSIGHT_TAGS env + runtime tags. */
export const mergeRetainTags = (
  pluginTags: string[],
  envTags: string | null | undefined,
  runtimeTags: string[] = [],
): string[] => mergeTags(pluginTags, parseTagString(envTags), runtimeTags);

/** Merge + dedupe retain items (by content) before send. */
export const mergeRetainItems = <T extends { content?: string; tags?: string[] }>(
  items: T[],
  envTags: string | null | undefined,
  runtimeTags: string[] = [],
): T[] => {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = (item.content ?? "").replace(/\s+/g, " ").trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(item);
  }
  return deduped.map((item) => ({
    ...item,
    tags: mergeRetainTags(item.tags ?? [], envTags, runtimeTags),
  }));
};

/**
 * Build the standard tag list for a zcode retain, mirroring pi's buildRetainTags().
 * kind is "turn-summary" (auto retain) or "explicit" (tool call).
 * origin is "auto" or "explicit".
 */
export const buildRetainTags = (input: {
  workspace: string;
  bankId: string;
  kind: "turn-summary" | "explicit";
  origin: "auto" | "explicit";
  envTags?: string | null | undefined;
  runtimeTags?: string[] | undefined;
}): string[] => {
  const tags = [
    "source:zcode",
    buildScopedTag("workspace", input.workspace),
    buildScopedTag("bank", input.bankId),
    `kind:${input.kind}`,
    `origin:${input.origin}`,
  ].filter((tag): tag is string => Boolean(tag));
  return mergeRetainTags(tags, input.envTags, input.runtimeTags ?? []);
};
