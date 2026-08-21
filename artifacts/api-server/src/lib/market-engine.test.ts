/**
 * market-engine.test.ts
 *
 * Unit tests for the directional-bias and alignment signal logic in market-engine.ts.
 *
 * Coverage:
 *  - determineDirectionalBias: BULL / BEAR / NEUTRAL conditions
 *  - evaluateSymbol: BULLISH_ALIGNMENT / BEARISH_ALIGNMENT / null signal
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GetMarketSnapshotResponse } from "@workspace/api-zod";

import {
  determineDirectionalBias,
  evaluateSymbol,
  computeVWAP,
  buffers,
  historicalBootstrapWindow,
  type Bar,
} from "./market-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("historicalBootstrapWindow", () => {
  it("uses the last safely closed minute when booting just after UTC midnight", () => {
    const { start, end } = historicalBootstrapWindow(
      Date.UTC(2026, 7, 21, 0, 0, 43),
    );

    assert.equal(end.getTime(), Date.UTC(2026, 7, 20, 23, 59));
    assert.equal(start.getTime(), Date.UTC(2026, 7, 17, 23, 59));
  });
});

/**
 * Build a sequence of `count` bars with linearly changing closes.
 *
 * Timestamps are spaced 1 hour apart so that when `evaluateSymbol` aggregates
 * into 1m / 5m / 15m / 1h buckets every bar lands in its own bucket — giving
 * each timeframe exactly `count` bars (enough to satisfy the 50-bar warmup).
 *
 * @param startPrice  Close price of bar 0
 * @param step        Price delta per bar (positive → rising, negative → falling)
 * @param count       Number of bars to generate
 * @param lastLowOverride  If provided, overrides the `low` of the final bar
 */
function buildBars(
  startPrice: number,
  step: number,
  count: number,
  lastLowOverride?: number,
): Bar[] {
  const bars: Bar[] = [];
  const baseTs = 1_700_000_000_000; // arbitrary base ms timestamp
  const hourMs = 3_600_000;

  for (let i = 0; i < count; i++) {
    const close = startPrice + step * i;
    const spread = Math.abs(close) * 0.001; // 0.1% spread for high/low
    bars.push({
      ts: baseTs + i * hourMs,
      open: close - spread * 0.5,
      high: close + spread,
      low: i === count - 1 && lastLowOverride !== undefined ? lastLowOverride : close - spread,
      close,
      volume: 1000,
    });
  }
  return bars;
}

/**
 * Build a sequence of `count` bars spaced 1 minute apart.
 *
 * When aggregated to 5m / 15m buckets, consecutive bars share a bucket, so
 * the bucket-start ts is meaningfully earlier than the latest constituent's ts.
 * This makes `lastUpdated` accuracy testable.
 *
 * The base timestamp is aligned to an exact 15-minute boundary so bucket
 * arithmetic is predictable across all TF aggregations.
 */
function buildBarsMinute(
  startPrice: number,
  step: number,
  count: number,
): Bar[] {
  const bars: Bar[] = [];
  // Align to an exact 15-minute boundary for predictable bucket arithmetic.
  const baseTs = 1_700_000_000_000 - (1_700_000_000_000 % (15 * 60_000));
  const minMs = 60_000;

  for (let i = 0; i < count; i++) {
    const close = startPrice + step * i;
    const spread = Math.max(Math.abs(close) * 0.001, 0.01);
    bars.push({
      ts: baseTs + i * minMs,
      open: close - spread * 0.5,
      high: close + spread,
      low: close - spread,
      close,
      volume: 1000,
    });
  }
  return bars;
}

function buildRthReversionBars(
  direction: "LONG" | "SHORT",
): { bars: Bar[]; now: number } {
  const rthOpen = Date.UTC(2026, 6, 15, 13, 30); // 9:30 AM EDT
  const bars: Bar[] = [];

  for (let i = 0; i < 300; i++) {
    let price = i % 2 === 0 ? 98 : 102;
    if (i === 298) price = direction === "LONG" ? 96 : 104;
    if (i === 299) price = direction === "LONG" ? 97 : 103;
    bars.push({
      ts: rthOpen + i * 60_000,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1000,
    });
  }

  return { bars, now: bars[bars.length - 1]!.ts };
}

/** Seed a symbol buffer with pre-built bars, bypassing storeBar validation. */
function seedBuffer(symbol: string, bars: Bar[]): void {
  buffers.set(symbol, [...bars]);
}

