# Threat Model

## Project Overview

A Node.js/Express (v5) API server that streams real-time and historical futures market data via the Databento data feed (TCP live gateway + REST historical API). A React frontend ("Futures Alignment Monitor") consumes the API over HTTP/SSE. Deployed publicly on Replit autoscale at `https://dj-first-project.replit.app`. No user accounts or authentication system exists; the application is a single-tenant market-data dashboard.

Tech stack: Node.js 24, Express 5, Pino logger, Drizzle ORM (PostgreSQL via `DATABASE_URL`), pnpm workspaces, TypeScript 5.9.

## Assets

- **Databento API key** (`DATABENTO_API_KEY` env var) — used to authenticate to Databento's historical REST API and live TCP gateway. Compromise allows arbitrary billable Databento API calls, financial cost, data exfiltration.
- **Live market data** — real-time OHLCV bar data fetched from Databento; intended for internal dashboard use.
- **Server-wide watchlist state** — in-memory set of watched futures symbols; mutations trigger billable Databento API calls and affect all users.
- **Database connection** (`DATABASE_URL`) — PostgreSQL connection string; compromise allows full data access.

## Trust Boundaries

- **Internet → API server** — all `/api/*` routes are publicly reachable with no authentication. The server must be treated as fully untrusted at this boundary.
- **API server → Databento REST** — outbound HTTPS; credentials are the `DATABENTO_API_KEY` env var. Any code path that reaches this with attacker-controlled parameters is SSRF-adjacent.
- **API server → Databento Live TCP** — persistent TCP connection to `live.databento.com:13000`; credentials are the same API key.
- **API server → PostgreSQL** — trusted internal boundary; Drizzle ORM used for queries.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/routes/market.ts`, `artifacts/api-server/src/routes/health.ts`
- Highest-risk code areas: `addWatchedSymbol` in `market-engine.ts`, SSE handler in `market.ts`, CORS config in `app.ts`
- All API routes are public (no auth layer present)
- `artifacts/mockup-sandbox/` and `artifacts/futures-alignment/` are frontend/design artifacts — not server-side production risk
- Dev-only: mockup sandbox at `/__mockup`

## Threat Categories

### Spoofing / Authentication

There is no authentication on any API endpoint. All state-mutating routes (POST/DELETE watchlist) and data-streaming routes are callable by any internet user. For a single-tenant read-only dashboard this is acceptable for read paths, but write paths that trigger billable external API calls must be protected.

Guarantee required: "POST /api/market/watchlist and DELETE /api/market/watchlist/:symbol MUST require authentication or be restricted to trusted callers."

### Tampering

POST /api/market/watchlist accepts a `symbol` parameter from anonymous internet users. Although it is validated against a hardcoded catalog, each new symbol triggers a Databento historical-data bootstrap fetch (billable) and subscribes the symbol on the live TCP stream. An attacker can add all ~30 catalog symbols, repeatedly, causing excess API spend.

Guarantee required: "Watchlist mutation endpoints MUST be rate-limited and authenticated."

### Denial of Service

The `/api/market/stream` SSE endpoint has no authentication, no connection limit, and no rate limiting. Each connected client holds an EventEmitter listener on `marketEvents` indefinitely. An attacker can open thousands of concurrent SSE connections, exhausting file descriptors and memory. Node.js will also emit `MaxListenersExceededWarning` after 10 listeners.

Guarantee required: "The SSE stream endpoint MUST enforce a connection limit and rate limit per IP."

### Information Disclosure

CORS is configured with `app.use(cors())` (wildcard `*`), allowing any web origin to read API responses. For public market data this may be intentional, but if any future endpoint returns sensitive data (user info, DB records), it will be exposed cross-origin without additional controls.

Guarantee required: "CORS origin policy MUST be explicitly scoped to known frontend origins before any authenticated or private data is exposed via the API."

### Elevation of Privilege

No privilege separation exists. There are no admin routes currently. Drizzle ORM is used for DB access (parameterized — low SQL injection risk). No file uploads, no shell execution, no template rendering.
