#!/usr/bin/env node
"use strict";
// @ts-check
/**
 * ZCode Stop hook -> automatic per-turn Hindsight retain.
 *
 * ZCode port of pi's agent_end -> WriteScheduler.onTurnEnd() from
 * hindsight-pi-local/extensions/upload.ts. pi writes the turn's messages back to the
 * bank after the agent finishes; ZCode exposes the same seam via a Stop hook.
 *
 * The Stop payload includes `responsePreview` (the agent's final answer). We retain a
 * compact summary of it as an experience/observation so future turns can recall it.
 *
 * Retain mode (mirrors pi HINDSIGHT_RETAIN_MODE): off -> this hook emits {}.
 * Always fire-and-forget; never block the turn. Output is `{}` (Stop ignores
 * additionalContext, but emitting valid JSON avoids parse warnings).
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
	// Don't retain trivially short or empty responses (pi drops these too).
	if (!preview || preview.length < 40) return emit("{}");

	const bankId = await deriveBankId(cwd, config.bankStrategy, config);
	await ensureBank(config.baseUrl, config.apiKey, bankId, {
		autoCreateBank: config.autoCreateBank,
		workspace: config.workspace,
	});

	// Retain a compact record of the agent's output for this turn.
	const content = preview.slice(0, 2000);
	await retain(config.baseUrl, config.apiKey, bankId, content, {
		context: `zcode session ${payload.sessionId || "unknown"} @ ${payload.timestamp || new Date().toISOString()}`,
		tags: ["zcode", "agent-response", ...(config.retainTags || [])],
		asyncRetain: true,
	}).catch(() => {});

	emit("{}");
};

main().catch(() => emit("{}"));
