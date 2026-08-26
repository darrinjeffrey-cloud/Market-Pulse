import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bar } from "./market-engine.js";
import {
  determineBias,
  evaluateCausalIctSetup,
  findLatestActiveFvg,
} from "./ict-engine.js";

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

function bullishSequence(retrace: "valid" | "invalid" | "none" = "valid"): Bar[] {
  const bars = [
    bar(0, 99, 100, 98, 99.5),
    bar(1, 100, 102, 99, 101),
    bar(2, 101, 103, 100, 102),
    bar(3, 102, 102.5, 100, 101),
    bar(4, 101, 101.5, 99, 100),
    bar(5, 100, 101, 94, 99),       // SSL 95 swept and reclaimed
    bar(6, 99, 102, 98, 101),
    bar(7, 102, 108, 102, 107),     // bullish CHoCH + displacement FVG 101–102
  ];
  if (retrace === "valid") bars.push(bar(8, 106, 106, 101.5, 101.75));
  if (retrace === "invalid") bars.push(bar(8, 103, 104, 100.5, 101));
  return bars;
}

function bearishSequence(): Bar[] {
  return [
    bar(0, 102, 103, 101, 102),
    bar(1, 101, 102, 99, 100),
    bar(2, 100, 101, 97, 98),
    bar(3, 98, 100, 97.5, 99),
    bar(4, 99, 101, 98, 100),
    bar(5, 102, 106, 101, 103),     // BSL 105 swept and reclaimed
    bar(6, 103, 103, 100, 101),
    bar(7, 100, 100.5, 94, 95),     // bearish CHoCH + displacement FVG 100.5–101
    bar(8, 96, 100.75, 95, 100.75), // valid retracement closing inside the FVG
  ];
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

  it("confirms a bullish setup only after sweep, CHoCH, new FVG, and retracement", () => {
    const setup = evaluateCausalIctSetup(bullishSequence(), 95, "BULLISH");

    assert.equal(setup.status, "READY");
    assert.equal(setup.sweepIndex, 5);
    assert.equal(setup.displacementIndex, 7);
    assert.equal(setup.retraceIndex, 8);
    assert.deepEqual(setup.fvg, {
      type: "BULLISH",
      top: 102,
      bottom: 101,
    });
  });

  it("confirms the inverse bearish sweep-to-entry sequence", () => {
    const setup = evaluateCausalIctSetup(bearishSequence(), 105, "BEARISH");

    assert.equal(setup.status, "READY");
    assert.equal(setup.sweepIndex, 5);
    assert.equal(setup.displacementIndex, 7);
    assert.equal(setup.retraceIndex, 8);
    assert.deepEqual(setup.fvg, {
      type: "BEARISH",
      top: 101,
      bottom: 100.5,
    });
  });

  it("rejects an FVG that formed before the liquidity sweep", () => {
    const bars = bullishSequence("none");
    bars[7] = bar(7, 100, 108, 100, 107); // CHoCH, but no post-sweep bullish FVG

    const setup = evaluateCausalIctSetup(bars, 95, "BULLISH");

    assert.equal(setup.status, "AWAITING_FVG");
    assert.equal(setup.fvg, null);
  });

  it("waits when a reclaimed sweep has no qualifying CHoCH displacement", () => {
    const bars = bullishSequence("none").slice(0, 7);
    bars[6] = bar(6, 99, 102, 98, 101); // remains below pre-sweep high 103

    const setup = evaluateCausalIctSetup(bars, 95, "BULLISH");

    assert.equal(setup.status, "AWAITING_CHOCH");
    assert.equal(setup.displacementIndex, null);
  });

  it("invalidates a setup when price fully trades through the displacement FVG", () => {
    const setup = evaluateCausalIctSetup(bullishSequence("invalid"), 95, "BULLISH");

    assert.equal(setup.status, "INVALIDATED");
    assert.notEqual(setup.fvg, null);
  });

  it("expires an unfilled setup after the retracement window", () => {
    const bars = bullishSequence("none");
    for (let index = 8; index <= 20; index++) {
      bars.push(bar(index, 105, 107, 104, 106));
    }

    const setup = evaluateCausalIctSetup(bars, 95, "BULLISH");

    assert.equal(setup.status, "EXPIRED");
    assert.notEqual(setup.fvg, null);
  });

  it("does not keep a bullish entry active after price leaves the FVG", () => {
    const bars = bullishSequence();
    bars.push(bar(9, 103, 110, 102.5, 109));

    const setup = evaluateCausalIctSetup(bars, 95, "BULLISH");

    assert.equal(setup.status, "EXPIRED");
    assert.equal(setup.retraceIndex, 8);
  });

  it("does not keep a bearish entry active after price leaves the FVG", () => {
    const bars = bearishSequence();
    bars.push(bar(9, 99, 100.25, 90, 91));

    const setup = evaluateCausalIctSetup(bars, 105, "BEARISH");

    assert.equal(setup.status, "EXPIRED");
    assert.equal(setup.retraceIndex, 8);
  });
});