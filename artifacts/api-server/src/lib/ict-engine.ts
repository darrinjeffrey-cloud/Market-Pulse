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
const SWEEP_LOOKBACK_BARS = 24;
const RECLAIM_WINDOW_BARS = 2;
const STRUCTURE_LOOKBACK_BARS = 8;
const CHOCH_WINDOW_BARS = 5;
const FVG_FORMATION_WINDOW_BARS = 3;
const FVG_RETRACE_WINDOW_BARS = 12;
const MIN_DISPLACEMENT_BODY_RATIO = 0.6;

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
 * Bias via EMA 9/21 alignment + recent swing High-High / Low-Low structure.
 * Requires ≥ 21 bars for meaningful EMA warmup.
 */
export function determineBias(bars: Bar[]): Bias {
  if (bars.length < 21) return "Neutral";
  const closes = bars.map((b) => b.close);
  const ema9   = computeEMA(closes, 9);
  const ema21  = computeEMA(closes, 21);
  const last   = bars[bars.length - 1];
  const e9     = ema9[ema9.length - 1];
  const e21    = ema21[ema21.length - 1];
  const recent = bars.slice(-8);
  const prior  = bars.slice(-16, -8);
  if (recent.length < 5 || prior.length < 5) return "Neutral";

  // A bias should persist through normal pullbacks. Requiring the *latest*
  // candle to make a new 9-bar extreme left ICT Neutral for almost every
  // otherwise valid setup. Instead, confirm the EMA trend with a recent
  // higher high/low (or lower high/low) sequence.
  const higherStructure =
    barMax(recent, "high") > barMax(prior, "high") ||
    barMin(recent, "low") > barMin(prior, "low");
  const lowerStructure =
    barMin(recent, "low") < barMin(prior, "low") ||
    barMax(recent, "high") < barMax(prior, "high");

  if (last.close > e9 && e9 > e21 && higherStructure) return "Bullish";
  if (last.close < e9 && e9 < e21 && lowerStructure)  return "Bearish";
  return "Neutral";
}

/**
 * Identify Fair Value Gaps in the bar series.
 * Bullish FVG: low[i] > high[i-2]  (gap left by rapid upward displacement)
 * Bearish FVG: high[i] < low[i-2]  (gap left by rapid downward displacement)
 */
type IctFvgCandidate = IctFvg & { formedAt: number };

function detectFVG(bars: Bar[]): IctFvgCandidate[] {
  const fvgs: IctFvgCandidate[] = [];
  for (let i = 2; i < bars.length; i++) {
    if (bars[i].low > bars[i - 2].high) {
      fvgs.push({ type: "BULLISH", top: bars[i].low, bottom: bars[i - 2].high, formedAt: i });
    } else if (bars[i].high < bars[i - 2].low) {
      fvgs.push({ type: "BEARISH", top: bars[i - 2].low, bottom: bars[i].high, formedAt: i });
    }
  }
  return fvgs;
}

/**
 * Return the latest unfilled five-minute FVG, optionally in one direction.
 * A bullish gap is invalid after price trades through its lower boundary; a
 * bearish gap is invalid after price trades through its upper boundary.
 */
export function findLatestActiveFvg(
  bars: Bar[],
  type?: IctFvg["type"],
): IctFvg | null {
  const candidates = detectFVG(bars);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (type && candidate.type !== type) continue;
    const laterBars = bars.slice(candidate.formedAt + 1);
    const filled = candidate.type === "BULLISH"
      ? laterBars.some((bar) => bar.low <= candidate.bottom)
      : laterBars.some((bar) => bar.high >= candidate.top);
    if (!filled) {
      return {
        type: candidate.type,
        top: candidate.top,
        bottom: candidate.bottom,
      };
    }
  }
  return null;
}

type SetupDirection = "BULLISH" | "BEARISH";
type CausalSetupStatus =
  | "NONE"
  | "AWAITING_CHOCH"
  | "AWAITING_FVG"
  | "AWAITING_RETRACE"
  | "READY"
  | "INVALIDATED"
  | "EXPIRED";

type SweepEvent = {
  side: "SSL" | "BSL";
  sweepIndex: number;
  reclaimIndex: number;
  extreme: number;
};

