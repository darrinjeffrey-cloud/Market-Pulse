/**
 * ict-engine.ts — ICT-style liquidity sweep + FVG multi-timeframe signal engine
 *
 * For each tracked symbol runs:
 *   15m → market bias (EMA 9/21 alignment + swing HH/LL structure)
 *   5m  → structure direction, Fair Value Gap detection, BSL/SSL sweep check
 *   1m  → current price
 *
 * Generates BUY / SELL / WAIT with entry zone, stop loss, T1–T3, and R:R.
 * Minimum R:R threshold is 2.0 — setups below are demoted to WAIT.
 */

import { buffers, getWatchedSymbols, type Bar } from "./market-engine.js";
import {
  overnightWindow,
  overnightHLFromBars,
} from "./session-bounds.js";

const DAY_MS  = 24 * 60 * 60_000;
const MIN_BARS = 20;
const MIN_RR   = 2.0;

// Only compute ICT signals for these symbols (core equity futures)
const ICT_SYMBOLS = ["ES.v.0", "NQ.v.0", "MES.v.0", "MNQ.v.0"];

// ─── Types ────────────────────────────────────────────────────────────────────

export type IctSignal = "BUY" | "SELL" | "WAIT";

export type IctFvg = {
  type:   "BULLISH" | "BEARISH";
  top:    number;
  bottom: number;
};

export type IctState = {
  symbol:        string;
  displayName:   string;
  signal:        IctSignal;
  confidence:    number;
  bias15m:       string;
  struct5m:      string;
  entryZone:     [number, number] | null;
  stopLoss:      number | null;
  tp1:           number | null;
  tp2:           number | null;
  tp3:           number | null;
  rrRatio:       number | null;
  bsl:           number | null;
  ssl:           number | null;
  keyFvg:        IctFvg | null;
  tradeReason:   string;
  whatToWaitFor: string;
  lastUpdated:   string;
};

