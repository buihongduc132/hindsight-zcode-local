---
description: Store a durable fact into Hindsight for future recall. Shared with the pi agent.
---

# /hindsight-retain

Store a durable fact/memory into the project's Hindsight bank.

## What to do

1. Run the `hindsight_retain` tool with:
   - `content` = the user's argument (`$ARGUMENTS`)
   - optionally `context` = "When: ... / Involving: ..." if the user gave context
   - optionally `tags` = relevant tags if obvious (e.g. `["lesson-learned"]`)
2. Confirm what was retained and into which bank.

## Guard

Only retain genuinely durable, reusable knowledge (decisions, lessons, architecture facts).
Do not retain transient state or routine progress.

Argument: `$ARGUMENTS`
