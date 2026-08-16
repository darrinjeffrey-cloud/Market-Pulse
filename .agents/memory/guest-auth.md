---
name: Guest auth pattern
description: How guest invite links work in Market Posture — JWT signing, URL token consumption, admin-only UI.
---

# Guest auth pattern

## The rule
Guest access uses short-lived JWTs signed with `SESSION_SECRET` (not `API_TOKEN`). The auth middleware accepts both the raw `API_TOKEN` string and a valid guest JWT.

**Why:** Avoids sharing the main operator token with team members. Guests can be expired individually by setting a TTL at invite time.

## How to apply
- `artifacts/api-server/src/lib/guest-auth.ts` — `signGuestToken(ttl, label)` / `verifyGuestToken(token)`
- `artifacts/api-server/src/routes/auth.ts` — `POST /api/auth/invite` (admin-only), `GET /api/auth/validate`
- `artifacts/api-server/src/app.ts` — middleware checks raw token first, then tries `verifyGuestToken()`
- `artifacts/futures-alignment/src/lib/auth.ts` — `consumeUrlToken()` reads `?token=` from URL, stores in sessionStorage, strips from address bar
- `artifacts/futures-alignment/src/components/LoginGate.tsx` — calls `/api/auth/validate` on mount to detect role; handles URL tokens automatically
- `artifacts/futures-alignment/src/components/InvitePanel.tsx` — admin-only dialog; calls `POST /api/auth/invite`; renders shareable URL
- `artifacts/futures-alignment/src/components/market-dashboard.tsx` — shows invite button only when `isAdmin` (determined by calling `/api/auth/validate` on mount)

## TTL options
`"1h" | "8h" | "24h" | "7d" | "30d"` — defined in `guest-auth.ts` TTL_SECONDS map.

## Edge cases
- `SESSION_SECRET` must be set or signing throws. It is already set as a Replit secret.
- Guest tokens carry `{ role: "guest", label: string }` — the validate endpoint returns this so the UI can distinguish admin vs guest.
- URL token strips itself from the address bar after first read (no bookmark leakage).
