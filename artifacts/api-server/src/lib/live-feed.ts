/**
 * live-feed.ts
 *
 * Provides real-time 1-minute bar updates using the Databento Live TCP gateway.
 * Falls back to polling the historical API every 60s when the live connection
 * is down (outside market hours, network issues, reconnects).
 *
 * Architecture:
 *  1. DatabentoLiveClient opens a persistent TCP connection to {dataset}.lsg.databento.com:13000.
 *     On every completed 1m bar, it calls storeBar() + rebuildSnapshot().
 *  2. The 60s polling loop runs in parallel as a safety net — it deduplicates
 *     bars by timestamp (high-water mark), so there is no double-counting even
 *     when both sources deliver the same bar.
 *  3. isLiveConnected in the market snapshot reflects TCP connection state so
 *     the frontend can show "LIVE" vs "POLLING".
 */

import { logger } from "./logger";
import {
  storeBar,
  storeRows,
  rebuildSnapshot,
  asTimestamp,
  parseDatabentoJsonLines,
  getWatchedSymbols,
  setLiveConnected,
  setSymbolAddedHook,
} from "./market-engine";
import { DatabentoLiveClient, type OhlcvBar } from "./databento-live";

const DATASET = "GLBX.MDP3";

// How far back from "now" to cap the end timestamp so we only request bars
// that have already closed. 1-minute bars close at :00 each minute, and
// Databento's ingest pipeline adds a few seconds of latency, so 90 seconds
// is a safe buffer that avoids "data_end_after_available_end" errors.
const INGEST_LAG_MS = 90_000;

// Poll interval: align with bar close cadence (one bar per minute).
// Even with the live stream active this runs as a catch-up/fallback.
const POLL_INTERVAL_MS = 60_000;

// Per-symbol high-water mark: the latest bar timestamp we've already stored.
// Initialized lazily so we don't re-fetch bars the bootstrap already loaded.
const lastBarTs = new Map<string, number>();

let liveClient: DatabentoLiveClient | null = null;
let pollTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// High-water mark helper
// ---------------------------------------------------------------------------

/** Return the latest bar timestamp already in the buffer for a symbol. */
function latestBufferTs(symbol: string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buffers } = require("./market-engine") as { buffers: Map<string, { ts: number }[]> };
  const buf = buffers.get(symbol);
  if (!buf || buf.length === 0) return 0;
  return buf[buf.length - 1].ts;
}

// ---------------------------------------------------------------------------
// 60-second polling fallback
// ---------------------------------------------------------------------------

async function fetchIntradayBars(): Promise<void> {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) return;

  const auth = Buffer.from(`${apiKey}:`).toString("base64");
  const now = Date.now();

  const endMs = Math.floor((now - INGEST_LAG_MS) / 60_000) * 60_000;
  const end = new Date(endMs);

  const d = new Date(now);
  const todayMidnightMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  if (endMs <= todayMidnightMs) return;

  let gotNewData = false;

  await Promise.allSettled(
    getWatchedSymbols().map(async (symbol) => {
      if (!lastBarTs.has(symbol)) {
        const bufTs = latestBufferTs(symbol);
        if (bufTs > 0) lastBarTs.set(symbol, bufTs);
      }

      const hwm = lastBarTs.get(symbol) ?? 0;
      const startMs = Math.max(todayMidnightMs, hwm > 0 ? hwm + 60_000 : 0);
      const start = new Date(startMs);

      if (startMs >= endMs) return;

      const params = new URLSearchParams({
        dataset: DATASET,
        schema: "ohlcv-1m",
        symbols: symbol,
        stype_in: "continuous",
        start: start.toISOString(),
        end: end.toISOString(),
        encoding: "json",
      });

      const response = await fetch(
        `https://hist.databento.com/v0/timeseries.get_range?${params.toString()}`,
        {
          headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        },
      );

      const body = await response.text();

      if (!response.ok) {
        if (body.includes("data_end_after_available_end")) {
          logger.debug({ symbol }, "Polling: today's bars not yet available");
        } else {
          logger.warn({ symbol, status: response.status }, "Polling: intraday fetch failed");
        }
        return;
      }

      const rows = parseDatabentoJsonLines(body);
      if (rows.length === 0) return;

      logger.info({ symbol, rowCount: rows.length }, "Polling: intraday bars received");
      storeRows(symbol, rows);
      gotNewData = true;

      // Advance the high-water mark
      const lastRow = rows[rows.length - 1];
      const hd = lastRow.hd as Record<string, unknown> | undefined;
      const tsRaw = hd?.ts_event ?? lastRow.ts_event ?? lastRow.timestamp ?? lastRow.ts;
      const ts = asTimestamp(tsRaw);
      const current = lastBarTs.get(symbol) ?? 0;
      if (ts > current) lastBarTs.set(symbol, ts);
    }),
  );

  if (gotNewData) {
    rebuildSnapshot();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the live feed. Should be called once on server startup.
 * Launches the Databento Live TCP client and the polling fallback.
 */
export function startLiveFeed(): void {
  if (pollTimer) return; // already started

  // Register the hook so addWatchedSymbol can subscribe new symbols on the
  // active TCP connection without creating a circular import.
  setSymbolAddedHook((symbol: string) => {
    if (liveClient) {
      liveClient.subscribeLiveSymbol(symbol);
    }
  });

  const apiKey = process.env.DATABENTO_API_KEY;

  if (apiKey) {
    liveClient = new DatabentoLiveClient(apiKey, DATASET, getWatchedSymbols());

    liveClient.on("bar", (bar: OhlcvBar) => {
      // Advance the high-water mark for this symbol so the polling fallback
      // doesn't re-fetch bars we already received from the live stream.
      const current = lastBarTs.get(bar.symbol) ?? 0;
      if (bar.ts > current) lastBarTs.set(bar.symbol, bar.ts);

      storeBar(bar.symbol, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume);
      rebuildSnapshot();
    });

    liveClient.on("connected", () => {
      setLiveConnected(true);
      rebuildSnapshot();
      logger.info("Databento Live TCP stream connected — real-time bars active");
    });

    liveClient.on("disconnected", () => {
      setLiveConnected(false);
      rebuildSnapshot();
      logger.info("Databento Live TCP stream disconnected — falling back to polling");
    });

    liveClient.start();
  }

  // Polling fallback: runs regardless of live stream state.
  // Immediate first poll to hydrate the current session without waiting a minute.
  void fetchIntradayBars().catch((err: unknown) => {
    logger.warn({ err }, "Polling: initial poll failed");
  });

  pollTimer = setInterval(() => {
    void fetchIntradayBars().catch((err: unknown) => {
      logger.warn({ err }, "Polling: poll failed");
    });
  }, POLL_INTERVAL_MS);

  pollTimer.unref();
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "Live feed started (TCP + polling fallback)");
}

export function stopLiveFeed(): void {
  liveClient?.stop();
  liveClient = null;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
