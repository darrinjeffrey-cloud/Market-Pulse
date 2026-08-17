import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getETOffsetHours,
  overnightHLFromBars,
  overnightWindow,
} from "./session-bounds.js";
import type { Bar } from "./market-engine.js";

const bar = (ts: number, high: number, low: number): Bar => ({
  ts, open: (high + low) / 2, high, low, close: (high + low) / 2, volume: 100,
});

describe("getETOffsetHours", () => {
  it("returns -5 (EST) in January and -4 (EDT) in July", () => {
    assert.equal(getETOffsetHours(new Date(Date.UTC(2026, 0, 15, 12))), -5);
    assert.equal(getETOffsetHours(new Date(Date.UTC(2026, 6, 15, 12))), -4);
  });

  it("handles the 2026 DST transitions (Mar 8 and Nov 1)", () => {
    assert.equal(getETOffsetHours(new Date(Date.UTC(2026, 2, 8, 6, 59))), -5);
    assert.equal(getETOffsetHours(new Date(Date.UTC(2026, 2, 8, 7, 1))), -4);
    assert.equal(getETOffsetHours(new Date(Date.UTC(2026, 10, 1, 5, 59))), -4);
    assert.equal(getETOffsetHours(new Date(Date.UTC(2026, 10, 1, 6, 1))), -5);
  });
});

describe("overnightWindow (EDT — July 15, 2026)", () => {
  // EDT: 9:30 AM ET = 13:30 UTC, 4:15 PM ET = 20:15 UTC
  const open = Date.UTC(2026, 6, 15, 13, 30);
  const close = Date.UTC(2026, 6, 15, 20, 15);

  it("during RTH: completed reference window ending at today's open", () => {
    const w = overnightWindow(Date.UTC(2026, 6, 15, 15, 0)); // 11:00 AM ET
    assert.equal(w.phase, "rth");
    assert.equal(w.start, close - 24 * 3_600_000); // yesterday 4:15 PM ET
    assert.equal(w.end, open);
  });

  it("after RTH close: newly opened session is forming (post-close, pre-midnight)", () => {
    const w = overnightWindow(Date.UTC(2026, 6, 15, 21, 0)); // 5:00 PM ET
    assert.equal(w.phase, "overnight");
    assert.equal(w.start, close);                  // today 4:15 PM ET
    assert.equal(w.end, open + 24 * 3_600_000);    // tomorrow 9:30 AM ET
  });

  it("pre-market: session that opened at yesterday's close, still forming", () => {
    const w = overnightWindow(Date.UTC(2026, 6, 15, 8, 0)); // 4:00 AM ET
    assert.equal(w.phase, "overnight");
    assert.equal(w.start, close - 24 * 3_600_000);
    assert.equal(w.end, open);
  });
});

describe("overnightWindow (EST — January 15, 2026)", () => {
  // EST: 9:30 AM ET = 14:30 UTC, 4:15 PM ET = 21:15 UTC
  const open = Date.UTC(2026, 0, 15, 14, 30);
  const close = Date.UTC(2026, 0, 15, 21, 15);

  it("uses EST boundaries during RTH (13:30 UTC is still pre-market)", () => {
    // 13:45 UTC = 8:45 AM ET — pre-market in winter despite being past 13:30 UTC
    const pre = overnightWindow(Date.UTC(2026, 0, 15, 13, 45));
    assert.equal(pre.phase, "overnight");
    assert.equal(pre.end, open);

    const rth = overnightWindow(Date.UTC(2026, 0, 15, 15, 0)); // 10:00 AM ET
    assert.equal(rth.phase, "rth");
    assert.equal(rth.start, close - 24 * 3_600_000);
    assert.equal(rth.end, open);
  });

  it("20:30 UTC (3:30 PM ET) is still RTH; 21:30 UTC (4:30 PM ET) starts the new session", () => {
    assert.equal(overnightWindow(Date.UTC(2026, 0, 15, 20, 30)).phase, "rth");
    const w = overnightWindow(Date.UTC(2026, 0, 15, 21, 30));
    assert.equal(w.phase, "overnight");
    assert.equal(w.start, close);
    assert.equal(w.end, open + 24 * 3_600_000);
  });
});

describe("overnightHLFromBars", () => {
  const start = Date.UTC(2026, 6, 14, 20, 15);
  const end = Date.UTC(2026, 6, 15, 13, 30);

  it("selects highest high / lowest low strictly inside the window", () => {
    const bars = [
      bar(start - 60_000, 9999, 1),      // before window — ignored
      bar(start, 5010, 5000),
      bar(start + 3_600_000, 5025.125, 4990.375),
      bar(end - 60_000, 5015, 5005),
      bar(end, 9999, 1),                 // at end (exclusive) — ignored
    ];
    const { onHigh, onLow } = overnightHLFromBars(bars, { start, end });
    assert.equal(onHigh, 5025.13); // rounded to 2dp
    assert.equal(onLow, 4990.38);
  });

  it("returns nulls when no bars fall inside the window", () => {
    const { onHigh, onLow } = overnightHLFromBars([bar(start - 1, 10, 5)], { start, end });
    assert.equal(onHigh, null);
    assert.equal(onLow, null);
  });
});