export type CausalIctSetup = {
  direction: SetupDirection;
  status: CausalSetupStatus;
  sweepIndex: number | null;
  reclaimIndex: number | null;
  displacementIndex: number | null;
  retraceIndex: number | null;
  structureLevel: number | null;
  fvg: IctFvg | null;
};

function emptyCausalSetup(direction: SetupDirection): CausalIctSetup {
  return {
    direction,
    status: "NONE",
    sweepIndex: null,
    reclaimIndex: null,
    displacementIndex: null,
    retraceIndex: null,
    structureLevel: null,
    fvg: null,
  };
}

/**
 * Find the latest actionable external-liquidity sweep and reclaim.
 * A reclaim must occur on the sweep bar or within the next two 5M bars.
 */
function findRecentSweep(
  bars: Bar[],
  level: number,
  side: "SSL" | "BSL",
): SweepEvent | null {
  const start = Math.max(0, bars.length - SWEEP_LOOKBACK_BARS);
  let latest: SweepEvent | null = null;

  for (let sweepIndex = start; sweepIndex < bars.length; sweepIndex++) {
    const sweepBar = bars[sweepIndex];
    const breached = side === "SSL"
      ? sweepBar.low < level
      : sweepBar.high > level;
    if (!breached) continue;

    const reclaimEnd = Math.min(bars.length - 1, sweepIndex + RECLAIM_WINDOW_BARS);
    for (let reclaimIndex = sweepIndex; reclaimIndex <= reclaimEnd; reclaimIndex++) {
      const reclaimed = side === "SSL"
        ? bars[reclaimIndex].close > level
        : bars[reclaimIndex].close < level;
      if (!reclaimed) continue;

      latest = {
        side,
        sweepIndex,
        reclaimIndex,
        extreme: side === "SSL" ? sweepBar.low : sweepBar.high,
      };
      break;
    }
  }

  return latest;
}

function recentStructureLevel(
  bars: Bar[],
  beforeIndex: number,
  direction: SetupDirection,
): number | null {
  const start = Math.max(0, beforeIndex - STRUCTURE_LOOKBACK_BARS);
  const source = bars.slice(start, beforeIndex);
  if (source.length < 3) return null;
  return direction === "BULLISH"
    ? barMax(source, "high")
    : barMin(source, "low");
}

function displacementBodyRatio(bar: Bar): number {
  const range = bar.high - bar.low;
  return range > 0 ? Math.abs(bar.close - bar.open) / range : 0;
}

function findDisplacement(
  bars: Bar[],
  sweep: SweepEvent,
  direction: SetupDirection,
): { index: number; structureLevel: number } | null {
  const structureLevel = recentStructureLevel(bars, sweep.sweepIndex, direction);
  if (structureLevel === null) return null;

  const end = Math.min(bars.length - 1, sweep.reclaimIndex + CHOCH_WINDOW_BARS);
  for (let index = sweep.reclaimIndex + 1; index <= end; index++) {
    const candidate = bars[index];
    const directionalBody = direction === "BULLISH"
      ? candidate.close > candidate.open
      : candidate.close < candidate.open;
    const breaksStructure = direction === "BULLISH"
      ? candidate.close > structureLevel
      : candidate.close < structureLevel;
    if (
      directionalBody &&
      breaksStructure &&
      displacementBodyRatio(candidate) >= MIN_DISPLACEMENT_BODY_RATIO
    ) {
      return { index, structureLevel };
    }
  }

  return null;
}

function causalFvgCandidates(
  bars: Bar[],
  direction: SetupDirection,
  displacementIndex: number,
): IctFvgCandidate[] {
  const latestFormationIndex = displacementIndex + FVG_FORMATION_WINDOW_BARS;
  return detectFVG(bars).filter((candidate) =>
    candidate.type === direction &&
    candidate.formedAt >= displacementIndex &&
    candidate.formedAt <= latestFormationIndex
  );
}

/**
 * Evaluate a complete sweep → reclaim → CHoCH displacement → new FVG →
 * retracement sequence. The result is deliberately independent of the 15M/5M
 * trend filters so the causal price-action sequence can be tested in isolation.
 */
