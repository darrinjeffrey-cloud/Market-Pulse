import { EventEmitter } from "events";
import { logger } from "./logger";
import { overnightHLFromBars, overnightWindow } from "./session-bounds.js";

const DATASET = "GLBX.MDP3";

export type CatalogEntry = {
  symbol: string;      // Databento continuous symbol, e.g. "ES.v.0"
  displayName: string; // Trader-friendly label, e.g. "ES.c.0"
  name: string;        // Full name, e.g. "E-mini S&P 500"
  category: string;    // "Equity" | "Energy" | "Metals" | "Fixed Income" | "FX" | "Agriculture"
  multiplier: number;  // Dollar value per 1-point move
};

const FUTURES_CATALOG: CatalogEntry[] = [
  // Equity
  { symbol: "ES.v.0",   displayName: "ES.c.0",   name: "E-mini S&P 500",          category: "Equity",       multiplier: 50 },
  { symbol: "NQ.v.0",   displayName: "NQ.c.0",   name: "E-mini Nasdaq-100",        category: "Equity",       multiplier: 20 },
  { symbol: "RTY.v.0",  displayName: "RTY.c.0",  name: "E-mini Russell 2000",      category: "Equity",       multiplier: 50 },
  { symbol: "YM.v.0",   displayName: "YM.c.0",   name: "E-mini Dow Jones",         category: "Equity",       multiplier: 5 },
  { symbol: "MES.v.0",  displayName: "MES.c.0",  name: "Micro E-mini S&P 500",     category: "Equity",       multiplier: 5 },
  { symbol: "MNQ.v.0",  displayName: "MNQ.c.0",  name: "Micro E-mini Nasdaq-100",  category: "Equity",       multiplier: 2 },
  { symbol: "MRTY.v.0", displayName: "MRTY.c.0", name: "Micro E-mini Russell 2000",category: "Equity",       multiplier: 5 },
  { symbol: "MYM.v.0",  displayName: "MYM.c.0",  name: "Micro E-mini Dow Jones",   category: "Equity",       multiplier: 0.5 },
  // Energy
  { symbol: "CL.v.0",   displayName: "CL.c.0",   name: "Crude Oil (WTI)",          category: "Energy",       multiplier: 1000 },
  { symbol: "NG.v.0",   displayName: "NG.c.0",   name: "Natural Gas",              category: "Energy",       multiplier: 10000 },
  { symbol: "RB.v.0",   displayName: "RB.c.0",   name: "RBOB Gasoline",            category: "Energy",       multiplier: 42000 },
  { symbol: "HO.v.0",   displayName: "HO.c.0",   name: "Heating Oil",              category: "Energy",       multiplier: 42000 },
  // Metals
  { symbol: "GC.v.0",   displayName: "GC.c.0",   name: "Gold",                     category: "Metals",       multiplier: 100 },
  { symbol: "SI.v.0",   displayName: "SI.c.0",   name: "Silver",                   category: "Metals",       multiplier: 5000 },
  { symbol: "HG.v.0",   displayName: "HG.c.0",   name: "Copper",                   category: "Metals",       multiplier: 25000 },
  { symbol: "MGC.v.0",  displayName: "MGC.c.0",  name: "Micro Gold",               category: "Metals",       multiplier: 10 },
  // Fixed Income
  { symbol: "ZB.v.0",   displayName: "ZB.c.0",   name: "30-Year T-Bond",           category: "Fixed Income", multiplier: 1000 },
  { symbol: "ZN.v.0",   displayName: "ZN.c.0",   name: "10-Year T-Note",           category: "Fixed Income", multiplier: 1000 },
  { symbol: "ZF.v.0",   displayName: "ZF.c.0",   name: "5-Year T-Note",            category: "Fixed Income", multiplier: 1000 },
  { symbol: "ZT.v.0",   displayName: "ZT.c.0",   name: "2-Year T-Note",            category: "Fixed Income", multiplier: 2000 },
  // FX
  { symbol: "6E.v.0",   displayName: "6E.c.0",   name: "Euro FX",                  category: "FX",           multiplier: 125000 },
  { symbol: "6J.v.0",   displayName: "6J.c.0",   name: "Japanese Yen",             category: "FX",           multiplier: 12500000 },
  { symbol: "6B.v.0",   displayName: "6B.c.0",   name: "British Pound",            category: "FX",           multiplier: 62500 },
  { symbol: "6A.v.0",   displayName: "6A.c.0",   name: "Australian Dollar",        category: "FX",           multiplier: 100000 },
  { symbol: "6C.v.0",   displayName: "6C.c.0",   name: "Canadian Dollar",          category: "FX",           multiplier: 100000 },
  // Agriculture
  { symbol: "ZC.v.0",   displayName: "ZC.c.0",   name: "Corn",                     category: "Agriculture",  multiplier: 50 },
  { symbol: "ZS.v.0",   displayName: "ZS.c.0",   name: "Soybeans",                 category: "Agriculture",  multiplier: 50 },
  { symbol: "ZW.v.0",   displayName: "ZW.c.0",   name: "Wheat",                    category: "Agriculture",  multiplier: 50 },
];

