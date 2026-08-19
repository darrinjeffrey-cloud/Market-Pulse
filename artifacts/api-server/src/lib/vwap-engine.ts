/**
 * vwap-engine.ts — VWAP Reversion signal engine
 *
 * Computes intraday VWAP + standard-deviation bands from Globex bar data
 * already stored in market-engine buffers. Detects mean-reversion setups
 * throughout the CME Globex session, excluding maintenance and weekends.
 *
 * Strategy rules:
 *   VWAP     : volume-weighted average of typical price (H+L+C)/3 from Globex open
 *   Bands    : ±1σ and ±2σ (volume-weighted standard deviation)
 *   Long setup  : price extends below VWAP−1σ AND latest close > previous close
 *   Short setup : price extends above VWAP+1σ AND latest close < previous close
 *   Entry    : current close
 *   Stop     : ±2σ band (beyond current extension)
 *   T1       : VWAP (mean)
 *   T2       : ±1σ on the other side (overshoot target)
 *   Reset    : daily at 6:00 PM ET Globex open
 */

import { buffers, getWatchedSymbols } from "./market-engine.js";
import {
  overnightWindow,
  overnightHLFromBars,
  globexWindow,
} from "./session-bounds.js";
import {
  analyzeVwapReversion,
  currentGlobexBars,
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
  barsInSession:   number;          // Globex bars used for VWAP
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

  const session = globexWindow(now);
  if (session.phase !== "active") return blank;

  const globexBars = currentGlobexBars(allBars, now);
  if (globexBars.length === 0) return blank;

  // Cumulative VWAP + σ per bar (same math as computeState, but running)
  let sumVolume = 0, sumTpVol = 0, sumTp2Vol = 0;
  const points: VwapSeriesPoint[] = [];
  for (const bar of globexBars) {
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
