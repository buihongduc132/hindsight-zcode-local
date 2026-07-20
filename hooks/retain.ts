/**
 * ZCode Stop hook -> automatic per-turn Hindsight retain.
 *
 * Port of pi's agent_end -> WriteScheduler.onTurnEnd() from
 * hindsight-pi-local/extensions/upload.ts. Uses the retain-pipeline module
 * for: sanitization, skip rules, retry queue, provenance tags, async send.
 *
 * The Stop payload includes `responsePreview` (the agent's final answer) and
 * (optionally) `userPrompt` (the prompt that triggered the turn). We build a
 * sanitized, chunked, tagged turn-summary from those and send it through the
 * pipeline.
 *
 * Failure-isolated: any error -> emit {} (never block the turn).
 */
import { resolveConfig } from "../src/config.ts";
import { deriveBankId } from "../src/bank.ts";
import { ensureBank } from "../src/client.ts";
import { onTurnEnd } from "../src/retain-pipeline.ts";
import { HookOutputSchema, StopPayloadSchema, type HookOutput } from "../src/types.ts";

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
  const parsed = StopPayloadSchema.safeParse(rawPayload);
  const payload = parsed.success ? parsed.data : {};
  const cwd = payload.cwd ?? process.cwd();

  const config = await resolveConfig(cwd);
  if (!config.enabled) return emit({});
  if (config.retainMode === "off") return emit({});

  const responsePreview = (payload.responsePreview ?? "").trim();
  // zcode's Stop payload doesn't include the original user prompt directly;
  // it can include it as part of the session context. Best-effort: empty.
  const userPrompt = "";

  const bankId = await deriveBankId(cwd, config.bankStrategy, config);
  await ensureBank(config.baseUrl, config.apiKey, bankId, {
    autoCreateBank: config.autoCreateBank,
    workspace: config.workspace,
  });

  // onTurnEnd awaits the actual retain (with backoff + queue fallback) so
  // the hook process doesn't exit and drop the in-flight HTTP request.
  // The Stop hook timeout in hooks.json must be >= retainTimeoutMs.
  try {
    await onTurnEnd({
      config,
      bankId,
      userPrompt,
      responsePreview,
    });
  } catch (error) {
    if (config.logging) {
      console.error(
        `[hindsight/retain] onTurnEnd failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  emit(HookOutputSchema.parse({ hookEventName: "Stop" }));
};

main().catch(() => emit({}));
