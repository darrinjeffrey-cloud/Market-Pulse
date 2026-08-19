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
  const globexOpen = Date.UTC(2026, 6, 14, 22, 0); // Tuesday 6:00 PM EDT
  const activeNow = Date.UTC(2026, 6, 14, 22, 30);

  it("creates a long between −1σ entry and −2σ stop", () => {
    const result = analyzeVwapReversion(reversionBars(globexOpen, "LONG"), activeNow);
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
    const result = analyzeVwapReversion(reversionBars(globexOpen, "SHORT"), activeNow);
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
    const result = analyzeVwapReversion(reversionBars(globexOpen, "NONE"), activeNow);
    assert.equal(result.status, "watching");
    assert.equal(result.signal, null);
    assert.equal(result.entry, null);
  });

  it("does not publish a setup after price has crossed the ±2σ stop", () => {
    const result = analyzeVwapReversion(reversionBars(globexOpen, "BEYOND_STOP"), activeNow);
    assert.equal(result.status, "watching");
    assert.equal(result.signal, null);
    assert.equal(result.stop, null);
  });

  it("pauses for daily maintenance and expires after Friday's close", () => {
    const bars = reversionBars(globexOpen, "LONG");
    assert.equal(
      analyzeVwapReversion(bars, Date.UTC(2026, 6, 15, 21, 30)).status, // 5:30 PM EDT
      "inactive",
    );
    assert.equal(
      analyzeVwapReversion(bars, Date.UTC(2026, 6, 17, 21, 0)).status, // Friday 5:00 PM EDT
      "expired",
    );
  });

  it("remains active through RTH during EST", () => {
    const estOpen = Date.UTC(2026, 0, 14, 23, 0); // Wednesday 6:00 PM EST
    const result = analyzeVwapReversion(
      reversionBars(estOpen, "LONG"),
      Date.UTC(2026, 0, 15, 20, 30), // 3:30 PM EST
    );
    assert.equal(result.status, "long_setup");
  });

  it("never activates during the weekend and restarts Sunday at 6 PM ET", () => {
    const saturdayOpenEquivalent = Date.UTC(2026, 6, 18, 22, 0);
    const result = analyzeVwapReversion(
      reversionBars(saturdayOpenEquivalent, "LONG"),
      Date.UTC(2026, 6, 18, 22, 30),
    );
    assert.equal(result.status, "expired");

    const sundayOpen = Date.UTC(2026, 6, 19, 22, 0);
    assert.equal(
      analyzeVwapReversion(reversionBars(sundayOpen, "LONG"), sundayOpen + 30 * 60_000).status,
      "long_setup",
    );
  });
});

describe("computeVwapSeriesSnapshot — EDT (July 15, 2026, UTC−4)", () => {
  // Tuesday 6:00 PM ET = Wednesday 22:00 UTC
  const globexOpen = Date.UTC(2026, 6, 14, 22, 0);

  it("returns empty points with no data", () => {
    const snap = computeVwapSeriesSnapshot(globexOpen + 60 * 60_000);
    const es = snap.markets[SYMBOL]!;
    assert.equal(es.points.length, 0);
    assert.equal(es.overnightHigh, null);
    assert.equal(es.overnightLow, null);
  });

  it("accumulates one point per Globex bar with ordered bands", () => {
    buffers.set(SYMBOL, seedBars(globexOpen, 30));
    const snap = computeVwapSeriesSnapshot(globexOpen + 30 * 60_000);
    const es = snap.markets[SYMBOL]!;
    assert.equal(es.points.length, 30);
    const last = es.points[es.points.length - 1]!;
    assert.ok(last.band2Upper > last.band1Upper);
    assert.ok(last.band1Upper > last.vwap);
    assert.ok(last.vwap > last.band1Lower);
    assert.ok(last.band1Lower > last.band2Lower);
    assert.equal(es.points[0]!.timestamp, new Date(globexOpen).toISOString());
  });

  it("keeps the Globex series active throughout RTH", () => {
    const rthNow = Date.UTC(2026, 6, 15, 14, 30); // 10:30 AM EDT
    const evening = seedBars(globexOpen, 10, 4950);
    const rth = seedBars(rthNow - 10 * 60_000, 10);
    buffers.set(SYMBOL, [...evening, ...rth]);
    const snap = computeVwapSeriesSnapshot(rthNow);
    const es = snap.markets[SYMBOL]!;
    assert.equal(es.points.length, 20);
    assert.ok(es.overnightHigh != null && es.overnightLow != null);
    assert.ok(es.overnightHigh! > es.overnightLow!);
    assert.ok(es.overnightHigh! < 4990);
  });

  it("returns empty points during maintenance and the weekend", () => {
    buffers.set(SYMBOL, seedBars(globexOpen, 30));
    const maintenance = computeVwapSeriesSnapshot(Date.UTC(2026, 6, 15, 21, 30));
    assert.equal(maintenance.markets[SYMBOL]!.points.length, 0);
    const weekend = computeVwapSeriesSnapshot(Date.UTC(2026, 6, 18, 14, 0));
    assert.equal(weekend.markets[SYMBOL]!.points.length, 0);
  });
});

describe("computeVwapSeriesSnapshot — EST (January 15, 2026, UTC−5)", () => {
  const globexOpen = Date.UTC(2026, 0, 14, 23, 0); // 6:00 PM EST

  it("is active during RTH on an EST date", () => {
    buffers.set(SYMBOL, seedBars(globexOpen, 5));
    const snap = computeVwapSeriesSnapshot(Date.UTC(2026, 0, 15, 14, 30));
    assert.equal(snap.markets[SYMBOL]!.points.length, 5);
  });

  it("stays active at 3:30 PM ET (would be dead under fixed-UTC math)", () => {
    buffers.set(SYMBOL, seedBars(globexOpen, 6 * 60));
    // 3:30 PM ET = 20:30 UTC — after the old hard-coded 20:00 UTC cutoff
    const snap = computeVwapSeriesSnapshot(Date.UTC(2026, 0, 15, 20, 30));
    assert.ok(snap.markets[SYMBOL]!.points.length > 0);
  });

  it("stays active after RTH and pauses at the EST maintenance break", () => {
    buffers.set(SYMBOL, seedBars(globexOpen, 6 * 60));
    const afterRth = computeVwapSeriesSnapshot(Date.UTC(2026, 0, 15, 21, 0));
    assert.ok(afterRth.markets[SYMBOL]!.points.length > 0);
    const snap = computeVwapSeriesSnapshot(Date.UTC(2026, 0, 15, 22, 30));
    assert.equal(snap.markets[SYMBOL]!.points.length, 0);
  });
});