export function evaluateCausalIctSetup(
  bars: Bar[],
  liquidityLevel: number,
  direction: SetupDirection,
): CausalIctSetup {
  const result = emptyCausalSetup(direction);
  if (bars.length < 6) return result;

  const side = direction === "BULLISH" ? "SSL" : "BSL";
  const sweep = findRecentSweep(bars, liquidityLevel, side);
  if (!sweep) return result;
  result.sweepIndex = sweep.sweepIndex;
  result.reclaimIndex = sweep.reclaimIndex;

  const displacement = findDisplacement(bars, sweep, direction);
  if (!displacement) {
    result.status = bars.length - 1 > sweep.reclaimIndex + CHOCH_WINDOW_BARS
      ? "EXPIRED"
      : "AWAITING_CHOCH";
    return result;
  }
  result.displacementIndex = displacement.index;
  result.structureLevel = displacement.structureLevel;

  const candidates = causalFvgCandidates(bars, direction, displacement.index);
  if (!candidates.length) {
    result.status = bars.length - 1 > displacement.index + FVG_FORMATION_WINDOW_BARS
      ? "EXPIRED"
      : "AWAITING_FVG";
    return result;
  }

  const candidate = candidates[candidates.length - 1];
  result.fvg = {
    type: candidate.type,
    top: candidate.top,
    bottom: candidate.bottom,
  };

  const laterBars = bars.slice(candidate.formedAt + 1);
  const invalidationOffset = laterBars.findIndex((bar) =>
    direction === "BULLISH"
      ? bar.low <= candidate.bottom
      : bar.high >= candidate.top
  );
  if (invalidationOffset >= 0) {
    result.status = "INVALIDATED";
    return result;
  }

  const setupAge = bars.length - 1 - candidate.formedAt;
  if (setupAge > FVG_RETRACE_WINDOW_BARS) {
    result.status = "EXPIRED";
    return result;
  }

  const retraceOffset = laterBars.findIndex((bar) =>
    direction === "BULLISH"
      ? bar.low <= candidate.top && bar.close > candidate.bottom
      : bar.high >= candidate.bottom && bar.close < candidate.top
  );
  if (retraceOffset < 0) {
    result.status = "AWAITING_RETRACE";
    return result;
  }

  const retraceIndex = candidate.formedAt + 1 + retraceOffset;
  result.retraceIndex = retraceIndex;
  const current = bars[bars.length - 1];
  const currentCloseInEntryZone =
    current.close >= candidate.bottom &&
    current.close <= candidate.top;
  result.status = currentCloseInEntryZone ? "READY" : "EXPIRED";
  return result;
}

