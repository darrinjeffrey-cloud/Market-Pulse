---
name: ICT liquidity pools
description: The invariant required for ICT BSL/SSL sweep detection.
---

ICT BSL and SSL sweep levels must be established before the active sweep
window. Prior-day and overnight highs/lows are valid external liquidity pools;
current-session high/low values should not be used as the sweep target for the
same complete session.

**Why:** Comparing a bar against the maximum high or minimum low that already
includes that bar makes a sweep mathematically impossible, causing the engine
to return WAIT even while the endpoint is healthy.

**How to apply:** Keep current-session extrema for display or context, but use
prior-day/overnight levels when evaluating the five-bar breach-and-reclaim
condition.