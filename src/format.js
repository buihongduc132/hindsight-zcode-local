"use strict";
// @ts-check
/**
 * Output formatting — mirrors message-format.ts + the inline formatters in tools.ts
 * from hindsight-pi-local so recall/reflect/retain blocks look the same to the model
 * regardless of whether pi or zcode produced them.
 */

/**
 * @param {{bankId: string, action: string, mode?: string, result: string, durationMs: number, count?: number}} s
 * @returns {string}
 */
const formatHindsightStatus = (s) => {
	const parts = [`[hindsight:${s.action}`, `bank=${s.bankId}`, `result=${s.result}`];
	if (s.mode) parts.push(`mode=${s.mode}`);
	if (typeof s.count === "number") parts.push(`count=${s.count}`);
	parts.push(`${s.durationMs}ms]`);
	return parts.join(" ");
};

/**
 * Format a recall result set into the same grouped view pi produces.
 * @param {any} result  Raw recall response from the API.
 * @param {number} previewLength
 * @returns {string}
 */
const formatRecallResults = (result, previewLength) => {
	/** @type {string[]} */ const sections = [];
	const memories = Array.isArray(result?.memories) ? result.memories : [];
	const items = Array.isArray(result?.items) ? result.items : memories;
	if (items.length === 0) {
		return "(no memories recalled)";
	}
	// Group by type when present, else single group.
	/** @type {Record<string, any[]>} */ const byType = {};
	for (const it of items) {
		const type = it?.type || it?.memory_type || "memory";
		(byType[type] ??= []).push(it);
	}
	const types = Object.keys(byType);
	for (const type of types) {
		const group = byType[type];
		sections.push(`${type} (${group.length}):`);
		for (const m of group) {
			const content =
				typeof m?.content === "string"
					? m.content
					: typeof m?.text === "string"
						? m.text
						: JSON.stringify(m);
			const preview = content.length > previewLength ? `${content.slice(0, previewLength)}...` : content;
			const meta = [];
			if (m?.score != null) meta.push(`score=${typeof m.score === "number" ? m.score.toFixed(3) : m.score}`);
			if (m?.created_at) meta.push(`at=${m.created_at}`);
			if (m?.timestamp) meta.push(`when=${m.timestamp}`);
			const metaStr = meta.length ? `  {${meta.join(", ")}}` : "";
			sections.push(`  - ${preview.replace(/\s+/g, " ").trim()}${metaStr}`);
		}
	}
	return sections.join("\n");
};

/**
 * Format a reflect (synthesized) response.
 * @param {any} result
 * @returns {string}
 */
const formatReflectResult = (result) => {
	if (result == null) return "(no reflection returned)";
	if (typeof result === "string") return result;
	const content =
		result?.response ??
		result?.answer ??
		result?.content ??
		result?.result ??
		result?.message ??
		null;
	if (content != null) return String(content);
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
};

/**
 * Format a retain result, surfacing an operation id / status when present.
 * @param {any} result
 * @returns {string}
 */
const formatRetainResult = (result) => {
	if (result == null) return "retained";
	const opId = result?.operation_id ?? result?.operationId;
	const status = result?.status;
	const accepted = result?.accepted ?? result?.retained;
	const parts = [];
	if (opId) parts.push(`operation_id=${opId}`);
	if (status) parts.push(`status=${status}`);
	if (typeof accepted === "number") parts.push(`accepted=${accepted}`);
	return parts.length ? `retained ${parts.join(", ")}` : "retained";
};

module.exports = {
	formatHindsightStatus,
	formatRecallResults,
	formatReflectResult,
	formatRetainResult,
};
