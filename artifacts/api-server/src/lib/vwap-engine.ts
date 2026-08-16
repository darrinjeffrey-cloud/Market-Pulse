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

// ─── Constants ────────────────────────────────────────────────────────────────

const TICK_SIZE    = 0.25;
const RTH_START_MINS = 13 * 60 + 30;   // 13:30 UTC = 09:30 ET
const RTH_END_MINS   = 20 * 60;        // 20:00 UTC = 16:00 ET

// ─── Types ────────────────────────────────────────────────────────────────────

export type VwapStatus =
  | "inactive"      // Before 13:30 UTC or weekend / no bars
  | "watching"      // RTH open, price within ±1σ — no setup
  | "long_setup"    // Price below VWAP−1σ with reversal candle
  | "short_setup"   // Price above VWAP+1σ with reversal candle
  | "expired";      // After 20:00 UTC

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

function utcMins(ts: number): number {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function startOfUtcDay(ts: number): number {
  return ts - (ts % (24 * 60 * 60_000));
}

function toDisplayName(symbol: string): string {
  return symbol.replace(".v.", ".c.");
}

function fmt2(n: number): number {
  return Number(n.toFixed(2));
}

// ─── Core computation ─────────────────────────────────────────────────────────

function computeState(symbol: string): VwapState {
  const displayName = toDisplayName(symbol);
  const now         = Date.now();
  const nowMins     = utcMins(now);
  const todayMs     = startOfUtcDay(now);
  const lastUpdated = new Date(now).toISOString();

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

  // ── Outside RTH ─────────────────────────────────────────────────────────
  if (nowMins < RTH_START_MINS) return { ...blank, status: "inactive" };
  if (nowMins >= RTH_END_MINS)  return { ...blank, status: "expired" };

  // ── Gather today's RTH bars ──────────────────────────────────────────────
  const rthStart = todayMs + RTH_START_MINS * 60_000;
  const allBars  = buffers.get(symbol) ?? [];
  const rthBars  = allBars.filter(b => b.ts >= rthStart);

  if (rthBars.length < 2) {
    // Not enough data yet — still warming up
    return { ...blank, status: "inactive", barsInSession: rthBars.length };
  }

  // ── VWAP + σ ────────────────────────────────────────────────────────────
  // Typical price for each bar
  let sumVolume  = 0;
  let sumTpVol   = 0;   // Σ(typical × volume)
  let sumTp2Vol  = 0;   // Σ(typical² × volume) — for variance

  for (const bar of rthBars) {
    const tp  = (bar.high + bar.low + bar.close) / 3;
    const vol = bar.volume > 0 ? bar.volume : 1; // guard zero-volume bars
    sumVolume += vol;
    sumTpVol  += tp * vol;
    sumTp2Vol += tp * tp * vol;
  }

  const vwap    = sumTpVol / sumVolume;
  // Volume-weighted variance: E[tp²] − E[tp]²
  const variance = (sumTp2Vol / sumVolume) - (vwap * vwap);
  const sigma    = Math.sqrt(Math.max(variance, 0));

  // If σ is negligibly small (flat market / single bar) skip signal generation
  const minSigma = TICK_SIZE * 2;
  if (sigma < minSigma) {
    return {
      ...blank,
      status: "watching",
      vwap: fmt2(vwap),
      band1Upper: fmt2(vwap + minSigma), band1Lower: fmt2(vwap - minSigma),
      band2Upper: fmt2(vwap + minSigma * 2), band2Lower: fmt2(vwap - minSigma * 2),
      currentPrice: fmt2(rthBars[rthBars.length - 1]!.close),
      deviationSigmas: 0,
      barsInSession: rthBars.length,
    };
  }

  const band1Upper = fmt2(vwap + sigma);
  const band1Lower = fmt2(vwap - sigma);
  const band2Upper = fmt2(vwap + sigma * 2);
  const band2Lower = fmt2(vwap - sigma * 2);

  const latest   = rthBars[rthBars.length - 1]!;
  const previous = rthBars[rthBars.length - 2]!;
  const currentPrice    = fmt2(latest.close);
  const deviationSigmas = fmt2((currentPrice - vwap) / sigma);

  const base: VwapState = {
    ...blank,
    vwap: fmt2(vwap),
    band1Upper, band1Lower, band2Upper, band2Lower,
    currentPrice, deviationSigmas,
    barsInSession: rthBars.length,
  };

  // ── Signal detection ─────────────────────────────────────────────────────
  // Long: price below −1σ AND last bar is a bullish reversal candle
  if (currentPrice < band1Lower && latest.close > previous.close) {
    const entry   = currentPrice;
    const stop    = band2Lower;
    const riskPts = Math.abs(entry - stop);
    return {
      ...base,
      status: "long_setup",
      signal: "LONG",
      entry:     fmt2(entry),
      stop:      fmt2(stop),
      target1:   fmt2(vwap),
      target2:   fmt2(band1Upper),
      riskTicks: Math.round(riskPts / TICK_SIZE),
    };
  }

  // Short: price above +1σ AND last bar is a bearish reversal candle
  if (currentPrice > band1Upper && latest.close < previous.close) {
    const entry   = currentPrice;
    const stop    = band2Upper;
    const riskPts = Math.abs(entry - stop);
    return {
      ...base,
      status: "short_setup",
      signal: "SHORT",
      entry:     fmt2(entry),
      stop:      fmt2(stop),
      target1:   fmt2(vwap),
      target2:   fmt2(band1Lower),
      riskTicks: Math.round(riskPts / TICK_SIZE),
    };
  }

  // ── Watching — price within ±1σ or no reversal candle yet ───────────────
  return { ...base, status: "watching" };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeVwapSnapshot(): VwapSnapshot {
  const markets: Record<string, VwapState> = {};
  for (const symbol of getWatchedSymbols()) {
    markets[symbol] = computeState(symbol);
  }
  return { timestamp: new Date().toISOString(), markets };
}