// ---------------------------------------------------------------------------
// determineDirectionalBias
// ---------------------------------------------------------------------------

describe("determineDirectionalBias", () => {
  it("returns NEUTRAL when fewer than 20 bars are supplied", () => {
    const bars = buildBars(100, 1, 19);
    assert.equal(determineDirectionalBias(bars).direction, "NEUTRAL");
  });

  it("returns NEUTRAL for exactly 19 bars regardless of direction", () => {
    const rising = buildBars(100, 1, 19);
    const falling = buildBars(200, -1, 19);
    assert.equal(determineDirectionalBias(rising).direction, "NEUTRAL");
    assert.equal(determineDirectionalBias(falling).direction, "NEUTRAL");
  });

  it("returns BULL when price > EMA9 > EMA21, EMA21 is rising, ADX trending, RSI bullish", () => {
    // 55 steadily rising bars: EMA cascade bull, slope up, higher low (fallback),
    // ADX strong (monotone trend → DX ≈ 100), RSI ≈ 100 (all gains).
    const bars = buildBars(100, 1, 55);
    assert.equal(determineDirectionalBias(bars).direction, "BULL");
  });

  it("returns BEAR when price < EMA9 < EMA21, EMA21 falling, ADX trending, RSI bearish", () => {
    // 55 steadily falling bars: EMAs cascade downward, ADX strong, RSI ≈ 0.
    const bars = buildBars(200, -1, 55);
    assert.equal(determineDirectionalBias(bars).direction, "BEAR");
  });

  it("returns NEUTRAL when prices are flat (ADX near zero, no EMA separation)", () => {
    // All closes identical → EMA9 = EMA21 = price → ADX = 0 → NEUTRAL regardless.
    const bars = buildBars(100, 0, 55);
    assert.equal(determineDirectionalBias(bars).direction, "NEUTRAL");
  });

  it("returns NEUTRAL when EMA is bullish but market structure is not (last low is the 20-bar minimum)", () => {
    // Rising price sequence gives bull EMA alignment, but we override the final
    // bar's low to be the lowest value in the 20-bar window — no higher low.
    const bars = buildBars(100, 1, 55, /* lastLowOverride */ 1);
    assert.equal(determineDirectionalBias(bars).direction, "NEUTRAL");
  });

  it("returns NEUTRAL when the final high is the 20-bar maximum (no lower high in bear run)", () => {
    // Falling prices give bear EMA alignment, but we make the last bar have the
    // highest high in the window — lowerHigh = false → no BEAR signal.
    const bars = buildBars(200, -1, 55);
    const last = bars[bars.length - 1];
    bars[bars.length - 1] = { ...last, high: 999_999 };
    assert.equal(determineDirectionalBias(bars).direction, "NEUTRAL");
  });

  it("exposes adx, rsi, and confluenceScore on every return", () => {
    const result = determineDirectionalBias(buildBars(100, 1, 55));
    assert.ok(typeof result.adx === "number" && result.adx >= 0, "adx must be a non-negative number");
    assert.ok(typeof result.rsi === "number" && result.rsi >= 0 && result.rsi <= 100, "rsi must be 0–100");
    assert.ok(typeof result.confluenceScore === "number" && result.confluenceScore >= 0 && result.confluenceScore <= 5, "score must be 0–5");
  });
});

// ---------------------------------------------------------------------------
// evaluateSymbol — signal aggregation
// ---------------------------------------------------------------------------

// Use a dedicated test symbol that won't clash with real watched symbols.
// (buffers.set accepts any string key; evaluateSymbol reads directly from it)
const TEST_SYMBOL = "__test_symbol__";

