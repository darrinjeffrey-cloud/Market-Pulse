#!/usr/bin/env node
/**
 * vwap-backtest.ts — VWAP Reversion strategy backtest
 *
 * Fetches 90 days of 1-minute OHLCV bars from Databento and replays them
 * session-by-session to measure how each σ-threshold combination performs.
 *
 * Scenarios (entry σ / stop σ / reversal candle filter):
 *   A  Aggressive   — entry ±0.75σ · stop ±1.5σ  · no reversal filter
 *   B  Default      — entry ±1.0σ  · stop ±2.0σ  · no reversal filter
 *   C  Conservative — entry ±1.5σ  · stop ±2.5σ  · no reversal filter
 *   D  Live engine  — entry ±1.0σ  · stop ±2.0σ  · reversal candle required
 *
 * VWAP rules:
 *   • Cumulative from RTH open (09:30 ET / 13:30 UTC), reset each session
 *   • σ = volume-weighted standard deviation of typical price (H+L+C)/3
 *   • Min σ guard: 2 ticks (0.50 pts) — skip signal when market is dead flat
 *
 * Trade rules:
 *   • Entry at open of the bar after the signal fires
 *   • T1: VWAP at signal time (stop moves to breakeven)
 *   • T2: ±1σ opposite side (full exit)
 *   • Stop: ±stopS × σ from entry side
 *   • Multiple trades per session allowed — one position at a time
 *   • Session end (20:00 UTC): any open position force-closed at bar close
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run vwap-backtest
 */

import { asPrice, asTimestamp, parseDatabentoJsonLines } from "./lib/market-engine.js";
import type { Bar } from "./lib/market-engine.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DATASET       = "GLBX.MDP3";
const BACKTEST_DAYS = 90;
const SYMBOLS       = ["ES.v.0", "NQ.v.0", "MES.v.0", "MNQ.v.0"];
const TICK_SIZE     = 0.25;
const MIN_SIGMA     = TICK_SIZE * 2;   // ignore signals when market is flat

/** RTH window in UTC minutes-since-midnight */
const RTH_START = 13 * 60 + 30;   // 13:30 UTC = 09:30 ET
const RTH_END   = 20 * 60;        // 20:00 UTC = 16:00 ET

const SCENARIOS = [
  { id: "A", label: "±0.75σ entry / ±1.5σ stop", entryS: 0.75, stopS: 1.5, reversal: false },
  { id: "B", label: "±1.0σ  entry / ±2.0σ stop", entryS: 1.0,  stopS: 2.0, reversal: false },
  { id: "C", label: "±1.5σ  entry / ±2.5σ stop", entryS: 1.5,  stopS: 2.5, reversal: false },
  { id: "D", label: "±1.0σ  entry / ±2.0σ stop + rev", entryS: 1.0, stopS: 2.0, reversal: true },
] as const;

