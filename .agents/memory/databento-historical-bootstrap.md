---
name: Databento historical bootstrap
description: The availability boundary required when hydrating market history after a server restart.
---

Historical hydration must cap its request end at the last safely closed minute as
well as the prior completed UTC-day boundary.

**Why:** Immediately after UTC midnight, Databento can reject a range ending
exactly at midnight because that final minute is not yet finalized. A failed
bootstrap leaves session-dependent engines without prior-session liquidity data
until their next retry.

**How to apply:** When changing or reusing historical range requests, derive the
end from an ingest-safe completed-minute cutoff and never assume midnight data is
available at the instant the date rolls over.