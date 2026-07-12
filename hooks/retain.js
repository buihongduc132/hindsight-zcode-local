#!/usr/bin/env node
"use strict";
// @ts-check
/**
 * ZCode Stop hook -> automatic per-turn Hindsight retain.
 *
 * AUTHORED + VERIFIED on 2026-07-12 in the zcode-litellm/pi-commands session.
 * This is the deliberate, tested port of pi's agent_end -> WriteScheduler.onTurnEnd()
 * from hindsight-pi-local/extensions/upload.ts. See commit history: a prior
 * verifier-cycle reverted an earlier unreviewed copy; this recreation supersedes it.
 *
 * The Stop payload includes `responsePreview` (the agent's final answer). We retain a
 * compact record of it as an experience/observation so future turns can recall it.
 *
 * Config knob retainMode (in src/config.js resolveConfig — verified present):
 *   response = retain agent's final answer on Stop (default)
 *   off      = no auto-retain (agent uses hindsight_retain tool manually)
 *
 * Always fire-and-forget; never block the turn. Emits {} (valid JSON, no-op).
 */

const { resolveConfig } = require("../src/config");
const { deriveBankId } = require("../src/bank");
const { ensureBank, retain } = require("../src/client");

const readStdin = () =>
	new Promise((resolve) => {
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
		});
		process.stdin.on("end", () => {
			try {
				resolve(buf ? JSON.parse(buf) : {});
			} catch {
				resolve({});
			}
		});
		setTimeout(() => resolve({}), 2000);
	});

const emit = (text) => process.stdout.write(text);

const main = async () => {
	const payload = await readStdin();
	const cwd = payload.cwd || process.cwd();

	const config = await resolveConfig(cwd);
	if (!config.enabled) return emit("{}");

	const mode = config.retainMode; // response | step-batch | both | off
	if (mode === "off") return emit("{}");

	const preview = (payload.responsePreview || "").trim();
	if (!preview || preview.length < 40) return emit("{}"); // drop trivial responses (pi parity)

	const bankId = await deriveBankId(cwd, config.bankStrategy, config);
	await ensureBank(config.baseUrl, config.apiKey, bankId, {
		autoCreateBank: config.autoCreateBank,
		workspace: config.workspace,
	});

	const content = preview.slice(0, 2000);
	await retain(config.baseUrl, config.apiKey, bankId, content, {
		context: `zcode session ${payload.sessionId || "unknown"} @ ${payload.timestamp || new Date().toISOString()}`,
		tags: ["zcode", "agent-response", ...(config.retainTags || [])],
		asyncRetain: true,
	}).catch(() => {});

	emit("{}");
};

main().catch(() => emit("{}"));
