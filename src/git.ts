/**
 * Minimal git helper. Mirrors extensions/git.ts (execGit) from hindsight-pi-local.
 * Typed, with an explicit result type (no null-return ambiguity at call sites).
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  readonly kind: "exec";
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitError {
  readonly kind: "git-error";
  readonly message: string;
}

/** A spawn that failed to start (ENOENT, etc.) vs a git that exited non-zero. */
export type GitResult = ExecResult | GitError;

const isGitError = (r: GitResult): r is GitError => r.kind === "git-error";

export const execGit = (
  cwd: string,
  args: readonly string[],
  timeoutMs = 5000,
): Promise<GitResult> =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on("data", (d: Buffer) => stderrChunks.push(d));
    child.on("error", (err: NodeJS.ErrnoException) =>
      resolve({ kind: "git-error", message: err.message }),
    );
    child.on("close", (code) =>
      resolve({
        kind: "exec",
        code: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      }),
    );
  });

/** Run a git command, returning stdout trimmed if exit 0, else undefined. */
export const gitOutput = async (
  cwd: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<string | undefined> => {
  const result = await execGit(cwd, args, timeoutMs);
  if (isGitError(result)) return undefined;
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
};
