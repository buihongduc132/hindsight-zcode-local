"use strict";
// @ts-check
/**
 * Hindsight HTTP API client (zero-dependency).
 *
 * Implements the exact REST shapes used by @vectorize-io/hindsight-client (v0.6.2)
 * so zcode hits the SAME server, SAME banks, SAME endpoints as pi:
 *
 *   POST /v1/default/banks/{bank_id}/memories/recall   -> recall
 *   POST /v1/default/banks/{bank_id}/reflect           -> reflect (synthesize)
 *   POST /v1/default/banks/{bank_id}/memories          -> retain (POST = create)
 *   GET  /v1/default/banks                             -> list banks
 *   GET  /v1/default/banks/{bank_id}                   -> bank profile
 *   GET  /v1/default/banks/{bank_id}/tags              -> top tags
 *   GET  /v1/default/banks/{bank_id}/entities          -> top entities
 *   PUT  /v1/default/banks/{bank_id}                   -> create/update bank
 *
 * @typedef {import("./types").HindsightConfig} HindsightConfig
 */

/** @param {string|undefined} apiKey @returns {Record<string,string>} */
const authHeaders = (apiKey) => ({
	"Content-Type": "application/json",
	"User-Agent": "hindsight-zcode-local/0.1.0",
	...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
});

/**
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} path
 * @param {{method?: string, body?: any, timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
const apiRequest = async (baseUrl, apiKey, path, opts = {}) => {
	const { method = "GET", body, timeoutMs = 30_000 } = opts;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
			method,
			headers: authHeaders(apiKey),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		const text = await response.text();
		let data = null;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
		}
		if (!response.ok) {
			const detail = data?.detail ?? data?.message ?? data ?? `${response.status} ${response.statusText}`;
			const err = new Error(`${method} ${path} failed: ${JSON.stringify(detail)}`);
			// @ts-ignore
			err.statusCode = response.status;
			// @ts-ignore
			err.detail = detail;
			throw err;
		}
		return data;
	} finally {
		clearTimeout(timer);
	}
};

/**
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @returns {Promise<any>}
 */
const getBankProfile = async (baseUrl, apiKey, bankId) => {
	// The profile path differs across Hindsight API versions:
	//   - older: GET /v1/default/banks/{id}
	//   - newer: GET /v1/default/banks/{id}/profile
	// Try /profile first (works on v0.7.x), fall back to the bare path.
	try {
		return await apiRequest(baseUrl, apiKey, `/v1/default/banks/${encodeURIComponent(bankId)}/profile`);
	} catch (err) {
		// If /profile 404s, fall back to the legacy bare-path GET.
		const msg = err instanceof Error ? err.message : String(err);
		if (/404|not found/i.test(msg)) {
			return apiRequest(baseUrl, apiKey, `/v1/default/banks/${encodeURIComponent(bankId)}`);
		}
		throw err;
	}
};

/**
 * Create or update a bank (PUT). Mirrors createOrUpdateBank.
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {{name?: string, mission?: string, background?: string}} [options]
 * @returns {Promise<any>}
 */
const createBank = (baseUrl, apiKey, bankId, options = {}) =>
	apiRequest(baseUrl, apiKey, `/v1/default/banks/${encodeURIComponent(bankId)}`, {
		method: "PUT",
		body: {
			name: options.name,
			background: options.background,
			mission: options.mission,
		},
	});

/**
 * Ensure a bank exists; auto-create on 404. Mirrors ensureBank from client.ts.
 *
 * Resilient across Hindsight API versions:
 *   - 404 (Not Found) on the profile path → bank missing → create (if autoCreate)
 *   - 405 (Method Not Allowed) on the bare path → bank EXISTS, just the method differs
 *     (newer servers expose the profile at /profile). Treat as exists, do nothing.
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {{autoCreateBank: boolean, workspace: string}} config
 * @returns {Promise<void>}
 */
const ensureBank = async (baseUrl, apiKey, bankId, config) => {
	try {
		await getBankProfile(baseUrl, apiKey, bankId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const notFound = /404|not found/i.test(message);
		const methodNotAllowed = /405|method not allowed/i.test(message);
		if (methodNotAllowed) return; // bank exists; profile is at a different path
		if (!notFound || !config.autoCreateBank) throw error;
		await createBank(baseUrl, apiKey, bankId, {
			name: bankId,
			background: `Persistent coding memory for zcode workspace ${config.workspace}`,
		});
	}
};

/**
 * Recall memories. Mirrors HindsightClient.recall.
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {string} query
 * @param {{types?: string[], budget?: string, maxTokens?: number, tags?: string[]}} [options]
 * @returns {Promise<any>}
 */
const recall = (baseUrl, apiKey, bankId, query, options = {}) =>
	apiRequest(
		baseUrl,
		apiKey,
		`/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
		{
			method: "POST",
			body: {
				query,
				types: options.types,
				max_tokens: options.maxTokens,
				budget: options.budget || "mid",
			},
		},
	);

/**
 * Reflect (synthesize). Mirrors HindsightClient.reflect.
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {string} query
 * @param {{context?: string, budget?: string}} [options]
 * @returns {Promise<any>}
 */
const reflect = (baseUrl, apiKey, bankId, query, options = {}) =>
	apiRequest(baseUrl, apiKey, `/v1/default/banks/${encodeURIComponent(bankId)}/reflect`, {
		method: "POST",
		body: {
			query,
			context: options.context,
			budget: options.budget || "low",
		},
	});

/**
 * Retain a single memory. Mirrors HindsightClient.retain -> retainBatch.
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {string} content
 * @param {{context?: string, tags?: string[], entities?: string[], documentId?: string, asyncRetain?: boolean}} [options]
 * @returns {Promise<any>}
 */
const retain = (baseUrl, apiKey, bankId, content, options = {}) =>
	apiRequest(baseUrl, apiKey, `/v1/default/banks/${encodeURIComponent(bankId)}/memories`, {
		method: "POST",
		body: {
			items: [
				{
					content,
					context: options.context,
					tags: options.tags,
					entities: options.entities,
					document_id: options.documentId,
				},
			],
			async: options.asyncRetain ?? true,
		},
	});

/**
 * List all banks.
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @returns {Promise<any>}
 */
const listBanks = (baseUrl, apiKey) => apiRequest(baseUrl, apiKey, "/v1/default/banks");

/**
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
const fetchTopTags = async (baseUrl, apiKey, bankId, limit) => {
	try {
		const result = await apiRequest(
			baseUrl,
			apiKey,
			`/v1/default/banks/${encodeURIComponent(bankId)}/tags?limit=${limit}`,
		);
		return Array.isArray(result?.items) ? result.items : [];
	} catch {
		return [];
	}
};

/**
 * @param {string} baseUrl
 * @param {string|undefined} apiKey
 * @param {string} bankId
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
const fetchTopEntities = async (baseUrl, apiKey, bankId, limit) => {
	try {
		const result = await apiRequest(
			baseUrl,
			apiKey,
			`/v1/default/banks/${encodeURIComponent(bankId)}/entities?limit=${limit}`,
		);
		return Array.isArray(result?.items) ? result.items : [];
	} catch {
		return [];
	}
};

module.exports = {
	apiRequest,
	getBankProfile,
	createBank,
	ensureBank,
	recall,
	reflect,
	retain,
	listBanks,
	fetchTopTags,
	fetchTopEntities,
};
