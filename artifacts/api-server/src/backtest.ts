#!/usr/bin/env node
/**
 * backtest.ts — Historical signal replay for Market Posture
 *
 * Fetches 90 days of 1-minute OHLCV bars from Databento and runs four
 * progressively-filtered scenarios to measure how much each filter improves
 * (or hurts) signal quality.
 *
 * Scenarios:
 *   A  Baseline          — raw signal, all hours, ADX ≥ 20
 *   B  RTH only          — restrict to 09:30–16:00 ET (13:30–20:00 UTC)
 *   C  RTH + ADX ≥ 25   — tighter trend gate
 *   D  RTH + ADX ≥ 25   — + require 15m direction to agree with trade direction
 *      + 15m confirm       + ATR ≥ 0.05% of price (skip dead-quiet markets)
 *
 * Trade rules:
 *   Enter at next bar open on direction change
 *   Stop:  max(12-bar swing extreme, entry ± 1.5×ATR)
 *   TP1:   ±1.5R → stop moves to breakeven
 *   TP2:   ±2R   → full exit
 *   Timeout: forced close at bar close after MAX_TRADE_BARS
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run backtest
 */

import { determineDirectionalBias, asPrice, asTimestamp, parseDatabentoJsonLines } from "./lib/market-engine.js";
import type { Bar } from "./lib/market-engine.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DATASET        = "GLBX.MDP3";
const BACKTEST_DAYS  = 90;
const LOOKBACK       = 300;   // bars fed to signal engine
const MAX_TRADE_BARS = 200;   // force-close timeout
const SYMBOLS        = ["ES.v.0", "NQ.v.0", "MES.v.0", "MNQ.v.0"];

// Scenarios: progressively stack filters
const SCENARIOS = [
  { id: "A", label: "Baseline",               rthOnly: false, minAdx: 20, htfConfirm: false, minAtrPct: 0     },
  { id: "B", label: "RTH only",               rthOnly: true,  minAdx: 20, htfConfirm: false, minAtrPct: 0     },
  { id: "C", label: "RTH + ADX≥25",           rthOnly: true,  minAdx: 25, htfConfirm: false, minAtrPct: 0     },
  { id: "D", label: "RTH + ADX≥25 + 15m + ATR", rthOnly: true, minAdx: 25, htfConfirm: true, minAtrPct: 0.0005 },
] as const;

type Scenario = (typeof SCENARIOS)[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function aggregate(bars: Bar[], minutes: number): Bar[] {
  const groups = new Map<number, Bar>();
  for (const bar of bars) {
    const bucket = Math.floor(bar.ts / (minutes * 60_000)) * minutes * 60_000;
    const cur = groups.get(bucket);
    if (!cur) {
      groups.set(bucket, { ...bar, ts: bucket });
    } else {
      cur.high   = Math.max(cur.high, bar.high);
      cur.low    = Math.min(cur.low,  bar.low);
      cur.close  = bar.close;
      cur.volume += bar.volume;
    }
  }
  return [...groups.values()].sort((a, b) => a.ts - b.ts);
}

function computeATR(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs = bars.slice(1).map((b, i) =>
    Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close))
  );
  const slice = trs.slice(-period);
  return slice.length ? slice.reduce((s, v) => s + v, 0) / slice.length : 0;
}

/** True when timestamp falls inside RTH: 09:30–16:00 ET ≈ 13:30–20:00 UTC */
function isRTH(ts: number): boolean {
  const d    = new Date(ts);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins < 20 * 60;
}

/**
 * Pre-compute 15m directional bias for each 15-minute bucket.
 * Returns a sorted array of { ts (bucket open), direction }.
 * Used as a lookup table for HTF confirmation.
 */
function build15mDirectionMap(
  minuteBars: Bar[],
): { ts: number; direction: "BULL" | "BEAR" | "NEUTRAL" }[] {
  const bars = aggregate(minuteBars, 15);
  const map: { ts: number; direction: "BULL" | "BEAR" | "NEUTRAL" }[] = [];
  for (let i = LOOKBACK; i < bars.length; i++) {
    const window    = bars.slice(i - LOOKBACK, i + 1);
    const { direction } = determineDirectionalBias(window);
    map.push({ ts: bars[i].ts, direction });
  }
  return map;
}

