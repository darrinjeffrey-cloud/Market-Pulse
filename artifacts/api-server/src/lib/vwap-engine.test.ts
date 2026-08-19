import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { buffers } from "./market-engine.js";
import type { Bar } from "./market-engine.js";
import { computeVwapSeriesSnapshot } from "./vwap-engine.js";
import { analyzeVwapReversion } from "./vwap-reversion.js";

const SYMBOL = "ES.v.0"; // in the default watchlist

const bar = (ts: number, close: number, volume = 500): Bar => ({
  ts,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume,
});

/** Seed n 1-min bars starting at startMs with a gently trending close. */
function seedBars(startMs: number, n: number, base = 5000): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    out.push(bar(startMs + i * 60_000, base + Math.sin(i / 5) * 6 + i * 0.2));
  }
  return out;
}

function reversionBars(
  startMs: number,
  direction: "LONG" | "SHORT" | "NONE" | "BEYOND_STOP",
): Bar[] {
  const prices: number[] = Array.from(
    { length: 20 },
    (_, i) => (i % 2 === 0 ? 98 : 102),
  );
  if (direction === "LONG") prices.push(96, 97);
  if (direction === "SHORT") prices.push(104, 103);
  if (direction === "NONE") prices.push(99, 100);
  if (direction === "BEYOND_STOP") prices.push(90, 91);

  return prices.map((price, index) => ({
    ts: startMs + index * 60_000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1000,
  }));
}

beforeEach(() => {
  buffers.set(SYMBOL, []);
});

describe("analyzeVwapReversion — confirmed trade levels", () => {
  const edtOpen = Date.UTC(2026, 6, 15, 13, 30); // 9:30 AM EDT
  const activeNow = Date.UTC(2026, 6, 15, 14, 30);

  it("creates a long between −1σ entry and −2σ stop", () => {
    const result = analyzeVwapReversion(reversionBars(edtOpen, "LONG"), activeNow);
    assert.equal(result.status, "long_setup");
    assert.equal(result.signal, "LONG");
    assert.ok(result.stop !== null && result.entry !== null);
    assert.ok(result.target1 !== null && result.target2 !== null);
    assert.ok(result.stop < result.entry);
    assert.ok(result.entry < result.target1);
    assert.ok(result.target1 < result.target2);
    assert.equal(result.riskPts, Number((result.entry - result.stop).toFixed(2)));
  });

  it("creates a short between +1σ entry and +2σ stop", () => {
    const result = analyzeVwapReversion(reversionBars(edtOpen, "SHORT"), activeNow);
    assert.equal(result.status, "short_setup");
    assert.equal(result.signal, "SHORT");
    assert.ok(result.stop !== null && result.entry !== null);
    assert.ok(result.target1 !== null && result.target2 !== null);
    assert.ok(result.stop > result.entry);
    assert.ok(result.entry > result.target1);
    assert.ok(result.target1 > result.target2);
    assert.equal(result.riskPts, Number((result.stop - result.entry).toFixed(2)));
  });

  it("stays watching while price remains inside ±1σ", () => {
    const result = analyzeVwapReversion(reversionBars(edtOpen, "NONE"), activeNow);
    assert.equal(result.status, "watching");
    assert.equal(result.signal, null);
    assert.equal(result.entry, null);
  });

  it("does not publish a setup after price has crossed the ±2σ stop", () => {
    const result = analyzeVwapReversion(reversionBars(edtOpen, "BEYOND_STOP"), activeNow);
    assert.equal(result.status, "watching");
    assert.equal(result.signal, null);
    assert.equal(result.stop, null);
  });

  it("is inactive before the EDT open and expired after the close", () => {
    const bars = reversionBars(edtOpen, "LONG");
    assert.equal(
      analyzeVwapReversion(bars, Date.UTC(2026, 6, 15, 13, 29)).status,
      "inactive",
    );
    assert.equal(
      analyzeVwapReversion(bars, Date.UTC(2026, 6, 15, 20, 0)).status,
      "expired",
    );
  });

  it("remains active at 3:30 PM during EST", () => {
    const estOpen = Date.UTC(2026, 0, 15, 14, 30); // 9:30 AM EST
    const result = analyzeVwapReversion(
      reversionBars(estOpen, "LONG"),
      Date.UTC(2026, 0, 15, 20, 30), // 3:30 PM EST
    );
    assert.equal(result.status, "long_setup");
  });

  it("never activates during the weekend", () => {
    const saturdayOpenEquivalent = Date.UTC(2026, 6, 18, 13, 30);
    const result = analyzeVwapReversion(
      reversionBars(saturdayOpenEquivalent, "LONG"),
      Date.UTC(2026, 6, 18, 14, 30),
    );
    assert.equal(result.status, "inactive");
  });
});

