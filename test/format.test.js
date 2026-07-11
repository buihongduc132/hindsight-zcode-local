"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	formatHindsightStatus,
	formatRecallResults,
	formatReflectResult,
	formatRetainResult,
} = require("../src/format");

test("formatHindsightStatus includes action, bank, result, duration", () => {
	const s = formatHindsightStatus({ bankId: "b1", action: "recall", mode: "sync", result: "success", durationMs: 42, count: 3 });
	assert.match(s, /\[hindsight:recall/);
	assert.match(s, /bank=b1/);
	assert.match(s, /result=success/);
	assert.match(s, /mode=sync/);
	assert.match(s, /count=3/);
	assert.match(s, /42ms\]/);
});

test("formatRecallResults groups by type", () => {
	const result = {
		memories: [
			{ type: "observation", content: "first fact here", score: 0.9 },
			{ type: "experience", content: "a lesson", score: 0.8 },
			{ type: "observation", content: "second fact" },
		],
	};
	const out = formatRecallResults(result, 100);
	assert.match(out, /observation \(2\):/);
	assert.match(out, /experience \(1\):/);
	assert.match(out, /first fact here/);
});

test("formatRecallResults truncates to preview length", () => {
	const long = "x".repeat(200);
	const out = formatRecallResults({ memories: [{ type: "observation", content: long }] }, 10);
	assert.ok(out.includes("..."));
	assert.ok(!out.includes("x".repeat(50)));
});

test("formatRecallResults empty", () => {
	assert.equal(formatRecallResults({ memories: [] }, 100), "(no memories recalled)");
	assert.equal(formatRecallResults({}, 100), "(no memories recalled)");
});

test("formatReflectResult prefers response/answer/content", () => {
	assert.equal(formatReflectResult({ response: "the answer" }), "the answer");
	assert.equal(formatReflectResult({ answer: "alt" }), "alt");
	assert.equal(formatReflectResult("plain string"), "plain string");
	assert.equal(formatReflectResult(null), "(no reflection returned)");
});

test("formatRetainResult surfaces operation_id", () => {
	assert.match(formatRetainResult({ operation_id: "op-1", status: "queued" }), /operation_id=op-1/);
	assert.match(formatRetainResult({ operation_id: "op-1", status: "queued" }), /status=queued/);
	assert.equal(formatRetainResult(null), "retained");
});
