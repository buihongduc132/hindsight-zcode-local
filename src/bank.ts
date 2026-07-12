/**
 * Bank ID derivation. Byte-for-byte faithful to hindsight-pi-local's
 * extensions/session.ts (deriveBankId + sanitizeBankId) so ZCode and pi resolve
 * the SAME bank for the same project. Verified against commit 5e50d78 alignment.
 */
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { gitOutput } from "./git.ts";
import { asBankId, type BankId, type BankStrategy } from "./types.ts";

export interface BankDeriveConfig {
  readonly bankId: string | undefined;
  readonly globalBankId: string | undefined;
  readonly mappings: Record<string, string>;
}

const MAX_TRAVERSAL_DEPTH = 3;

/** Sanitize a candidate into a valid bank id: lowercase, [a-z0-9_-], max 120. */
export const sanitizeBankId = (raw: string): BankId => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return asBankId(slug || "default");
};

const sha256Short = (input: string): string => {
  try {
    return createHash("sha256").update(input).digest("hex").slice(0, 10);
  } catch {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (h * 31 + input.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16).slice(0, 10).padStart(10, "0");
  }
};

const dirname = (p: string): string => path.basename(p) || p;

/** Find a .hindsight.json cache by traversing up to MAX_TRAVERSAL_DEPTH parents. */
const findHindsightCache = async (cwd: string): Promise<{ bankId?: string } | null> => {
  for (let depth = 0; depth <= MAX_TRAVERSAL_DEPTH; depth++) {
    const dir = depth === 0 ? cwd : path.dirname(cwd);
    if (dir === path.dirname(dir)) break; // reached root
    try {
      const raw = await fs.readFile(path.join(dir, ".hindsight.json"), "utf8");
      const parsed = JSON.parse(raw) as { bankId?: string };
      if (parsed.bankId) return parsed;
    } catch {
      // not present at this level
    }
    cwd = dir;
  }
  return null;
};

/** Detect the git repo root for cwd, or undefined if not in a repo. */
const repoRoot = async (cwd: string): Promise<string | undefined> => gitOutput(cwd, ["rev-parse", "--show-toplevel"]);

/** Detect the git remote origin URL slug (owner/repo), or undefined. */
const remoteSlug = async (cwd: string): Promise<string | undefined> => {
  const url = await gitOutput(cwd, ["remote", "get-url", "origin"]);
  if (!url) return undefined;
  // Normalize git@github.com:owner/repo.git and https://github.com/owner/repo.git
  const cleaned = url.replace(/\.git$/, "").replace(/[^/]+@|https?:\/\//g, "").replace(/:/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return cleaned || undefined;
};

/**
 * Derive the bank id for cwd, mirroring pi's resolution order:
 *   1. config.mappings[cwd]        (explicit override)
 *   2. .hindsight.json bankId      (traversed cache)
 *   3. config.bankId               (env / config file)
 *   4. strategy-based derivation
 */
export const deriveBankId = async (
  cwd: string,
  strategy: BankStrategy,
  config: BankDeriveConfig,
): Promise<BankId> => {
  // 1. explicit mapping override
  const mapped = config.mappings[cwd];
  if (mapped) return asBankId(mapped);

  // 2. cached .hindsight.json
  const cache = await findHindsightCache(cwd);
  if (cache?.bankId) return asBankId(cache.bankId);

  // 3. config / env bankId
  if (config.bankId) return asBankId(config.bankId);

  // 4. strategy-based
  switch (strategy) {
    case "global":
      return sanitizeBankId("pi-global-memory");
    case "manual":
      return sanitizeBankId(config.bankId ?? dirname(cwd));
    case "pi-session": {
      const ts = Date.now().toString(36);
      return sanitizeBankId(`session-${ts}`);
    }
    case "per-directory":
      return sanitizeBankId(`dir-${dirname(cwd)}-${sha256Short(cwd)}`);
    case "git-branch": {
      const root = await repoRoot(cwd);
      const branch = await gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const base = root ? dirname(root) : dirname(cwd);
      return sanitizeBankId(`${base}--${branch ?? "detached"}`);
    }
    case "per-repo":
    default: {
      const slug = await remoteSlug(cwd);
      if (slug) return sanitizeBankId(slug);
      const root = await repoRoot(cwd);
      if (root) return sanitizeBankId(`${dirname(root)}-${sha256Short(root)}`);
      return sanitizeBankId(`dir-${dirname(cwd)}-${sha256Short(cwd)}`);
    }
  }
};

export type { BankId };