/** Look up the most recent 15m direction at or before a given timestamp. */
function htfDirectionAt(
  map: { ts: number; direction: "BULL" | "BEAR" | "NEUTRAL" }[],
  ts: number,
): "BULL" | "BEAR" | "NEUTRAL" {
  // Binary search for the last entry ≤ ts
  let lo = 0, hi = map.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid].ts <= ts) { best = mid; lo = mid + 1; }
    else                   { hi  = mid - 1; }
  }
  return best >= 0 ? map[best].direction : "NEUTRAL";
}

// ─── Databento fetch ──────────────────────────────────────────────────────────

async function fetchHistory(symbol: string, auth: string): Promise<Bar[]> {
  const now   = new Date();
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - BACKTEST_DAYS * 24 * 60 * 60_000);

  const params = new URLSearchParams({
    dataset:  DATASET,
    schema:   "ohlcv-1m",
    symbols:  symbol,
    stype_in: "continuous",
    start:    start.toISOString(),
    end:      end.toISOString(),
    encoding: "json",
  });

  process.stdout.write(`  Fetching ${symbol} (${BACKTEST_DAYS}d)… `);

  const res  = await fetch(
    `https://hist.databento.com/v0/timeseries.get_range?${params.toString()}`,
    { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } },
  );
  const body = await res.text();

  if (!res.ok) {
    process.stdout.write(`FAILED (HTTP ${res.status})\n`);
    if (body) console.error("  ", body.slice(0, 200));
    return [];
  }

  const rows = parseDatabentoJsonLines(body);
  const bars: Bar[] = [];
  for (const row of rows) {
    const hd    = row.hd as Record<string, unknown> | undefined;
    const tsRaw = hd?.ts_event ?? row.ts_event ?? row.timestamp ?? row.ts;
    const ts    = asTimestamp(tsRaw);
    const open  = asPrice(row.open);
    const high  = asPrice(row.high);
    const low   = asPrice(row.low);
    const close = asPrice(row.close);
    const vol   = Number(row.volume ?? 0);
    if (open > 0 && high > 0 && low > 0 && close > 0 && vol > 0) {
      bars.push({ ts, open, high, low, close, volume: vol });
    }
  }

  const deduped = new Map<number, Bar>();
  for (const b of bars) deduped.set(b.ts, b);
  const result = [...deduped.values()].sort((a, b) => a.ts - b.ts);

  process.stdout.write(`${result.length.toLocaleString()} bars\n`);
  return result;
}

// ─── Trade simulation ─────────────────────────────────────────────────────────

type Outcome = "TP2" | "TP1_ONLY" | "STOP" | "TIMEOUT";

type TradeResult = {
  direction: "BULL" | "BEAR";
  entryTs:   number;
  outcome:   Outcome;
  rMultiple: number;
  barsHeld:  number;
};

type Position = {
  direction:   "BULL" | "BEAR";
  entry:       number;
  stop:        number;
  tp1:         number;
  tp2:         number;
  riskPts:     number;
  entryTs:     number;
  entryBarIdx: number;
  reachedTP1:  boolean;
};

