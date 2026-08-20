import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bar } from "./market-engine.js";
import { determineBias, findLatestActiveFvg } from "./ict-engine.js";

function bar(index: number, open: number, high: number, low: number, close: number): Bar {
  return {
    ts: Date.UTC(2026, 7, 20, 13, 30) + index * 5 * 60_000,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

describe("ICT signal helpers", () => {
  it("keeps bullish bias through a normal pullback after a confirmed uptrend", () => {
    const bars: Bar[] = Array.from({ length: 21 }, (_, index) => {
      const base = 100 + index * 2;
      return bar(index, base, base + 1.5, base - 0.5, base + 1);
    });
    // The latest candle is a pullback, not a fresh breakout. The EMA and
    // recent market structure remain bullish.
    bars.push(bar(21, 140, 141, 137, 138));

    assert.equal(determineBias(bars), "Bullish");
  });

  it("ignores a bullish FVG after price fully trades through its lower boundary", () => {
    const bars = [
      bar(0, 98, 100, 96, 99),
      bar(1, 99, 101, 98, 100),
      bar(2, 102, 105, 102, 104), // bullish FVG: 100–102
      bar(3, 104, 106, 103, 105),
      bar(4, 104, 105, 99, 100),  // fills the gap through 100
    ];

    assert.equal(findLatestActiveFvg(bars, "BULLISH"), null);
  });

  it("keeps an unfilled bearish FVG available for a short setup", () => {
    const bars = [
      bar(0, 110, 112, 108, 111),
      bar(1, 109, 110, 106, 107),
      bar(2, 105, 106, 103, 104), // bearish FVG: 106–108
      bar(3, 104, 107, 102, 103),
    ];

    assert.deepEqual(findLatestActiveFvg(bars, "BEARISH"), {
      type: "BEARISH",
      top: 108,
      bottom: 106,
    });
  });
});