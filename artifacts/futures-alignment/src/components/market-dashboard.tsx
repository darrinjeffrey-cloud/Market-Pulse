import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OrbPanel } from './OrbPanel';
import { VwapPanel } from './VwapPanel';
import { IctPanel } from './IctPanel';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Cable,
  Check,
  ChevronRight,
  CircleDashed,
  Clock3,
  Copy,
  Database,
  Gauge,
  Link2,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Radio,
  Search,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Trash2,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  getGetMarketSnapshotQueryKey,
  getHealthCheckQueryKey,
  getStreamMarketSnapshotQueryKey,
  useGetMarketSnapshot,
  useHealthCheck,
  useStreamMarketSnapshot,
} from '@workspace/api-client-react';
import type {
  MarketSnapshot,
  MarketState,
  TimeframeState,
} from '@workspace/api-client-react';

type StreamState = 'connecting' | 'live' | 'disconnected';

const DISPLAY_ORDER = ['ES', 'NQ', 'MES', 'MNQ'];

function formatPrice(value: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCompact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString('en-US');
}

function formatTimestamp(value?: string | null) {
  if (!value) return 'Awaiting timestamp';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Returns a human-readable staleness age, e.g. "2m ago" or "1h ago". */
function formatStaleAge(tfState: TimeframeState, now: number): string {
  const lu = (tfState as unknown as { lastUpdated?: string }).lastUpdated;
  if (!lu) return 'stale';
  const ageMs = now - new Date(lu).getTime();
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 1) return '<1m ago';
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ago`;
}


function StatusPill({
  state,
  label,
}: {
  state: 'live' | 'connecting' | 'disconnected' | 'unavailable';
  label: string;
}) {
  const config = {
    live: {
      className: 'border-[hsl(var(--chart-4)/.28)] bg-[hsl(var(--chart-4)/.1)] text-[hsl(var(--chart-4))]',
      dot: 'bg-[hsl(var(--chart-4))]',
    },
    connecting: {
      className: 'border-[hsl(var(--primary)/.28)] bg-[hsl(var(--primary)/.08)] text-[hsl(var(--primary))]',
      dot: 'bg-[hsl(var(--primary))]',
    },
    disconnected: {
      className: 'border-[hsl(var(--destructive)/.34)] bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]',
      dot: 'bg-[hsl(var(--destructive))]',
    },
    unavailable: {
      className: 'border-[hsl(var(--muted-foreground)/.25)] bg-[hsl(var(--muted)/.6)] text-[hsl(var(--muted-foreground))]',
      dot: 'bg-[hsl(var(--muted-foreground))]',
    },
  }[state];

  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.14em] ${config.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot} ${state === 'live' ? 'fam-pulse' : ''}`} />
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = 'default',
  suffix,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'lime' | 'cyan' | 'coral';
  suffix?: string;
}) {
  const tones = {
    default: 'text-foreground',
    lime: 'text-[hsl(var(--primary))]',
    cyan: 'text-[hsl(var(--accent))]',
    coral: 'text-[hsl(var(--destructive))]',
  };

  return (
    <div className="min-w-0">
      <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">{label}</div>
      <div className={`fam-mono truncate text-[15px] font-medium ${tones[tone]}`}>
        {value}
        {suffix ? <span className="ml-1 text-[10px] text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-timeframe tab UI
// ---------------------------------------------------------------------------

// Local extension — perTimeframeSetup added server-side, not yet in generated client types
type TfSetup = {
  entry: number;
  stopLoss: number;
  riskPts: number;
  riskDollarsPerContract: number;
  tp1: number;
  tp2: number;
};
type ExtMarket = MarketState & { perTimeframeSetup?: Record<string, TfSetup> };

const TF_ORDER = ['1m', '5m', '15m'] as const;
type Tf = (typeof TF_ORDER)[number];

/** Maximum age (ms) before a timeframe's data is considered stale. */
const STALE_THRESHOLD_MS: Record<string, number> = {
  '1m':  2 * 60_000,   // 2 min
  '5m':  6 * 60_000,   // 6 min
  '15m': 20 * 60_000,  // 20 min
};

function isTimeframeStale(tfState: TimeframeState, tfKey: string, now: number): boolean {
  const lu = (tfState as unknown as { lastUpdated?: string }).lastUpdated;
  if (!lu) return false;
  const threshold = STALE_THRESHOLD_MS[tfKey] ?? 2 * 60_000;
  return now - new Date(lu).getTime() > threshold;
}

/**
 * Converts the three indicator values into a single 0–100% confidence reading.
 *
 * Composition:
 *   base     = (confluenceScore / 5) × 60   → 0–60 %  (structural factors)
 *   adxBonus = (min(adx, 60) / 60)  × 20   → 0–20 %  (trend strength)
 *   rsiBonus = (min(|rsi−50|, 40) / 40) × 20 → 0–20 % (momentum conviction)
 *
 * NEUTRAL signals are capped at 60 % so they never reach the yellow/green bands.
 */
function computeConfidencePct(timeframe: TimeframeState): number {
  const score = (timeframe as unknown as { confluenceScore?: number }).confluenceScore ?? 0;
  const adx   = (timeframe as unknown as { adx?: number }).adx ?? 0;
  const rsi   = (timeframe as unknown as { rsi?: number }).rsi ?? 50;

  const base     = (score / 5) * 60;
  const adxBonus = (Math.min(adx, 60) / 60) * 20;
  const rsiBonus = (Math.min(Math.abs(rsi - 50), 40) / 40) * 20;

  const raw = Math.min(100, Math.round(base + adxBonus + rsiBonus));
  // NEUTRAL can only reflect "near-miss" conditions — cap below the yellow band
  return timeframe.direction === 'NEUTRAL' ? Math.min(raw, 60) : raw;
}

function confidenceColor(pct: number, direction: 'BULL' | 'BEAR' | 'NEUTRAL'): string {
  if (direction === 'BULL' && pct >= 80) return 'text-[hsl(var(--chart-4))]';   // green
  if (direction === 'BEAR' && pct >= 80) return 'text-[hsl(var(--destructive))]'; // red
  if (pct >= 70) return 'text-yellow-400';                                         // yellow
  return 'text-muted-foreground';                                                  // grey
}

// ---------------------------------------------------------------------------
// CME session clock
// ---------------------------------------------------------------------------

/**
 * Returns the UTC→ET offset in hours for America/New_York at date d.
 * US DST: 2nd Sunday March 02:00 EST (07:00 UTC) → 1st Sunday Nov 02:00 EDT (06:00 UTC).
 * April–October are always EDT (-4); Dec–Feb are always EST (-5);
 * March and November require the precise Sunday boundary check.
 */
function getETOffsetHours(d: Date): -4 | -5 {
  const m = d.getUTCMonth(); // 0=Jan … 11=Dec
  if (m >= 3 && m <= 9)  return -4;  // Apr–Oct: always EDT
  if (m <= 1 || m === 11) return -5; // Dec–Feb: always EST
  const y = d.getUTCFullYear();
  if (m === 2) { // March: EDT begins on 2nd Sunday at 07:00 UTC
    const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    return d.getTime() >= Date.UTC(y, 2, 8 + (7 - mar1) % 7, 7) ? -4 : -5;
  }
  // November: EDT ends on 1st Sunday at 06:00 UTC
  const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  return d.getTime() < Date.UTC(y, 10, 1 + (7 - nov1) % 7, 6) ? -4 : -5;
}

/** Returns {day: 0=Sun…6=Sat, tod: minutes since midnight} in America/New_York. */
function getETComponents(d: Date): { day: number; tod: number } {
  const offsetMs = getETOffsetHours(d) * 3_600_000;
  const et = new Date(d.getTime() + offsetMs);
  return { day: et.getUTCDay(), tod: et.getUTCHours() * 60 + et.getUTCMinutes() };
}

const RTH_OPEN   = 9 * 60 + 30;  // 570  — 9:30 AM ET
const RTH_CLOSE  = 16 * 60 + 15; // 975  — 4:15 PM ET
const MAINT_START = 17 * 60;     // 1020 — 5:00 PM ET
const MAINT_END   = 18 * 60;     // 1080 — 6:00 PM ET

type CMESession = { name: string; open: boolean; nextLabel: string; msUntilNext: number };

function getCMESession(now: Date): CMESession {
  const { day, tod } = getETComponents(now);
  // Helpers — all return milliseconds
  const msLeft  = (b: number) => (b - tod) * 60_000;                      // until today's boundary
  const msNext  = (t: number) => (1440 - tod + t) * 60_000;               // until tomorrow at t
  const ms2Days = (t: number) => (2 * 1440 - tod + t) * 60_000;           // until day-after-tomorrow at t

  if (day === 6) // Saturday — whole day is weekend
    return { name: 'Weekend', open: false, nextLabel: 'Globex opens', msUntilNext: msNext(MAINT_END) };

  if (day === 0) { // Sunday
    if (tod < MAINT_END)
      return { name: 'Weekend', open: false, nextLabel: 'Globex opens', msUntilNext: msLeft(MAINT_END) };
    return { name: 'Globex', open: true, nextLabel: 'RTH opens', msUntilNext: msNext(RTH_OPEN) };
  }

  if (day <= 4) { // Mon – Thu
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

function formatCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 48) return `${Math.floor(h / 24)}d`;
  if (h > 0)   return `${h}h ${m}m`;
  if (m > 0)   return `${m}m`;
  return '< 1m';
}

function SessionClock() {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const session = getCMESession(new Date(tick));

  const dotClass = session.name === 'RTH'
    ? 'bg-[hsl(var(--chart-4))] shadow-[0_0_0_3px_hsl(var(--chart-4)/.18)]'
    : session.open
      ? 'bg-yellow-400 shadow-[0_0_0_3px_hsl(60_100%_50%/.15)]'
      : 'bg-muted-foreground/40';

  const nameClass = session.name === 'RTH'
    ? 'text-[hsl(var(--chart-4))]'
    : session.open
      ? 'text-yellow-400'
      : 'text-muted-foreground/60';

  const subtitle = session.name === 'RTH'
    ? 'Regular trading hours · 9:30 AM – 4:15 PM ET'
    : session.name === 'Globex'
      ? 'Electronic session · CME Equity Index Futures'
      : session.name === 'Maintenance'
        ? 'Daily maintenance break · 5:00 – 6:00 PM ET'
        : 'Weekend close · reopens Sunday 6:00 PM ET';

  return (
    <div className="fam-rise fam-rise-1 mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-border bg-card/75 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
        <div className="flex items-baseline gap-2">
          <span className={`text-[11px] font-bold uppercase tracking-[.14em] ${nameClass}`}>
            {session.name}
          </span>
          <span className="text-[10px] text-muted-foreground">{subtitle}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Clock3 className="h-3 w-3 shrink-0" />
        <span>{session.nextLabel}</span>
        <span className="fam-mono font-semibold text-foreground">in {formatCountdown(session.msUntilNext)}</span>
      </div>
    </div>
  );
}

function TimeframePanel({
  tf,
  timeframe,
  setup,
  now,
  marketClosed = false,
}: {
  tf: string;
  timeframe: TimeframeState;
  setup?: TfSetup;
  now: number;
  marketClosed?: boolean;
}) {
  const bull = timeframe.direction === 'BULL';
  const bear = timeframe.direction === 'BEAR';
  const neutral = !bull && !bear;
  const dirColor = bull
    ? 'text-[hsl(var(--chart-4))]'
    : bear
      ? 'text-[hsl(var(--destructive))]'
      : 'text-muted-foreground';

  // ADX coloring: <20 ranging (muted), 20-40 trending (normal), >40 strong (lime)
  const adxColor = (timeframe as unknown as Record<string, unknown>).adx !== undefined
    ? ((timeframe as unknown as {adx: number}).adx >= 40
        ? 'text-[hsl(var(--chart-4))]'
        : (timeframe as unknown as {adx: number}).adx >= 20
          ? 'text-foreground/80'
          : 'text-muted-foreground')
    : 'text-muted-foreground';
  const adxVal = (timeframe as unknown as {adx?: number}).adx;
  const adxLabel = adxVal !== undefined
    ? (adxVal >= 40 ? 'Strong' : adxVal >= 20 ? 'Trend' : 'Range')
    : '—';

  // RSI coloring: <30 or >70 exhaustion (coral), 45-55 neutral, bull/bear zones
  const rsiVal = (timeframe as unknown as {rsi?: number}).rsi;
  const rsiColor = rsiVal !== undefined
    ? (rsiVal >= 70 || rsiVal <= 30
        ? 'text-[hsl(var(--destructive))]'
        : rsiVal >= 55
          ? 'text-[hsl(var(--chart-4))]'
          : rsiVal <= 45
            ? 'text-muted-foreground'
            : 'text-foreground/80')
    : 'text-muted-foreground';

  // VWAP: lime when price above, coral when below
  const vwapVal = (timeframe as unknown as {vwap?: number}).vwap;
  const aboveVwap = vwapVal !== undefined && timeframe.close > vwapVal;
  const vwapColor = vwapVal !== undefined
    ? (aboveVwap ? 'text-[hsl(var(--chart-4))]' : 'text-[hsl(var(--destructive))]')
    : 'text-muted-foreground';

  // Confluence score coloring: 0-2 muted, 3 normal, 4-5 lime
  const scoreVal = (timeframe as unknown as {confluenceScore?: number}).confluenceScore;
  const scoreColor = scoreVal !== undefined
    ? (scoreVal >= 4 ? 'text-[hsl(var(--chart-4))]' : scoreVal >= 3 ? 'text-foreground/80' : 'text-muted-foreground')
    : 'text-muted-foreground';

  const isRTH = (timeframe as unknown as {isRTH?: boolean}).isRTH;

  const closed = marketClosed;

  return (
    <div className="space-y-4">
      {/* Row 1: Bias, RVOL, ATR, Vol */}
      <div className="grid grid-cols-4 gap-3 border-b border-border/50 pb-4">
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">Bias</div>
          <div className={`fam-mono text-[13px] font-semibold ${closed ? 'text-muted-foreground/40' : dirColor}`}>
            {closed ? '–' : timeframe.direction}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">RVOL</div>
          <div className={`fam-mono text-[13px] font-medium ${closed ? 'text-muted-foreground/40' : timeframe.volSpike && !neutral ? 'text-[hsl(var(--primary))]' : 'text-foreground/80'}`}>
            {closed ? '–' : `${timeframe.rvol.toFixed(2)}×`}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">ATR</div>
          <div className={`fam-mono text-[13px] font-medium ${closed ? 'text-muted-foreground/40' : 'text-foreground/80'}`}>
            {closed ? '–' : formatPrice(timeframe.atr)}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">Vol</div>
          <div className={`fam-mono text-[13px] font-medium ${closed ? 'text-muted-foreground/40' : 'text-foreground/80'}`}>
            {closed ? '–' : formatCompact(timeframe.volume)}
          </div>
        </div>
      </div>

      {/* Row 2: ADX, RSI, VWAP, Score */}
      <div className="grid grid-cols-4 gap-3 border-b border-border/50 pb-4">
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">ADX</div>
          <div className={`fam-mono text-[13px] font-medium ${closed ? 'text-muted-foreground/40' : adxColor}`}>
            {closed ? '–' : (adxVal !== undefined ? adxVal.toFixed(1) : '—')}
            {!closed && <span className={`ml-1 text-[9px] ${adxColor}`}>{adxLabel}</span>}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">RSI</div>
          <div className={`fam-mono text-[13px] font-medium ${closed ? 'text-muted-foreground/40' : rsiColor}`}>
            {closed ? '–' : (rsiVal !== undefined ? rsiVal.toFixed(1) : '—')}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">VWAP</div>
          <div className={`fam-mono text-[13px] font-medium ${closed ? 'text-muted-foreground/40' : vwapColor}`}>
            {closed ? '–' : (vwapVal !== undefined ? formatPrice(vwapVal) : '—')}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">Conf</div>
          {closed ? (
            <div className="fam-mono text-[13px] font-semibold text-muted-foreground/40">–</div>
          ) : (() => {
            const stale = isTimeframeStale(timeframe, tf, now);
            if (stale) {
              return (
                <div className="fam-mono text-[13px] font-semibold text-muted-foreground/40" title={`Data is stale — ${formatStaleAge(timeframe, now)}`}>
                  –
                  <span className="mt-0.5 block text-[8px] font-normal leading-none text-muted-foreground/30">
                    {formatStaleAge(timeframe, now)}
                  </span>
                </div>
              );
            }
            const pct = computeConfidencePct(timeframe);
            const color = confidenceColor(pct, timeframe.direction);
            return (
              <div className={`fam-mono text-[13px] font-semibold ${color}`}>
                {pct}%
              </div>
            );
          })()}
        </div>
      </div>

      {/* Staleness warning — shown when the feed for this timeframe has gone quiet */}
      {!closed && isTimeframeStale(timeframe, tf, now) && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/[.08] px-2.5 py-1.5 text-[10px] text-amber-400/90">
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
          <span>
            Feed stale · last seen{' '}
            {formatTimestamp((timeframe as unknown as { lastUpdated?: string }).lastUpdated)}
            {' · '}
            {formatStaleAge(timeframe, now)}
          </span>
        </div>
      )}

      {/* Session context */}
      {!closed && isRTH === false && (
        <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-[.12em] text-muted-foreground">
          <Clock3 className="h-2.5 w-2.5" />
          Extended hours — signals carry lower conviction
        </div>
      )}

      {/* Trade levels — suppressed when market closed, ranging, or no volume conviction */}
      <div>
        <div className="mb-2.5 flex items-center gap-2 text-[9px] font-bold uppercase tracking-[.16em] text-muted-foreground">
          <Gauge className="h-3 w-3 text-[hsl(var(--accent))]" />
          {tf} trade levels
        </div>
        {closed ? (
          <div className="flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-4 text-center">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              Market Closed
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              No active session — signals resume when trading reopens
            </div>
          </div>
        ) : neutral ? (
          <div className="flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-4 text-center">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <CircleDashed className="h-3.5 w-3.5" />
              No Trade
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              Market is ranging — no directional setup on this timeframe
            </div>
          </div>
        ) : !timeframe.volSpike ? (
          <div className="flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 bg-muted/20 px-4 text-center">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[.12em] text-muted-foreground">
              <CircleDashed className="h-3.5 w-3.5" />
              No Trade
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              RVOL {timeframe.rvol.toFixed(2)}× — no volume conviction on this timeframe
            </div>
          </div>
        ) : setup ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-[hsl(var(--primary)/.24)] bg-[hsl(var(--primary)/.045)] p-3">
            <Metric label="Entry" value={formatPrice(setup.entry)} tone="lime" />
            <Metric label="Stop loss" value={formatPrice(setup.stopLoss)} tone="coral" />
            <Metric label="Risk points" value={formatPrice(setup.riskPts)} />
            <Metric label="Risk / contract" value={`$${formatPrice(setup.riskDollarsPerContract)}`} />
            <Metric label="Target 1 · 1.5R" value={formatPrice(setup.tp1)} tone="cyan" />
            <Metric label="Target 2 · 2.0R" value={formatPrice(setup.tp2)} tone="cyan" />
            <div className="col-span-2 flex items-center gap-1.5 pt-1 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--primary))]">
              <Zap className="h-2.5 w-2.5" /> Volume spike confirmed
            </div>
          </div>
        ) : (
          <div className="flex min-h-[80px] items-center gap-3 rounded-md border border-dashed border-border bg-background/35 px-4">
            <CircleDashed className="h-4 w-4 text-muted-foreground" />
            <div className="text-[10px] text-muted-foreground">No data for this timeframe yet.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function MarketCard({
  market,
  index,
}: {
  market: MarketState;
  index: number;
}) {
  const ext = market as ExtMarket;
  const storageKey = `fam-tf-${market.symbol}`;
  // Lazy-init: restore from localStorage, fall back to first tab with data
  const [activeTab, setActiveTabRaw] = useState<Tf>(() => {
    const saved = localStorage.getItem(storageKey) as Tf | null;
    if (saved && TF_ORDER.includes(saved)) return saved;
    return (TF_ORDER.find((tf) => market.timeframes[tf]) ?? '5m') as Tf;
  });
  const setActiveTab = useCallback((tf: Tf) => {
    setActiveTabRaw(tf);
    localStorage.setItem(storageKey, tf);
  }, [storageKey]);

  // Timer tick: forces a re-render every 60 s so staleness checks stay current
  // even when the SSE feed has gone quiet (no new snapshot = no React state change).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Market-closed flag — derived from the CME session at the current tick
  const marketClosed = !getCMESession(new Date(now)).open;

  const tfs = Object.values(market.timeframes);
  const bullCount = marketClosed ? 0 : tfs.filter((tf) => tf.direction === 'BULL').length;
  const bearCount = marketClosed ? 0 : tfs.filter((tf) => tf.direction === 'BEAR').length;
  const isBull = !marketClosed && bullCount > bearCount;
  const isBear = !marketClosed && bearCount > bullCount;
  const dirTone = marketClosed
    ? 'border-border bg-muted/40 text-muted-foreground'
    : isBull
      ? 'border-[hsl(var(--chart-4)/.4)] bg-[hsl(var(--chart-4)/.08)] text-[hsl(var(--chart-4))]'
      : isBear
        ? 'border-[hsl(var(--destructive)/.42)] bg-[hsl(var(--destructive)/.08)] text-[hsl(var(--destructive))]'
        : 'border-border bg-muted/40 text-muted-foreground';
  const neutralCount = marketClosed ? tfs.length : tfs.length - bullCount - bearCount;
  const dirLabel = marketClosed
    ? 'Closed'
    : bullCount === 0 && bearCount === 0
      ? 'Ranging'
      : [bullCount > 0 ? `${bullCount} Bull` : '', bearCount > 0 ? `${bearCount} Bear` : ''].filter(Boolean).join(' · ');

  const visibleTabs = TF_ORDER.filter((tf) => market.timeframes[tf]);

  // Highest-confidence timeframe for the card badge — stale timeframes are excluded
  const bestConfidence = (() => {
    let bestPct = -1;
    let bestDir: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL';
    let bestTf: string | null = null;
    for (const [tfKey, tfState] of Object.entries(market.timeframes)) {
      if (isTimeframeStale(tfState, tfKey, now)) continue;
      const pct = computeConfidencePct(tfState);
      if (pct > bestPct) {
        bestPct = pct;
        bestDir = tfState.direction;
        bestTf = tfKey;
      }
    }
    const allNeutral = bestPct < 0 ||
      Object.entries(market.timeframes)
        .filter(([k, s]) => !isTimeframeStale(s, k, now))
        .every(([, s]) => s.direction === 'NEUTRAL');
    return { pct: bestPct >= 0 ? bestPct : 0, dir: bestDir, tf: bestTf, allNeutral };
  })();

  return (
    <article
      data-testid={`card-market-${market.symbol}`}
      className={`fam-card fam-rise fam-rise-${Math.min(index + 1, 4)} group overflow-hidden rounded-lg transition-all duration-300`}
    >
      {/* Card header — symbol + price */}
      <div className="relative border-b border-border/80 p-4 pb-3">
        <div className="fam-scanline pointer-events-none absolute left-0 top-0 h-px w-1/2 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="fam-display text-[25px] font-extrabold tracking-[-.06em] text-foreground">{market.symbol}</h2>
            </div>
            <div className="mt-1 text-[9px] font-bold uppercase tracking-[.18em] text-muted-foreground">CME futures</div>
          </div>
          <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[9px] font-bold uppercase tracking-[.09em] ${dirTone}`}>
            {isBull ? <ArrowUpRight className="h-4 w-4" strokeWidth={2.5} /> : isBear ? <ArrowDownRight className="h-4 w-4" strokeWidth={2.5} /> : <X className="h-3.5 w-3.5" />}
            <span className="hidden min-[430px]:inline">{dirLabel}</span>
            <>
              <span className="opacity-40">·</span>
              {marketClosed || bestConfidence.allNeutral ? (
                <span className="text-muted-foreground/40">–</span>
              ) : (
                <button
                  type="button"
                  title={bestConfidence.tf ? `Jump to ${bestConfidence.tf} timeframe` : undefined}
                  aria-label={bestConfidence.tf ? `Jump to ${bestConfidence.tf} timeframe (${bestConfidence.pct}% confidence)` : undefined}
                  onClick={() => {
                    if (bestConfidence.tf && visibleTabs.includes(bestConfidence.tf as Tf)) {
                      setActiveTab(bestConfidence.tf as Tf);
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded px-0.5 transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current active:opacity-60"
                >
                  <span className={confidenceColor(bestConfidence.pct, bestConfidence.dir)}>
                    {bestConfidence.pct}%
                  </span>
                  {bestConfidence.tf && (
                    <span className="text-[8px] font-bold opacity-50 tracking-[.06em]">
                      {bestConfidence.tf}
                    </span>
                  )}
                </button>
              )}
            </>
          </div>
        </div>
        <div className="mt-5 flex items-end justify-between gap-3">
          <div className={`fam-mono text-[29px] font-medium leading-none tracking-[-.06em] ${marketClosed ? 'text-muted-foreground/40' : 'text-foreground'}`}>
            {marketClosed ? '–' : formatPrice(market.lastPrice)}
          </div>
          <div className="text-right">
            <div className="text-[9px] font-bold uppercase tracking-[.14em] text-muted-foreground">Timeframes</div>
            <div className={`mt-1 text-[11px] font-semibold ${!marketClosed && (isBull || isBear) ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground'}`}>
              {marketClosed
                ? 'All closed'
                : neutralCount < tfs.length
                  ? `${bullCount} bull · ${bearCount} bear`
                  : 'All ranging'}
            </div>
          </div>
        </div>
      </div>

      {/* Timeframe tab bar — roving tabindex + arrow-key navigation */}
      <div
        role="tablist"
        aria-label="Timeframes"
        className="flex gap-1 border-b border-border/80 bg-muted/30 px-3 py-2"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const idx = visibleTabs.indexOf(activeTab);
          const next = e.key === 'ArrowRight'
            ? visibleTabs[(idx + 1) % visibleTabs.length]
            : visibleTabs[(idx - 1 + visibleTabs.length) % visibleTabs.length];
          setActiveTab(next);
          (e.currentTarget.querySelector(`[data-tf="${next}"]`) as HTMLElement | null)?.focus();
        }}
      >
        {visibleTabs.map((tf) => {
          const isActive = activeTab === tf;
          const tfState = market.timeframes[tf];
          return (
            <button
              key={tf}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-tf={tf}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tf)}
              className={`fam-focus relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] transition-all
                ${isActive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'}`}
            >
              {tfState?.volSpike && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" />
              )}
              {tfState && (
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  tfState.direction === 'BULL'
                    ? 'bg-[hsl(var(--chart-4))]'
                    : tfState.direction === 'BEAR'
                      ? 'bg-[hsl(var(--destructive))]'
                      : 'bg-muted-foreground/40'
                }`} />
              )}
              {tf}
            </button>
          );
        })}
      </div>

      {/* Active tab panel */}
      <div className="p-4">
        {(() => {
          // If user's stored tab lost its data, fall back to first available tab
          const effectiveTab = visibleTabs.includes(activeTab) ? activeTab : (visibleTabs[0] ?? activeTab);
          const tfState = market.timeframes[effectiveTab];
          if (!tfState) {
            return (
              <div className="flex min-h-[160px] items-center gap-3 rounded-md border border-dashed border-border px-4">
                <CircleDashed className="h-4 w-4 text-muted-foreground" />
                <div className="text-[10px] text-muted-foreground">No {effectiveTab} data yet.</div>
              </div>
            );
          }
          return (
            <TimeframePanel
              tf={effectiveTab}
              timeframe={tfState}
              setup={ext.perTimeframeSetup?.[effectiveTab]}
              now={now}
              marketClosed={marketClosed}
            />
          );
        })()}
      </div>
    </article>
  );
}

function LoadingDashboard() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="fam-card animate-pulse overflow-hidden rounded-lg p-4" data-testid={`skeleton-market-${item}`}>
          <div className="flex justify-between"><div className="h-8 w-16 rounded bg-muted" /><div className="h-6 w-28 rounded bg-muted" /></div>
          <div className="mt-7 h-8 w-36 rounded bg-muted" />
          <div className="mt-6 space-y-4">
            {[0, 1, 2, 3].map((line) => <div key={line} className="h-5 rounded bg-muted/70" />)}
          </div>
          <div className="mt-5 h-24 rounded bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  unavailable,
  message,
  onRetry,
}: {
  unavailable?: boolean;
  message?: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="fam-card relative overflow-hidden rounded-lg px-6 py-16 text-center sm:px-12">
      <div className="fam-scanline absolute left-0 top-0 h-px w-1/2 opacity-70" />
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-[hsl(var(--primary)/.25)] bg-[hsl(var(--primary)/.08)] text-[hsl(var(--primary))]">
        {unavailable ? <ShieldAlert className="h-5 w-5" /> : <Database className="h-5 w-5" />}
      </div>
      <h2 className="fam-display mt-5 text-2xl font-extrabold tracking-[-.05em]">
        {unavailable ? 'Market source is unavailable' : 'No market lanes yet'}
      </h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
        {message || (unavailable
          ? 'The monitor is connected, but the market provider has not returned a usable snapshot.'
          : 'Waiting for the first multi-timeframe snapshot from the market stream.')}
      </p>
      <button
        type="button"
        onClick={onRetry}
        data-testid="button-retry-market"
        className="fam-focus mt-7 inline-flex items-center gap-2 rounded-md border border-border bg-muted px-3.5 py-2 text-xs font-semibold text-foreground transition-colors hover:border-[hsl(var(--primary)/.45)] hover:bg-muted/80"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Request fresh snapshot
      </button>
    </div>
  );
}

function DisconnectedNotice({
  streamState,
  onReconnect,
}: {
  streamState: StreamState;
  onReconnect: () => void;
}) {
  if (streamState === 'live') return null;
  const connecting = streamState === 'connecting';
  return (
    <div className={`fam-rise-1 flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 ${connecting ? 'border-[hsl(var(--primary)/.2)] bg-[hsl(var(--primary)/.045)]' : 'border-[hsl(var(--destructive)/.25)] bg-[hsl(var(--destructive)/.05)]'}`}>
      <div className="flex items-center gap-3">
        {connecting ? <Cable className="h-4 w-4 text-[hsl(var(--primary))]" /> : <WifiOff className="h-4 w-4 text-[hsl(var(--destructive))]" />}
        <div>
          <div className="text-xs font-semibold">{connecting ? 'Opening live market channel' : 'Live market channel disconnected'}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{connecting ? 'The latest snapshot will remain visible while the stream negotiates.' : 'Snapshot data may be stale. Retrying the stream is safe.'}</div>
        </div>
      </div>
      {!connecting ? (
        <button type="button" onClick={onReconnect} data-testid="button-reconnect-stream" className="fam-focus inline-flex items-center gap-1.5 self-start rounded border border-[hsl(var(--destructive)/.3)] px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/.08)] sm:self-auto">
          <RefreshCw className="h-3 w-3" /> Reconnect
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Futures search dialog
// ---------------------------------------------------------------------------

type CatalogEntry = {
  symbol: string;
  displayName: string;
  name: string;
  category: string;
  multiplier: number;
};


function FuturesSearchDialog({
  watchedSymbols,
  onAdd,
  onRemove,
}: {
  /** Raw Databento symbols currently on the watchlist, e.g. "ES.v.0" */
  watchedSymbols: Set<string>;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loadingSymbol, setLoadingSymbol] = useState<string | null>(null);
  const [errorSymbol, setErrorSymbol] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    fetch('/api/market/catalog', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setCatalog(data as CatalogEntry[]))
      .catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) return catalog;
    const q = query.toLowerCase();
    return catalog.filter(
      (e) =>
        e.displayName.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const grouped = useMemo(
    () =>
      filtered.reduce<Record<string, CatalogEntry[]>>((acc, e) => {
        (acc[e.category] ??= []).push(e);
        return acc;
      }, {}),
    [filtered],
  );

  const handleToggle = async (entry: CatalogEntry) => {
    const isWatched = watchedSymbols.has(entry.symbol);
    setLoadingSymbol(entry.symbol);
    setErrorSymbol(null);
    try {
      if (isWatched) {
        const res = await fetch(`/api/market/watchlist/${encodeURIComponent(entry.symbol)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onRemove(entry.symbol);
      } else {
        const res = await fetch('/api/market/watchlist', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: entry.symbol }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onAdd(entry.symbol);
      }
    } catch {
      setErrorSymbol(entry.symbol);
      setTimeout(() => setErrorSymbol(null), 3000);
    } finally {
      setLoadingSymbol(null);
    }
  };

  const categoryOrder = ['Equity', 'Energy', 'Metals', 'Fixed Income', 'FX', 'Agriculture'];
  const sortedCategories = Object.keys(grouped).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="button-add-futures"
        aria-label="Add futures contract"
        className="fam-focus inline-flex h-8 items-center gap-1.5 rounded-md border border-[hsl(var(--primary)/.4)] bg-[hsl(var(--primary)/.08)] px-2.5 text-[10px] font-bold uppercase tracking-[.11em] text-[hsl(var(--primary))] transition-all hover:border-[hsl(var(--primary)/.7)] hover:bg-[hsl(var(--primary)/.15)] active:scale-95"
      >
        <Plus className="h-3 w-3" />
        <span className="hidden sm:inline">Add</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80dvh] flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-lg">
          <DialogHeader className="border-b border-border px-4 pb-3 pt-4">
            <DialogTitle className="fam-display text-sm font-extrabold tracking-tight">
              Add futures contract
            </DialogTitle>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Symbols are fetched from Databento GLBX.MDP3 · historical bootstrap takes ~15s
            </p>
          </DialogHeader>

          {/* Search input */}
          <div className="relative border-b border-border px-3 py-2">
            <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by symbol, name, or category…"
              className="w-full rounded-md bg-background/50 py-1.5 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:ring-1 focus:ring-[hsl(var(--primary)/.5)]"
            />
          </div>

          {/* Catalog list */}
          <div className="fam-scrollbar flex-1 overflow-y-auto">
            {catalog.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-[11px] text-muted-foreground">
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading catalog…
              </div>
            ) : sortedCategories.length === 0 ? (
              <div className="py-12 text-center text-[11px] text-muted-foreground">No results for "{query}"</div>
            ) : (
              sortedCategories.map((category) => (
                <div key={category}>
                  <div className="sticky top-0 z-10 border-b border-border/60 bg-muted/80 px-4 py-1.5 text-[8px] font-bold uppercase tracking-[.18em] text-muted-foreground backdrop-blur">
                    {category}
                  </div>
                  {grouped[category]?.map((entry) => {
                    const isWatched = watchedSymbols.has(entry.symbol);
                    const isLoading = loadingSymbol === entry.symbol;
                    const hasError = errorSymbol === entry.symbol;
                    return (
                      <div
                        key={entry.symbol}
                        className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5 last:border-b-0 hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="fam-mono text-[12px] font-semibold text-foreground">
                              {entry.displayName}
                            </span>
                            {isWatched && (
                              <span className="rounded-sm border border-[hsl(var(--chart-4)/.3)] bg-[hsl(var(--chart-4)/.1)] px-1 py-px text-[8px] font-bold uppercase tracking-wider text-[hsl(var(--chart-4))]">
                                Watching
                              </span>
                            )}
                            {hasError && (
                              <span className="rounded-sm border border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.1)] px-1 py-px text-[8px] font-bold uppercase tracking-wider text-[hsl(var(--destructive))]">
                                Failed
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{entry.name}</div>
                        </div>
                        <button
                          type="button"
                          disabled={isLoading}
                          onClick={() => void handleToggle(entry)}
                          title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
                          className={`fam-focus inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40
                            ${hasError
                              ? 'border-[hsl(var(--destructive)/.5)] bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))]'
                              : isWatched
                                ? 'border-[hsl(var(--destructive)/.35)] bg-[hsl(var(--destructive)/.08)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)/.18)]'
                                : 'border-[hsl(var(--primary)/.35)] bg-[hsl(var(--primary)/.08)] text-[hsl(var(--primary))] hover:bg-[hsl(var(--primary)/.18)]'
                            }`}
                        >
                          {isLoading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : isWatched ? (
                            <Trash2 className="h-3 w-3" />
                          ) : (
                            <Plus className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Invite link management ───────────────────────────────────────────────────

interface InviteLink {
  token: string;
  url: string;
  label: string | null;
  expiresAt: string;
  createdAt: string;
}

function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return `${h}h left`;
  return `${Math.floor(h / 24)}d left`;
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [invites, setInvites] = useState<InviteLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [duration, setDuration] = useState('7d');
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch('/api/invites', { credentials: 'include' })
      .then((r) => r.json() as Promise<{ invites: InviteLink[] }>)
      .then((d) => setInvites(d.invites ?? []))
      .catch(() => setInvites([]))
      .finally(() => setLoading(false));
  }, [open]);

  async function createInvite() {
    setCreating(true);
    try {
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ duration, label: label.trim() || undefined }),
      });
      const created = (await res.json()) as InviteLink;
      setInvites((prev) => [created, ...prev]);
      setLabel('');
    } finally {
      setCreating(false);
    }
  }

  async function revokeInvite(token: string) {
    await fetch(`/api/invites/${token}`, { method: 'DELETE', credentials: 'include' });
    setInvites((prev) => prev.filter((i) => i.token !== token));
  }

  function copyLink(url: string, token: string) {
    void navigator.clipboard.writeText(url);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[80dvh] flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border px-4 pb-3 pt-4">
          <DialogTitle className="fam-display text-sm font-extrabold tracking-tight">
            Invite links
          </DialogTitle>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Share a link for temporary read-only access. Links expire automatically.
          </p>
        </DialogHeader>

        {/* Create form */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="min-w-0 flex-1 rounded-md bg-background/50 px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 outline-none ring-1 ring-border focus:ring-[hsl(var(--primary)/.5)]"
          />
          <select
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="rounded-md bg-background/50 px-2 py-1.5 text-xs text-foreground outline-none ring-1 ring-border focus:ring-[hsl(var(--primary)/.5)]"
          >
            <option value="24h">24 h</option>
            <option value="7d">7 d</option>
            <option value="30d">30 d</option>
          </select>
          <button
            type="button"
            onClick={() => void createInvite()}
            disabled={creating}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[hsl(var(--primary)/.4)] bg-[hsl(var(--primary)/.08)] px-2.5 text-[10px] font-bold uppercase tracking-widest text-[hsl(var(--primary))] transition-all hover:bg-[hsl(var(--primary)/.15)] disabled:opacity-40 active:scale-95"
          >
            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Generate
          </button>
        </div>

        {/* Link list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : invites.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">No active links yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {invites.map((inv) => (
                <li key={inv.token} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-foreground">
                      {inv.label ?? <span className="text-muted-foreground">No label</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Clock3 className="h-2.5 w-2.5 shrink-0" />
                      {timeLeft(inv.expiresAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyLink(inv.url, inv.token)}
                    title="Copy link"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-[hsl(var(--primary)/.4)] hover:text-[hsl(var(--primary))]"
                  >
                    {copied === inv.token ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => void revokeInvite(inv.token)}
                    title="Revoke link"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MarketDashboard() {
  const snapshotQuery = useGetMarketSnapshot({
    query: {
      queryKey: getGetMarketSnapshotQueryKey(),
      staleTime: 20_000,
      refetchOnWindowFocus: true,
    },
  });
  const healthQuery = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchInterval: 30_000,
    },
  });
  const streamProbe = useStreamMarketSnapshot({
    query: {
      queryKey: getStreamMarketSnapshotQueryKey(),
      enabled: false,
    },
  });
  void streamProbe;

  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [streamSnapshot, setStreamSnapshot] = useState<MarketSnapshot | null>(null);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Symbols added via dialog that are still bootstrapping on the server (~15s)
  const [bootstrapping, setBootstrapping] = useState<Set<string>>(new Set());
  const [optimisticRemoved, setOptimisticRemoved] = useState<Set<string>>(new Set());

  const [activeContract, setActiveContractRaw] = useState<string | null>(() => {
    try { return localStorage.getItem('activeContract'); } catch { return null; }
  });

  const setActiveContract = useCallback((valOrUpdater: string | null | ((prev: string | null) => string | null)) => {
    setActiveContractRaw((prev) => {
      const next = typeof valOrUpdater === 'function' ? valOrUpdater(prev) : valOrUpdater;
      try { if (next) localStorage.setItem('activeContract', next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/market/stream', { withCredentials: true });
    setStreamState('connecting');

    const receive = (event: MessageEvent<string>) => {
      try {
        const incoming = JSON.parse(event.data) as MarketSnapshot;
        if (incoming && typeof incoming === 'object' && 'markets' in incoming) {
          setStreamSnapshot(incoming);
          setStreamState('live');
          // Clear any bootstrapping symbols that have now arrived in the snapshot
          const arrived = new Set(Object.keys(incoming.markets));
          setBootstrapping((prev) => {
            if (![...prev].some((s) => arrived.has(s))) return prev;
            return new Set([...prev].filter((s) => !arrived.has(s)));
          });
        }
      } catch {
        setStreamState('disconnected');
      }
    };

    source.onopen = () => setStreamState('live');
    source.onmessage = receive;
    source.addEventListener('market', receive as EventListener);

    source.onerror = () => {
      // readyState CONNECTING (0) = EventSource is auto-reconnecting — show as
      // 'connecting' rather than 'disconnected' so the UI doesn't flash red on
      // every transient network blip that self-heals in a few seconds.
      // readyState CLOSED (2) means the source won't retry on its own, so we
      // force a new attempt via streamAttempt after a short delay.
      if (source.readyState === EventSource.CLOSED) {
        setStreamState('disconnected');
        setTimeout(() => setStreamAttempt((v) => v + 1), 5_000);
      } else {
        setStreamState('connecting');
      }
    };

    // Watchdog: if we haven't reached 'live' within 20 s of opening this
    // EventSource, close it and create a fresh one. Handles cases where the
    // browser's built-in reconnect loop gets stuck without firing onerror.
    const watchdog = setTimeout(() => {
      if (source.readyState !== EventSource.OPEN) {
        source.close();
        setStreamAttempt((v) => v + 1);
      }
    }, 20_000);

    return () => {
      clearTimeout(watchdog);
      source.removeEventListener('market', receive as EventListener);
      source.close();
    };
  }, [streamAttempt]);

  const snapshot = streamSnapshot ?? snapshotQuery.data;
  const markets = useMemo(() => {
    if (!snapshot?.markets) return [];
    return Object.values(snapshot.markets)
      .filter((m) => !optimisticRemoved.has(m.symbol))
      .sort((a, b) => {
        const aIndex = DISPLAY_ORDER.indexOf(a.symbol);
        const bIndex = DISPLAY_ORDER.indexOf(b.symbol);
        return (aIndex < 0 ? 99 : aIndex) - (bIndex < 0 ? 99 : bIndex);
      });
  }, [snapshot, optimisticRemoved]);

  // Keep activeContract pointing at a valid symbol; default to first on load
  useEffect(() => {
    if (!markets.length) return;
    setActiveContract((prev) => {
      if (prev && markets.some((m) => m.symbol === prev)) return prev;
      return markets[0]?.symbol ?? null;
    });
  }, [markets]);

  const activeMarket = markets.find((m) => m.symbol === activeContract) ?? markets[0] ?? null;

  const removeContract = useCallback(async (symbol: string) => {
    // Move focus before removing so the active card doesn't flash empty
    setActiveContract((prev) => {
      if (prev !== symbol) return prev;
      const others = markets.filter((m) => m.symbol !== symbol);
      return others[0]?.symbol ?? null;
    });
    setOptimisticRemoved((prev) => new Set([...prev, symbol]));
    try {
      await fetch(`/api/market/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE', credentials: 'include' });
    } catch {
      // Revert on failure
      setOptimisticRemoved((prev) => { const next = new Set(prev); next.delete(symbol); return next; });
    }
  }, [markets]);

  // Set of raw symbols currently on the watchlist (from snapshot + still-bootstrapping adds)
  const watchedSymbols = useMemo(() => {
    const fromSnapshot = new Set(markets.map((m) => m.symbol));
    return new Set([...fromSnapshot, ...bootstrapping]);
  }, [markets, bootstrapping]);
  // Summary counts — stale timeframes excluded; all zeroed when market is closed
  const nowMs = Date.now();
  const summaryMarketClosed = !getCMESession(new Date(nowMs)).open;
  const bullishCount = summaryMarketClosed ? 0 : markets.reduce(
    (count, market) => count + Object.entries(market.timeframes).filter(
      ([tf, s]) => s.direction === 'BULL' && !isTimeframeStale(s, tf, nowMs),
    ).length,
    0,
  );
  const spikeCount = summaryMarketClosed ? 0 : markets.reduce(
    (count, market) => count + Object.entries(market.timeframes).filter(
      ([tf, s]) => s.volSpike && !isTimeframeStale(s, tf, nowMs),
    ).length,
    0,
  );
  const directionalCount = summaryMarketClosed ? 0 : markets.reduce(
    (count, market) => count + Object.entries(market.timeframes).filter(
      ([tf, s]) => s.direction !== 'NEUTRAL' && !isTimeframeStale(s, tf, nowMs),
    ).length,
    0,
  );

  const isUnavailable = snapshot?.source === 'unavailable';
  const hasError = Boolean(snapshotQuery.error) && !snapshot;
  const healthStatus = healthQuery.data?.status;
  const providerState = isUnavailable ? 'unavailable' : snapshot?.source === 'databento' ? 'live' : 'connecting';

  const retryAll = () => {
    void snapshotQuery.refetch();
    setStreamSnapshot(null);
    setStreamAttempt((value) => value + 1);
  };

  return (
    <div className="fam-noise min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border/80 bg-[hsl(var(--background)/.88)] backdrop-blur-xl">
        <div className="mx-auto flex min-h-[72px] max-w-[1560px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--primary)/.4)] bg-[hsl(var(--primary)/.1)] text-[hsl(var(--primary))]">
              <Activity className="h-4 w-4" />
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[hsl(var(--primary))] shadow-[0_0_0_3px_hsl(var(--background))]" />
            </div>
            <div className="min-w-0">
              <div className="fam-display truncate text-sm font-extrabold tracking-[-.035em]">Market Pulse</div>
              <div className="mt-0.5 hidden text-[9px] font-bold uppercase tracking-[.19em] text-muted-foreground sm:block">Multi-timeframe command center</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 text-right sm:block">
              <div className="fam-mono text-[10px] text-muted-foreground">{formatTimestamp(snapshot?.timestamp)}</div>
              <div className="mt-0.5 text-[9px] uppercase tracking-[.14em] text-muted-foreground">Last snapshot</div>
            </div>
            <StatusPill
              state={
                streamState !== 'live'
                  ? streamState
                  : (snapshot as MarketSnapshot & { isLiveConnected?: boolean })?.isLiveConnected
                    ? 'live'
                    : 'connecting'
              }
              label={
                streamState === 'disconnected'
                  ? 'Disconnected'
                  : streamState === 'connecting'
                    ? 'Connecting'
                    : (snapshot as MarketSnapshot & { isLiveConnected?: boolean })?.isLiveConnected
                      ? 'Live'
                      : 'Polling'
              }
            />
            <FuturesSearchDialog
              watchedSymbols={watchedSymbols}
              onAdd={(symbol) => setBootstrapping((prev) => new Set([...prev, symbol]))}
              onRemove={(symbol) => {
                // Optimistically hide the contract immediately
                setActiveContract((prev) => {
                  if (prev !== symbol) return prev;
                  const others = markets.filter((m) => m.symbol !== symbol);
                  return others[0]?.symbol ?? null;
                });
                setOptimisticRemoved((prev) => new Set([...prev, symbol]));
                setBootstrapping((prev) => { const next = new Set(prev); next.delete(symbol); return next; });
              }}
            />
            <button
              type="button"
              onClick={retryAll}
              data-testid="button-refresh-dashboard"
              aria-label="Refresh market snapshot"
              className="fam-focus inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground transition-all hover:border-[hsl(var(--primary)/.45)] hover:text-[hsl(var(--primary))] active:scale-95"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              aria-label="Invite links"
              title="Invite links"
              className="fam-focus inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground transition-all hover:border-[hsl(var(--primary)/.45)] hover:text-[hsl(var(--primary))] active:scale-95"
            >
              <Link2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={async () => { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); window.location.reload(); }}
              aria-label="Sign out"
              title="Sign out"
              className="fam-focus inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground transition-all hover:border-destructive/40 hover:text-destructive active:scale-95"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="h-px overflow-hidden bg-border/30"><div className="fam-scanline h-px w-1/3" /></div>
      </header>
      <DisconnectedNotice streamState={streamState} onReconnect={() => setStreamAttempt((value) => value + 1)} />
      <main className="mx-auto max-w-[1560px] px-4 pb-12 pt-7 sm:px-6 lg:px-8">
        <div className="fam-rise mb-7 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-[hsl(var(--primary))]">
              <span className="h-px w-7 bg-[hsl(var(--primary))]" />
              Market Pulse
            </div>
            <h1 className="fam-display max-w-3xl text-[clamp(2.25rem,5vw,4.6rem)] font-extrabold leading-[.93] tracking-[-.075em]">
              Is the tape<br /><span className="text-[hsl(var(--primary))]">aligned?</span>
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              Volume, volatility, and direction across the contracts that matter. Wait for the signal to agree before you put risk on.
            </p>
          </div>
          <div className="flex max-w-[330px] items-start gap-3 rounded-lg border border-border bg-card/75 p-3.5">
            <div className={`mt-0.5 h-7 w-7 shrink-0 rounded-md ${providerState === 'live' ? 'bg-[hsl(var(--chart-4)/.12)] text-[hsl(var(--chart-4))]' : providerState === 'unavailable' ? 'bg-muted text-muted-foreground' : 'bg-[hsl(var(--primary)/.1)] text-[hsl(var(--primary))]'} flex items-center justify-center`}>
              {providerState === 'live' ? <Check className="h-3.5 w-3.5" /> : providerState === 'unavailable' ? <ShieldAlert className="h-3.5 w-3.5" /> : <CircleDashed className="h-3.5 w-3.5" />}
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[.16em] text-muted-foreground">Data provider</div>
              <div data-testid="status-provider" className="mt-1 text-sm font-semibold">{snapshot?.source === 'databento' ? 'Databento connected' : snapshot?.source === 'unavailable' ? 'Provider unavailable' : 'Waiting for provider'}</div>
              {healthStatus ? <div className="mt-1 text-[10px] text-muted-foreground">Service health: {healthStatus}</div> : null}
            </div>
          </div>
        </div>

        <SessionClock />

        <section aria-label="Market summary" className="fam-rise fam-rise-1 mb-6 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card/75 sm:grid-cols-4">
          {[
            { label: 'Markets covered', value: markets.length.toString(), detail: 'returned by source', icon: Radio, tone: 'text-[hsl(var(--accent))]' },
            { label: 'Bull reads', value: bullishCount.toString(), detail: 'bullish timeframes', icon: TrendingUp, tone: 'text-[hsl(var(--chart-4))]' },
            { label: 'Volume spikes', value: spikeCount.toString(), detail: 'across timeframes', icon: Zap, tone: 'text-[hsl(var(--destructive))]' },
            { label: 'Directional reads', value: directionalCount.toString(), detail: 'biases observed', icon: TrendingDown, tone: 'text-[hsl(var(--primary))]' },
          ].map((item) => (
            <div key={item.label} data-testid={`metric-summary-${item.label.toLowerCase().replaceAll(' ', '-')}`} className="border-b border-border p-4 last:border-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-bold uppercase tracking-[.15em] text-muted-foreground">{item.label}</span>
                <item.icon className={`h-3.5 w-3.5 ${item.tone}`} />
              </div>
              <div className="fam-mono mt-2 text-2xl font-medium tracking-[-.06em]">{item.value}</div>
              <div className="mt-1 text-[10px] text-muted-foreground">{item.detail}</div>
            </div>
          ))}
        </section>

        {hasError ? (
          <div className="fam-card flex flex-col items-start gap-4 rounded-lg border-[hsl(var(--destructive)/.3)] p-6 sm:flex-row sm:items-center sm:justify-between" data-testid="state-error-market">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 text-[hsl(var(--destructive))]" />
              <div>
                <h2 className="font-semibold">Snapshot request failed</h2>
                <p className="mt-1 text-sm text-muted-foreground">The monitor could not retrieve the latest market state. The stream will continue trying in the background.</p>
              </div>
            </div>
            <button type="button" onClick={retryAll} data-testid="button-retry-error" className="fam-focus inline-flex shrink-0 items-center gap-2 rounded-md bg-[hsl(var(--destructive))] px-3.5 py-2 text-xs font-bold text-[hsl(var(--destructive-foreground))] hover:opacity-90">
              Try again <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : snapshotQuery.isLoading && !snapshot ? (
          <LoadingDashboard />
        ) : isUnavailable || !markets.length ? (
          <EmptyState unavailable={isUnavailable} message={snapshot?.message} onRetry={retryAll} />
        ) : (
          <section aria-label="Market lanes">
            {/* Contract tab bar */}
            <div className="fam-scrollbar mb-4 flex gap-1.5 overflow-x-auto pb-1">
              {markets.map((market) => {
                const isActive = market.symbol === activeContract;
                const tfList = Object.values(market.timeframes);
                const mBull = tfList.filter((tf) => tf.direction === 'BULL').length;
                const mBear = tfList.filter((tf) => tf.direction === 'BEAR').length;
                const bull = mBull > mBear;
                const bear = mBear > mBull;
                const hasSpike = tfList.some((tf) => tf.volSpike);
                return (
                  <div key={market.symbol} className="group relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setActiveContract(market.symbol)}
                      data-testid={`tab-contract-${market.symbol}`}
                      className={`fam-focus relative inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.1em] transition-all
                        ${isActive
                          ? bull
                            ? 'border-[hsl(var(--chart-4)/.5)] bg-[hsl(var(--chart-4)/.12)] text-[hsl(var(--chart-4))] shadow-sm'
                            : bear
                              ? 'border-[hsl(var(--destructive)/.5)] bg-[hsl(var(--destructive)/.1)] text-[hsl(var(--destructive))] shadow-sm'
                              : 'border-border bg-card text-foreground shadow-sm'
                          : 'border-border/60 bg-card/50 text-muted-foreground hover:border-border hover:bg-card hover:text-foreground'}`}
                    >
                      {/* Alignment dot */}
                      <span className={`h-2 w-2 shrink-0 rounded-full ${bull ? 'bg-[hsl(var(--chart-4))]' : bear ? 'bg-[hsl(var(--destructive))]' : 'bg-muted-foreground/40'}`} />
                      {market.symbol}
                      {/* Vol spike indicator */}
                      {hasSpike && (
                        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" />
                      )}
                    </button>
                    {/* Remove button — floats above the tab corner on hover */}
                    <button
                      type="button"
                      onClick={() => void removeContract(market.symbol)}
                      aria-label={`Remove ${market.symbol}`}
                      className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground opacity-0 transition-opacity hover:border-destructive/50 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                );
              })}
              {/* Bootstrapping placeholders — shown while the server loads new contracts (~15s) */}
              {[...bootstrapping]
                .filter((s) => !markets.some((m) => m.symbol === s))
                .map((symbol) => (
                  <div key={`boot-${symbol}`} className="shrink-0">
                    <div
                      title="Loading contract data — usually takes ~15 seconds"
                      className="relative inline-flex cursor-default items-center gap-2 rounded-lg border border-[hsl(var(--primary)/.25)] bg-[hsl(var(--primary)/.05)] px-4 py-2.5 text-[11px] font-bold uppercase tracking-[.1em] text-[hsl(var(--primary)/.5)]"
                    >
                      <Loader2 className="h-2 w-2 animate-spin" />
                      {symbol}
                      <span className="ml-0.5 text-[8px] font-normal normal-case tracking-normal opacity-70">loading…</span>
                    </div>
                  </div>
                ))}
            </div>

            {/* Active contract card — full width */}
            {activeMarket && (
              <MarketCard key={activeMarket.symbol} market={activeMarket} index={0} />
            )}
          </section>
        )}

        {/* ORB scalping panel — shown whenever market data is available */}
        {snapshot && <OrbPanel snapshotTimestamp={snapshot.timestamp} />}

        {/* VWAP reversion panel — all-session scalping */}
        {snapshot && <VwapPanel snapshotTimestamp={snapshot.timestamp} />}

        {/* Overnight High/Low reference levels */}
        

        {snapshot && <IctPanel snapshotTimestamp={snapshot.timestamp} />}

        <footer className="fam-rise fam-rise-4 mt-8 flex flex-col justify-between gap-3 border-t border-border/70 pt-4 text-[10px] text-muted-foreground sm:flex-row sm:items-center">
          <div className="flex items-center gap-2"><Clock3 className="h-3 w-3" /> Stream updates are reflected as received.</div>
          <div className="fam-mono flex items-center gap-2 uppercase tracking-[.1em]"><TrendingDown className="h-3 w-3" /> Signals are informational, not a trade instruction.</div>
        </footer>
      </main>

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </div>
  );
}