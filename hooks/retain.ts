/**
 * ZCode Stop hook -> automatic per-turn Hindsight retain.
 *
 * TypeScript port of pi's agent_end -> WriteScheduler.onTurnEnd() from
 * hindsight-pi-local/extensions/upload.ts. The Stop payload includes
 * `responsePreview` (the agent's final answer); we retain a compact record.
 *
 * Failure-isolated: any error -> emit {} (never block the turn).
 */
import { resolveConfig } from "../src/config.ts";
import { deriveBankId } from "../src/bank.ts";
import { ensureBank, retain } from "../src/client.ts";
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

  const preview = (payload.responsePreview ?? "").trim();
  if (!preview || preview.length < 40) return emit({}); // drop trivial (pi parity)

  const bankId = await deriveBankId(cwd, config.bankStrategy, config);
  await ensureBank(config.baseUrl, config.apiKey, bankId, {
    autoCreateBank: config.autoCreateBank,
    workspace: config.workspace,
  });

  const content = preview.slice(0, 2000);
  await retain(config.baseUrl, config.apiKey, bankId, content, {
    context: `zcode session ${payload.sessionId ?? "unknown"} @ ${String(payload.timestamp ?? new Date().toISOString())}`,
    tags: ["zcode", "agent-response", ...config.retainTags],
    asyncRetain: true,
  }).catch(() => {
    // Retain is best-effort; never block the turn on a write failure.
  });

  emit(HookOutputSchema.parse({ hookEventName: "Stop" }));
};

main().catch(() => emit({}));
