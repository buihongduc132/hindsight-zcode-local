/**
 * Response formatting for tool output and hook injection.
 *
 * Consumers receive ALREADY-PARSED values (NormalizedRecallResult, etc.) from the
 * client layer — there is no field-name branching here, which eliminates the
 * silent-drop bug class at the formatting seam too.
 */
import { itemText, type NormalizedRecallResult } from "./types.ts";

export interface StatusLine {
  readonly bankId: string;
  readonly action: "recall" | "reflect" | "retain";
  readonly mode: "sync" | "async";
  readonly result: "success" | "error";
  readonly durationMs: number;
  readonly count?: number;
}

export const formatHindsightStatus = (s: StatusLine): string => {
  const parts = [`bank=${s.bankId}`, `action=${s.action}`, s.mode, s.result, `${String(s.durationMs)}ms`];
  if (s.count !== undefined) parts.push(`n=${String(s.count)}`);
  return `[hindsight ${parts.join(" ")}]`;
};

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Format a parsed recall result. Uses the canonical .items array (never raw fields). */
export const formatRecallResults = (result: NormalizedRecallResult, previewLength: number): string => {
  const items = result.items;
  if (items.length === 0) return "(no memories recalled)";
  const byType = new Map<string, typeof items>();
  for (const item of items) {
    const type = item.type ?? "memory";
    const bucket = byType.get(type) ?? [];
    bucket.push(item);
    byType.set(type, bucket);
  }
  const lines: string[] = [];
  for (const [type, bucket] of byType) {
    lines.push(`${type} (${String(bucket.length)}):`);
    for (const item of bucket) {
      const text = truncate(itemText(item), previewLength);
      const score = typeof item.score === "number" ? ` {score=${item.score.toFixed(3)}}` : "";
      lines.push(`  - ${text}${score}`);
    }
  }
  return lines.join("\n");
};

export const formatReflectResult = (result: { answer: string; items: NormalizedRecallResult["items"] }): string => {
  const answer = result.answer.trim();
  if (!answer && result.items.length === 0) return "(no synthesized answer)";
  const lines: string[] = [];
  if (answer) lines.push(answer);
  if (result.items.length > 0) {
    lines.push("", `Sources (${String(result.items.length)}):`);
    for (const item of result.items.slice(0, 5)) {
      lines.push(`  - ${truncate(itemText(item), 200)}`);
    }
  }
  return lines.join("\n");
};

export const formatRetainResult = (
  result: { id?: string | number | undefined; success?: boolean | undefined; status?: string | undefined },
): string => {
  const ok = result.success !== false;
  const id = result.id !== undefined ? ` id=${String(result.id)}` : "";
  const status = result.status ? ` status=${result.status}` : "";
  return `${ok ? "retained" : "failed"}${id}${status}`;
};
