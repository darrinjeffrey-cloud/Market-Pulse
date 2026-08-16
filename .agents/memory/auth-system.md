---
name: Auth system
description: How Market Posture authentication works — password gate replacing Replit OIDC.
---

# Auth System

## Current approach: password gate

Password from `ADMIN_PASSWORD` env secret is checked server-side. On success, a session ID is stored in the Postgres `sessions` table and returned as an `httpOnly` cookie (`sid`). Mobile uses `Authorization: Bearer <sid>`.

**Why:** Replit OIDC caused blank windows in the Replit preview iframe because the OAuth redirect left the iframe context. A simple password field POST to `/api/login` has no redirects.

**How to apply:**
- Web: `LoginGate` → `useAuth()` from `lib/replit-auth-web` → `login(password)` → POST `/api/login`
- Mobile: `LoginScreen` component → `AuthProvider.login(password)` → POST `/api/mobile-auth/login` → stores `sid` in SecureStore
- Logout: POST `/api/logout` (web) or POST `/api/mobile-auth/logout` (mobile)
- All `/api/market/*` routes gated by `authMiddleware` in `app.ts`

## Invite links

Admin-only feature. Token stored in `invite_tokens` Postgres table. Visiting `/api/invite/:token` creates a guest session (`user.id = 'guest'`) and redirects to `/`. Admin can set label + duration (24h/7d/30d), copy URLs, and revoke. UI is a dialog opened via the link-icon button in the dashboard header.

**Why:** Guest sessions use the same session cookie mechanism as admin; only the origin differs (`id: 'guest'` vs `id: 'admin'`). Admin-only routes check `req.user?.id === 'admin'`.

## Key files
- `artifacts/api-server/src/routes/auth.ts` — login/logout/mobile endpoints
- `artifacts/api-server/src/lib/auth.ts` — session CRUD (no OIDC)
- `artifacts/api-server/src/middlewares/authMiddleware.ts` — sets `req.user` from session
- `lib/replit-auth-web/src/use-auth.ts` — web hook
- `artifacts/futures-alignment/src/components/LoginGate.tsx` — password form
- `artifacts/futures-mobile/lib/auth.tsx` — mobile AuthProvider
- `artifacts/futures-mobile/components/LoginScreen.tsx` — mobile password UI
- `artifacts/futures-mobile/app/_layout.tsx` — shows LoginScreen when not authenticated
