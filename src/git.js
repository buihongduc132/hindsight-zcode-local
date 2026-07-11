"use strict";
// @ts-check
/**
 * Minimal git helper. Mirrors extensions/git.ts (execGit) from hindsight-pi-local.
 * @typedef {{ code: number; stdout: string; stderr: string }} ExecResult
 */

const { spawn } = require("node:child_process");

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<ExecResult|null>}
 */
const execGit = (cwd, args, timeoutMs = 5000) =>
	new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});
		/** @type {Buffer[]} */ let stdout = [];
		/** @type {Buffer[]} */ let stderr = [];
		child.stdout.on("data", (d) => stdout.push(d));
		child.stderr.on("data", (d) => stderr.push(d));
		child.on("error", () => resolve(null));
		child.on("close", (code) =>
			resolve({
				code: code ?? 0,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
	});

module.exports = { execGit };