// Lookup maps derived from catalog
const DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  FUTURES_CATALOG.map((e) => [e.symbol, e.displayName]),
);
const MULTIPLIERS: Record<string, number> = Object.fromEntries(
  FUTURES_CATALOG.map((e) => [e.symbol, e.multiplier]),
);

// Default watchlist — always present, cannot be removed
const DEFAULT_SYMBOLS = ["ES.v.0", "NQ.v.0", "MES.v.0", "MNQ.v.0"];
const watchedSymbols = new Set<string>(DEFAULT_SYMBOLS);
const MAX_BARS = 4320; // 3 days of 1-minute bars — enough for EMA warmup on all timeframes
const REFRESH_MS = 60_000;

export type Bar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type TimeframeState = {
  rvol: number;
  atr: number;
  direction: "BULL" | "BEAR" | "NEUTRAL";
  volSpike: boolean;
  close: number;
  volume: number;
  /** ADX (0–100): < 20 = ranging, 20–40 = trending, > 40 = strong */
  adx: number;
  /** RSI-14 (0–100): > 50 = bullish momentum, < 50 = bearish */
  rsi: number;
  /** VWAP anchored to current UTC calendar day */
  vwap: number;
  /** VWAP + 1 volume-weighted standard deviation */
  vwapStd1Up: number;
  /** VWAP − 1 volume-weighted standard deviation */
  vwapStd1Down: number;
  /** VWAP + 2 volume-weighted standard deviations */
  vwapStd2Up: number;
  /** VWAP − 2 volume-weighted standard deviations */
  vwapStd2Down: number;
  /** True when bar falls inside US equity futures RTH (13:30–20:00 UTC) */
  isRTH: boolean;
  /** 0–5: how many of the five bias factors confirm the active direction */
  confluenceScore: number;
  /** ISO-8601 timestamp of the most recent bar used to compute this timeframe */
  lastUpdated: string;
};

type TradeSetup = {
  entry: number;
  stopLoss: number;
  riskPts: number;
  riskDollarsPerContract: number;
  tp1: number;
  tp2: number;
};

type MarketState = {
  symbol: string;
  lastPrice: number;
  /** Overnight (Globex) session high — prior RTH close (4:15 PM ET) → RTH open (9:30 AM ET). Null until overnight bars exist. */
  onHigh: number | null;
  /** Overnight (Globex) session low. Null until overnight bars exist. */
  onLow: number | null;
  perTimeframeSetup: Record<string, TradeSetup>;
  timeframes: Record<string, TimeframeState>;
};

export type MarketSnapshot = {
  timestamp: string;
  source: "databento" | "unavailable";
  /** true when the Databento Live TCP stream is active; false = polling fallback */
  isLiveConnected: boolean;
  markets: Record<string, MarketState>;
  message: string | null;
};

