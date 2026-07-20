/**
 * Project config cache (.hindsight.json) — port of pi's project-config.ts.
 *
 * Caches the resolved bank ID at the project root so subsequent sessions skip
 * bank derivation (and skip the git calls derivation needs). Pi writes this on
 * first session_start; without it, zcode re-derives every turn.
 *
 * Format is identical to pi's (version: 1, bankId, provider, repoSlug, ...).
 * The file is read by both agents, so a .hindsight.json scaffolded by zcode
 * will be reused by pi and vice versa.
 *
 * Note: we reuse the existing bank.ts:deriveBankId (already verified
 * byte-for-byte parity) rather than duplicating the derivation here. This
 * module just wraps that call with file-cache logic.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sanitizeBankId, type BankId } from "./bank.ts";
import type { BankStrategy } from "./types.ts";

export type ProjectProvider = "local" | "github" | "gitlab";

export interface HindsightProjectConfig {
  /** Schema version. */
  version: 1;
  /** Resolved bank ID — used directly by hindsight. */
  bankId: string;
  /** How the bank was derived. */
  provider: ProjectProvider;
  /** Git remote slug (e.g. "owner/repo"), if available. */
  repoSlug?: string | undefined;
  /** Base URL of the Hindsight server used during discovery. */
  baseUrl?: string | undefined;
  /** Bank strategy that was active during discovery. */
  bankStrategy?: BankStrategy | undefined;
  /** ISO timestamp of when this file was created. */
  discoveredAt: string;
  /** ISO timestamp of last update. */
  updatedAt?: string | undefined;
}

export const PROJECT_CONFIG_FILENAME = ".hindsight.json";

/** Max parent directories to traverse when looking for an existing cache. */
const MAX_TRAVERSAL_DEPTH = 3;

export const readProjectConfig = async (
  filePath: string,
): Promise<HindsightProjectConfig | null> => {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<HindsightProjectConfig>;
    if (typeof parsed === "object" && parsed.version === 1 && parsed.bankId) {
      return parsed as HindsightProjectConfig;
    }
    return null;
  } catch {
    return null;
  }
};

export const writeProjectConfig = async (
  filePath: string,
  config: HindsightProjectConfig,
): Promise<void> => {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
};

/**
 * Find an existing .hindsight.json by walking up from cwd.
 * Returns { path, config } if found, else null.
 */
export const findProjectConfig = async (
  cwd: string,
): Promise<{ path: string; config: HindsightProjectConfig } | null> => {
  let current = resolve(cwd);
  for (let depth = 0; depth <= MAX_TRAVERSAL_DEPTH; depth++) {
    const candidate = join(current, PROJECT_CONFIG_FILENAME);
    if (existsSync(candidate)) {
      const config = await readProjectConfig(candidate);
      if (config) return { path: candidate, config };
    }
    const parent = dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }
  return null;
};

/**
 * Derive a fresh bank ID using the existing bank.ts derivation (verified
 * parity) plus a repo-slug probe for the cache record.
 *
 * This deliberately reuses deriveBankId rather than re-implementing strategy
 * switches — bank.ts is the single source of truth for derivation.
 */
const deriveFresh = async (
  cwd: string,
  bankStrategy: BankStrategy,
  bankDeriveConfig: { bankId?: string | undefined; globalBankId?: string | undefined; mappings: Record<string, string> },
): Promise<{ bankId: BankId; repoSlug?: string }> => {
  // Lazy import to avoid a static cycle (bank.ts imports nothing from here,
  // but keeping the dynamic import future-proofs it).
  const { deriveBankId } = await import("./bank.ts");
  const bankId = await deriveBankId(cwd, bankStrategy, {
    bankId: bankDeriveConfig.bankId,
    globalBankId: bankDeriveConfig.globalBankId,
    mappings: bankDeriveConfig.mappings,
  });
  // repoSlug is best-effort metadata for the cache file; not used by derivation
  // (deriveBankId already considered it). For the cache we just record what
  // would have been the slug if derivation had hit the remote-slug path.
  const slug = bankDeriveConfig.mappings[cwd];
  return slug ? { bankId, repoSlug: slug } : { bankId };
};

/**
 * Scaffold a new .hindsight.json at targetDir using derived bankId.
 */
export const scaffoldProjectConfig = async (
  cwd: string,
  targetDir: string,
  provider: ProjectProvider,
  bankStrategy: BankStrategy,
  baseUrl: string | undefined,
  bankDeriveConfig: { bankId?: string | undefined; globalBankId?: string | undefined; mappings: Record<string, string> },
): Promise<{ path: string; config: HindsightProjectConfig }> => {
  const { bankId, repoSlug } = await deriveFresh(cwd, bankStrategy, bankDeriveConfig);
  const now = new Date().toISOString();
  const config: HindsightProjectConfig = repoSlug
    ? {
        version: 1,
        bankId: sanitizeBankId(bankId),
        provider,
        repoSlug,
        baseUrl,
        bankStrategy,
        discoveredAt: now,
        updatedAt: now,
      }
    : {
        version: 1,
        bankId: sanitizeBankId(bankId),
        provider,
        baseUrl,
        bankStrategy,
        discoveredAt: now,
        updatedAt: now,
      };
  const filePath = join(targetDir, PROJECT_CONFIG_FILENAME);
  await writeProjectConfig(filePath, config);
  return { path: filePath, config };
};

/**
 * Main entry: find an existing .hindsight.json, or scaffold a new one.
 * Mirrors pi's findOrScaffoldProjectConfig().
 */
export const findOrScaffoldProjectConfig = async (
  cwd: string,
  provider: ProjectProvider,
  bankStrategy: BankStrategy,
  baseUrl: string | undefined,
  bankDeriveConfig: { bankId?: string | undefined; globalBankId?: string | undefined; mappings: Record<string, string> },
): Promise<{ path: string; config: HindsightProjectConfig; scaffolded: boolean }> => {
  const existing = await findProjectConfig(cwd);
  if (existing) {
    return { ...existing, scaffolded: false };
  }
  const { path: newPath, config: newConfig } = await scaffoldProjectConfig(
    cwd,
    cwd,
    provider,
    bankStrategy,
    baseUrl,
    bankDeriveConfig,
  );
  return { path: newPath, config: newConfig, scaffolded: true };
};
