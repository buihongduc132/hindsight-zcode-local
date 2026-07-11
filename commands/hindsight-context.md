---
description: Synthesize a contextual answer from Hindsight memories (reflect). Slower but coherent.
---

# /hindsight-context

Ask Hindsight to reflect across the project's memories and synthesize a coherent answer.

## What to do

1. Run the `hindsight_context` tool with:
   - `query` = the user's question (`$ARGUMENTS`)
   - `budget` = `low` unless the user asked for broader recall
2. Present the synthesized answer.
3. Note this uses server-side LLM synthesis; if it returns empty, the model backend may be down — fall back to `hindsight_search`.

Argument: `$ARGUMENTS`
