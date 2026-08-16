/**
 * CME session clock — mirrors the web dashboard's session logic.
 * All time computations are in America/New_York (ET) without Intl APIs
 * so they work on React Native without polyfills.
 */

export type CMESession = {
  name: string;
  open: boolean;
  nextLabel: string;
  msUntilNext: number;
};

/**
 * Returns the UTC→ET offset in hours for America/New_York at date d.
 * US DST: 2nd Sunday March 02:00 → 1st Sunday Nov 02:00.
 */
export function getETOffsetHours(d: Date): -4 | -5 {
  const m = d.getUTCMonth();
  if (m >= 3 && m <= 9)  return -4;
  if (m <= 1 || m === 11) return -5;
  const y = d.getUTCFullYear();
  if (m === 2) {
    const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    return d.getTime() >= Date.UTC(y, 2, 8 + (7 - mar1) % 7, 7) ? -4 : -5;
  }
  const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  return d.getTime() < Date.UTC(y, 10, 1 + (7 - nov1) % 7, 6) ? -4 : -5;
}

export function getETComponents(d: Date): { day: number; tod: number } {
  const offsetMs = getETOffsetHours(d) * 3_600_000;
  const et = new Date(d.getTime() + offsetMs);
  return { day: et.getUTCDay(), tod: et.getUTCHours() * 60 + et.getUTCMinutes() };
}

const RTH_OPEN    = 9 * 60 + 30;  // 570  — 9:30 AM ET
const RTH_CLOSE   = 16 * 60 + 15; // 975  — 4:15 PM ET
const MAINT_START = 17 * 60;      // 1020 — 5:00 PM ET
const MAINT_END   = 18 * 60;      // 1080 — 6:00 PM ET

export function getCMESession(now: Date): CMESession {
  const { day, tod } = getETComponents(now);
  const msLeft  = (b: number) => (b - tod) * 60_000;
  const msNext  = (t: number) => (1440 - tod + t) * 60_000;
  const ms2Days = (t: number) => (2 * 1440 - tod + t) * 60_000;

  if (day === 6)
    return { name: 'Weekend', open: false, nextLabel: 'Globex opens', msUntilNext: msNext(MAINT_END) };

  if (day === 0) {
    if (tod < MAINT_END)
      return { name: 'Weekend', open: false, nextLabel: 'Globex opens', msUntilNext: msLeft(MAINT_END) };
    return { name: 'Globex', open: true, nextLabel: 'RTH opens', msUntilNext: msNext(RTH_OPEN) };
  }

  if (day <= 4) {
    if (tod < RTH_OPEN)    return { name: 'Globex',      open: true,  nextLabel: 'RTH opens',    msUntilNext: msLeft(RTH_OPEN) };
    if (tod < RTH_CLOSE)   return { name: 'RTH',         open: true,  nextLabel: 'RTH closes',   msUntilNext: msLeft(RTH_CLOSE) };
    if (tod < MAINT_START) return { name: 'Globex',      open: true,  nextLabel: 'Maintenance',  msUntilNext: msLeft(MAINT_START) };
    if (tod < MAINT_END)   return { name: 'Maintenance', open: false, nextLabel: 'Globex opens', msUntilNext: msLeft(MAINT_END) };
    return { name: 'Globex', open: true, nextLabel: 'RTH opens', msUntilNext: msNext(RTH_OPEN) };
  }

  // Friday
  if (tod < RTH_OPEN)    return { name: 'Globex',  open: true,  nextLabel: 'RTH opens',     msUntilNext: msLeft(RTH_OPEN) };
  if (tod < RTH_CLOSE)   return { name: 'RTH',     open: true,  nextLabel: 'RTH closes',    msUntilNext: msLeft(RTH_CLOSE) };
  if (tod < MAINT_START) return { name: 'Globex',  open: true,  nextLabel: 'Weekend close', msUntilNext: msLeft(MAINT_START) };
  return { name: 'Weekend', open: false, nextLabel: 'Globex opens', msUntilNext: ms2Days(MAINT_END) };
}

export function formatCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h > 0)   return `${h}h ${m}m`;
  if (m > 0)   return `${m}m`;
  return '< 1m';
}
