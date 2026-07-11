"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	normalizeBaseUrl,
	normalizeRecallTypes,
	normalizeBankStrategy,
	normalizeBudget,
	intOr,
	boolOr,
} = require("../src/config");

test("normalizeBaseUrl adds http:// and strips trailing slash", () => {
	assert.equal(normalizeBaseUrl("100.114.135.99:24300"), "http://100.114.135.99:24300");
	assert.equal(normalizeBaseUrl("http://x.com/"), "http://x.com");
	assert.equal(normalizeBaseUrl("https://y.com/"), "https://y.com");
	assert.equal(normalizeBaseUrl(""), "http://localhost:8888");
	assert.equal(normalizeBaseUrl(undefined), "http://localhost:8888");
});

test("normalizeBaseUrl with undefined/null", () => {
	assert.equal(normalizeBaseUrl(null), "http://localhost:8888");
});

test("normalizeRecallTypes filters invalid and dedupes", () => {
	assert.deepEqual(normalizeRecallTypes(["observation", "experience", "bogus"]), ["observation", "experience"]);
	assert.deepEqual(normalizeRecallTypes("observation, experience"), ["observation", "experience"]);
	assert.deepEqual(normalizeRecallTypes(["observation", "observation"]), ["observation"]);
	assert.deepEqual(normalizeRecallTypes([]), ["observation"]);
	assert.deepEqual(normalizeRecallTypes(undefined), ["observation"]);
});

test("normalizeBankStrategy defaults to per-repo", () => {
	assert.equal(normalizeBankStrategy("per-repo"), "per-repo");
	assert.equal(normalizeBankStrategy("global"), "global");
	assert.equal(normalizeBankStrategy("bogus"), "per-repo");
	assert.equal(normalizeBankStrategy(undefined), "per-repo");
});

test("normalizeBudget falls back", () => {
	assert.equal(normalizeBudget("high", "mid"), "high");
	assert.equal(normalizeBudget("bogus", "mid"), "mid");
	assert.equal(normalizeBudget(undefined, "low"), "low");
});

test("intOr parses positive integers", () => {
	assert.equal(intOr(5, 1), 5);
	assert.equal(intOr("10", 1), 10);
	assert.equal(intOr("nope", 1), 1);
	assert.equal(intOr(-3, 1), 1);
	assert.equal(intOr(undefined, 7), 7);
});

test("boolOr handles bool/string/other", () => {
	assert.equal(boolOr(true, false), true);
	assert.equal(boolOr(false, true), false);
	assert.equal(boolOr("true", false), true);
	assert.equal(boolOr("false", true), false);
	assert.equal(boolOr("anything", true), false);
	assert.equal(boolOr(undefined, true), true);
});