describe("evaluateSymbol", () => {
  beforeEach(() => {
    // Reset the test buffer before every case.
    buffers.set(TEST_SYMBOL, []);
  });

  it("returns null when the buffer has fewer than 20 bars", () => {
    seedBuffer(TEST_SYMBOL, buildBars(100, 1, 10));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.equal(result, null);
  });

  it("all 3 timeframes are BULL when rising bars meet the bias conditions", () => {
    // 55 rising bars satisfies the 20-bar minimum for all three aggregated TFs (1m, 5m, 15m).
    seedBuffer(TEST_SYMBOL, buildBars(100, 1, 55));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null, "evaluateSymbol must return a state object");
    const directions = Object.values(result.timeframes).map((tf) => tf.direction);
    assert.ok(directions.every((d) => d === "BULL"), `Expected all BULL, got: ${directions.join(", ")}`);
  });

  it("all 3 timeframes are BEAR when falling bars meet the bias conditions", () => {
    seedBuffer(TEST_SYMBOL, buildBars(200, -1, 55));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null, "evaluateSymbol must return a state object");
    const directions = Object.values(result.timeframes).map((tf) => tf.direction);
    assert.ok(directions.every((d) => d === "BEAR"), `Expected all BEAR, got: ${directions.join(", ")}`);
  });

  it("all 3 timeframes appear and are BULL when the buffer has 22 hourly-spaced rising bars", () => {
    // buildBars spaces bars 1 hour apart, so aggregate(bars, N) puts each bar in
    // its own N-minute bucket — all three TFs get exactly 22 bars, which clears
    // the 20-bar minimum for both timeframeState and determineDirectionalBias.
    seedBuffer(TEST_SYMBOL, buildBars(100, 1, 22));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null, "evaluateSymbol must return a state object");
    const tfKeys = Object.keys(result.timeframes).sort();
    assert.deepEqual(tfKeys, ["15m", "1m", "5m"]);
    for (const tf of Object.values(result.timeframes)) {
      assert.equal(tf.direction, "BULL");
    }
  });

  it("all timeframes are NEUTRAL for flat prices", () => {
    // Flat prices → EMA alignment is neither bull nor bear → all NEUTRAL.
    seedBuffer(TEST_SYMBOL, buildBars(100, 0, 55));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);
    const directions = Object.values(result.timeframes).map((tf) => tf.direction);
    assert.ok(directions.every((d) => d === "NEUTRAL"), `Expected all NEUTRAL, got: ${directions.join(", ")}`);
  });

  it("includes lastPrice from the most recent bar", () => {
    const bars = buildBars(100, 1, 55);
    seedBuffer(TEST_SYMBOL, bars);
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);
    // Last close is 100 + 1 * 54 = 154, rounded to 2 dp.
    assert.equal(result.lastPrice, 154.0);
  });

  it("does not publish a VWAP setup when no ±1σ reversal is confirmed", () => {
    seedBuffer(TEST_SYMBOL, buildBars(100, 0, 55));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);
    assert.equal(Object.keys(result.perTimeframeSetup).length, 0);
  });

  it("does not convert a directional trend into a VWAP reversion setup", () => {
    seedBuffer(TEST_SYMBOL, buildBars(100, 1, 55));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);
    assert.equal(Object.keys(result.perTimeframeSetup).length, 0);
  });

  it("publishes a confirmed 1m VWAP long even without a volume spike", () => {
    const { bars, now } = buildRthReversionBars("LONG");
    seedBuffer(TEST_SYMBOL, bars);
    const result = evaluateSymbol(TEST_SYMBOL, now);
    assert.ok(result !== null);

    const setup = result.perTimeframeSetup["1m"];
    assert.ok(setup !== undefined, "confirmed 1m reversion must publish levels");
    assert.equal(setup.strategy, "VWAP_REVERSION");
    assert.equal(setup.direction, "LONG");
    assert.ok(setup.stopLoss < setup.entry);
    assert.ok(setup.entry < setup.tp1);
    assert.ok(setup.tp1 < setup.tp2);
    assert.equal(setup.riskPts, Number((setup.entry - setup.stopLoss).toFixed(2)));
    assert.equal(result.timeframes["1m"]!.volSpike, false);
  });

  it("preserves VWAP setup metadata through the API response validator", () => {
    const { bars, now } = buildRthReversionBars("SHORT");
    seedBuffer(TEST_SYMBOL, bars);
    const result = evaluateSymbol(TEST_SYMBOL, now);
    assert.ok(result !== null);

    const parsed = GetMarketSnapshotResponse.parse({
      timestamp: new Date(now).toISOString(),
      source: "databento",
      isLiveConnected: true,
      markets: { [TEST_SYMBOL]: result },
      message: null,
    });

    const setup = parsed.markets[TEST_SYMBOL]!.perTimeframeSetup?.["1m"];
    assert.equal(setup?.strategy, "VWAP_REVERSION");
    assert.equal(setup?.direction, "SHORT");
    assert.equal(
      parsed.markets[TEST_SYMBOL]!.timeframes["1m"]!.vwapReversionStatus,
      "short_setup",
    );
  });

  // -------------------------------------------------------------------------
  // lastUpdated staleness accuracy
  // -------------------------------------------------------------------------

  it("every timeframe exposes a lastUpdated ISO string", () => {
    seedBuffer(TEST_SYMBOL, buildBars(100, 1, 55));
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);
    for (const [tfKey, tfState] of Object.entries(result.timeframes)) {
      assert.ok(
        typeof tfState.lastUpdated === "string" && !Number.isNaN(Date.parse(tfState.lastUpdated)),
        `${tfKey}.lastUpdated must be a valid ISO string`,
      );
    }
  });

  it("lastUpdated matches the latest constituent 1-minute bar timestamp, not the bucket start", () => {
    // 55 bars spaced 1 minute apart.  The latest bar is at baseTs + 54 * 60_000.
    const bars = buildBarsMinute(100, 1, 55);
    const latestBarTs = bars[bars.length - 1].ts;
    const expectedIso = new Date(latestBarTs).toISOString();

    seedBuffer(TEST_SYMBOL, bars);
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);

    // All three timeframes should report the latest bar's timestamp, not
    // the earlier bucket-start that aggregate() uses for grouping.
    for (const [tfKey, tfState] of Object.entries(result.timeframes)) {
      assert.equal(
        tfState.lastUpdated,
        expectedIso,
        `${tfKey}.lastUpdated should equal the latest 1m bar timestamp`,
      );
    }
  });

  it("5m lastUpdated is not stuck at bucket start when the bucket is partially filled", () => {
    // Need ≥20 5-min buckets → ≥100 1-minute bars.  Use 103 so the last 3 bars
    // sit in a partially-filled 5-min bucket (bucket-start is 3 minutes before
    // the final bar).  lastUpdated must reflect that latest bar, not the earlier
    // bucket open.
    const bars = buildBarsMinute(100, 1, 103);
    const latestBarTs = bars[bars.length - 1].ts;

    seedBuffer(TEST_SYMBOL, bars);
    const result = evaluateSymbol(TEST_SYMBOL);
    assert.ok(result !== null);

    const tfState = result.timeframes["5m"];
    assert.ok(tfState !== undefined, "5m timeframe must exist");
    assert.equal(
      tfState.lastUpdated,
      new Date(latestBarTs).toISOString(),
      "5m lastUpdated must equal the most recent 1m bar ts, not the bucket-start",
    );
  });
});

