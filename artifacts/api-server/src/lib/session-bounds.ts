/**
 * session-bounds.ts — Shared, DST-aware CME session boundary helpers.
 *
 * Single source of truth for the overnight (Globex) session window used by
 * both the market snapshot (onHigh/onLow) and the overnight reference-level
 * engine, so the two can never diverge.
 *
 * Session definition (America/New_York):
 *   RTH:       9:30 AM – 4:15 PM ET
 *   Overnight: 4:15 PM ET → next day 9:30 AM ET
 *
 * The overnight window "containing" a given instant follows the live session
 * lifecycle:
 *   - During RTH (9:30 AM – 4:15 PM ET): the completed session that ended at
 *     today's 9:30 AM open — fixed reference levels for the day.
 *   - After 4:15 PM ET: the newly opened session (today 4:15 PM → tomorrow
 *     9:30 AM) — levels are forming.
 *   - Before 9:30 AM ET: yesterday 4:15 PM → today 9:30 AM — forming.
 */

import type { Bar } from "./market-engine.js";

/** RTH boundaries in ET minutes-from-midnight. */
export const RTH_OPEN_ET_MINS = 9 * 60 + 30;   // 9:30 AM ET
export const RTH_CLOSE_ET_MINS = 16 * 60 + 15; // 4:15 PM ET

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * UTC→ET offset in hours for America/New_York at instant d.
 * US DST: 2nd Sunday March 02:00 EST (07:00 UTC) → 1st Sunday Nov 02:00 EDT (06:00 UTC).
 */
export function getETOffsetHours(d: Date): -4 | -5 {
  const m = d.getUTCMonth(); // 0=Jan … 11=Dec
  if (m >= 3 && m <= 9) return -4;  // Apr–Oct: always EDT
  if (m <= 1 || m === 11) return -5; // Dec–Feb: always EST
  const y = d.getUTCFullYear();
  if (m === 2) { // March: EDT begins on 2nd Sunday at 07:00 UTC
    const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    return d.getTime() >= Date.UTC(y, 2, 8 + ((7 - mar1) % 7), 7) ? -4 : -5;
  }
  // November: EDT ends on 1st Sunday at 06:00 UTC
  const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  return d.getTime() < Date.UTC(y, 10, 1 + ((7 - nov1) % 7), 6) ? -4 : -5;
}

/** Minutes since ET midnight for the given epoch-ms instant. */
export function etMinutesOfDay(ms: number): number {
  const offsetMs = getETOffsetHours(new Date(ms)) * HOUR_MS;
  const et = new Date(ms + offsetMs);
  return et.getUTCHours() * 60 + et.getUTCMinutes();
}

/** Epoch-ms of ET midnight for the ET calendar day containing the instant. */
function etMidnightMs(ms: number): number {
  const offsetMs = getETOffsetHours(new Date(ms)) * HOUR_MS;
  const shifted = ms + offsetMs;
  return shifted - (shifted % DAY_MS) - offsetMs;
}

export type SessionPhase = "overnight" | "rth";

export type OvernightWindow = {
  /** Epoch-ms of the overnight session start (4:15 PM ET). */
  start: number;
  /** Epoch-ms of the overnight session end (9:30 AM ET). */
  end: number;
  /** "overnight" = window still forming (now inside it); "rth" = completed reference window. */
  phase: SessionPhase;
};

/**
 * Overnight session window relevant at `nowMs` (see file header for lifecycle).
 * Levels derived from this window reset at each new RTH open (9:30 AM ET) and
 * begin re-forming at each RTH close (4:15 PM ET).
 */
export function overnightWindow(nowMs: number): OvernightWindow {
  const tod = etMinutesOfDay(nowMs);
  const midnight = etMidnightMs(nowMs);
  const openToday = midnight + RTH_OPEN_ET_MINS * 60_000;
  const closeToday = midnight + RTH_CLOSE_ET_MINS * 60_000;

  if (tod >= RTH_CLOSE_ET_MINS) {
    // New overnight session opened at today's close, ends tomorrow at the open.
    return { start: closeToday, end: openToday + DAY_MS, phase: "overnight" };
  }
  if (tod < RTH_OPEN_ET_MINS) {
    // Still inside the session that began at yesterday's close.
    return { start: closeToday - DAY_MS, end: openToday, phase: "overnight" };
  }
  // RTH: the completed session ending at today's open is the day's reference.
  return { start: closeToday - DAY_MS, end: openToday, phase: "rth" };
}

/** Highest high / lowest low of bars inside [window.start, window.end). Nulls when empty. */
export function overnightHLFromBars(
  bars: Bar[],
  window: { start: number; end: number },
): { onHigh: number | null; onLow: number | null } {
  let onHigh: number | null = null;
  let onLow: number | null = null;
  for (const b of bars) {
    if (b.ts < window.start || b.ts >= window.end) continue;
    if (onHigh === null || b.high > onHigh) onHigh = b.high;
    if (onLow === null || b.low < onLow) onLow = b.low;
  }
  return {
    onHigh: onHigh === null ? null : Number(onHigh.toFixed(2)),
    onLow: onLow === null ? null : Number(onLow.toFixed(2)),
  };
}
