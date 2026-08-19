/**
 * vwap-engine.ts — VWAP Reversion signal engine
 *
 * Computes intraday VWAP + standard-deviation bands from RTH bar data already
 * stored in market-engine buffers. Detects mean-reversion setups valid any
 * time during the RTH session (09:30–16:00 ET / 13:30–20:00 UTC).
 *
 * Strategy rules:
 *   VWAP     : volume-weighted average of typical price (H+L+C)/3 from RTH open
 *   Bands    : ±1σ and ±2σ (volume-weighted standard deviation)
 *   Long setup  : price extends below VWAP−1σ AND latest close > previous close
 *   Short setup : price extends above VWAP+1σ AND latest close < previous close
 *   Entry    : current close
 *   Stop     : ±2σ band (beyond current extension)
 *   T1       : VWAP (mean)
 *   T2       : ±1σ on the other side (overshoot target)
 *   Reset    : daily at RTH open (13:30 UTC)
 */

import { buffers, getWatchedSymbols } from "./market-engine.js";
import {
  overnightWindow,
  overnightHLFromBars,
  etMinutesOfDay,
  RTH_OPEN_ET_MINS,
} from "./session-bounds.js";
import {
  analyzeVwapReversion,
  DEFAULT_TICK_SIZE,
  type VwapReversionStatus,
} from "./vwap-reversion.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TICK_SIZE = DEFAULT_TICK_SIZE;

// ─── Types ────────────────────────────────────────────────────────────────────

export type VwapStatus = VwapReversionStatus;

export type VwapState = {
  symbol:          string;
  displayName:     string;
  status:          VwapStatus;
  vwap:            number | null;
  band1Upper:      number | null;   // VWAP + 1σ
  band1Lower:      number | null;   // VWAP − 1σ
  band2Upper:      number | null;   // VWAP + 2σ
  band2Lower:      number | null;   // VWAP − 2σ
  currentPrice:    number | null;
  deviationSigmas: number | null;   // (currentPrice − VWAP) / σ, signed
  barsInSession:   number;          // RTH bars used for VWAP
  signal:          "LONG" | "SHORT" | null;
  entry:           number | null;
  stop:            number | null;
  target1:         number | null;   // VWAP
  target2:         number | null;   // ±1σ on the reverse side
  riskTicks:       number | null;
  lastUpdated:     string;
};