// ---------------------------------------------------------------------------
// computeVWAP — deviation bands
// ---------------------------------------------------------------------------

describe("computeVWAP deviation bands", () => {
  /** Bar with high = low = close so typical price === price. */
  function flatBar(ts: number, price: number, volume: number): Bar {
    return { ts, open: price, high: price, low: price, close: price, volume };
  }

  const now = Date.UTC(2026, 6, 15, 15, 0); // 11:00 AM EDT

  it("computes VWAP, ±1σ and ±2σ for equal-volume bars", () => {
    // tp = 100 and 104, equal volume → vwap 102, variance 4, σ = 2
    const bars = [flatBar(now - 120_000, 100, 1), flatBar(now - 60_000, 104, 1)];
    const r = computeVWAP(bars, now);
    assert.equal(r.vwap, 102);
    assert.equal(r.vwapStd1Up, 104);
    assert.equal(r.vwapStd1Down, 100);
    assert.equal(r.vwapStd2Up, 106);
    assert.equal(r.vwapStd2Down, 98);
  });

  it("weights variance by volume", () => {
    // tp 100 @ vol 3, tp 110 @ vol 1 → vwap 102.5, var 18.75, σ ≈ 4.3301
    const bars = [flatBar(now - 120_000, 100, 3), flatBar(now - 60_000, 110, 1)];
    const r = computeVWAP(bars, now);
    assert.equal(r.vwap, 102.5);
    assert.equal(r.vwapStd1Up, 106.83);
    assert.equal(r.vwapStd1Down, 98.17);
    assert.equal(r.vwapStd2Up, 111.16);
    assert.equal(r.vwapStd2Down, 93.84);
  });

  it("zero-variance session collapses all bands onto VWAP", () => {
    const bars = [flatBar(now - 120_000, 5000, 2), flatBar(now - 60_000, 5000, 7)];
    const r = computeVWAP(bars, now);
    assert.equal(r.vwap, 5000);
    assert.equal(r.vwapStd1Up, 5000);
    assert.equal(r.vwapStd1Down, 5000);
    assert.equal(r.vwapStd2Up, 5000);
    assert.equal(r.vwapStd2Down, 5000);
  });
});