export type IctSnapshot = {
  timestamp: string;
  markets:   Record<string, IctState>;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Aggregate 1-minute bars into N-minute OHLCV bars, sorted ascending. */
function aggregate(bars: Bar[], minutes: number): Bar[] {
  const groups = new Map<number, Bar>();
  for (const bar of bars) {
    const bucket = Math.floor(bar.ts / (minutes * 60_000)) * minutes * 60_000;
    const cur = groups.get(bucket);
    if (!cur) {
      groups.set(bucket, { ...bar, ts: bucket });
    } else {
      cur.high   = Math.max(cur.high, bar.high);
      cur.low    = Math.min(cur.low, bar.low);
      cur.close  = bar.close;
      cur.volume += bar.volume;
    }
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

/** EMA matching pandas ewm(span, adjust=False). Initialised to first value. */
function computeEMA(values: number[], span: number): number[] {
  const k = 2 / (span + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    out.push(i === 0 ? values[0] : values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function barMax(bars: Bar[], field: "high" | "low"): number {
  return Math.max(...bars.map((b) => b[field]));
}
function barMin(bars: Bar[], field: "high" | "low"): number {
  return Math.min(...bars.map((b) => b[field]));
}

// ─── Core analysis ────────────────────────────────────────────────────────────

type Bias = "Bullish" | "Bearish" | "Neutral";

/**
 * Bias via EMA 9/21 alignment + swing High-High / Low-Low structure.
 * Requires ≥ 21 bars for meaningful EMA warmup.
 */
function determineBias(bars: Bar[]): Bias {
  if (bars.length < 21) return "Neutral";
  const closes = bars.map((b) => b.close);
  const ema9   = computeEMA(closes, 9);
  const ema21  = computeEMA(closes, 21);
  const last   = bars[bars.length - 1];
  const e9     = ema9[ema9.length - 1];
  const e21    = ema21[ema21.length - 1];
  const recent = bars.slice(-10, -1);
  if (recent.length === 0) return "Neutral";
  const swingHigh = barMax(recent, "high");
  const swingLow  = barMin(recent, "low");

  if (last.close > e9 && e9 > e21 && last.high > swingHigh) return "Bullish";
  if (last.close < e9 && e9 < e21 && last.low  < swingLow)  return "Bearish";
  return "Neutral";
}

/**
 * Identify Fair Value Gaps in the bar series.
 * Bullish FVG: low[i] > high[i-2]  (gap left by rapid upward displacement)
 * Bearish FVG: high[i] < low[i-2]  (gap left by rapid downward displacement)
 */
function detectFVG(bars: Bar[]): IctFvg[] {
  const fvgs: IctFvg[] = [];
  for (let i = 2; i < bars.length; i++) {
    if (bars[i].low > bars[i - 2].high) {
      fvgs.push({ type: "BULLISH", top: bars[i].low, bottom: bars[i - 2].high });
    } else if (bars[i].high < bars[i - 2].low) {
      fvgs.push({ type: "BEARISH", top: bars[i - 2].low, bottom: bars[i].high });
    }
  }
  return fvgs;
}

/**
 * Liquidity sweep: did price breach the level in the last 5 bars then
 * close back on the other side (reclaim)?
 *
 * SSL sweep → bullish (swept sell-side, reclaimed above)
 * BSL sweep → bearish (swept buy-side, reclaimed below)
 */
function checkSweep(bars: Bar[], level: number, side: "SSL" | "BSL"): boolean {
  const recent = bars.slice(-5);
  if (!recent.length) return false;
  const last = recent[recent.length - 1];
  if (side === "SSL") return recent.some((b) => b.low < level) && last.close > level;
  return recent.some((b) => b.high > level) && last.close < level;
}

type SessionLevels = {
  pdh: number | null; // previous-day RTH high
  pdl: number | null; // previous-day RTH low
  onh: number | null; // overnight high
  onl: number | null; // overnight low
  csh: number | null; // current-session high
  csl: number | null; // current-session low
};

/**
 * Extract DST-aware session levels from 1-minute bars.
 *
 * - PDH/PDL : yesterday's RTH (9:30 AM → 4:15 PM ET)
 * - ONH/ONL : overnight (4:15 PM ET yesterday → 9:30 AM ET today)
 *             via the shared overnightHLFromBars helper
 * - CSH/CSL : today's RTH from 9:30 AM ET open to now
 */
function extractSessionLevels(bars1m: Bar[]): SessionLevels {
  const now = Date.now();
  const win = overnightWindow(now);

  // Overnight H/L via the session-bounds helper
  const { onHigh, onLow } = overnightHLFromBars(bars1m, win);

  // Yesterday's RTH: [win.end − 1 day, win.start)
  //   win.end   = today's 9:30 AM ET open
  //   win.start = yesterday's 4:15 PM ET close
  const prevRthStart = win.end - DAY_MS;
  const prevRthEnd   = win.start;
  let pdh: number | null = null;
  let pdl: number | null = null;
  for (const b of bars1m) {
    if (b.ts < prevRthStart || b.ts >= prevRthEnd) continue;
    if (pdh === null || b.high > pdh) pdh = b.high;
    if (pdl === null || b.low  < pdl) pdl = b.low;
  }

  // Current RTH: [win.end, now]
  let csh: number | null = null;
  let csl: number | null = null;
  for (const b of bars1m) {
    if (b.ts < win.end || b.ts > now) continue;
    if (csh === null || b.high > csh) csh = b.high;
    if (csl === null || b.low  < csl) csl = b.low;
  }

  return { pdh, pdl, onh: onHigh, onl: onLow, csh, csl };
}

// ─── Symbol-level analysis ────────────────────────────────────────────────────

function waitState(
  symbol: string,
  displayName: string,
  tradeReason: string,
  whatToWaitFor: string,
  confidence = 0,
  bias15m = "Neutral",
  struct5m = "Neutral",
  bsl: number | null = null,
  ssl: number | null = null,
  keyFvg: IctFvg | null = null,
): IctState {
  return {
    symbol, displayName,
    signal: "WAIT", confidence,
    bias15m, struct5m,
    entryZone: null, stopLoss: null,
    tp1: null, tp2: null, tp3: null, rrRatio: null,
    bsl, ssl, keyFvg,
    tradeReason, whatToWaitFor,
    lastUpdated: new Date().toISOString(),
  };
}

function analyzeSymbol(symbol: string, displayName: string): IctState {
  const raw = buffers.get(symbol) ?? [];

  if (raw.length < MIN_BARS) {
    return waitState(symbol, displayName,
      "Insufficient bar data — engine needs ≥ 20 bars.",
      "Bars to accumulate from the live feed.");
  }

  const bars15m = aggregate(raw, 15);
  const bars5m  = aggregate(raw, 5);
  const bars1m  = aggregate(raw, 1);

  if (bars5m.length < MIN_BARS || bars15m.length < 5) {
    return waitState(symbol, displayName,
      "Insufficient aggregated bars for multi-timeframe analysis.",
      "More 1-minute bars to build the 5M and 15M views.");
  }

  const bias15m  = determineBias(bars15m);
  const struct5m = determineBias(bars5m);
  const levels   = extractSessionLevels(bars1m);
  const fvgs5m   = detectFVG(bars5m);
  const currentPrice = bars1m[bars1m.length - 1].close;

  // Buy-side and sell-side liquidity pools: max/min of available session levels
  const bslCandidates = [levels.pdh, levels.onh, levels.csh].filter((v): v is number => v !== null);
  const sslCandidates = [levels.pdl, levels.onl, levels.csl].filter((v): v is number => v !== null);
  const bsl = bslCandidates.length ? Math.max(...bslCandidates) : null;
  const ssl = sslCandidates.length ? Math.min(...sslCandidates) : null;
  const recentFvg = fvgs5m[fvgs5m.length - 1] ?? null;

  if (bsl === null || ssl === null) {
    return waitState(symbol, displayName,
      "Cannot determine key liquidity levels — session data not yet available.",
      "Session bars to accumulate (RTH opens at 9:30 AM ET).",
      0, bias15m, struct5m, bsl, ssl, recentFvg);
  }

  const sslSwept = checkSweep(bars5m, ssl, "SSL");
  const bslSwept = checkSweep(bars5m, bsl, "BSL");

  let signal: IctSignal = "WAIT";
  let confidence = 50;
  let entryZone: [number, number] | null = null;
  let stopLoss:  number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;
  let rrRatio: number | null = null;
  let tradeReason   = "";
  let whatToWaitFor = "";

  // ── Bullish ────────────────────────────────────────────────────────────────
  if (bias15m === "Bullish" && struct5m === "Bullish" && sslSwept && recentFvg?.type === "BULLISH") {
    const { top: fvgHigh, bottom: fvgLow } = recentFvg;
    if (currentPrice > fvgHigh * 1.005) {
      tradeReason   = "Price has displaced past the ideal entry zone — chasing risk.";
      whatToWaitFor = `Retrace into 5M bullish FVG (${fvgLow.toFixed(2)}–${fvgHigh.toFixed(2)}).`;
    } else {
      const mid  = (fvgLow + fvgHigh) / 2;
      const stop = barMin(bars5m.slice(-5), "low");
      const risk = mid - stop;
      if (risk > 0) {
        signal     = "BUY";
        entryZone  = [fvgLow, fvgHigh];
        stopLoss   = stop;
        tp1        = parseFloat((mid + risk * 1.5).toFixed(2));
        tp2        = bsl;
        tp3        = parseFloat((bsl + risk).toFixed(2));
        rrRatio    = parseFloat(((bsl - mid) / risk).toFixed(2));
        confidence = 85;
        tradeReason = "SSL swept on 5M with bullish CHoCH displacement leaving an active 5M FVG.";
      } else {
        tradeReason   = "Bullish conditions met but stop is above mid — no tradeable risk.";
        whatToWaitFor = "Clean 5M FVG with the sweep low clearly below the gap.";
      }
    }
  }
  // ── Bearish ────────────────────────────────────────────────────────────────
  else if (bias15m === "Bearish" && struct5m === "Bearish" && bslSwept && recentFvg?.type === "BEARISH") {
    const { top: fvgHigh, bottom: fvgLow } = recentFvg;
    if (currentPrice < fvgLow * 0.995) {
      tradeReason   = "Price has displaced past the ideal entry zone — chasing risk.";
      whatToWaitFor = `Retrace into 5M bearish FVG (${fvgLow.toFixed(2)}–${fvgHigh.toFixed(2)}).`;
    } else {
      const mid  = (fvgLow + fvgHigh) / 2;
      const stop = barMax(bars5m.slice(-5), "high");
      const risk = stop - mid;
      if (risk > 0) {
        signal     = "SELL";
        entryZone  = [fvgLow, fvgHigh];
        stopLoss   = stop;
        tp1        = parseFloat((mid - risk * 1.5).toFixed(2));
        tp2        = ssl;
        tp3        = parseFloat((ssl - risk).toFixed(2));
        rrRatio    = parseFloat(((mid - ssl) / risk).toFixed(2));
        confidence = 85;
        tradeReason = "BSL swept on 5M with bearish CHoCH displacement leaving an active 5M FVG.";
      } else {
        tradeReason   = "Bearish conditions met but stop is below mid — no tradeable risk.";
        whatToWaitFor = "Clean 5M FVG with the sweep high clearly above the gap.";
      }
    }
  }
  // ── No setup ───────────────────────────────────────────────────────────────
  else {
    signal = "WAIT";
    if (bias15m !== "Neutral" && struct5m !== "Neutral" && bias15m !== struct5m) {
      confidence   -= 20;
      tradeReason    = "Timeframe divergence — 15M bias and 5M structure conflict.";
      whatToWaitFor  = "Alignment of 15M trend with 5M structure shift.";
    } else {
      tradeReason    = "No high-probability liquidity sweep + displacement setup confirmed.";
      whatToWaitFor  = "BSL or SSL sweep followed by CHoCH displacement leaving an open 5M FVG.";
    }
  }

  // Filter poor R:R
  if (signal !== "WAIT" && rrRatio !== null && rrRatio < MIN_RR) {
    confidence    -= 15;
    tradeReason    = `Setup rejected — R:R ${rrRatio.toFixed(2)} is below minimum ${MIN_RR}.`;
    whatToWaitFor  = `Deeper FVG retracement to reach 1:${MIN_RR} R:R.`;
    signal         = "WAIT";
    entryZone      = null;
    stopLoss       = null;
    tp1 = tp2 = tp3 = null;
    rrRatio        = null;
  }

  return {
    symbol, displayName,
    signal,
    confidence: Math.max(0, confidence),
    bias15m,
    struct5m,
    entryZone,
    stopLoss,
    tp1, tp2, tp3,
    rrRatio,
    bsl: parseFloat(bsl.toFixed(2)),
    ssl: parseFloat(ssl.toFixed(2)),
    keyFvg: recentFvg,
    tradeReason,
    whatToWaitFor,
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeIctSnapshot(): IctSnapshot {
  const watched = getWatchedSymbols();
  const markets: Record<string, IctState> = {};
  for (const symbol of ICT_SYMBOLS) {
    if (!watched.includes(symbol)) continue;
    const displayName = symbol.replace(".v.", ".c.");
    markets[symbol] = analyzeSymbol(symbol, displayName);
  }
  return { timestamp: new Date().toISOString(), markets };
}
