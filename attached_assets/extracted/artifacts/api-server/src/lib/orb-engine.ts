/**
 * orb-engine.ts — Opening Range Breakout signal engine
 *
 * Computes ORB state per symbol using bar data already stored in market-engine
 * buffers. Called on-demand from the /api/market/orb route — no separate event
 * loop or state store required.
 *
 * ORB rules:
 *   Window  : first 30 minutes of RTH (13:30–14:00 UTC / 09:30–10:00 ET)
 *   Entry   : break above ORB high (BULL) or below ORB low (BEAR)
 *   Stop    : opposite side of ORB range
 *   Target 1: 10 ticks from entry (0.25 pts/tick for all 4 equity contracts)
 *   Target 2: 20 ticks from entry
 *   Reset   : daily at 20:00 UTC (RTH close)
 */

import { buffers, getWatchedSymbols } from "./market-engine.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const TICK_SIZE      = 0.25;  // ES, NQ, MES, MNQ all use 0.25 pts/tick
const TARGET_1_TICKS = 10;
const TARGET_2_TICKS = 20;

/** RTH window boundaries in UTC minutes-from-midnight */
const RTH_START_MINS = 13 * 60 + 30;               // 13:30 UTC = 09:30 ET (EDT)
const ORB_WINDOW_MINS = 30;                          // 13:30–14:00 UTC
const RTH_END_MINS   = 20 * 60;                     // 20:00 UTC = 16:00 ET (EDT)

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrbStatus =
  | "inactive"   // Before 13:30 UTC or weekend
  | "building"   // 13:30–14:00 UTC — collecting ORB bars
  | "ready"      // ORB established, no breakout yet
  | "triggered"  // Breakout detected — trade setup active
  | "expired";   // After 20:00 UTC — resets next session

export type OrbState = {
  symbol:       string;          // Internal e.g. "ES.v.0"
  displayName:  string;          // Trader-friendly e.g. "ES.c.0"
  status:       OrbStatus;
  orbHigh:      number | null;   // Highest high of ORB window
  orbLow:       number | null;   // Lowest low of ORB window
  rangeTicks:   number | null;   // ORB range in ticks
  barsInWindow: number;          // 1m bars collected during ORB window (max 30)
  signal:       "BULL" | "BEAR" | null;
  entry:        number | null;   // ORB high (BULL) or ORB low (BEAR)
  stop:         number | null;   // ORB low (BULL) or ORB high (BEAR)
  target1:      number | null;   // Entry ± 10 ticks
  target2:      number | null;   // Entry ± 20 ticks
  riskTicks:    number | null;   // Stop distance in ticks
  lastUpdated:  string;
};

export type OrbSnapshot = {
  timestamp: string;
  markets: Record<string, OrbState>;
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
  // "ES.v.0" → "ES.c.0" — consistent with DISPLAY_NAMES in market-engine
  return symbol.replace(".v.", ".c.");
}

function fmt2(n: number): number {
  return Number(n.toFixed(2));
}

// ─── Core computation ─────────────────────────────────────────────────────────

function computeState(symbol: string): OrbState {
  const displayName = toDisplayName(symbol);
  const now         = Date.now();
  const nowMins     = utcMins(now);
  const todayMs     = startOfUtcDay(now);
  const lastUpdated = new Date(now).toISOString();

  const blank: OrbState = {
    symbol, displayName,
    status: "inactive",
    orbHigh: null, orbLow: null, rangeTicks: null,
    barsInWindow: 0,
    signal: null,
    entry: null, stop: null, target1: null, target2: null, riskTicks: null,
    lastUpdated,
  };

  const allBars = buffers.get(symbol) ?? [];

  // ── Outside RTH ─────────────────────────────────────────────────────────
  if (nowMins < RTH_START_MINS) return { ...blank, status: "inactive" };
  if (nowMins >= RTH_END_MINS)  return { ...blank, status: "expired" };

  // ── ORB window boundaries ────────────────────────────────────────────────
  const orbStart = todayMs + RTH_START_MINS * 60_000;
  const orbEnd   = todayMs + (RTH_START_MINS + ORB_WINDOW_MINS) * 60_000;

  // Bars within the ORB window (13:30–14:00 UTC)
  const orbBars = allBars.filter(b => b.ts >= orbStart && b.ts < orbEnd);

  // ── Still building ───────────────────────────────────────────────────────
  if (nowMins < RTH_START_MINS + ORB_WINDOW_MINS) {
    if (orbBars.length === 0) return { ...blank, status: "building" };
    const orbHigh = fmt2(Math.max(...orbBars.map(b => b.high)));
    const orbLow  = fmt2(Math.min(...orbBars.map(b => b.low)));
    return {
      ...blank,
      status: "building",
      orbHigh, orbLow,
      rangeTicks:   Math.round((orbHigh - orbLow) / TICK_SIZE),
      barsInWindow: orbBars.length,
    };
  }

  // ── ORB window complete ──────────────────────────────────────────────────
  if (orbBars.length === 0) {
    // No bars in window — session data not loaded yet
    return { ...blank, status: "ready" };
  }

  const orbHigh    = fmt2(Math.max(...orbBars.map(b => b.high)));
  const orbLow     = fmt2(Math.min(...orbBars.map(b => b.low)));
  const rangeTicks = Math.round((orbHigh - orbLow) / TICK_SIZE);
  const barsInWindow = orbBars.length;

  // Bars after the ORB window — scan for the first breakout close
  const postBars = allBars.filter(b => b.ts >= orbEnd);

  let signal: "BULL" | "BEAR" | null = null;
  let breakoutTs: number | undefined;

  for (const bar of postBars) {
    if (bar.close > orbHigh) { signal = "BULL"; breakoutTs = bar.ts; break; }
    if (bar.close < orbLow)  { signal = "BEAR"; breakoutTs = bar.ts; break; }
  }

  // ── No breakout yet ──────────────────────────────────────────────────────
  if (!signal) {
    return {
      ...blank,
      status: "ready",
      orbHigh, orbLow, rangeTicks, barsInWindow,
    };
  }

  // ── Breakout — build trade setup ─────────────────────────────────────────
  const entry   = signal === "BULL" ? orbHigh : orbLow;
  const stop    = signal === "BULL" ? orbLow  : orbHigh;
  const riskPts = Math.abs(entry - stop);
  const riskTicks = Math.round(riskPts / TICK_SIZE);

  const target1 = fmt2(signal === "BULL"
    ? entry + TARGET_1_TICKS * TICK_SIZE
    : entry - TARGET_1_TICKS * TICK_SIZE);
  const target2 = fmt2(signal === "BULL"
    ? entry + TARGET_2_TICKS * TICK_SIZE
    : entry - TARGET_2_TICKS * TICK_SIZE);

  return {
    ...blank,
    status: "triggered",
    orbHigh, orbLow, rangeTicks, barsInWindow,
    signal,
    entry:  fmt2(entry),
    stop:   fmt2(stop),
    target1, target2, riskTicks,
    lastUpdated: breakoutTs ? new Date(breakoutTs).toISOString() : lastUpdated,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeOrbSnapshot(): OrbSnapshot {
  const markets: Record<string, OrbState> = {};
  for (const symbol of getWatchedSymbols()) {
    markets[symbol] = computeState(symbol);
  }
  return { timestamp: new Date().toISOString(), markets };
}