function runBacktest(
  minuteBars: Bar[],
  tfMinutes:  number,
  scenario:   Scenario,
  htfMap:     { ts: number; direction: "BULL" | "BEAR" | "NEUTRAL" }[],
): TradeResult[] {
  const bars    = aggregate(minuteBars, tfMinutes);
  const results: TradeResult[] = [];

  let pos:           Position | null = null;
  let prevDirection: "BULL" | "BEAR" | "NEUTRAL" = "NEUTRAL";

  for (let i = LOOKBACK; i < bars.length; i++) {
    const window  = bars.slice(i - LOOKBACK, i + 1);
    const current = bars[i];

    // ── In a trade: check exit ────────────────────────────────────────────
    if (pos) {
      const barsHeld = i - pos.entryBarIdx;
      let outcome: Outcome | null = null;
      let rMultiple = 0;

      if (pos.direction === "BULL") {
        if (!pos.reachedTP1) {
          if (current.low <= pos.stop) {
            outcome = "STOP"; rMultiple = -1;
          } else if (current.high >= pos.tp2) {
            outcome = "TP2"; rMultiple = 2;
          } else if (current.high >= pos.tp1) {
            pos.reachedTP1 = true;
            pos.stop       = pos.entry; // move to breakeven
          }
        } else {
          if (current.low <= pos.entry) {
            outcome = "TP1_ONLY"; rMultiple = 0;
          } else if (current.high >= pos.tp2) {
            outcome = "TP2"; rMultiple = 2;
          }
        }
      } else {
        if (!pos.reachedTP1) {
          if (current.high >= pos.stop) {
            outcome = "STOP"; rMultiple = -1;
          } else if (current.low <= pos.tp2) {
            outcome = "TP2"; rMultiple = 2;
          } else if (current.low <= pos.tp1) {
            pos.reachedTP1 = true;
            pos.stop       = pos.entry;
          }
        } else {
          if (current.high >= pos.entry) {
            outcome = "TP1_ONLY"; rMultiple = 0;
          } else if (current.low <= pos.tp2) {
            outcome = "TP2"; rMultiple = 2;
          }
        }
      }

      if (!outcome && barsHeld >= MAX_TRADE_BARS) {
        outcome   = "TIMEOUT";
        rMultiple = pos.direction === "BULL"
          ? (current.close - pos.entry) / pos.riskPts
          : (pos.entry - current.close) / pos.riskPts;
      }

      if (outcome !== null) {
        results.push({ direction: pos.direction, entryTs: pos.entryTs, outcome, rMultiple, barsHeld });
        pos           = null;
        prevDirection = "NEUTRAL";
      }
      continue;
    }

    // ── No position: evaluate signal ──────────────────────────────────────

    // Filter 1: RTH only
    if (scenario.rthOnly && !isRTH(current.ts)) {
      prevDirection = "NEUTRAL";
      continue;
    }

    const { direction, adx } = determineDirectionalBias(window);
    if (direction === "NEUTRAL") { prevDirection = "NEUTRAL"; continue; }

    // Filter 2: ADX threshold
    if (adx < scenario.minAdx) { prevDirection = direction; continue; }

    // Filter 3: HTF (15m) confirmation — skip for 15m timeframe (it IS the HTF)
    if (scenario.htfConfirm && tfMinutes < 15) {
      const htf = htfDirectionAt(htfMap, current.ts);
      if (htf !== direction) { prevDirection = direction; continue; }
    }

    // Only enter on a direction change (not while the same signal persists)
    if (direction === prevDirection) { prevDirection = direction; continue; }

    // Enter at next bar's open
    const nextIdx = i + 1;
    if (nextIdx >= bars.length) break;
    const nextBar    = bars[nextIdx];
    const entryPrice = nextBar.open;

    const atr       = computeATR(window, 14);

    // Filter 4: minimum ATR (skip dead-quiet markets)
    if (atr < entryPrice * scenario.minAtrPct) { prevDirection = direction; continue; }

    const atrBuffer = atr * 1.5;
    const recent    = window.slice(-12);
    const swingLow  = Math.min(...recent.map(b => b.low));
    const swingHigh = Math.max(...recent.map(b => b.high));

    const stop = direction === "BULL"
      ? Math.min(swingLow, entryPrice - atrBuffer)
      : Math.max(swingHigh, entryPrice + atrBuffer);

    const riskPts = Math.abs(entryPrice - stop);
    if (riskPts <= 0) { prevDirection = direction; continue; }

    const tp1 = direction === "BULL" ? entryPrice + riskPts * 1.5 : entryPrice - riskPts * 1.5;
    const tp2 = direction === "BULL" ? entryPrice + riskPts * 2   : entryPrice - riskPts * 2;

    pos = { direction, entry: entryPrice, stop, tp1, tp2, riskPts, entryTs: nextBar.ts, entryBarIdx: nextIdx, reachedTP1: false };
    prevDirection = direction;
  }

  return results;
}

// ─── Reporting ────────────────────────────────────────────────────────────────

type Stats = {
  trades:  number;
  tp2Pct:  number;
  bePct:   number;
  stopPct: number;
  avgR:    number;
  avgHold: number;
};

function stats(results: TradeResult[]): Stats {
  const n = results.length;
  if (n === 0) return { trades: 0, tp2Pct: 0, bePct: 0, stopPct: 0, avgR: 0, avgHold: 0 };
  return {
    trades:  n,
    tp2Pct:  results.filter(r => r.outcome === "TP2").length       / n * 100,
    bePct:   results.filter(r => r.outcome === "TP1_ONLY").length  / n * 100,
    stopPct: results.filter(r => r.outcome === "STOP").length      / n * 100,
    avgR:    results.reduce((s, r) => s + r.rMultiple, 0)          / n,
    avgHold: results.reduce((s, r) => s + r.barsHeld, 0)           / n,
  };
}

