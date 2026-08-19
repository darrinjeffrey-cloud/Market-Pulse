---
name: Globex VWAP session
description: The intended time boundaries for VWAP-reversion signals and VWAP accumulation.
---

VWAP-reversion signals and VWAP accumulation use the full CME equity-index
Globex trading session: Sunday 6:00 PM ET through Friday 5:00 PM ET. Each
session resets at 6:00 PM ET. No signal may be published during the daily
5:00–6:00 PM ET maintenance break or the weekend closure.

**Why:** Traders need the same anchored VWAP reference across the overnight,
RTH, and post-RTH portions of the CME session; restricting the calculation to
RTH hides valid overnight setups and changes the reference at the open.

**How to apply:** Use the shared DST-aware ET session helper for all VWAP
filters, snapshots, time series, and signal gating. Do not introduce fixed UTC
cutoffs or independent RTH-only VWAP windows.