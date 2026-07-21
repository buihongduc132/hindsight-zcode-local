/**
 * File-based retry queue for failed retains.
 *
 * Direct port of hindsight-pi-local's lib/retry-queue.ts, adapted to zcode
 * TS conventions. Persists failed retains to ~/.hindsight/queue/pending.jsonl
 * under a lock so they survive session crashes and can be drained by the next
 * session_start. The queue file is shared byte-for-byte with pi (same path,
 * same format) — pi's session_start drain and zcode's drain consume the same
 * entries, so a retain that failed under zcode will be retried under whichever
 * agent runs next in the same bank.
 *
 * Without this, a network blip or 5xx silently drops a memory forever.
 */

import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface QueuedRetain {
  id: string;
  bankId: string;
  baseUrl: string;
  content: string;
  metadata?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
  context?: string | undefined;
  queuedAt: string;
  retryCount: number;
  lastError?: string | undefined;
  lastAttemptAt?: string | undefined;
}

/**
 * Resolve the queue directory lazily on each call so tests can override HOME
 * (or set HINDSIGHT_QUEUE_DIR) after module load. Without this, QUEUE_DIR is
 * captured at import time and tests can't isolate the queue.
 */
const getQueueDir = (): string => {
  const explicit = process.env.HINDSIGHT_QUEUE_DIR;
  if (explicit) return explicit;
  return join(homedir(), ".hindsight", "queue");
};
const getQueueFile = (): string => join(getQueueDir(), "pending.jsonl");
const getLockFile = (): string => join(getQueueDir(), "pending.jsonl.lock");

const ensureDir = async (): Promise<void> => {
  await mkdir(getQueueDir(), { recursive: true });
};

const currentSize = async (): Promise<number> => {
  try {
    const s = await stat(getQueueFile());
    return s.size;
  } catch {
    return 0; // file not found is expected
  }
};

const parseLines = (raw: string): QueuedRetain[] => {
  const entries: QueuedRetain[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as QueuedRetain);
    } catch {
      // skip corrupt line
    }
  }
  return entries;
};

/**
 * Simple file-based mutex to prevent TOCTOU between enqueue and drain.
 * Uses O_EXCL create as an atomic lock acquisition.
 */
const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  await ensureDir();
  const maxAttempts = 300;
  const retryMs = 100;
  let hasLock = false;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const handle = await open(getLockFile(), "wx");
      await handle.close();
      hasLock = true;
      break;
    } catch {
      if (i === maxAttempts - 1) {
        // Stale lock — force remove and retry once
        try {
          await unlink(getLockFile());
        } catch {
          // ignore
        }
        try {
          const handle = await open(getLockFile(), "wx");
          await handle.close();
          hasLock = true;
          break;
        } catch {
          // give up — fall through, fn() may fail or succeed without lock
        }
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  try {
    return await fn();
  } finally {
    // Only release the lock if we actually acquired it.
    if (hasLock) {
      try {
        await unlink(getLockFile());
      } catch {
        // already gone
      }
    }
  }
};

export const enqueue = async (
  entry: Omit<QueuedRetain, "id" | "queuedAt" | "retryCount">,
  maxSizeBytes: number,
): Promise<boolean> =>
  withLock(async () => {
    await ensureDir();
    const size = await currentSize();
    if (size >= maxSizeBytes) return false;

    const record: QueuedRetain = {
      ...entry,
      id: randomUUID(),
      queuedAt: new Date().toISOString(),
      retryCount: 0,
    };

    await appendFile(getQueueFile(), `${JSON.stringify(record)}\n`, "utf8");
    return true;
  });

export const loadPending = async (): Promise<QueuedRetain[]> => {
  try {
    const raw = await readFile(getQueueFile(), "utf8");
    return parseLines(raw);
  } catch {
    return []; // file not found is expected
  }
};

export const writePending = async (entries: QueuedRetain[]): Promise<void> => {
  await ensureDir();
  if (entries.length === 0) {
    try {
      await unlink(getQueueFile());
    } catch {
      // already gone
    }
    return;
  }
  const tmpFile = `${getQueueFile()}.tmp`;
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(tmpFile, content, "utf8");
  await rename(tmpFile, getQueueFile());
};

/** Load + write under lock to prevent TOCTOU with enqueue. */
export const rewritePending = async (
  fn: (entries: QueuedRetain[]) => QueuedRetain[] | Promise<QueuedRetain[]>,
): Promise<void> => {
  await withLock(async () => {
    const entries = await loadPending();
    const rewritten = await fn(entries);
    await writePending(rewritten);
  });
};

export const queueSize = async (): Promise<{ entries: number; bytes: number }> => {
  const pending = await loadPending();
  const size = await currentSize();
  return { entries: pending.length, bytes: size };
};

export const purgeQueue = async (): Promise<number> => {
  const pending = await loadPending();
  try {
    await unlink(getQueueFile());
  } catch {
    // already gone
  }
  return pending.length;
};

/** Remove entries older than maxAgeMs. */
export const pruneExpired = async (maxAgeMs: number): Promise<number> => {
  let pruned = 0;
  await rewritePending((pending) => {
    if (pending.length === 0) return pending;
    const cutoff = Date.now() - maxAgeMs;
    const kept: QueuedRetain[] = [];
    for (const entry of pending) {
      const age = new Date(entry.queuedAt).getTime();
      if (age < cutoff) {
        pruned++;
        continue;
      }
      kept.push(entry);
    }
    return kept;
  });
  return pruned;
};

const NON_RETRYABLE_PATTERNS = [
  "CausalRelation", // Server dataclass version mismatch
  "unexpected keyword argument", // Python API signature mismatch
  "invalid_api_key", // Permanent — wrong key configured
];

/** Check if error is a permanent 403 (not transient rate-limit). */
const isPermanentForbidden = (errorMsg: string): boolean => {
  if (!errorMsg.includes("forbidden")) return false;
  if (/rate.?limit|throttl|quota|too many requests/i.test(errorMsg)) return false;
  return true;
};

/** Remove entries whose lastError matches a permanent-failure pattern. */
export const pruneNonRetryable = async (): Promise<number> => {
  let pruned = 0;
  await rewritePending((pending) => {
    if (pending.length === 0) return pending;
    const kept: QueuedRetain[] = [];
    for (const entry of pending) {
      if (
        entry.lastError &&
        (NON_RETRYABLE_PATTERNS.some((p) => entry.lastError!.includes(p)) ||
          isPermanentForbidden(entry.lastError))
      ) {
        pruned++;
        continue;
      }
      kept.push(entry);
    }
    return kept;
  });
  return pruned;
};
