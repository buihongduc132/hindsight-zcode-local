---
name: hindsight-usage
description: Use this whenever you are finding information in hindsight (recall, reflect, search, retain) via the zcode hindsight plugin. Provides the hindsight_search, hindsight_context, and hindsight_retain tools and how to use them.
---

# Hindsight Usage (ZCode)

ZCode's hindsight plugin exposes THREE tools that talk to the SAME hindsight banks the pi
agent uses. Both read `~/.hindsight/config.json` and resolve identical bank IDs, so any
fact pi retained is recallable from zcode and vice versa.

## The three tools

| Tool | API | When |
|------|-----|------|
| `hindsight_search` | recall | Raw durable-memory hits. "What happened with X?" |
| `hindsight_context` | reflect | Synthesized answer across memories. "What should I do about X?" |
| `hindsight_retain` | retain | Store a durable fact. ONLY when explicitly asked or for genuinely reusable knowledge. |

## Search strategy

| What you want | Query pattern | Why it works |
|---------------|---------------|--------------|
| Mistakes & failures | `"mistake" OR "flip-flop" OR "wrong" OR "false claim"` | Catches self-corrections |
| Deployment disasters | `"CI pipeline" OR "Docker" OR "ENOSPC" OR "staging failed"` | Infra pain is well-documented |
| Verification gaps | `"blind retrigger" OR "unverified" OR "proven false"` | Explicit false-claim tags |
| What worked | `"lesson learned" OR "golden rule" OR "always" OR "must"` | Positive patterns stored as imperatives |
| Architecture decisions | `"flip" OR "reverted" OR "interim" OR "architecture decision"` | Flip-flops documented |

## Budgets

- `low` → fast, 5-10 results
- `mid` (default for search) → balanced, 15-25 results
- `high` → comprehensive, 30-50 results — use for post-mortems

## Memory types

- `observation` — facts discovered (what happened)
- `experience` — lessons and actions (what was learned)
- `world` — general knowledge

## Tool selection

- `hindsight_search` → raw recall, good for "what happened with X"
- `hindsight_context` → synthesized answer, good for "what should I do about X" (slower; LLM synthesis)

## Pro tips

1. Use entity names in queries (backend, frontend, `<packageName>`, `<moduleName>`, milestones) — they're tagged naturally and narrow results.
2. Date-anchored queries work well — include "June 11" or "2026-06" because memories have timestamps.
3. Use `hindsight_banks` (with `listAll: false`) to see which bank + top tags/entities you're connected to before searching.

## Anti-pattern: symptom > cause

Search for the symptom, not the abstract lesson:
- Symptom: `"spun 4 iterations"` → finds the spinning pattern
- These are more memorable than abstract lesson names.

## Retaining

Call `hindsight_retain` ONLY when:
- the user explicitly asks to remember/store something, OR
- you've discovered a genuinely durable, reusable fact (a decision, a lesson, an architecture truth).

Never retain transient state, the current task list, or routine progress.