export const marketEvents = new EventEmitter();
marketEvents.setMaxListeners(100); // Many SSE clients can connect simultaneously

export const buffers = new Map<string, Bar[]>();
for (const symbol of watchedSymbols) buffers.set(symbol, []);

// Set to true by the live-feed module when the Databento TCP stream is active.
let liveConnected = false;

export function setLiveConnected(value: boolean): void {
  liveConnected = value;
}

let latestSnapshot: MarketSnapshot = {
  timestamp: new Date().toISOString(),
  source: "unavailable",
  isLiveConnected: false,
  markets: {},
  message: "Waiting for Databento market data.",
};
let refreshPromise: Promise<void> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

export function asPrice(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.abs(numeric) > 1_000_000 ? numeric / 1e9 : numeric;
}

export function asTimestamp(value: unknown): number {
  // Databento sends ts_event as a nanosecond-epoch string e.g. "1786492800000000000"
  // Convert to number first, then scale to milliseconds.
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Nanoseconds (> 1e15): divide by 1e6 → ms
    // Microseconds (> 1e12): divide by 1e3 → ms
    // Milliseconds (> 1e9): use as-is
    // Seconds: multiply by 1000
    if (numeric > 1e15) return numeric / 1e6;
    if (numeric > 1e12) return numeric / 1e3;
    if (numeric > 1e9) return numeric;
    return numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseCsv(text: string): Record<string, unknown>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
    );
  });
}

// Databento JSON Lines: each row has top-level OHLCV strings + nested hd object.
// { "hd": { "ts_event": "...", "instrument_id": ... }, "open": "...", ... }
export function parseDatabentoJsonLines(text: string): Record<string, unknown>[] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function rowToBar(row: Record<string, unknown>): Bar | null {
  // ts_event lives inside the "hd" header object
  const hd = row.hd as Record<string, unknown> | undefined;
  const tsRaw = hd?.ts_event ?? row.ts_event ?? row.timestamp ?? row.ts;
  const ts = asTimestamp(tsRaw);
  const open = asPrice(row.open);
  const high = asPrice(row.high);
  const low = asPrice(row.low);
  const close = asPrice(row.close);
  const volume = Number(row.volume ?? 0);
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || !Number.isFinite(volume) || volume <= 0) {
    return null;
  }
  return { ts, open, high, low, close, volume };
}

export function storeRows(symbol: string, rows: Record<string, unknown>[]): void {
  const buf = buffers.get(symbol);
  if (!buf) return;
  for (const row of rows) {
    const bar = rowToBar(row);
    if (bar) buf.push(bar);
  }
  const deduped = new Map<number, Bar>();
  for (const bar of buf) deduped.set(bar.ts, bar);
  buffers.set(
    symbol,
    [...deduped.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_BARS),
  );
}

/**
 * Push a single pre-parsed bar directly into the buffer.
 * Called by the Databento Live client on each bar event, bypassing JSON-Lines
 * parsing overhead. Deduplicates by timestamp and caps at MAX_BARS.
 */
export function storeBar(
  symbol: string,
  ts: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): void {
  const buf = buffers.get(symbol);
  if (!buf) return;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || !Number.isFinite(volume) || volume <= 0) return;
  buf.push({ ts, open, high, low, close, volume });
  const deduped = new Map<number, Bar>();
  for (const bar of buf) deduped.set(bar.ts, bar);
  buffers.set(
    symbol,
    [...deduped.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_BARS),
  );
}