function fmtR(r: number): string {
  return ((r >= 0 ? "+" : "") + r.toFixed(2) + "R").padStart(6);
}
function fmtPct(p: number): string {
  return `${p.toFixed(0)}%`.padStart(4);
}

function printResults(
  symbol: string,
  data: { tf: number; scenario: Scenario; stats: Stats }[],
): void {
  const sym = symbol.replace(".v.0", "");
  console.log(`\n  ┌─ ${sym} ${"─".repeat(72)}`);
  console.log(`  │  TF    Scenario                  Trades   TP2%   BE%  Stop%   Avg R  Hold`);
  console.log(`  │  ${"─".repeat(71)}`);

  for (const tf of [1, 5, 15]) {
    const rows = data.filter(d => d.tf === tf);
    for (const row of rows) {
      const s      = row.stats;
      const tfStr  = `${tf}m`.padEnd(4);
      const scn    = row.scenario.label.padEnd(30);
      const n      = s.trades === 0 ? "     —" : String(s.trades).padStart(6);
      const tp2    = s.trades === 0 ? "  —" : fmtPct(s.tp2Pct);
      const be     = s.trades === 0 ? "  —" : fmtPct(s.bePct);
      const stop   = s.trades === 0 ? "  —" : fmtPct(s.stopPct);
      const avgR   = s.trades === 0 ? "     —" : fmtR(s.avgR);
      const hold   = s.trades === 0 ? "  —" : `${s.avgHold.toFixed(0)}b`.padStart(4);
      console.log(`  │  ${tfStr}  ${scn}${n}  ${tp2}  ${be}  ${stop}  ${avgR} ${hold}`);
    }
    if (tf < 15) console.log(`  │`);
  }
  console.log(`  └${"─".repeat(74)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.error("\n  ✗  DATABENTO_API_KEY is not set.\n");
    process.exit(1);
  }
  const auth = Buffer.from(`${apiKey}:`).toString("base64");

  const W = 76;
  console.log(`\n${"═".repeat(W)}`);
  console.log(`  Market Posture — Signal Backtest (${BACKTEST_DAYS}-day window)`);
  console.log(`  ${new Date().toISOString().slice(0, 10)}  |  Scenarios A–D stacking filters`);
  console.log(`${"═".repeat(W)}`);
  console.log(`  A  Baseline (all hours, ADX≥20)`);
  console.log(`  B  RTH only (09:30–16:00 ET)`);
  console.log(`  C  RTH + ADX≥25`);
  console.log(`  D  RTH + ADX≥25 + 15m confirms direction + ATR≥0.05% of price`);
  console.log(`${"═".repeat(W)}`);

  for (const symbol of SYMBOLS) {
    process.stdout.write("\n");
    const bars = await fetchHistory(symbol, auth);
    if (bars.length < LOOKBACK + 10) {
      console.log(`  Skipping ${symbol} — insufficient bars (${bars.length})`);
      continue;
    }

    // Pre-compute 15m direction map (used by scenario D for 1m/5m HTF confirmation)
    process.stdout.write(`  Building 15m direction map… `);
    const htfMap = build15mDirectionMap(bars);
    process.stdout.write(`${htfMap.length} buckets\n`);

    const results: { tf: number; scenario: Scenario; stats: Stats }[] = [];

    for (const tf of [1, 5, 15]) {
      for (const scenario of SCENARIOS) {
        process.stdout.write(`  Running ${tf}m / Scenario ${scenario.id}… `);
        const trades = runBacktest(bars, tf, scenario, htfMap);
        process.stdout.write(`${trades.length} trades\n`);
        results.push({ tf, scenario, stats: stats(trades) });
      }
    }

    printResults(symbol, results);
  }

  console.log(`\n${"═".repeat(W)}`);
  console.log("  Outcomes:  TP2 = full 2R win  │  BE = TP1 hit, stopped at breakeven (0R)");
  console.log("             Stop = full −1R loss │  Avg R = expected value per trade");
  console.log(`${"═".repeat(W)}\n`);
}

main().catch((err: unknown) => {
  console.error("\n  Backtest failed:", err);
  process.exit(1);
});
