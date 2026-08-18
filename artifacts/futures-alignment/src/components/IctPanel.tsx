/**
 * IctPanel — ICT Liquidity Sweep + FVG signal panel
 *
 * Fetches /api/market/ict on mount and whenever the parent market snapshot
 * timestamp changes. Also self-refreshes every 30 s.
 */

import { useEffect, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type IctSignal = 'BUY' | 'SELL' | 'WAIT';

type IctFvg = {
  type:   'BULLISH' | 'BEARISH';
  top:    number;
  bottom: number;
};

type IctState = {
  symbol:        string;
  displayName:   string;
  signal:        IctSignal;
  confidence:    number;
  bias15m:       string;
  struct5m:      string;
  entryZone:     [number, number] | null;
  stopLoss:      number | null;
  tp1:           number | null;
  tp2:           number | null;
  tp3:           number | null;
  rrRatio:       number | null;
  bsl:           number | null;
  ssl:           number | null;
  keyFvg:        IctFvg | null;
  tradeReason:   string;
  whatToWaitFor: string;
  lastUpdated:   string;
};

type IctSnapshot = {
  timestamp: string;
  markets:   Record<string, IctState>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number | null, decimals = 2): string {
  if (n === null) return '—';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

const DISPLAY_ORDER = ['ES', 'NQ', 'MES', 'MNQ'];
function sortKey(displayName: string): number {
  const root = displayName.replace('.c.0', '');
  const idx  = DISPLAY_ORDER.indexOf(root);
  return idx < 0 ? 99 : idx;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: IctSignal }) {
  if (signal === 'BUY') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--chart-4)/.35)] bg-[hsl(var(--chart-4)/.1)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--chart-4))]">
        <ArrowUpRight className="h-2.5 w-2.5" /> BUY
      </span>
    );
  }
  if (signal === 'SELL') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--destructive)/.35)] bg-[hsl(var(--destructive)/.1)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--destructive))]">
        <ArrowDownRight className="h-2.5 w-2.5" /> SELL
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
      <Minus className="h-2.5 w-2.5" /> WAIT
    </span>
  );
}

function BiasChip({ label, bias }: { label: string; bias: string }) {
  const colorClass =
    bias === 'Bullish' ? 'text-[hsl(var(--chart-4))]' :
    bias === 'Bearish' ? 'text-[hsl(var(--destructive))]' :
    'text-muted-foreground/60';
  const Icon =
    bias === 'Bullish' ? TrendingUp :
    bias === 'Bearish' ? TrendingDown :
    Minus;
  return (
    <div className="flex items-center gap-1">
      <span className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground/50">{label}</span>
      <span className={`flex items-center gap-0.5 text-[9px] font-bold ${colorClass}`}>
        <Icon className="h-2.5 w-2.5" />{bias}
      </span>
    </div>
  );
}

function LevelRow({
  label,
  value,
  variant = 'default',
}: {
  label: string;
  value: string;
  variant?: 'default' | 'entry' | 'stop' | 'target' | 'ref';
}) {
  const valClass =
    variant === 'stop'   ? 'text-[hsl(var(--destructive))]' :
    variant === 'target' ? 'text-[hsl(var(--chart-4))]' :
    variant === 'entry'  ? 'text-foreground font-bold' :
    variant === 'ref'    ? 'text-muted-foreground/70' :
    'text-foreground';
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
      <span className={`fam-mono text-[10px] font-semibold ${valClass}`}>{value}</span>
    </div>
  );
}

