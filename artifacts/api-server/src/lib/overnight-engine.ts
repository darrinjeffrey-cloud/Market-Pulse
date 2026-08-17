/**
 * overnight-engine.ts — Overnight High/Low reference level engine
 *
 * Tracks the high and low of the Globex overnight session for ES, NQ, MES, MNQ.
 * These levels are key intraday reference points — price often tests overnight H/L
 * during the RTH session.
 *
 * Overnight session definition:
 *   Start : previous day's RTH close (20:00 UTC / 16:00 ET)
 *   End   : current day's RTH open (13:30 UTC / 09:30 ET)
 *
 * Status lifecycle:
 *   forming   — currently inside the overnight window (pre-market / after-hours)
 *   reference — RTH is active; overnight H/L are fixed reference levels for the day
 *   expired   — RTH session ended (after 20:00 UTC)
 *
 * Context signals (during RTH):
 *   above_both  — price above overnight high (bullish extension)
 *   below_both  — price below overnight low (bearish extension)
 *   inside      — price between overnight H and L (balancing)
 *   near_high   — within 0.5σ of overnight high
 *   near_low    — within 0.5σ of overnight low
 */

import { buffers, getWatchedSymbols } from "./market-engine.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** RTH / Globex boundaries in UTC minutes-from-midnight */
const RTH_START_MINS = 13 * 60 + 30;   // 13:30 UTC = 09:30 ET
const RTH_END_MINS   = 20 * 60;        // 20:00 UTC = 16:00 ET
const TICK_SIZE      = 0.25;

// ─── Types ────────────────────────────────────────────────────────────────────

export type OvernightStatus =
  | "forming"    // Inside overnight window — levels still building
  | "reference"  // RTH active — overnight H/L are fixed reference levels
  | "expired";   // RTH session ended — reset on next overnight open

export type OvernightContext =
  | "above_both"  // Price above overnight high
  | "below_both"  // Price below overnight low
  | "near_high"   // Within 2 ticks of overnight high
  | "near_low"    // Within 2 ticks of overnight low
  | "inside"      // Price inside overnight range
  | null;

export type OvernightState = {
  symbol:            string;        // Internal e.g. "ES.v.0"
  displayName:       string;        // Trader-friendly e.g. "ES.c.0"
  status:            OvernightStatus;
  overnightHigh:     number | null; // Highest high of overnight session
  overnightLow:      number | null; // Lowest low of overnight session
  rangeTicks:        number | null; // Range in ticks
  barsInSession:     number;        // 1m bars that make up the overnight range
  currentPrice:      number | null;
  context:           OvernightContext;
  distToHigh:        number | null; // pts from current price to overnight high (+ = below)
  distToLow:         number | null; // pts from current price to overnight low (+ = above)
  lastUpdated:       string;
};

export type OvernightSnapshot = {
  timestamp: string;
  markets:   Record<string, OvernightState>;
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

/** Returns the overnight window [start, end) in epoch-ms for the *current* day. */
function overnightBounds(nowMs: number): { start: number; end: number } {
  const todayMs  = startOfUtcDay(nowMs);
  const rthOpen  = todayMs + RTH_START_MINS * 60_000;          // 13:30 UTC today
  const prevClose = todayMs - (24 * 60 * 60_000) + RTH_END_MINS * 60_000; // 20:00 UTC yesterday
  return { start: prevClose, end: rthOpen };
}

// ─── Core computation ─────────────────────────────────────────────────────────

function computeState(symbol: string): OvernightState {
  const displayName = toDisplayName(symbol);
  const now         = Date.now();
  const nowMins     = utcMins(now);
  const lastUpdated = new Date(now).toISOString();

  const blank: OvernightState = {
    symbol, displayName,
    status: "forming",
    overnightHigh: null, overnightLow: null, rangeTicks: null,
    barsInSession: 0,
    currentPrice: null, context: null,
    distToHigh: null, distToLow: null,
    lastUpdated,
  };

  const allBars = buffers.get(symbol) ?? [];

  // ── Overnight window boundaries ──────────────────────────────────────────
  const { start: overnightStart, end: overnightEnd } = overnightBounds(now);

  // Bars in the overnight session (prev RTH close → current RTH open)
  const overnightBars = allBars.filter(b => b.ts >= overnightStart && b.ts < overnightEnd);

  if (overnightBars.length === 0) {
    // Determine appropriate status even without data
    if (nowMins >= RTH_START_MINS && nowMins < RTH_END_MINS) {
      return { ...blank, status: "reference" };
    }
    if (nowMins >= RTH_END_MINS) {
      return { ...blank, status: "expired" };
    }
    return blank;  // forming, no data yet
  }

  const overnightHigh  = fmt2(Math.max(...overnightBars.map(b => b.high)));
  const overnightLow   = fmt2(Math.min(...overnightBars.map(b => b.low)));
  const rangeTicks     = Math.round((overnightHigh - overnightLow) / TICK_SIZE);
  const barsInSession  = overnightBars.length;

  // ── Status ───────────────────────────────────────────────────────────────
  let status: OvernightStatus = "forming";
  if (nowMins >= RTH_END_MINS) {
    status = "expired";
  } else if (nowMins >= RTH_START_MINS) {
    status = "reference";
  }

  // ── Current price + context (only meaningful during RTH) ─────────────────
  let currentPrice: number | null = null;
  let context: OvernightContext = null;
  let distToHigh: number | null = null;
  let distToLow:  number | null = null;

  if (status === "reference") {
    // Use latest bar in the buffer for current price
    const latest = allBars[allBars.length - 1];
    if (latest) {
      currentPrice = fmt2(latest.close);
      distToHigh   = fmt2(overnightHigh - currentPrice);   // + = price below high
      distToLow    = fmt2(currentPrice - overnightLow);    // + = price above low

      const nearThreshold = TICK_SIZE * 2; // 2 ticks = 0.50 pts
      if (currentPrice > overnightHigh) {
        context = "above_both";
      } else if (currentPrice < overnightLow) {
        context = "below_both";
      } else if (Math.abs(currentPrice - overnightHigh) <= nearThreshold) {
        context = "near_high";
      } else if (Math.abs(currentPrice - overnightLow) <= nearThreshold) {
        context = "near_low";
      } else {
        context = "inside";
      }
    }
  }

  return {
    symbol, displayName, status,
    overnightHigh, overnightLow, rangeTicks, barsInSession,
    currentPrice, context, distToHigh, distToLow,
    lastUpdated,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeOvernightSnapshot(): OvernightSnapshot {
  const markets: Record<string, OvernightState> = {};
  for (const symbol of getWatchedSymbols()) {
    markets[symbol] = computeState(symbol);
  }
  return { timestamp: new Date().toISOString(), markets };
}
