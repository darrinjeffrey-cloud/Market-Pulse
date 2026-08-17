/**
 * OvernightPanel — Overnight High/Low reference level panel
 *
 * Shows the high and low from the Globex overnight session (prev RTH close →
 * current RTH open). During RTH these become key reference levels — price often
 * tests overnight H/L as support/resistance.
 *
 * Fetches /api/market/overnight on mount and whenever the parent snapshot
 * timestamp changes. Self-refreshes every 30s.
 */

import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Moon, MoveHorizontal } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type OvernightStatus = 'forming' | 'reference' | 'expired';

type OvernightContext =
  | 'above_both'
  | 'below_both'
  | 'near_high'
  | 'near_low'
  | 'inside'
  | null;

type OvernightState = {
  symbol:          string;
  displayName:     string;
  status:          OvernightStatus;
  overnightHigh:   number | null;
  overnightLow:    number | null;
  rangeTicks:      number | null;
  barsInSession:   number;
  currentPrice:    number | null;
  context:         OvernightContext;
  distToHigh:      number | null;
  distToLow:       number | null;
  lastUpdated:     string;
};

type OvernightSnapshot = {
  timestamp: string;
  markets:   Record<string, OvernightState>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(n: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDist(n: number) {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

const DISPLAY_ORDER = ['ES', 'NQ', 'MES', 'MNQ'];

function sortKey(displayName: string): number {
  const root = displayName.replace('.c.0', '');
  const idx  = DISPLAY_ORDER.indexOf(root);
  return idx < 0 ? 99 : idx;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ state }: { state: OvernightState }) {
  switch (state.status) {
    case 'forming':
      return (
        <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--primary)/.3)] bg-[hsl(var(--primary)/.1)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--primary))]">
          <span className="h-1 w-1 animate-pulse rounded-full bg-[hsl(var(--primary))]" />
          Forming
        </span>
      );
    case 'reference':
      return (
        <span className="rounded border border-border/50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
          Reference
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

function ContextBadge({ context }: { context: OvernightContext }) {
  if (!context) return null;

  const configs: Record<NonNullable<OvernightContext>, { label: string; className: string; icon: React.ReactNode }> = {
    above_both: {
      label: 'Above O/N High',
      className: 'text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4)/.3)] bg-[hsl(var(--chart-4)/.08)]',
      icon: <ArrowUpRight className="h-3 w-3" />,
    },
    below_both: {
      label: 'Below O/N Low',
      className: 'text-[hsl(var(--destructive))] border-[hsl(var(--destructive)/.3)] bg-[hsl(var(--destructive)/.08)]',
      icon: <ArrowDownRight className="h-3 w-3" />,
    },
    near_high: {
      label: 'Near O/N High',
      className: 'text-[hsl(var(--chart-4)/.8)] border-[hsl(var(--chart-4)/.2)] bg-[hsl(var(--chart-4)/.05)]',
      icon: <ArrowUpRight className="h-3 w-3" />,
    },
    near_low: {
      label: 'Near O/N Low',
      className: 'text-[hsl(var(--destructive)/.8)] border-[hsl(var(--destructive)/.2)] bg-[hsl(var(--destructive)/.05)]',
      icon: <ArrowDownRight className="h-3 w-3" />,
    },
    inside: {
      label: 'Inside Range',
      className: 'text-muted-foreground border-border/40',
      icon: <MoveHorizontal className="h-3 w-3" />,
    },
  };

  const cfg = configs[context];
  return (
    <div className={`mt-2 flex items-center gap-1 rounded border px-2 py-1 text-[9px] font-bold uppercase tracking-wider ${cfg.className}`}>
      {cfg.icon}
      {cfg.label}
    </div>
  );
}

function OvernightCard({ state }: { state: OvernightState }) {
  const sym        = state.displayName.replace('.c.0', '');
  const isForming  = state.status === 'forming';
  const isRef      = state.status === 'reference';
  const hasLevels  = state.overnightHigh !== null && state.overnightLow !== null;

  const isAbove   = state.context === 'above_both';
  const isBelow   = state.context === 'below_both';

  const borderClass = isAbove
    ? 'border-[hsl(var(--chart-4)/.4)]'
    : isBelow
    ? 'border-[hsl(var(--destructive)/.4)]'
    : isForming
    ? 'border-[hsl(var(--primary)/.25)]'
    : 'border-border/50';

  const bgClass = isAbove
    ? 'bg-[hsl(var(--chart-4)/.04)]'
    : isBelow
    ? 'bg-[hsl(var(--destructive)/.04)]'
    : isForming
    ? 'bg-[hsl(var(--primary)/.03)]'
    : 'bg-card/60';

  return (
    <div className={`fam-card rounded-lg border p-4 transition-colors ${borderClass} ${bgClass}`}>
      {/* Card header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="fam-mono text-[12px] font-bold tracking-tight text-foreground">{sym}</span>
        <StatusBadge state={state} />
      </div>

      {/* Overnight range levels */}
      {hasLevels ? (
        <div className="mb-2 rounded border border-border/40 bg-background/40 px-3 py-2">
          <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
            O/N Range
            {isForming && state.barsInSession > 0 && (
              <span className="ml-1 text-[hsl(var(--primary))]">· {state.barsInSession} bars</span>
            )}
          </div>
          <div className="flex items-center justify-between">
            {/* High */}
            <div>
              <div className="mb-0.5 text-[9px] text-muted-foreground">High</div>
              <div className="fam-mono text-xs font-semibold text-[hsl(var(--chart-4))]">
                {fmtPrice(state.overnightHigh!)}
              </div>
            </div>
            {/* Center — range ticks */}
            <div className="text-center">
              <div className="text-[10px] text-muted-foreground/60">│</div>
              <div className="text-[10px] font-bold text-muted-foreground">
                {state.rangeTicks != null ? `${state.rangeTicks}T` : '—'}
              </div>
              <div className="text-[10px] text-muted-foreground/60">│</div>
            </div>
            {/* Low */}
            <div className="text-right">
              <div className="mb-0.5 text-[9px] text-muted-foreground">Low</div>
              <div className="fam-mono text-xs font-semibold text-[hsl(var(--destructive))]">
                {fmtPrice(state.overnightLow!)}
              </div>
            </div>
          </div>
        </div>
      ) : isForming ? (
        <div className="mb-2 rounded border border-[hsl(var(--primary)/.2)] bg-[hsl(var(--primary)/.04)] px-3 py-2 text-center">
          <div className="text-[10px] text-[hsl(var(--primary))/80]">Collecting overnight bars…</div>
          <div className="mt-0.5 text-[9px] text-muted-foreground">Levels lock at RTH open 09:30 ET</div>
        </div>
      ) : null}

      {/* Distance-to-levels (RTH only) */}
      {isRef && hasLevels && state.distToHigh !== null && state.distToLow !== null && (
        <div className="mt-1 space-y-1 text-[9px] text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Dist to High</span>
            <span className={`fam-mono font-semibold ${state.distToHigh >= 0 ? 'text-[hsl(var(--chart-4))]' : 'text-[hsl(var(--destructive))]'}`}>
              {fmtDist(-state.distToHigh)} pts
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Dist to Low</span>
            <span className={`fam-mono font-semibold ${state.distToLow >= 0 ? 'text-[hsl(var(--chart-4))]' : 'text-[hsl(var(--destructive))]'}`}>
              {fmtDist(state.distToLow)} pts
            </span>
          </div>
        </div>
      )}

      {/* Context badge */}
      {isRef && <ContextBadge context={state.context} />}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function OvernightPanel({ snapshotTimestamp }: { snapshotTimestamp?: string }) {
  const [data, setData] = useState<OvernightSnapshot | null>(null);

  const refresh = () => {
    fetch('/api/market/overnight', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setData(d as OvernightSnapshot))
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

  const phase     = states[0]?.status ?? 'forming';
  const offSession = states.every(s => s.status === 'expired');

  const phaseLabel =
    phase === 'forming'   ? 'Forming' :
    phase === 'reference' ? 'Active' :
    phase === 'expired'   ? 'Session Ended' :
    null;

  const phasePillClass =
    phase === 'forming'
      ? 'border-[hsl(var(--primary)/.3)] bg-[hsl(var(--primary)/.08)] text-[hsl(var(--primary))]'
      : phase === 'reference'
        ? 'border-border/60 text-muted-foreground'
        : 'border-border/30 text-muted-foreground/50';

  return (
    <section aria-label="Overnight Levels" className="fam-rise fam-rise-3 mt-8">
      {/* Section header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="fam-display text-[11px] font-extrabold uppercase tracking-[.14em] text-muted-foreground">
            Overnight Levels
          </h2>
          <span className="text-[10px] text-muted-foreground/50">
            Globex 16:00–09:30 ET · key S/R for RTH session
          </span>
        </div>

        {phaseLabel && (
          <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${phasePillClass}`}>
            {phase === 'forming' && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--primary))]" />
            )}
            {phaseLabel}
          </span>
        )}
      </div>

      {offSession ? (
        <div className="fam-card flex items-center justify-center gap-2 rounded-lg border border-border/40 py-5 text-[11px] text-muted-foreground">
          <Moon className="h-4 w-4 opacity-40" />
          RTH session ended — overnight window opens at 16:00 ET.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {states.map((state) => (
            <OvernightCard key={state.symbol} state={state} />
          ))}
        </div>
      )}

      <div className="mt-2 text-[9px] text-muted-foreground/50">
        Overnight High/Low = max/min of Globex bars from prior RTH close to current RTH open · key support/resistance during RTH
      </div>
    </section>
  );
}