export type VwapSnapshot = {
  timestamp: string;
  markets:   Record<string, VwapState>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDisplayName(symbol: string): string {
  return symbol.replace(".v.", ".c.");
}

function fmt2(n: number): number {
  return Number(n.toFixed(2));
}

// ─── Core computation ─────────────────────────────────────────────────────────

function computeState(symbol: string, now: number): VwapState {
  const displayName = toDisplayName(symbol);
  const lastUpdated = new Date(now).toISOString();
  const analysis = analyzeVwapReversion(buffers.get(symbol) ?? [], now);

  const blank: VwapState = {
    symbol, displayName,
    status: "inactive",
    vwap: null, band1Upper: null, band1Lower: null,
    band2Upper: null, band2Lower: null,
    currentPrice: null, deviationSigmas: null,
    barsInSession: 0,
    signal: null,
    entry: null, stop: null, target1: null, target2: null, riskTicks: null,
    lastUpdated,
  };

  if (!analysis.bands) {
    return {
      ...blank,
      status: analysis.status,
      barsInSession: analysis.barsInSession,
    };
  }

  return {
    ...blank,
    status: analysis.status,
    vwap: analysis.bands.vwap,
    band1Upper: analysis.bands.vwapStd1Up,
    band1Lower: analysis.bands.vwapStd1Down,
    band2Upper: analysis.bands.vwapStd2Up,
    band2Lower: analysis.bands.vwapStd2Down,
    currentPrice: analysis.currentPrice,
    deviationSigmas: analysis.deviationSigmas,
    barsInSession: analysis.barsInSession,
    signal: analysis.signal,
    entry: analysis.entry,
    stop: analysis.stop,
    target1: analysis.target1,
    target2: analysis.target2,
    riskTicks: analysis.riskTicks,
  };
}

// ─── Session time series ──────────────────────────────────────────────────────

/** Series ends at 4:00 PM ET — same close as the scalar VWAP signal window. */
const SERIES_RTH_CLOSE_ET_MINS = 16 * 60;

export type VwapSeriesPoint = {
  timestamp:  string;  // ISO-8601 of the 1-min bar
  price:      number;  // bar close
  vwap:       number;  // running session VWAP up to and including this bar
  band1Upper: number;  // VWAP + 1σ (running)
  band1Lower: number;  // VWAP − 1σ (running)
  band2Upper: number;  // VWAP + 2σ (running)
  band2Lower: number;  // VWAP − 2σ (running)
};

export type VwapSeriesState = {
  symbol:        string;
  displayName:   string;
  points:        VwapSeriesPoint[];
  overnightHigh: number | null;
  overnightLow:  number | null;
};

export type VwapSeriesSnapshot = {
  timestamp: string;
  markets:   Record<string, VwapSeriesState>;
};

function computeSeries(symbol: string, now: number): VwapSeriesState {
  const displayName = toDisplayName(symbol);
  const allBars = buffers.get(symbol) ?? [];

  // Overnight H/L reference levels (DST-aware shared session window)
  const win = overnightWindow(now);
  const { onHigh, onLow } = overnightHLFromBars(allBars, win);

  const blank: VwapSeriesState = {
    symbol, displayName, points: [],
    overnightHigh: onHigh != null ? fmt2(onHigh) : null,
    overnightLow:  onLow  != null ? fmt2(onLow)  : null,
  };

  // DST-aware RTH gate: 9:30 AM – 4:00 PM ET (matches the scalar VWAP panel's
  // signal window, computed via the shared ET session-boundary helpers).
  const etMins = etMinutesOfDay(now);
  if (etMins < RTH_OPEN_ET_MINS || etMins >= SERIES_RTH_CLOSE_ET_MINS) return blank;

  // During RTH the completed overnight window ends exactly at today's 9:30 AM
  // ET open — use it as the DST-aware session anchor for the bar filter.
  const rthStart = win.phase === "rth" ? win.end : now - (etMins - RTH_OPEN_ET_MINS) * 60_000;
  const rthBars  = allBars.filter(b => b.ts >= rthStart);
  if (rthBars.length === 0) return blank;

  // Cumulative VWAP + σ per bar (same math as computeState, but running)
  let sumVolume = 0, sumTpVol = 0, sumTp2Vol = 0;
  const points: VwapSeriesPoint[] = [];
  for (const bar of rthBars) {
    const tp  = (bar.high + bar.low + bar.close) / 3;
    const vol = bar.volume > 0 ? bar.volume : 1;
    sumVolume += vol;
    sumTpVol  += tp * vol;
    sumTp2Vol += tp * tp * vol;

    const vwap     = sumTpVol / sumVolume;
    const variance = (sumTp2Vol / sumVolume) - (vwap * vwap);
    const sigma    = Math.max(Math.sqrt(Math.max(variance, 0)), TICK_SIZE * 2);

    points.push({
      timestamp:  new Date(bar.ts).toISOString(),
      price:      fmt2(bar.close),
      vwap:       fmt2(vwap),
      band1Upper: fmt2(vwap + sigma),
      band1Lower: fmt2(vwap - sigma),
      band2Upper: fmt2(vwap + sigma * 2),
      band2Lower: fmt2(vwap - sigma * 2),
    });
  }

  return { ...blank, points };
}

export function computeVwapSeriesSnapshot(now: number = Date.now()): VwapSeriesSnapshot {
  const markets: Record<string, VwapSeriesState> = {};
  for (const symbol of getWatchedSymbols()) {
    markets[symbol] = computeSeries(symbol, now);
  }
  return { timestamp: new Date(now).toISOString(), markets };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeVwapSnapshot(now: number = Date.now()): VwapSnapshot {
  const markets: Record<string, VwapState> = {};
  for (const symbol of getWatchedSymbols()) {
    markets[symbol] = computeState(symbol, now);
  }
  return { timestamp: new Date(now).toISOString(), markets };
}