function aggregate(bars: Bar[], minutes: number): Bar[] {
  const groups = new Map<number, Bar>();
  // Track the highest constituent bar timestamp per bucket separately from
  // the bucket key so that `timeframeState` can emit an accurate `lastUpdated`.
  const latestBarTs = new Map<number, number>();
  for (const bar of bars) {
    const bucket = Math.floor(bar.ts / (minutes * 60_000)) * minutes * 60_000;
    const current = groups.get(bucket);
    if (!current) {
      groups.set(bucket, { ...bar, ts: bucket });
      latestBarTs.set(bucket, bar.ts);
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
      latestBarTs.set(bucket, Math.max(latestBarTs.get(bucket)!, bar.ts));
    }
  }
  // Replace the bucket-start ts with the latest constituent bar ts.
  // This ensures `timeframeState`'s `lastUpdated` reflects true data freshness
  // rather than the bucket open, which can be up to (minutes - 1) minutes stale.
  for (const [bucket, bar] of groups) {
    bar.ts = latestBarTs.get(bucket) ?? bucket;
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Compute an exponential moving average (matches pandas ewm(span, adjust=False)).
 * k = 2 / (span + 1), initialised to the first value.
 */
function computeEMA(values: number[], span: number): number[] {
  const k = 2 / (span + 1);
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    result.push(i === 0 ? values[0] : values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Technical indicator helpers
// ---------------------------------------------------------------------------

/**
 * Wilder's ADX (Average Directional Index), period=14.
 * Returns 0–100: < 20 = ranging, 20–40 = trending, > 40 = strong trend.
 */
function computeADX(bars: Bar[], period = 14): number {
  if (bars.length < period * 2 + 1) return 0;
  const pdm: number[] = [], ndm: number[] = [], tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], curr = bars[i];
    const up = curr.high - prev.high, dn = prev.low - curr.low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }
  // Wilder initial sums
  let sPDM = pdm.slice(0, period).reduce((s, v) => s + v, 0);
  let sNDM = ndm.slice(0, period).reduce((s, v) => s + v, 0);
  let sTR  = tr.slice(0, period).reduce((s, v) => s + v, 0);
  const dx: number[] = [];
  for (let i = period; i < tr.length; i++) {
    sPDM = sPDM - sPDM / period + pdm[i];
    sNDM = sNDM - sNDM / period + ndm[i];
    sTR  = sTR  - sTR  / period + tr[i];
    const pdi = sTR > 0 ? 100 * sPDM / sTR : 0;
    const ndi = sTR > 0 ? 100 * sNDM / sTR : 0;
    dx.push(pdi + ndi > 0 ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0);
  }
  if (dx.length < period) return 0;
  let adx = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return Number(adx.toFixed(2));
}

/**
 * Wilder's RSI-14. Returns 0–100.
 * > 50 = bullish momentum, < 50 = bearish momentum.
 * > 70 / < 30 signals overbought / oversold exhaustion.
 */
function computeRSI(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 50;
  const closes = bars.map((b) => b.close);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Number((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

export type VwapBands = {
  vwap: number;
  vwapStd1Up: number;
  vwapStd1Down: number;
  vwapStd2Up: number;
  vwapStd2Down: number;
};

/**
 * VWAP anchored to the current UTC calendar day, with ±1σ / ±2σ deviation
 * bands from the volume-weighted variance (E[tp²] − E[tp]², same bar loop).
 * Falls back to the last 60 bars when no same-day bars exist (e.g. overnight gap).
 */
export function computeVWAP(bars: Bar[]): VwapBands {
  const now = Date.now();
  const startOfDay = now - (now % (24 * 60 * 60_000));
  const src = bars.filter((b) => b.ts >= startOfDay);
  const source = src.length > 0 ? src : bars.slice(-60);
  let cumTPV = 0, cumTP2V = 0, cumVol = 0;
  for (const b of source) {
    const tp = (b.high + b.low + b.close) / 3;
    cumTPV += tp * b.volume;
    cumTP2V += tp * tp * b.volume;
    cumVol += b.volume;
  }
  const last = bars[bars.length - 1];
  const vwap = cumVol > 0 ? cumTPV / cumVol : last.close;
  const variance = cumVol > 0 ? cumTP2V / cumVol - vwap * vwap : 0;
  const sigma = Math.sqrt(Math.max(variance, 0));
  const r = (n: number) => Number(n.toFixed(2));
  return {
    vwap: r(vwap),
    vwapStd1Up: r(vwap + sigma),
    vwapStd1Down: r(vwap - sigma),
    vwapStd2Up: r(vwap + sigma * 2),
    vwapStd2Down: r(vwap - sigma * 2),
  };
}

/**
 * True if the bar timestamp falls inside US equity futures Regular Trading Hours:
 * 09:30–16:00 ET ≈ 13:30–20:00 UTC (adequate for CME equity index futures).
 */
function detectRTH(ts: number): boolean {
  const d = new Date(ts);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60;
}

/**
 * Identify swing pivot lows and highs.
 * A bar is a pivot low (high) when its low (high) is strictly lower (higher) than
 * `strength` bars on each side — the standard technical definition.
 */
function findSwingPivots(bars: Bar[], strength = 3): { lows: number[]; highs: number[] } {
  const lows: number[] = [], highs: number[] = [];
  for (let i = strength; i < bars.length - strength; i++) {
    const lo = bars[i].low, hi = bars[i].high;
    let pivLo = true, pivHi = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (bars[j].low  <= lo) pivLo = false;
      if (bars[j].high >= hi) pivHi = false;
    }
    if (pivLo) lows.push(lo);
    if (pivHi) highs.push(hi);
  }
  return { lows, highs };
}

// ---------------------------------------------------------------------------
// Directional bias engine
// ---------------------------------------------------------------------------

/**
 * Evaluates directional bias using five layered factors:
 *
 *  1. EMA alignment   — price > EMA9 > EMA21 (bull) or inverse (bear)
 *  2. EMA21 slope     — rising vs falling over the last 3 bars
 *  3. Swing structure — higher pivot low (bull) or lower pivot high (bear);
 *                       falls back to 20-bar extreme if pivots are sparse
 *  4. ADX filter      — ADX ≥ 20 required; gates direction to NEUTRAL in ranging markets
 *  5. RSI momentum    — bull invalidated when RSI < 45; bear invalidated when RSI > 55
 *
 * Returns direction plus raw indicator values for display and scoring.
 * Requires ≥ 20 bars to run.
 */
export function determineDirectionalBias(bars: Bar[]): {
  direction: "BULL" | "BEAR" | "NEUTRAL";
  adx: number;
  rsi: number;
  confluenceScore: number;
} {
  const fallback = (adx: number, rsi: number) =>
    ({ direction: "NEUTRAL" as const, adx, rsi, confluenceScore: 0 });
  if (bars.length < 20) return fallback(0, 50);

  const closes = bars.map((b) => b.close);
  const highs  = bars.map((b) => b.high);
  const lows   = bars.map((b) => b.low);

  const ema9  = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);

  const lastClose  = closes[closes.length - 1];
  const lastEma9   = ema9[ema9.length - 1];
  const lastEma21  = ema21[ema21.length - 1];
  const ema21_3ago = ema21[ema21.length - 3];

  const emaBullish     = lastClose > lastEma9 && lastEma9 > lastEma21;
  const emaBearish     = lastClose < lastEma9 && lastEma9 < lastEma21;
  const ema21SlopeUp   = lastEma21 > ema21_3ago;
  const ema21SlopeDown = lastEma21 < ema21_3ago;

  // Swing structure — pivot-based when enough pivots exist, 20-bar fallback otherwise
  const { lows: pivLows, highs: pivHighs } = findSwingPivots(bars, 3);
  let higherLow: boolean, lowerHigh: boolean;
  if (pivLows.length >= 2) {
    higherLow = pivLows[pivLows.length - 1] > pivLows[pivLows.length - 2];
  } else {
    const r = lows.slice(-20);
    higherLow = r[r.length - 1] > Math.min(...r);
  }
  if (pivHighs.length >= 2) {
    lowerHigh = pivHighs[pivHighs.length - 1] < pivHighs[pivHighs.length - 2];
  } else {
    const r = highs.slice(-20);
    lowerHigh = r[r.length - 1] < Math.max(...r);
  }

  const adx = computeADX(bars, 14);
  const rsi = computeRSI(bars, 14);
  // ADX requires period*2+1 bars to warm up; bypass the gate when insufficient history
  // rather than falsely marking a clear trend as NEUTRAL.
  const adxComputable = bars.length >= 14 * 2 + 1;
  const trending = !adxComputable || adx >= 20;

  // Confluence score (0–5): how many factors confirm each side
  const bullFactors = [emaBullish, ema21SlopeUp, higherLow, trending, rsi >= 50];
  const bearFactors = [emaBearish, ema21SlopeDown, lowerHigh, trending, rsi <= 50];
  const bullScore = bullFactors.filter(Boolean).length;
  const bearScore = bearFactors.filter(Boolean).length;

  if (emaBullish && ema21SlopeUp && higherLow) {
    if (!trending) return { direction: "NEUTRAL", adx, rsi, confluenceScore: bullScore };
    if (rsi < 45)  return { direction: "NEUTRAL", adx, rsi, confluenceScore: bullScore };
    return { direction: "BULL", adx, rsi, confluenceScore: bullScore };
  }
  if (emaBearish && ema21SlopeDown && lowerHigh) {
    if (!trending) return { direction: "NEUTRAL", adx, rsi, confluenceScore: bearScore };
    if (rsi > 55)  return { direction: "NEUTRAL", adx, rsi, confluenceScore: bearScore };
    return { direction: "BEAR", adx, rsi, confluenceScore: bearScore };
  }
  return { direction: "NEUTRAL", adx, rsi, confluenceScore: Math.max(bullScore, bearScore) };
}

function timeframeState(bars: Bar[]): TimeframeState | null {
  if (bars.length < 20) return null;
  const current = bars[bars.length - 1];
  const volumeWindow = bars.slice(-15, -1).map((bar) => bar.volume);
  const volMa = average(volumeWindow);
  const rvol = volMa > 0 ? current.volume / volMa : 0;
  const trueRanges = bars.slice(1).map((bar, index) => {
    const previous = bars[index];
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
  });
  const atr = average(trueRanges.slice(-14));
  const { direction, adx, rsi, confluenceScore } = determineDirectionalBias(bars);

  return {
    rvol: Number(rvol.toFixed(2)),
    atr: Number(atr.toFixed(2)),
    direction,
    volSpike: rvol > 1.5,
    close: Number(current.close.toFixed(2)),
    volume: Math.round(current.volume),
    adx,
    rsi,
    ...computeVWAP(bars),
    isRTH: detectRTH(current.ts),
    confluenceScore,
    lastUpdated: new Date(current.ts).toISOString(),
  };
}

/**
 * Break-of-structure entry price.
 *
 * For BULL: walks pivot highs from most-recent to oldest and returns the first
 * one that the current close has already exceeded — i.e. the swing high whose
 * break confirmed the bullish BOS.
 *
 * For BEAR: same logic with pivot lows — returns the most recently broken
 * swing low below which price has already traded.
 *
 * Falls back to the current close when no qualifying pivot exists (sparse
 * history or price has not yet cleared any identified swing level).
 */
function bosEntry(
  bars: Bar[],
  direction: "BULL" | "BEAR",
  currentClose: number,
): number {
  const { lows: pivLows, highs: pivHighs } = findSwingPivots(bars, 3);
  if (direction === "BULL") {
    // Scan from most-recent pivot high toward oldest; first one below close is the BOS level
    for (let i = pivHighs.length - 1; i >= 0; i--) {
      if (currentClose > pivHighs[i]) return pivHighs[i];
    }
  } else {
    // Scan from most-recent pivot low toward oldest; first one above close is the BOS level
    for (let i = pivLows.length - 1; i >= 0; i--) {
      if (currentClose < pivLows[i]) return pivLows[i];
    }
  }
  return currentClose; // fallback: no BOS level identified yet
}

function tradeLevels(
  symbol: string,
  entry: number,
  atr: number,
  direction: "BULL" | "BEAR",
  bars: Bar[],
): TradeSetup {
  const recent = bars.slice(-12);
  const swingLow = Math.min(...recent.map((bar) => bar.low));
  const swingHigh = Math.max(...recent.map((bar) => bar.high));
  const atrBuffer = atr * 1.5;
  const pointValue = MULTIPLIERS[symbol] ?? 1;
  const stopLoss =
    direction === "BULL"
      ? Math.min(swingLow, entry - atrBuffer)
      : Math.max(swingHigh, entry + atrBuffer);
  const riskPts = Math.abs(entry - stopLoss);
  const tp1 = direction === "BULL" ? entry + riskPts * 1.5 : entry - riskPts * 1.5;
  const tp2 = direction === "BULL" ? entry + riskPts * 2 : entry - riskPts * 2;
  return {
    entry: Number(entry.toFixed(2)),
    stopLoss: Number(stopLoss.toFixed(2)),
    riskPts: Number(riskPts.toFixed(2)),
    riskDollarsPerContract: Number((riskPts * pointValue).toFixed(2)),
    tp1: Number(tp1.toFixed(2)),
    tp2: Number(tp2.toFixed(2)),
  };
}

/**
 * Overnight (Globex) session high/low for the session relevant right now —
 * DST-aware ET boundaries shared with overnight-engine via session-bounds.
 * Forming after the 4:15 PM ET close, fixed reference during RTH, resets at
 * each 9:30 AM ET open. Nulls when no overnight bars exist.
 */
function computeOvernightHL(bars: Bar[]): { onHigh: number | null; onLow: number | null } {
  return overnightHLFromBars(bars, overnightWindow(Date.now()));
}

export function evaluateSymbol(symbol: string): MarketState | null {
  const bars = buffers.get(symbol) ?? [];
  if (bars.length < 20) return null;
  const oneMinute = aggregate(bars, 1);
  const fiveMinute = aggregate(bars, 5);
  const fifteenMinute = aggregate(bars, 15);
  // Each timeframe carries its own independent directional bias — no cross-TF alignment required.
  const timeframeBars = { "1m": oneMinute, "5m": fiveMinute, "15m": fifteenMinute };
  const states = Object.fromEntries(
    Object.entries(timeframeBars)
      .map(([timeframe, timeframeData]) => [timeframe, timeframeState(timeframeData)])
      .filter((entry): entry is [string, TimeframeState] => entry[1] !== null),
  );
  const latest = bars[bars.length - 1];

  // Compute trade levels for every directional timeframe using its own ATR and bars.
  // NEUTRAL timeframes carry no directional setup.
  const perTimeframeSetup: Record<string, TradeSetup> = {};
  for (const [tfName, tfState] of Object.entries(states)) {
    if (tfState.direction === "NEUTRAL") continue;
    const tfBars = timeframeBars[tfName as keyof typeof timeframeBars];
    if (tfBars) {
      const entry = bosEntry(tfBars, tfState.direction, latest.close);
      perTimeframeSetup[tfName] = tradeLevels(
        symbol,
        entry,
        tfState.atr,
        tfState.direction,
        tfBars,
      );
    }
  }

  return {
    symbol: DISPLAY_NAMES[symbol] ?? symbol,
    lastPrice: Number(latest.close.toFixed(2)),
    ...computeOvernightHL(bars),
    perTimeframeSetup,
    timeframes: states,
  };
}

export function rebuildSnapshot(message: string | null = null): void {
  const markets: Record<string, MarketState> = {};
  for (const symbol of watchedSymbols) {
    const state = evaluateSymbol(symbol);
    if (state) markets[symbol] = state;
  }
  latestSnapshot = {
    timestamp: new Date().toISOString(),
    source: markets && Object.keys(markets).length ? "databento" : "unavailable",
    isLiveConnected: liveConnected,
    markets,
    message:
      message ??
      (Object.keys(markets).length
        ? null
        : "Databento has not returned enough bars for the configured symbols yet."),
  };
  // Notify SSE subscribers and any other listeners
  marketEvents.emit("snapshot", latestSnapshot);
}

// Fetch the prior completed UTC day (24h window ending at midnight) for one symbol.
// Databento historical data only goes up to midnight UTC, so we cap the end there.
async function bootstrapSymbol(symbol: string, auth: string): Promise<void> {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 3 * 24 * 60 * 60_000); // 3 days for EMA warmup
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
    { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } },
  );
  const body = await response.text();
  if (!response.ok) {
    logger.warn({ symbol, status: response.status }, "Databento historical bootstrap failed for symbol");
    return;
  }
  const rows = parseDatabentoJsonLines(body);
  logger.info({ symbol, rowCount: rows.length }, "Historical bootstrap rows received");
  storeRows(symbol, rows);
}

