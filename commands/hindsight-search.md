---
description: Search durable memory in Hindsight (recall). Reuses the same banks as the pi agent.
---

# /hindsight-search

Search the project's Hindsight bank using recall. The argument is the natural-language query.

## What to do

1. Run the `hindsight_search` tool with:
   - `query` = the user's argument (`$ARGUMENTS`)
   - `budget` = `mid` unless the user asked for a different breadth
2. Present the recalled memories grouped by type.
3. If nothing useful returns, offer to widen to `budget: high` or to run `hindsight_context` for a synthesized answer.

## Tips

- Use entity names, dates, and symptom words in the query for best recall.
- This shares banks with pi — anything pi stored is recallable here.

Argument: `$ARGUMENTS`
