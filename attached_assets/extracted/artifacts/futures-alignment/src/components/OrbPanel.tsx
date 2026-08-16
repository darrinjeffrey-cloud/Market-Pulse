/**
 * OrbPanel — Opening Range Breakout signal panel
 *
 * Fetches /api/market/orb on mount and whenever the parent market snapshot
 * timestamp changes (i.e. a new bar arrived). Also self-refreshes every 30s
 * as a fallback. Shows one card per watched symbol.
 */

import { useEffect, useState } from 'react';

function getAuthHeaders(): Record<string, string> {
  const token = import.meta.env['VITE_API_TOKEN'] as string | undefined;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
import {
  ArrowDownRight,
  ArrowUpRight,
  Clock3,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type OrbStatus = 'inactive' | 'building' | 'ready' | 'triggered' | 'expired';

type OrbState = {
  symbol:       string;
  displayName:  string;
  status:       OrbStatus;
  orbHigh:      number | null;
  orbLow:       number | null;
  rangeTicks:   number | null;
  barsInWindow: number;
  signal:       'BULL' | 'BEAR' | null;
  entry:        number | null;
  stop:         number | null;
  target1:      number | null;
  target2:      number | null;
  riskTicks:    number | null;
  lastUpdated:  string;
};

type OrbSnapshot = {
  timestamp: string;
  markets: Record<string, OrbState>;
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

function StatusBadge({ state }: { state: OrbState }) {
  switch (state.status) {
    case 'building':
      return (
        <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--primary)/.3)] bg-[hsl(var(--primary)/.1)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--primary))]">
          <span className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--primary))]" />
          Building
        </span>
      );
    case 'ready':
      return (
        <span className="rounded border border-border/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
          Watching
        </span>
      );
    case 'triggered':
      return state.signal === 'BULL' ? (
        <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--chart-4)/.35)] bg-[hsl(var(--chart-4)/.1)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--chart-4))]">
          <TrendingUp className="h-2.5 w-2.5" /> Bull Break
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--destructive)/.35)] bg-[hsl(var(--destructive)/.1)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--destructive))]">
          <TrendingDown className="h-2.5 w-2.5" /> Bear Break
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