function setupWaitCopy(
  setup: CausalIctSetup,
  direction: SetupDirection,
): { tradeReason: string; whatToWaitFor: string } {
  const liquidity = direction === "BULLISH" ? "SSL" : "BSL";
  const label = direction === "BULLISH" ? "bullish" : "bearish";
  switch (setup.status) {
    case "AWAITING_CHOCH":
      return {
        tradeReason: `${liquidity} swept and reclaimed, but no qualifying ${label} 5M CHoCH displacement is confirmed.`,
        whatToWaitFor: `A decisive 5M close through the pre-sweep structure with a strong ${label} candle body.`,
      };
    case "AWAITING_FVG":
      return {
        tradeReason: `${liquidity} sweep and ${label} CHoCH are confirmed, but the displacement has not formed a new 5M FVG.`,
        whatToWaitFor: `A new active ${label} 5M FVG formed by the post-sweep displacement.`,
      };
    case "AWAITING_RETRACE":
      return {
        tradeReason: `${liquidity} sweep, ${label} CHoCH, and a new displacement FVG are confirmed.`,
        whatToWaitFor: `A timely retracement into the new 5M ${label} FVG.`,
      };
    case "INVALIDATED":
      return {
        tradeReason: `The post-sweep ${label} FVG was fully invalidated before a tradeable entry completed.`,
        whatToWaitFor: `A fresh ${liquidity} sweep followed by a new ${label} CHoCH and FVG.`,
      };
    case "EXPIRED":
      return {
        tradeReason: `The most recent ${label} sweep-to-FVG sequence expired before a valid entry completed.`,
        whatToWaitFor: `A fresh ${liquidity} sweep and complete post-sweep displacement sequence.`,
      };
    case "NONE":
    default:
      return {
        tradeReason: `No qualifying ${liquidity} sweep and reclaim is active.`,
        whatToWaitFor: `${liquidity} sweep, reclaim, 5M ${label} CHoCH displacement, and a new active FVG.`,
      };
  }
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

  // Buy-side and sell-side liquidity pools must be levels established before
  // the current five-bar sweep window. Including CSH/CSL here makes a sweep
  // self-defeating: the current session high can never be exceeded by a bar
  // inside that same session-high calculation, and likewise for the low.
  // Current-session extremes remain available in `levels` for future display,
  // but PDH/PDL and ONH/ONL are the actionable external liquidity pools.
  const bslCandidates = [levels.pdh, levels.onh].filter((v): v is number => v !== null);
  const sslCandidates = [levels.pdl, levels.onl].filter((v): v is number => v !== null);
  const bsl = bslCandidates.length ? Math.max(...bslCandidates) : null;
  const ssl = sslCandidates.length ? Math.min(...sslCandidates) : null;
  const activeBullishFvg = findLatestActiveFvg(bars5m, "BULLISH");
  const activeBearishFvg = findLatestActiveFvg(bars5m, "BEARISH");
  const recentFvg = bias15m === "Bullish"
    ? activeBullishFvg
    : bias15m === "Bearish"
      ? activeBearishFvg
      : findLatestActiveFvg(bars5m);

  if (bsl === null || ssl === null) {
    return waitState(symbol, displayName,
      "Cannot determine key liquidity levels — session data not yet available.",
      "Prior-day or overnight liquidity levels to accumulate.",
      0, bias15m, struct5m, bsl, ssl, recentFvg);
  }

  const bullishSetup = evaluateCausalIctSetup(bars5m, ssl, "BULLISH");
  const bearishSetup = evaluateCausalIctSetup(bars5m, bsl, "BEARISH");

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
  let setupFvg: IctFvg | null = null;

  // ── Bullish ────────────────────────────────────────────────────────────────
  if (bias15m === "Bullish" && struct5m === "Bullish") {
    setupFvg = bullishSetup.fvg;
    if (bullishSetup.status === "READY" && bullishSetup.fvg !== null) {
      const { top: fvgHigh, bottom: fvgLow } = bullishSetup.fvg;
      const mid  = (fvgLow + fvgHigh) / 2;
      const stopStart = bullishSetup.sweepIndex ?? Math.max(0, bars5m.length - 5);
      const stopEnd = (bullishSetup.retraceIndex ?? bars5m.length - 1) + 1;
      const stop = barMin(bars5m.slice(stopStart, stopEnd), "low");
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
    } else {
      ({ tradeReason, whatToWaitFor } = setupWaitCopy(bullishSetup, "BULLISH"));
    }
  }
  // ── Bearish ────────────────────────────────────────────────────────────────
  else if (bias15m === "Bearish" && struct5m === "Bearish") {
    setupFvg = bearishSetup.fvg;
    if (bearishSetup.status === "READY" && bearishSetup.fvg !== null) {
      const { top: fvgHigh, bottom: fvgLow } = bearishSetup.fvg;
      const mid  = (fvgLow + fvgHigh) / 2;
      const stopStart = bearishSetup.sweepIndex ?? Math.max(0, bars5m.length - 5);
      const stopEnd = (bearishSetup.retraceIndex ?? bars5m.length - 1) + 1;
      const stop = barMax(bars5m.slice(stopStart, stopEnd), "high");
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
    } else {
      ({ tradeReason, whatToWaitFor } = setupWaitCopy(bearishSetup, "BEARISH"));
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
      tradeReason    = "15M bias and 5M structure are not yet aligned for a causal ICT setup.";
      whatToWaitFor  = "Aligned multi-timeframe bias before the sweep → CHoCH → new FVG sequence completes.";
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
    keyFvg: signal === "BUY"
      ? bullishSetup.fvg
      : signal === "SELL"
        ? bearishSetup.fvg
        : setupFvg ?? recentFvg,
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
