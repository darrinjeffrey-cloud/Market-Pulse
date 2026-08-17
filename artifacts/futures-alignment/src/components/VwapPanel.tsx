/**
 * VwapPanel — VWAP Reversion signal panel
 *
 * Fetches /api/market/vwap on mount and whenever the parent market snapshot
 * timestamp changes. Also self-refreshes every 30s. Active all RTH session.
 */

import { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type VwapStatus = 'inactive' | 'watching' | 'long_setup' | 'short_setup' | 'expired';

type VwapState = {
  symbol:          string;
  displayName:     string;
  status:          VwapStatus;
  vwap:            number | null;
  band1Upper:      number | null;
  band1Lower:      number | null;
  band2Upper:      number | null;
  band2Lower:      number | null;
  currentPrice:    number | null;
  deviationSigmas: number | null;
  barsInSession:   number;
  signal:          'LONG' | 'SHORT' | null;
  entry:           number | null;
  stop:            number | null;
  target1:         number | null;
  target2:         number | null;
  riskTicks:       number | null;
  lastUpdated:     string;
};

type VwapSnapshot = {
  timestamp: string;
  markets:   Record<string, VwapState>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(n: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

const DISPLAY_ORDER = ['ES', 'NQ', 'MES', 'MNQ'];

function sortKey(displayName: string): number {
  const root = displayName.replace('.c.0', '');
  const idx  = DISPLAY_ORDER.indexOf(root);
  return idx < 0 ? 99 : idx;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: VwapState }) {
  switch (state.status) {
    case 'long_setup':
      return (
        <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--chart-4)/.35)] bg-[hsl(var(--chart-4)/.1)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--chart-4))]">
          <ArrowUpRight className="h-2.5 w-2.5" /> Long
        </span>
      );
    case 'short_setup':
      return (
        <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--destructive)/.35)] bg-[hsl(var(--destructive)/.1)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--destructive))]">
          <ArrowDownRight className="h-2.5 w-2.5" /> Short
        </span>
      );
    case 'watching':
      return (
        <span className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
          <Minus className="h-2.5 w-2.5" /> Watching
        </span>
      );
    default:
      return (
        <span className="rounded border border-border/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/40">
          Off
        </span>
      );
  }
}

function Stat({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string;
  variant?: 'default' | 'entry' | 'stop' | 'target';
}) {
  const textClass =
    variant === 'entry'  ? 'text-foreground' :
    variant === 'stop'   ? 'text-[hsl(var(--destructive))]' :
    variant === 'target' ? 'text-[hsl(var(--chart-4))]' :
                           'text-foreground';
  return (
    <div className="rounded bg-background/50 px-2 py-1.5">
      <div className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`fam-mono text-[11px] font-bold ${textClass}`}>{value}</div>
    </div>
  );
}

// ─── Deviation gauge ──────────────────────────────────────────────────────────

