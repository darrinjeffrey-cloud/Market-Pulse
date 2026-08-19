import type { Bar } from "./market-engine.js";
import { globexWindow } from "./session-bounds.js";

export const DEFAULT_TICK_SIZE = 0.25;

export type VwapBands = {
  vwap: number;
  vwapStd1Up: number;
  vwapStd1Down: number;
  vwapStd2Up: number;
  vwapStd2Down: number;
};

export type VwapReversionStatus =
  | "inactive"
  | "watching"
  | "long_setup"
  | "short_setup"
  | "expired";

export type VwapReversionAnalysis = {
  status: VwapReversionStatus;
  signal: "LONG" | "SHORT" | null;
  bands: VwapBands | null;
  currentPrice: number | null;
  deviationSigmas: number | null;
  barsInSession: number;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  riskPts: number | null;
  riskTicks: number | null;
};

function roundPrice(value: number): number {
  return Number(value.toFixed(2));
}

export function calculateVwapBands(
  bars: Bar[],
  minimumSigma = 0,
): VwapBands | null {
  if (bars.length === 0) return null;

  let sumVolume = 0;
  let sumTpVol = 0;
  let sumTp2Vol = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume > 0 ? bar.volume : 1;
    sumVolume += volume;
    sumTpVol += typicalPrice * volume;
    sumTp2Vol += typicalPrice * typicalPrice * volume;
  }

  const vwap = sumTpVol / sumVolume;
  const variance = sumTp2Vol / sumVolume - vwap * vwap;
  const sigma = Math.max(Math.sqrt(Math.max(variance, 0)), minimumSigma);

  return {
    vwap: roundPrice(vwap),
    vwapStd1Up: roundPrice(vwap + sigma),
    vwapStd1Down: roundPrice(vwap - sigma),
    vwapStd2Up: roundPrice(vwap + sigma * 2),
    vwapStd2Down: roundPrice(vwap - sigma * 2),
  };
}

export function currentGlobexBars(bars: Bar[], nowMs: number): Bar[] {
  const window = globexWindow(nowMs);
  return bars.filter(
    (bar) => bar.ts >= window.start && bar.ts < window.end && bar.ts <= nowMs,
  );
}

/**
 * Evaluate a confirmed VWAP mean-reversion setup from arbitrary timeframe bars.
 *
 * The entry must remain between ±1σ and ±2σ. Once price has crossed the ±2σ
 * invalidation level, the displayed stop would be on the wrong side of entry,
 * so the setup remains in watching state instead of publishing unsafe levels.
 */
export function analyzeVwapReversion(
  bars: Bar[],
  nowMs: number = Date.now(),
  tickSize: number = DEFAULT_TICK_SIZE,
): VwapReversionAnalysis {
  const window = globexWindow(nowMs);
  const blank: VwapReversionAnalysis = {
    status: window.phase === "expired" ? "expired" : "inactive",
    signal: null,
    bands: null,
    currentPrice: null,
    deviationSigmas: null,
    barsInSession: 0,
    entry: null,
    stop: null,
    target1: null,
    target2: null,
    riskPts: null,
    riskTicks: null,
  };

  if (window.phase !== "active") return blank;

  const sessionBars = currentGlobexBars(bars, nowMs);
  if (sessionBars.length < 2) {
    return { ...blank, barsInSession: sessionBars.length };
  }

  const minimumSigma = tickSize * 2;
  const bands = calculateVwapBands(sessionBars, minimumSigma);
  if (!bands) return blank;

  const latest = sessionBars[sessionBars.length - 1]!;
  const previous = sessionBars[sessionBars.length - 2]!;
  const currentPrice = roundPrice(latest.close);
  const sigma = bands.vwapStd1Up - bands.vwap;
  const deviationSigmas = sigma > 0
    ? roundPrice((currentPrice - bands.vwap) / sigma)
    : 0;

  const base: VwapReversionAnalysis = {
    ...blank,
    status: "watching",
    bands,
    currentPrice,
    deviationSigmas,
    barsInSession: sessionBars.length,
  };

  const longConfirmed =
    currentPrice < bands.vwapStd1Down &&
    currentPrice > bands.vwapStd2Down &&
    latest.close > previous.close;

  if (longConfirmed) {
    const riskPts = roundPrice(currentPrice - bands.vwapStd2Down);
    return {
      ...base,
      status: "long_setup",
      signal: "LONG",
      entry: currentPrice,
      stop: bands.vwapStd2Down,
      target1: bands.vwap,
      target2: bands.vwapStd1Up,
      riskPts,
      riskTicks: Math.round(riskPts / tickSize),
    };
  }

  const shortConfirmed =
    currentPrice > bands.vwapStd1Up &&
    currentPrice < bands.vwapStd2Up &&
    latest.close < previous.close;

  if (shortConfirmed) {
    const riskPts = roundPrice(bands.vwapStd2Up - currentPrice);
    return {
      ...base,
      status: "short_setup",
      signal: "SHORT",
      entry: currentPrice,
      stop: bands.vwapStd2Up,
      target1: bands.vwap,
      target2: bands.vwapStd1Down,
      riskPts,
      riskTicks: Math.round(riskPts / tickSize),
    };
  }

  return base;
}