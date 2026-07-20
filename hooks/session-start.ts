/**
 * ZCode SessionStart hook -> drain the hindsight retry queue.
 *
 * Port of pi's session_start -> drainRetryQueue() from
 * hindsight-pi-local/extensions/index.ts. On every new session, prune
 * expired/non-retryable queue entries and re-attempt any pending retains
 * for this bank.
 *
 * Why this exists: when a retain fails during a Stop hook (network blip,
 * server 5xx), it lands in ~/.hindsight/queue/pending.jsonl. Without a
 * SessionStart drain, those entries would sit there forever. Pi drains on
 * session_start; this hook gives zcode the same behavior.
 *
 * Note: zcode's plugin API does NOT expose SessionEnd / SessionShutdown /
 * SessionBeforeSwitch hooks (only SessionStart, UserPromptSubmit, PreToolUse,
 * PostToolUse, PostToolUseFailure, PermissionRequest, Stop). So we can't
 * flush pending writes on session end the way pi does. The Stop hook already
 * awaits its retain (no in-flight writes to flush), and any that fail there
 * land in the queue and get drained here next session.
 *
 * Failure-isolated: any error -> emit {} (never block the session).
 */
import { resolveConfig } from "../src/config.ts";
import { deriveBankId } from "../src/bank.ts";
import { ensureBank } from "../src/client.ts";
import { drainRetryQueue } from "../src/retain-pipeline.ts";
import { findOrScaffoldProjectConfig } from "../src/project-config.ts";
import { HookOutputSchema, type HookOutput } from "../src/types.ts";

interface SessionStartPayload {
  cwd?: string;
  sessionId?: string;
  hookEventName?: string;
}

const readStdin = (): Promise<unknown> =>
  new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(buf ? (JSON.parse(buf) as unknown) : {});
      } catch {
        resolve({});
      }
    });
    setTimeout(() => resolve({}), 2000);
  });

const emit = (output: HookOutput): void => {
  process.stdout.write(`${JSON.stringify(output)}\n`);
};

const main = async (): Promise<void> => {
  const rawPayload = await readStdin();
  const payload = (rawPayload ?? {}) as SessionStartPayload;
  const cwd = payload.cwd ?? process.cwd();

  const config = await resolveConfig(cwd);
  if (!config.enabled) return emit({});

  // Best-effort: scaffold .hindsight.json if not present (pi parity).
  // Non-blocking — failure here doesn't prevent drain.
  try {
    await findOrScaffoldProjectConfig(
      cwd,
      "local",
      config.bankStrategy,
      config.baseUrl,
      {
        bankId: config.bankId,
        globalBankId: config.globalBankId,
        mappings: config.mappings,
      },
    );
  } catch (error) {
    if (config.logging) {
      console.error(
        `[hindsight/session-start] scaffold failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const bankId = await deriveBankId(cwd, config.bankStrategy, config);
  await ensureBank(config.baseUrl, config.apiKey, bankId, {
    autoCreateBank: config.autoCreateBank,
    workspace: config.workspace,
  });

  // Drain the retry queue for this bank. Fire-and-forget at the process level
  // is OK here because the drain itself re-enqueues on failure — but we await
  // so that if the SessionStart hook has a generous timeout, the drain
  // completes before the user's first turn (which might depend on the
  // just-drained memory being present).
  try {
    await drainRetryQueue(config, bankId);
  } catch (error) {
    if (config.logging) {
      console.error(
        `[hindsight/session-start] drain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  emit(HookOutputSchema.parse({ hookEventName: "SessionStart" }));
};

main().catch(() => emit({}));
