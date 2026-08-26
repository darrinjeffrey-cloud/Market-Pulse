---
name: ICT signal selection
description: The bias and fair-value-gap rules that keep ICT setups actionable without chasing stale patterns.
---

ICT directional bias should represent sustained EMA-confirmed market structure,
not require the very latest bar to make a new swing extreme. A valid setup must
prove the ordered chain from external-liquidity sweep and reclaim through CHoCH
displacement into a newly formed, unfilled FVG. The current close must still be
inside that FVG entry zone; a historical touch must not leave a chase signal active.

**Why:** Treating every normal pullback as neutral suppressed otherwise valid
setups. Selecting a gap without enforcing causality could pair a sweep with an old,
filled, or opposing gap, while keeping a signal after price left the gap encouraged
late entries.

**How to apply:** Confirm 15M and 5M bias using EMA alignment plus recent
structure. For trade entry, require a reclaimed external-liquidity sweep, a
body-qualified 5M CHoCH displacement, a gap formed by that displacement, and a
timely retracement whose current close remains in the gap. Expire invalid or missed
entries and keep the minimum risk/reward gate intact.