async function bootstrapFromHistory(): Promise<void> {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    rebuildSnapshot("DATABENTO_API_KEY is not configured.");
    return;
  }
  const auth = Buffer.from(`${apiKey}:`).toString("base64");
  // Bootstrap all currently watched symbols in parallel.
  await Promise.all([...watchedSymbols].map((symbol) => bootstrapSymbol(symbol, auth)));
  rebuildSnapshot();
}

export async function refreshMarketData(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = bootstrapFromHistory()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown Databento error";
      logger.error({ err: error }, "Databento historical bootstrap failed");
      rebuildSnapshot(message);
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export function getMarketSnapshot(): MarketSnapshot {
  return latestSnapshot;
}

export function startMarketData(): void {
  if (refreshTimer) return;
  void refreshMarketData();
  // Periodic fallback re-bootstrap (every hour) in case live feed misses a reconnect
  refreshTimer = setInterval(() => void refreshMarketData(), 60 * REFRESH_MS);
  refreshTimer.unref();
}

export function stopMarketData(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

// ---------------------------------------------------------------------------
// Catalog & watchlist management
// ---------------------------------------------------------------------------

export function getCatalog(): CatalogEntry[] {
  return FUTURES_CATALOG;
}

export function getWatchedSymbols(): string[] {
  return [...watchedSymbols];
}

// ---------------------------------------------------------------------------
// Symbol-added hook — set by live-feed.ts to avoid circular imports
// ---------------------------------------------------------------------------

/** Called whenever a new symbol is successfully added to the watchlist. */
let symbolAddedHook: ((symbol: string) => void) | null = null;

/** Register a callback invoked when a new symbol is added (used by live-feed.ts). */
export function setSymbolAddedHook(fn: (symbol: string) => void): void {
  symbolAddedHook = fn;
}

/** Add a symbol to the live watchlist and kick off a historical bootstrap. */
export async function addWatchedSymbol(symbol: string): Promise<{ added: boolean }> {
  if (watchedSymbols.has(symbol)) return { added: false };
  if (!FUTURES_CATALOG.find((e) => e.symbol === symbol)) {
    throw new Error(`Symbol "${symbol}" is not in the futures catalog`);
  }
  watchedSymbols.add(symbol);
  buffers.set(symbol, []);
  const apiKey = process.env.DATABENTO_API_KEY;
  if (apiKey) {
    const auth = Buffer.from(`${apiKey}:`).toString("base64");
    bootstrapSymbol(symbol, auth)
      .then(() => rebuildSnapshot())
      .catch((err: unknown) => logger.warn({ symbol, err }, "Bootstrap failed for added symbol"));
  }
  // Notify live-feed so it can subscribe the new symbol on the active TCP stream
  symbolAddedHook?.(symbol);
  return { added: true };
}

/** Remove a symbol from the watchlist (default symbols cannot be removed). */
export function removeWatchedSymbol(symbol: string): { removed: boolean } {
  if (DEFAULT_SYMBOLS.includes(symbol)) {
    throw new Error(`Cannot remove default symbol "${symbol}"`);
  }
  if (!watchedSymbols.has(symbol)) return { removed: false };
  watchedSymbols.delete(symbol);
  buffers.delete(symbol);
  rebuildSnapshot();
  return { removed: true };
}
