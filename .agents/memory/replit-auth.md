---
name: Replit Auth migration
description: OIDC-based auth replacing the old API_TOKEN + guest JWT system in Market Posture.
---

## Auth architecture (current)

- **Server**: Express session middleware (`authMiddleware`) reads `sid` cookie or `Authorization: Bearer <sid>` header.
- **Sessions**: Stored in Postgres `sessions` table (Drizzle, `sessionsTable`). Users in `users` table.
- **OIDC**: `openid-client` library; issuer `https://replit.com/oidc`; client_id = `REPL_ID`.
- **Email allowlist**: `ALLOWED_EMAIL=darrinjeffrey@gmail.com` env var. Checked in `/callback` and `/mobile-auth/token-exchange` before creating a session. If mismatch → 403.
- **Market routes protected**: Middleware in `app.ts` gates all `req.path.startsWith("/api/market/")` paths — returns 401 if `!req.isAuthenticated()`.
- **Web auth**: `LoginGate.tsx` uses `useAuth()` from `@workspace/replit-auth-web`. Login → `/api/login` (redirects to Replit OIDC). Cookies set server-side; `credentials: 'include'` added globally to `customFetch`.
- **Mobile auth**: `AuthProvider` in `lib/auth.tsx` uses `expo-auth-session` PKCE flow → `/api/mobile-auth/token-exchange` → SecureStore.
- **Logout web**: `window.location.href = '/api/logout'` in dashboard header button.

**Why:** Bearer token was impractical to type; sole user wanted SSO via Replit/Google account.

## What was removed
- `artifacts/api-server/src/lib/guest-auth.ts` (JWT sign/verify)
- `artifacts/futures-alignment/src/components/InvitePanel.tsx`
- `getAuthHeaders()`, `getStoredToken()`, `logout()` from `lib/auth.ts` — web app no longer uses token-based auth.
- Bearer-token gating middleware from `app.ts`.
- `isAdmin`, `inviteOpen` state from `market-dashboard.tsx`.

## Env vars required
- `SESSION_SECRET` — used by openid-client internally (cookie signing)
- `ALLOWED_EMAIL` — allowlist email (`darrinjeffrey@gmail.com`)
- `REPL_ID` — automatically injected by Replit; used as OIDC client_id
- `DATABASE_URL` — for session/user storage

## Packages added
- `openid-client` → `@workspace/api-server`
- `expo-auth-session@~7.0.10`, `expo-crypto@~15.0.8` → `@workspace/futures-mobile`
- `vite` (dev) → `@workspace/replit-auth-web`
- New workspace lib: `lib/replit-auth-web/`