function DeviationGauge({ sigmas }: { sigmas: number }) {
  // Clamp to ±2.5σ for display
  const clamped = Math.max(-2.5, Math.min(2.5, sigmas));
  // Map [−2.5, +2.5] → [0, 100]%
  const pct = ((clamped + 2.5) / 5) * 100;

  const color =
    sigmas <= -1 ? 'hsl(var(--chart-4))' :   // below −1σ → green (long zone)
    sigmas >= 1  ? 'hsl(var(--destructive))' : // above +1σ → red (short zone)
    'hsl(var(--muted-foreground))';

  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[8px] text-muted-foreground/60">
        <span>−2σ</span>
        <span>VWAP</span>
        <span>+2σ</span>
      </div>
      {/* Track */}
      <div className="relative h-1.5 overflow-hidden rounded-full bg-secondary">
        {/* ±1σ zone markers */}
        <div className="absolute inset-y-0 left-[30%] w-[40%] bg-muted-foreground/10" />
        {/* Needle */}
        <div
          className="absolute top-0 h-full w-0.5 -translate-x-1/2 rounded-full transition-all duration-500"
          style={{ left: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <div className="mt-0.5 text-right text-[8px] font-semibold" style={{ color }}>
        {sigmas >= 0 ? '+' : ''}{sigmas.toFixed(2)}σ
      </div>
    </div>
  );
}

// ─── Per-symbol card ──────────────────────────────────────────────────────────

function VwapCard({ state }: { state: VwapState }) {
  const sym      = state.displayName.replace('.c.0', '');
  const isLong   = state.status === 'long_setup';
  const isShort  = state.status === 'short_setup';
  const hasSetup = isLong || isShort;

  const borderClass = isLong
    ? 'border-[hsl(var(--chart-4)/.4)]'
    : isShort
    ? 'border-[hsl(var(--destructive)/.4)]'
    : 'border-border/50';

  const bgClass = isLong
    ? 'bg-[hsl(var(--chart-4)/.04)]'
    : isShort
    ? 'bg-[hsl(var(--destructive)/.04)]'
    : 'bg-card/60';

  return (
    <div className={`fam-card rounded-lg border p-4 transition-colors ${borderClass} ${bgClass}`}>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="fam-mono text-[12px] font-bold tracking-tight text-foreground">{sym}</span>
        <StatusBadge state={state} />
      </div>

      {/* VWAP + bands row */}
      {state.vwap !== null && (
        <div className="mb-3 rounded border border-border/40 bg-background/40 px-3 py-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            VWAP · {state.barsInSession} bar{state.barsInSession !== 1 ? 's' : ''}
          </div>
          {/* 5-column band display: +2σ | +1σ | VWAP | −1σ | −2σ */}
          <div className="grid grid-cols-5 items-end gap-0.5 text-center">
            <div>
              <div className="mb-0.5 text-[8px] text-[hsl(var(--destructive)/.5)]">+2σ</div>
              <div className="fam-mono text-[10px] font-semibold text-[hsl(var(--destructive)/.6)]">
                {state.band2Upper != null ? fmtPrice(state.band2Upper) : '—'}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[8px] text-[hsl(var(--destructive)/.75)]">+1σ</div>
              <div className="fam-mono text-[10px] font-semibold text-[hsl(var(--destructive)/.85)]">
                {state.band1Upper != null ? fmtPrice(state.band1Upper) : '—'}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[8px] text-muted-foreground/50">VWAP</div>
              <div className="fam-mono text-[13px] font-bold text-foreground">
                {fmtPrice(state.vwap)}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[8px] text-[hsl(var(--chart-4)/.75)]">−1σ</div>
              <div className="fam-mono text-[10px] font-semibold text-[hsl(var(--chart-4)/.85)]">
                {state.band1Lower != null ? fmtPrice(state.band1Lower) : '—'}
              </div>
            </div>
            <div>
              <div className="mb-0.5 text-[8px] text-[hsl(var(--chart-4)/.5)]">−2σ</div>
              <div className="fam-mono text-[10px] font-semibold text-[hsl(var(--chart-4)/.6)]">
                {state.band2Lower != null ? fmtPrice(state.band2Lower) : '—'}
              </div>
            </div>
          </div>

          {/* Deviation gauge */}
          {state.deviationSigmas != null && (
            <DeviationGauge sigmas={state.deviationSigmas} />
          )}
        </div>
      )}

      {/* Signal direction label */}
      {hasSetup && (
        <div className={`mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${isLong ? 'text-[hsl(var(--chart-4))]' : 'text-[hsl(var(--destructive))]'}`}>
          {isLong
            ? <ArrowUpRight className="h-3.5 w-3.5" />
            : <ArrowDownRight className="h-3.5 w-3.5" />}
          {isLong ? 'Reversion long — price extended below −1σ' : 'Reversion short — price extended above +1σ'}
        </div>
      )}

      {/* Trade levels */}
      {hasSetup && state.entry !== null && state.stop !== null ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Entry"        value={fmtPrice(state.entry)}   variant="entry" />
            <Stat label="Stop · ±2σ"  value={fmtPrice(state.stop)}    variant="stop" />
            {state.target1 !== null && (
              <Stat label="T1 · VWAP"      value={fmtPrice(state.target1)} variant="target" />
            )}
            {state.target2 !== null && (
              <Stat label="T2 · ±1σ other" value={fmtPrice(state.target2)} variant="target" />
            )}
          </div>
          {state.riskTicks !== null && (
            <div className="pt-0.5 text-[9px] text-muted-foreground">
              Risk: {state.riskTicks} ticks · {(state.riskTicks * 0.25).toFixed(2)} pts
            </div>
          )}
        </div>
      ) : state.status === 'watching' && state.band1Upper !== null && state.band1Lower !== null ? (
        <div className="space-y-1 text-[9px] text-muted-foreground">
          {state.band2Upper !== null && (
            <div className="flex items-center justify-between">
              <span>Short extension (−2σ stop)</span>
              <span className="fam-mono font-semibold text-[hsl(var(--destructive)/.6)]">{fmtPrice(state.band2Upper)}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>Short zone above</span>
            <span className="fam-mono font-semibold text-[hsl(var(--destructive))]">{fmtPrice(state.band1Upper)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Long zone below</span>
            <span className="fam-mono font-semibold text-[hsl(var(--chart-4))]">{fmtPrice(state.band1Lower)}</span>
          </div>
          {state.band2Lower !== null && (
            <div className="flex items-center justify-between">
              <span>Long extension (+2σ stop)</span>
              <span className="fam-mono font-semibold text-[hsl(var(--chart-4)/.6)]">{fmtPrice(state.band2Lower)}</span>
            </div>
          )}
        </div>
      ) : state.status === 'inactive' ? (
        <div className="text-center text-[10px] text-muted-foreground/60">
          Signals active 09:30–16:00 ET on trading days
        </div>
      ) : null}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function VwapPanel({ snapshotTimestamp }: { snapshotTimestamp?: string }) {
  const [data, setData] = useState<VwapSnapshot | null>(null);

  const refresh = () => {
    fetch('/api/market/vwap', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setData(d as VwapSnapshot))
      .catch(() => {});
  };

  useEffect(() => { refresh(); }, [snapshotTimestamp]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const states = Object.values(data.markets).sort(
    (a, b) => sortKey(a.displayName) - sortKey(b.displayName),
  );

  if (states.length === 0) return null;

  const hasSignal  = states.some(s => s.status === 'long_setup' || s.status === 'short_setup');
  const offSession = states.every(s => s.status === 'inactive' || s.status === 'expired');
  const phase      = states[0]?.status ?? 'inactive';

  const phasePillClass = hasSignal
    ? 'border-[hsl(var(--chart-4)/.3)] bg-[hsl(var(--chart-4)/.08)] text-[hsl(var(--chart-4))]'
    : phase === 'watching'
    ? 'border-border/60 text-muted-foreground'
    : 'border-border/30 text-muted-foreground/50';

  const phaseLabel = hasSignal ? 'Setup Active' : phase === 'watching' ? 'Watching' : phase === 'expired' ? 'Session Ended' : null;

  return (
    <section aria-label="VWAP Reversion" className="fam-rise fam-rise-3 mt-8">
      {/* Section header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="fam-display text-[11px] font-extrabold uppercase tracking-[.14em] text-muted-foreground">
            VWAP Reversion
          </h2>
          <span className="text-[10px] text-muted-foreground/50">
            All-session · 09:30–16:00 ET · ±1σ entry · ±2σ stop
          </span>
        </div>

        {phaseLabel && (
          <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${phasePillClass}`}>
            {hasSignal && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            )}
            {phaseLabel}
          </span>
        )}
      </div>

      {offSession ? (
        <div className="fam-card flex items-center justify-center gap-2 rounded-lg border border-border/40 py-5 text-[11px] text-muted-foreground">
          <Minus className="h-4 w-4 opacity-40" />
          {phase === 'expired'
            ? 'RTH session ended — VWAP resets at 09:30 ET tomorrow.'
            : 'VWAP signals only active during RTH (09:30–16:00 ET).'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {states.map((state) => (
            <VwapCard key={state.symbol} state={state} />
          ))}
        </div>
      )}

      <div className="mt-2 text-[9px] text-muted-foreground/50">
        Signal: price extends ±1σ from VWAP with reversal candle · T1 = VWAP · T2 = ±1σ opposite · Stop = ±2σ
      </div>
    </section>
  );
}
