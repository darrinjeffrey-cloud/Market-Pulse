# Market Posture

A live futures market dashboard that answers one question in real time: *Is the tape aligned?* — showing multi-timeframe volume, volatility, trend direction, and Globex VWAP-reversion trade setups for ES, NQ, MES, and MNQ contracts.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/futures-alignment run dev` — run the web dashboard (port 22434)
- `pnpm --filter @workspace/futures-mobile run dev` — run the Expo mobile app (port 24950)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm run typecheck` — full typecheck across all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + SSE for live market streaming
- Web: React 19 + Vite 7 + Tailwind v4 + shadcn/ui
- Mobile: Expo 54 + React Native + Expo Router
- Data: Databento (live intraday feed via WebSocket + historical REST)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/market-engine.ts` — core market snapshot state + Databento polling
- `artifacts/api-server/src/lib/databento-live.ts` — live TCP feed client (WebSocket/MBP)
- `artifacts/api-server/src/lib/vwap-engine.ts` — VWAP reversion signal computation
- `artifacts/api-server/src/routes/market.ts` — REST + SSE route handlers
- `artifacts/futures-alignment/src/components/market-dashboard.tsx` — main web UI
- `artifacts/futures-alignment/src/components/VwapPanel.tsx` — VWAP reversion panel
- `artifacts/futures-mobile/app/index.tsx` — mobile home screen
- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts

## Architecture decisions

- SSE stream (`/api/market/stream`) pushes updated snapshots to the web/mobile client ~once per minute as new bars arrive; polling fallback every 60s ensures mobile clients backgrounded through the gap still recover.
- VWAP computations run on the server using the same cached bar data as the main snapshot — no extra Databento calls.
- Bearer token auth (`API_TOKEN` env var) is optional; unset means all `/api` routes are open (dev default).
- Expo mobile uses `EXPO_PUBLIC_DOMAIN` and SSE query-param auth (`?token=`) because `EventSource` cannot send custom headers.

## Product

**Web (Market Posture):** Dark terminal-aesthetic dashboard showing ES, NQ, MES, MNQ. KPI summary bar, per-symbol cards with multi-timeframe signal badges, and a Globex VWAP reversion section. Session-aware (shows weekend/pre-market state when markets are closed).

**Mobile (Market Posture Mobile):** Companion Expo app with real-time contract cards via SSE stream. Matches the dark aesthetic; optimized for at-a-glance reading on the go.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `DATABENTO_API_KEY` must be set for live data. Without it the API server starts and responds but returns an "unavailable" source in all snapshots.
- The live feed attempts a TCP connection on startup; missing API key prints a WARN but does not crash.
- Run codegen (`pnpm --filter @workspace/api-spec run codegen`) whenever `lib/api-spec/openapi.yaml` changes before touching frontend code.
- Do NOT run `pnpm dev` at workspace root — run each artifact individually or use the managed workflows.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