describe("computeVwapSeriesSnapshot — EDT (July 15, 2026, UTC−4)", () => {
  // 9:30 AM ET = 13:30 UTC; 4:00 PM ET = 20:00 UTC
  const rthOpen = Date.UTC(2026, 6, 15, 13, 30);

  it("returns empty points with no data", () => {
    const snap = computeVwapSeriesSnapshot(rthOpen + 60 * 60_000);
    const es = snap.markets[SYMBOL]!;
    assert.equal(es.points.length, 0);
    assert.equal(es.overnightHigh, null);
    assert.equal(es.overnightLow, null);
  });

  it("accumulates one point per RTH bar with ordered bands", () => {
    buffers.set(SYMBOL, seedBars(rthOpen, 30));
    const snap = computeVwapSeriesSnapshot(rthOpen + 30 * 60_000);
    const es = snap.markets[SYMBOL]!;
    assert.equal(es.points.length, 30);
    const last = es.points[es.points.length - 1]!;
    assert.ok(last.band2Upper > last.band1Upper);
    assert.ok(last.band1Upper > last.vwap);
    assert.ok(last.vwap > last.band1Lower);
    assert.ok(last.band1Lower > last.band2Lower);
    // First point timestamp is the RTH open bar
    assert.equal(es.points[0]!.timestamp, new Date(rthOpen).toISOString());
  });

  it("excludes pre-RTH (overnight) bars from the series but uses them for overnight H/L", () => {
    // Overnight bars 4:15 PM ET prev day → 9:30 AM ET (here: last 2h before open)
    const overnight = seedBars(rthOpen - 120 * 60_000, 120, 4950);
    const rth = seedBars(rthOpen, 10);
    buffers.set(SYMBOL, [...overnight, ...rth]);
    const snap = computeVwapSeriesSnapshot(rthOpen + 10 * 60_000);
    const es = snap.markets[SYMBOL]!;
    assert.equal(es.points.length, 10);
    assert.ok(es.overnightHigh != null && es.overnightLow != null);
    assert.ok(es.overnightHigh! > es.overnightLow!);
    // Overnight levels come from the ~4950 overnight range, not the 5000 RTH range
    assert.ok(es.overnightHigh! < 4990);
  });

  it("returns empty points outside RTH (before open and after 4:00 PM ET)", () => {
    buffers.set(SYMBOL, seedBars(rthOpen, 30));
    const before = computeVwapSeriesSnapshot(rthOpen - 60_000);
    assert.equal(before.markets[SYMBOL]!.points.length, 0);
    const after = computeVwapSeriesSnapshot(Date.UTC(2026, 6, 15, 20, 1));
    assert.equal(after.markets[SYMBOL]!.points.length, 0);
  });
});

describe("computeVwapSeriesSnapshot — EST (January 15, 2026, UTC−5)", () => {
  // 9:30 AM ET = 14:30 UTC; 4:00 PM ET = 21:00 UTC
  const rthOpen = Date.UTC(2026, 0, 15, 14, 30);

  it("is active right at the EST open (9:30 ET = 14:30 UTC)", () => {
    buffers.set(SYMBOL, seedBars(rthOpen, 5));
    const snap = computeVwapSeriesSnapshot(rthOpen + 5 * 60_000);
    assert.equal(snap.markets[SYMBOL]!.points.length, 5);
  });

  it("stays active between 3:00 and 4:00 PM ET (would be dead under fixed-UTC math)", () => {
    buffers.set(SYMBOL, seedBars(rthOpen, 6 * 60));
    // 3:30 PM ET = 20:30 UTC — after the old hard-coded 20:00 UTC cutoff
    const snap = computeVwapSeriesSnapshot(Date.UTC(2026, 0, 15, 20, 30));
    assert.ok(snap.markets[SYMBOL]!.points.length > 0);
  });

  it("ends at 4:00 PM ET (21:00 UTC)", () => {
    buffers.set(SYMBOL, seedBars(rthOpen, 6 * 60));
    const snap = computeVwapSeriesSnapshot(Date.UTC(2026, 0, 15, 21, 0));
    assert.equal(snap.markets[SYMBOL]!.points.length, 0);
  });
});