function OrbCard({ state }: { state: OrbState }) {
  const sym         = state.displayName.replace('.c.0', '');
  const isBuilding  = state.status === 'building';
  const isReady     = state.status === 'ready';
  const isTriggered = state.status === 'triggered';
  const isBull      = state.signal === 'BULL';
  const isBear      = state.signal === 'BEAR';

  const borderClass = isTriggered
    ? isBull
      ? 'border-[hsl(var(--chart-4)/.4)]'
      : 'border-[hsl(var(--destructive)/.4)]'
    : isBuilding
      ? 'border-[hsl(var(--primary)/.25)]'
      : 'border-border/50';

  const bgClass = isTriggered
    ? isBull
      ? 'bg-[hsl(var(--chart-4)/.04)]'
      : 'bg-[hsl(var(--destructive)/.04)]'
    : isBuilding
      ? 'bg-[hsl(var(--primary)/.03)]'
      : 'bg-card/60';

  return (
    <div className={`fam-card rounded-lg border p-4 transition-colors ${borderClass} ${bgClass}`}>
      {/* Card header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="fam-mono text-[12px] font-bold tracking-tight text-foreground">{sym}</span>
        <StatusBadge state={state} />
      </div>

      {/* ORB Range */}
      {state.orbHigh !== null && state.orbLow !== null ? (
        <div className="mb-3 rounded border border-border/40 bg-background/40 px-3 py-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            ORB Range
            {state.barsInWindow > 0 && isBuilding && (
              <span className="ml-1 text-[hsl(var(--primary))]">· {state.barsInWindow}/30 bars</span>
            )}
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="mb-0.5 text-[9px] text-muted-foreground">High</div>
              <div className="fam-mono text-xs font-semibold text-[hsl(var(--chart-4))]">
                {fmtPrice(state.orbHigh)}
              </div>
            </div>
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground/60">│</div>
              <div className="text-[10px] font-bold text-muted-foreground">
                {state.rangeTicks != null ? `${state.rangeTicks}T` : '—'}
              </div>
              <div className="text-[10px] text-muted-foreground/60">│</div>
            </div>
            <div className="text-right">
              <div className="mb-0.5 text-[9px] text-muted-foreground">Low</div>
              <div className="fam-mono text-xs font-semibold text-[hsl(var(--destructive))]">
                {fmtPrice(state.orbLow)}
              </div>
            </div>
          </div>
        </div>
      ) : isBuilding ? (
        <div className="mb-3 rounded border border-[hsl(var(--primary)/.2)] bg-[hsl(var(--primary)/.04)] px-3 py-2 text-center">
          <div className="text-[10px] text-[hsl(var(--primary))/80]">Collecting first 30 bars…</div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">Window closes at 10:00 ET</div>
        </div>
      ) : isReady ? (
        <div className="mb-3 rounded border border-border/30 bg-background/30 px-3 py-2 text-center text-[10px] text-muted-foreground">
          Waiting for breakout
        </div>
      ) : null}

      {/* Trade setup — shown when triggered */}
      {isTriggered && state.entry !== null && state.stop !== null ? (
        <div className="space-y-2">
          <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${isBull ? 'text-[hsl(var(--chart-4))]' : 'text-[hsl(var(--destructive))]'}`}>
            {isBull
              ? <ArrowUpRight className="h-3.5 w-3.5" />
              : <ArrowDownRight className="h-3.5 w-3.5" />}
            {isBull ? 'Bullish breakout confirmed' : 'Bearish breakout confirmed'}
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Entry"   value={fmtPrice(state.entry)}   variant="entry" />
            <Stat label="Stop"    value={fmtPrice(state.stop)}    variant="stop" />
            {state.target1 !== null && (
              <Stat label="T1 · 10 ticks" value={fmtPrice(state.target1)} variant="target" />
            )}
            {state.target2 !== null && (
              <Stat label="T2 · 20 ticks" value={fmtPrice(state.target2)} variant="target" />
            )}
          </div>

          {state.riskTicks !== null && (
            <div className="pt-0.5 text-[9px] text-muted-foreground">
              Risk: {state.riskTicks} ticks · {(state.riskTicks * 0.25).toFixed(2)} pts
            </div>
          )}
        </div>
      ) : isReady && state.orbHigh !== null && state.orbLow !== null ? (
        <div className="space-y-1 text-[9px] text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Break above</span>
            <span className="fam-mono font-semibold text-[hsl(var(--chart-4))]">{fmtPrice(state.orbHigh)} → BULL</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Break below</span>
            <span className="fam-mono font-semibold text-[hsl(var(--destructive))]">{fmtPrice(state.orbLow)} → BEAR</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function OrbPanel({ snapshotTimestamp }: { snapshotTimestamp?: string }) {
  const [data, setData] = useState<OrbSnapshot | null>(null);

  const refresh = () => {
    fetch('/api/market/orb', { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => setData(d as OrbSnapshot))
      .catch(() => {});
  };

  // Refetch on every new market snapshot (fires ~once/minute)
  useEffect(() => { refresh(); }, [snapshotTimestamp]);

  // Self-refresh every 30s independent of SSE (catches status changes mid-session)
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

  // Derive overall session phase from the first symbol (they share the same clock)
  const phase = states[0]?.status ?? 'inactive';
  const offSession = states.every(
    (s) => s.status === 'inactive' || s.status === 'expired',
  );

  const phaseLabel =
    phase === 'building'  ? 'Building' :
    phase === 'ready'     ? 'Watching' :
    phase === 'triggered' ? 'Signal Active' :
    phase === 'expired'   ? 'Session Ended' :
    null;

  const phasePillClass =
    phase === 'building'
      ? 'border-[hsl(var(--primary)/.3)] bg-[hsl(var(--primary)/.08)] text-[hsl(var(--primary))]'
      : phase === 'ready'
        ? 'border-border/60 text-muted-foreground'
        : phase === 'triggered'
          ? 'border-[hsl(var(--chart-4)/.3)] bg-[hsl(var(--chart-4)/.08)] text-[hsl(var(--chart-4))]'
          : 'border-border/30 text-muted-foreground/50';

  return (
    <section aria-label="Opening Range Breakout" className="fam-rise fam-rise-3 mt-8">
      {/* Section header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="fam-display text-[11px] font-extrabold uppercase tracking-[.14em] text-muted-foreground">
            Opening Range Breakout
          </h2>
          <span className="text-[10px] text-muted-foreground/50">
            RTH 09:30–16:00 ET · ORB window 09:30–10:00
          </span>
        </div>

        {phaseLabel && (
          <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${phasePillClass}`}>
            {phase === 'building' && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--primary))]" />
            )}
            {phaseLabel}
          </span>
        )}
      </div>

      {/* Off-session placeholder */}
      {offSession ? (
        <div className="fam-card flex items-center justify-center gap-2 rounded-lg border border-border/40 py-5 text-[11px] text-muted-foreground">
          <Clock3 className="h-4 w-4 opacity-40" />
          {phase === 'expired'
            ? 'RTH session ended — ORB resets at 09:30 ET tomorrow.'
            : 'ORB signals only active during RTH (09:30–16:00 ET).'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {states.map((state) => (
            <OrbCard key={state.symbol} state={state} />
          ))}
        </div>
      )}

      <div className="mt-2 text-[9px] text-muted-foreground/50">
        Targets: T1 = 10 ticks · T2 = 20 ticks · Stop = opposite side of ORB range · 0.25 pts/tick
      </div>
    </section>
  );
}
