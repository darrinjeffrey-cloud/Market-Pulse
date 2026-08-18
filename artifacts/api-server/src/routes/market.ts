import { Router, type IRouter } from "express";
import { GetMarketSnapshotResponse } from "@workspace/api-zod";
import {
  getMarketSnapshot,
  refreshMarketData,
  startMarketData,
  marketEvents,
  getCatalog,
  getWatchedSymbols,
  addWatchedSymbol,
  removeWatchedSymbol,
  type MarketSnapshot,
} from "../lib/market-engine";
import { startLiveFeed } from "../lib/live-feed";
import { computeOrbSnapshot } from "../lib/orb-engine";
import { computeVwapSnapshot, computeVwapSeriesSnapshot } from "../lib/vwap-engine";
import { computeOvernightSnapshot } from "../lib/overnight-engine";

const router: IRouter = Router();

// Bootstrap historical data (yesterday for indicator context) then start the
// live intraday feed which polls every ~60s for today's session bars.
startMarketData();
startLiveFeed();

router.get("/market/snapshot", async (req, res): Promise<void> => {
  const cached = getMarketSnapshot();
  // Only block on a live Databento fetch if we have no data yet.
  if (cached.source === "unavailable" && Object.keys(cached.markets).length === 0) {
    await refreshMarketData();
  }
  const snapshot = GetMarketSnapshotResponse.parse(getMarketSnapshot());
  req.log.debug(
    { source: snapshot.source, symbols: Object.keys(snapshot.markets).length },
    "Returning market snapshot",
  );
  res.json(snapshot);
});

router.get("/market/stream", async (req, res): Promise<void> => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Tell the browser to reconnect after 1 s if the stream drops (default is 3 s).
  res.write("retry: 1000\n\n");

  const sendSnapshot = (snapshot: MarketSnapshot) => {
    try {
      const parsed = GetMarketSnapshotResponse.parse(snapshot);
      res.write(`event: market\nid: ${parsed.timestamp}\ndata: ${JSON.stringify(parsed)}\n\n`);
    } catch {
      // Zod parse failure — skip this event rather than crashing the stream
    }
  };

  // Send an initial snapshot immediately so the client isn't left waiting.
  // If we have no data yet, trigger a fetch first.
  const cached = getMarketSnapshot();
  if (cached.source === "unavailable" && Object.keys(cached.markets).length === 0) {
    await refreshMarketData();
  }
  sendSnapshot(getMarketSnapshot());

  // Push every time a new bar is ingested and the snapshot is rebuilt.
  // This fires ~once per minute when the live feed delivers a new bar.
  marketEvents.on("snapshot", sendSnapshot);

  // Heartbeat every 10 s — keeps the connection alive through Replit's proxy
  // layer which drops idle SSE streams. 25 s was too slow; proxy timeouts can
  // be as short as 15-20 s on the dev preview path.
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 10_000);

  req.on("close", () => {
    marketEvents.off("snapshot", sendSnapshot);
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------------------
// Catalog & watchlist
// ---------------------------------------------------------------------------

router.get("/market/catalog", (_req, res): void => {
  res.json(getCatalog());
});

router.get("/market/watchlist", (_req, res): void => {
  res.json({ symbols: getWatchedSymbols() });
});

router.post("/market/watchlist", async (req, res): Promise<void> => {
  const { symbol } = req.body as { symbol?: string };
  if (!symbol || typeof symbol !== "string") {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const result = await addWatchedSymbol(symbol.trim());
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to add symbol" });
  }
});

router.delete("/market/watchlist/:symbol", (req, res): void => {
  const symbol = decodeURIComponent(req.params.symbol ?? "");
  try {
    const result = removeWatchedSymbol(symbol);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to remove symbol" });
  }
});

// ---------------------------------------------------------------------------
// Opening Range Breakout
// ---------------------------------------------------------------------------

router.get("/market/orb", (_req, res): void => {
  res.json(computeOrbSnapshot());
});

// ---------------------------------------------------------------------------
// VWAP Reversion
// ---------------------------------------------------------------------------

router.get("/market/vwap", (_req, res): void => {
  res.json(computeVwapSnapshot());
});

// Time series of price vs running VWAP ± σ bands for the current RTH session,
// plus overnight H/L reference levels — used by the mini session charts.
router.get("/market/vwap/series", (_req, res): void => {
  res.json(computeVwapSeriesSnapshot());
});

// ---------------------------------------------------------------------------
// Overnight High / Low
// ---------------------------------------------------------------------------

router.get("/market/overnight", (_req, res): void => {
  res.json(computeOvernightSnapshot());
});

export default router;
