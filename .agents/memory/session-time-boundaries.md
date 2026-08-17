---
name: Session time boundaries
description: CME session windows must be computed in America/New_York with DST, via the shared session-bounds module.
---

**Rule:** Any server-side logic touching RTH/overnight session boundaries must use the shared DST-aware session-bounds helper (ET-based, RTH 9:30 AM–4:15 PM ET), never fixed UTC minute constants.

**Why:** A completion review rejected fixed-UTC boundaries: in winter they shift by an hour (include RTH bars, miss overnight bars), and naive "yesterday close → today open" windows ignore the new session that starts forming right after the 4:15 PM ET close.

**How to apply:** When adding new session-relative levels (prior-day H/L/C, initial balance, ORB), reuse the session-bounds module and add deterministic tests for both an EST date and an EDT date plus the post-close forming phase.