function ConfidenceBar({ pct }: { pct: number }) {
  const color =
    pct >= 80 ? 'hsl(var(--chart-4))' :
    pct >= 50 ? 'hsl(var(--primary))' :
    'hsl(var(--muted-foreground))';
  return (
    <div className="mt-2">
      <div className="mb-0.5 flex justify-between text-[8px] text-muted-foreground/50">
        <span>Confidence</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function IctCard({ state }: { state: IctState }) {
  const sym      = state.displayName.replace('.c.0', '');
  const isBuy    = state.signal === 'BUY';
  const isSell   = state.signal === 'SELL';
  const hasSetup = isBuy || isSell;

  const borderClass = isBuy
    ? 'border-[hsl(var(--chart-4)/.4)]'
    : isSell
    ? 'border-[hsl(var(--destructive)/.4)]'
    : 'border-border/50';

  const bgClass = isBuy
    ? 'bg-[hsl(var(--chart-4)/.04)]'
    : isSell
    ? 'bg-[hsl(var(--destructive)/.04)]'
    : 'bg-card/60';

  return (
    <div className={`fam-card rounded-lg border p-4 transition-colors ${borderClass} ${bgClass}`}>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="fam-mono text-[13px] font-bold tracking-tight text-foreground">{sym}</span>
        <SignalBadge signal={state.signal} />
      </div>

      {/* Bias row */}
      <div className="mb-3 flex gap-4">
        <BiasChip label="15M" bias={state.bias15m} />
        <BiasChip label="5M"  bias={state.struct5m} />
      </div>

      {/* Trade levels */}
      {hasSetup && state.entryZone !== null ? (
        <div className="mb-3 space-y-px rounded border border-border/40 bg-background/40 px-3 py-2">
          <LevelRow label="Entry zone"  value={`${fmt(state.entryZone[0])} – ${fmt(state.entryZone[1])}`} variant="entry" />
          <LevelRow label="Stop loss"   value={fmt(state.stopLoss)}   variant="stop" />
          <LevelRow label="T1 · 1.5R"   value={fmt(state.tp1)}        variant="target" />
          <LevelRow label="T2 · BSL/SSL" value={fmt(state.tp2)}       variant="target" />
          {state.tp3 !== null && (
            <LevelRow label="T3 · ext"  value={fmt(state.tp3)}        variant="target" />
          )}
          {state.rrRatio !== null && (
            <LevelRow label="R:R"       value={`1:${state.rrRatio.toFixed(2)}`} />
          )}
        </div>
      ) : null}

      {/* Reference levels */}
      <div className="mb-3 rounded border border-border/30 bg-background/30 px-3 py-2">
        <div className="mb-1 text-[8px] font-semibold uppercase tracking-wider text-muted-foreground/50">Key levels</div>
        {state.bsl !== null && <LevelRow label="BSL" value={fmt(state.bsl)} variant="ref" />}
        {state.ssl !== null && <LevelRow label="SSL" value={fmt(state.ssl)} variant="ref" />}
        {state.keyFvg !== null && (
          <LevelRow
            label={`FVG · ${state.keyFvg.type === 'BULLISH' ? '▲' : '▼'}`}
            value={`${fmt(state.keyFvg.bottom)} – ${fmt(state.keyFvg.top)}`}
            variant="ref"
          />
        )}
      </div>

      {/* Reason */}
      <p className="mb-1 text-[9px] leading-relaxed text-muted-foreground">
        {state.tradeReason}
      </p>
      {state.whatToWaitFor && !hasSetup && (
        <p className="text-[8px] leading-relaxed text-muted-foreground/60">
          Wait for: {state.whatToWaitFor}
        </p>
      )}

      {/* Confidence bar */}
      <ConfidenceBar pct={state.confidence} />
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function IctPanel({ snapshotTimestamp }: { snapshotTimestamp?: string }) {
  const [data, setData] = useState<IctSnapshot | null>(null);

  const refresh = () => {
    fetch('/api/market/ict', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setData(d as IctSnapshot))
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

  const hasSignal = states.some((s) => s.signal === 'BUY' || s.signal === 'SELL');

  return (
    <section aria-label="ICT Signal" className="fam-rise fam-rise-3 mt-8">
      {/* Section header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="fam-display text-[11px] font-extrabold uppercase tracking-[.14em] text-muted-foreground">
            ICT Signal
          </h2>
          <span className="text-[10px] text-muted-foreground/50">
            Liquidity sweep · 5M FVG entry · EMA 9/21 bias
          </span>
        </div>

        {hasSignal && (
          <span className="inline-flex items-center gap-1 rounded border border-[hsl(var(--chart-4)/.3)] bg-[hsl(var(--chart-4)/.08)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--chart-4))]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            Setup Active
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {states.map((state) => (
          <IctCard key={state.symbol} state={state} />
        ))}
      </div>

      <div className="mt-2 text-[9px] text-muted-foreground/50">
        Signal: BSL/SSL sweep + CHoCH displacement into 5M FVG · Min R:R 1:2 · 15M + 5M bias aligned
      </div>
    </section>
  );
}