type Scenario = typeof SCENARIOS[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function utcMins(ts: number): number {
  const d = new Date(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function utcDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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

// ─── Session grouping ─────────────────────────────────────────────────────────

/** Split all bars into RTH sessions keyed by calendar date. */
function buildSessions(bars: Bar[]): Map<string, Bar[]> {
  const sessions = new Map<string, Bar[]>();
  for (const bar of bars) {
    const m = utcMins(bar.ts);
    if (m < RTH_START || m >= RTH_END) continue;
    const key = utcDateKey(bar.ts);
    const arr  = sessions.get(key) ?? [];
    arr.push(bar);
    sessions.set(key, arr);
  }
  // Sort bars within each session
  for (const [, arr] of sessions) arr.sort((a, b) => a.ts - b.ts);
  return sessions;
}

// ─── VWAP computation (incremental) ──────────────────────────────────────────

interface VwapAccum {
  sumVol:   number;
  sumTpVol: number;
  sumTp2Vol: number;
}

function updateAccum(accum: VwapAccum, bar: Bar): void {
  const tp  = (bar.high + bar.low + bar.close) / 3;
  const vol = bar.volume > 0 ? bar.volume : 1;
  accum.sumVol   += vol;
  accum.sumTpVol += tp * vol;
  accum.sumTp2Vol += tp * tp * vol;
}

function computeVwapSigma(accum: VwapAccum): { vwap: number; sigma: number } {
  if (accum.sumVol <= 0) return { vwap: 0, sigma: 0 };
  const vwap    = accum.sumTpVol / accum.sumVol;
  const variance = (accum.sumTp2Vol / accum.sumVol) - (vwap * vwap);
  const sigma    = Math.sqrt(Math.max(variance, 0));
  return { vwap, sigma };
}

// ─── Trade types ──────────────────────────────────────────────────────────────

type Direction = "LONG" | "SHORT";
type Outcome   = "TP2" | "TP1_BE" | "STOP" | "SESSION_END";

interface TradeResult {
  direction: Direction;
  entryTs:   number;
  outcome:   Outcome;
  rMultiple: number;   // actual R achieved
  barsHeld:  number;
}

interface Position {
  direction:   Direction;
  entryBarIdx: number;
  entryTs:     number;
  entry:       number;
  stop:        number;
  target1:     number;   // VWAP at signal time
  target2:     number;   // ±1σ opposite side
  riskPts:     number;
  reachedT1:   boolean;
}

// ─── Single session simulation ────────────────────────────────────────────────

function runSession(sessionBars: Bar[], scenario: Scenario): TradeResult[] {
  const results: TradeResult[] = [];
  const accum: VwapAccum = { sumVol: 0, sumTpVol: 0, sumTp2Vol: 0 };

  let pos: Position | null = null;

  for (let i = 0; i < sessionBars.length; i++) {
    const bar = sessionBars[i]!;

    // Always update VWAP accumulator
    updateAccum(accum, bar);

    // ── Manage open position ─────────────────────────────────────────────────
    if (pos !== null) {
      const barsHeld = i - pos.entryBarIdx;
      let outcome: Outcome | null = null;
      let exitPrice = 0;

      if (pos.direction === "LONG") {
        if (!pos.reachedT1) {
          if (bar.low <= pos.stop) {
            outcome = "STOP"; exitPrice = pos.stop;
          } else if (bar.high >= pos.target2) {
            outcome = "TP2"; exitPrice = pos.target2;
          } else if (bar.high >= pos.target1) {
            pos.reachedT1 = true;
            pos.stop      = pos.entry;  // move stop to breakeven
          }
        } else {
          if (bar.low <= pos.entry) {
            outcome = "TP1_BE"; exitPrice = pos.entry;
          } else if (bar.high >= pos.target2) {
            outcome = "TP2"; exitPrice = pos.target2;
          }
        }
      } else {
        if (!pos.reachedT1) {
          if (bar.high >= pos.stop) {
            outcome = "STOP"; exitPrice = pos.stop;
          } else if (bar.low <= pos.target2) {
            outcome = "TP2"; exitPrice = pos.target2;
          } else if (bar.low <= pos.target1) {
            pos.reachedT1 = true;
            pos.stop      = pos.entry;
          }
        } else {
          if (bar.high >= pos.entry) {
            outcome = "TP1_BE"; exitPrice = pos.entry;
          } else if (bar.low <= pos.target2) {
            outcome = "TP2"; exitPrice = pos.target2;
          }
        }
      }

      // Session-end force close
      const isLastBar = i === sessionBars.length - 1;
      if (!outcome && isLastBar) {
        outcome   = "SESSION_END";
        exitPrice = bar.close;
      }

      if (outcome !== null) {
        const signed = pos.direction === "LONG"
          ? exitPrice - pos.entry
          : pos.entry - exitPrice;
        results.push({
          direction: pos.direction,
          entryTs:   pos.entryTs,
          outcome,
          rMultiple: signed / pos.riskPts,
          barsHeld,
        });
        pos = null;
      }
      continue;
    }

    // ── No position — check for signal ───────────────────────────────────────
    // Need at least 2 bars to compute reversal condition
    if (i < 1) continue;

    const { vwap, sigma } = computeVwapSigma(accum);
    if (sigma < MIN_SIGMA) continue;

    const band1Upper = vwap + scenario.entryS * sigma;
    const band1Lower = vwap - scenario.entryS * sigma;
    const band2Upper = vwap + scenario.stopS  * sigma;
    const band2Lower = vwap - scenario.stopS  * sigma;

    const prev = sessionBars[i - 1]!;

    // Long: price extended below entry band AND (reversal candle if required)
    const isLong = bar.close < band1Lower &&
      (!scenario.reversal || bar.close > prev.close);

    // Short: price extended above entry band AND (reversal candle if required)
    const isShort = bar.close > band1Upper &&
      (!scenario.reversal || bar.close < prev.close);

    if (!isLong && !isShort) continue;

    // Enter at next bar's open
    const nextIdx = i + 1;
    if (nextIdx >= sessionBars.length) break;
    const next = sessionBars[nextIdx]!;

    const direction: Direction = isLong ? "LONG" : "SHORT";
    const entry = next.open;

    const stop = direction === "LONG" ? band2Lower : band2Upper;
    const riskPts = Math.abs(entry - stop);
    if (riskPts < TICK_SIZE) continue;  // degenerate — skip

    // T1 = VWAP, T2 = ±1σ on the opposite side
    const target1 = vwap;
    const target2 = direction === "LONG"
      ? vwap + sigma   // overshoot above VWAP
      : vwap - sigma;  // overshoot below VWAP

    pos = {
      direction,
      entryBarIdx: nextIdx,
      entryTs:     next.ts,
      entry, stop, target1, target2, riskPts,
      reachedT1: false,
    };
  }

  return results;
}

// ─── Full backtest for one symbol ─────────────────────────────────────────────

interface TradeStats {
  trades:       number;
  sessions:     number;
  tradesPerSess: number;
  tp2Pct:       number;
  t1BePct:      number;
  stopPct:      number;
  sesEndPct:    number;
  avgR:         number;
  maxConsecLoss: number;
}

function computeStats(results: TradeResult[], sessions: number): TradeStats {
  const n = results.length;
  if (n === 0) {
    return { trades: 0, sessions, tradesPerSess: 0, tp2Pct: 0, t1BePct: 0, stopPct: 0, sesEndPct: 0, avgR: 0, maxConsecLoss: 0 };
  }

  let maxConsecLoss = 0;
  let curLoss = 0;
  for (const r of results) {
    if (r.rMultiple < 0) { curLoss++; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
    else                 { curLoss = 0; }
  }

  return {
    trades:        n,
    sessions,
    tradesPerSess: n / sessions,
    tp2Pct:        results.filter(r => r.outcome === "TP2").length      / n * 100,
    t1BePct:       results.filter(r => r.outcome === "TP1_BE").length   / n * 100,
    stopPct:       results.filter(r => r.outcome === "STOP").length     / n * 100,
    sesEndPct:     results.filter(r => r.outcome === "SESSION_END").length / n * 100,
    avgR:          results.reduce((s, r) => s + r.rMultiple, 0) / n,
    maxConsecLoss,
  };
}

function runSymbol(
  bars: Bar[],
  scenario: Scenario,
): { stats: TradeStats } {
  const sessions = buildSessions(bars);
  const allResults: TradeResult[] = [];

  for (const [, sessionBars] of sessions) {
    if (sessionBars.length < 3) continue;  // skip stub sessions
    const trades = runSession(sessionBars, scenario);
    allResults.push(...trades);
  }

  return { stats: computeStats(allResults, sessions.size) };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function fmtR(r: number): string {
  return ((r >= 0 ? "+" : "") + r.toFixed(2) + "R").padStart(7);
}
function fmtPct(p: number): string {
  return `${p.toFixed(0)}%`.padStart(4);
}
function fmtN(n: number): string {
  return String(n).padStart(6);
}

function printResults(
  symbol: string,
  rows: { scenario: Scenario; stats: TradeStats }[],
): void {
  const sym = symbol.replace(".v.0", "");
  const W = 86;
  console.log(`\n  ┌─ ${sym} ${"─".repeat(W - 5)}`);
  console.log(`  │  Scenario                         Trades  /sess   TP2%  T1-BE%  Stop%  SesEnd%   Avg R  MaxDD`);
  console.log(`  │  ${"─".repeat(W - 3)}`);

  for (const { scenario, stats: s } of rows) {
    const lbl      = scenario.label.padEnd(34);
    const n        = s.trades === 0 ? "     —" : fmtN(s.trades);
    const perSess  = s.trades === 0 ? "   —" : s.tradesPerSess.toFixed(1).padStart(4);
    const tp2      = s.trades === 0 ? "  —" : fmtPct(s.tp2Pct);
    const t1be     = s.trades === 0 ? "    —" : fmtPct(s.t1BePct).padStart(6);
    const stop     = s.trades === 0 ? "  —" : fmtPct(s.stopPct).padStart(5);
    const sesEnd   = s.trades === 0 ? "      —" : fmtPct(s.sesEndPct).padStart(7);
    const avgR     = s.trades === 0 ? "      —" : fmtR(s.avgR);
    const maxdd    = s.trades === 0 ? "   —" : String(s.maxConsecLoss).padStart(4);
    console.log(`  │  ${lbl}${n}  ${perSess}  ${tp2}${t1be}${stop}${sesEnd}  ${avgR}  ${maxdd}`);
  }

  console.log(`  └${"─".repeat(W)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.DATABENTO_API_KEY;
  if (!apiKey) {
    console.error("\n  ✗  DATABENTO_API_KEY is not set.\n");
    process.exit(1);
  }
  const auth = Buffer.from(`${apiKey}:`).toString("base64");

  const W = 90;
  console.log(`\n${"═".repeat(W)}`);
  console.log(`  Market Posture — VWAP Reversion Backtest (${BACKTEST_DAYS}-day window)`);
  console.log(`  ${new Date().toISOString().slice(0, 10)}  |  RTH only · 1-minute bars · multiple trades/session`);
  console.log(`${"═".repeat(W)}`);
  console.log(`  A  ±0.75σ entry · ±1.5σ stop  · no reversal filter  (aggressive)`);
  console.log(`  B  ±1.0σ  entry · ±2.0σ stop  · no reversal filter  (default, no filter)`);
  console.log(`  C  ±1.5σ  entry · ±2.5σ stop  · no reversal filter  (conservative)`);
  console.log(`  D  ±1.0σ  entry · ±2.0σ stop  · reversal candle req (live engine)`);
  console.log(`${"═".repeat(W)}`);
  console.log(`  VWAP: volume-weighted avg of typical price (H+L+C)/3, cumulative from RTH open`);
  console.log(`  σ   : volume-weighted std dev · min ${MIN_SIGMA} pts guard`);
  console.log(`  T1  : VWAP at signal time (stop → breakeven) · T2 : ±1σ opposite side`);
  console.log(`  MaxDD: max consecutive full-stop losses`);
  console.log(`${"═".repeat(W)}`);

  for (const symbol of SYMBOLS) {
    process.stdout.write("\n");
    const bars = await fetchHistory(symbol, auth);
    if (bars.length < 10) {
      console.log(`  Skipping ${symbol} — insufficient bars (${bars.length})`);
      continue;
    }

    const rows: { scenario: Scenario; stats: TradeStats }[] = [];
    for (const scenario of SCENARIOS) {
      process.stdout.write(`  Running Scenario ${scenario.id}… `);
      const { stats } = runSymbol(bars, scenario);
      process.stdout.write(`${stats.trades} trades across ${stats.sessions} sessions\n`);
      rows.push({ scenario, stats });
    }

    printResults(symbol, rows);
  }

  console.log(`\n${"═".repeat(W)}`);
  console.log("  Outcomes:");
  console.log("    TP2      = price reached ±1σ opposite side (full target)");
  console.log("    T1-BE    = price reached VWAP then reversed (stopped at breakeven = 0R)");
  console.log("    Stop     = price hit ±stopS×σ (full −1R loss)");
  console.log("    SesEnd   = position open at 16:00 ET close (mark-to-market R)");
  console.log("  Avg R = expected value per trade in risk multiples");
  console.log(`${"═".repeat(W)}\n`);
}

main().catch((err: unknown) => {
  console.error("\n  Backtest failed:", err);
  process.exit(1);
});
