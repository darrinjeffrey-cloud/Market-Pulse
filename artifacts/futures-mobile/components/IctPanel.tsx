/**
 * IctPanel.tsx — ICT Liquidity Sweep + FVG signal panel (mobile)
 *
 * Fetches /api/market/ict on mount and every 30 s.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { getApiBase, getAuthHeaders } from '@/hooks/tokenStore';

// ─── Types ────────────────────────────────────────────────────────────────────

type IctSignal = 'BUY' | 'SELL' | 'WAIT';

interface IctFvg {
  type:   'BULLISH' | 'BEARISH';
  top:    number;
  bottom: number;
}

interface IctState {
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
}

interface IctSnapshot {
  timestamp: string;
  markets:   Record<string, IctState>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number | null, decimals = 2): string {
  if (n === null) return '—';
  return n.toFixed(decimals);
}

function baseSymbol(s: string): string {
  return s.split('.')[0] ?? s;
}

// ─── Signal badge ─────────────────────────────────────────────────────────────

function SignalBadge({ signal, colors }: {
  signal: IctSignal;
  colors: ReturnType<typeof useColors>;
}) {
  let label: string;
  let bg: string;
  let fg: string;

  if (signal === 'BUY') {
    label = '▲ BUY';
    bg    = colors.success;
    fg    = colors.primaryForeground;
  } else if (signal === 'SELL') {
    label = '▼ SELL';
    bg    = colors.destructive;
    fg    = colors.primaryForeground;
  } else {
    label = '— WAIT';
    bg    = colors.secondary;
    fg    = colors.mutedForeground;
  }

  return (
    <View style={[badge.wrap, { backgroundColor: bg }]}>
      <Text style={[badge.label, { color: fg }]}>{label}</Text>
    </View>
  );
}

const badge = StyleSheet.create({
  wrap: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5 },
  label: { fontSize: 10, fontFamily: 'Inter_700Bold', letterSpacing: 0.7 },
});

// ─── Bias chip ────────────────────────────────────────────────────────────────

function BiasChip({ label, bias, colors }: {
  label: string;
  bias:  string;
  colors: ReturnType<typeof useColors>;
}) {
  const color =
    bias === 'Bullish' ? colors.success :
    bias === 'Bearish' ? colors.destructive :
    colors.mutedForeground;
  const arrow = bias === 'Bullish' ? '↑' : bias === 'Bearish' ? '↓' : '—';
  return (
    <View style={chip.wrap}>
      <Text style={[chip.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[chip.value, { color }]}>{arrow} {bias}</Text>
    </View>
  );
}

const chip = StyleSheet.create({
  wrap:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: 9, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5 },
  value: { fontSize: 9, fontFamily: 'Inter_700Bold' },
});

// ─── Level row ────────────────────────────────────────────────────────────────

function LevelRow({ label, value, valueColor }: {
  label:      string;
  value:      string;
  valueColor: string;
}) {
  return (
    <View style={lvl.row}>
      <Text style={lvl.label}>{label}</Text>
      <Text style={[lvl.value, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const lvl = StyleSheet.create({
  row:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  label: { fontSize: 9, fontFamily: 'Inter_400Regular', color: '#888' },
  value: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
});

// ─── Confidence bar ───────────────────────────────────────────────────────────

function ConfidenceBar({ pct, colors }: {
  pct:    number;
  colors: ReturnType<typeof useColors>;
}) {
  const fillColor =
    pct >= 80 ? colors.success :
    pct >= 50 ? colors.primary :
    colors.mutedForeground;
  return (
    <View style={conf.wrap}>
      <View style={conf.labelRow}>
        <Text style={[conf.label, { color: colors.mutedForeground }]}>Confidence</Text>
        <Text style={[conf.label, { color: colors.mutedForeground }]}>{pct}%</Text>
      </View>
      <View style={[conf.track, { backgroundColor: colors.secondary }]}>
        <View style={[conf.fill, { width: `${pct}%` as any, backgroundColor: fillColor }]} />
      </View>
    </View>
  );
}

const conf = StyleSheet.create({
  wrap:     { marginTop: 8 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  label:    { fontSize: 8, fontFamily: 'Inter_400Regular' },
  track:    { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill:     { height: '100%', borderRadius: 2 },
});

// ─── Card ─────────────────────────────────────────────────────────────────────

function IctCard({ s, colors }: { s: IctState; colors: ReturnType<typeof useColors> }) {
  const isBuy  = s.signal === 'BUY';
  const isSell = s.signal === 'SELL';
  const accentColor =
    isBuy  ? colors.success :
    isSell ? colors.destructive :
    colors.border;

  return (
    <View style={[card.wrap, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: accentColor }]}>
      {/* Header */}
      <View style={card.header}>
        <Text style={[card.symbol, { color: colors.foreground }]}>{baseSymbol(s.displayName)}</Text>
        <View style={card.spacer} />
        <SignalBadge signal={s.signal} colors={colors} />
      </View>

      {/* Bias */}
      <View style={card.biasRow}>
        <BiasChip label="15M" bias={s.bias15m} colors={colors} />
        <Text style={{ color: colors.border, marginHorizontal: 6 }}>·</Text>
        <BiasChip label="5M"  bias={s.struct5m} colors={colors} />
      </View>

      {/* Trade levels */}
      {(isBuy || isSell) && s.entryZone !== null && (
        <View style={[card.section, { borderColor: colors.border, backgroundColor: colors.muted }]}>
          <LevelRow label="Entry" value={`${fmt(s.entryZone[0])} – ${fmt(s.entryZone[1])}`} valueColor={colors.foreground} />
          <LevelRow label="Stop"  value={fmt(s.stopLoss)}  valueColor={colors.destructive} />
          <LevelRow label="T1 · 1.5R"    value={fmt(s.tp1)} valueColor={colors.success} />
          <LevelRow label="T2 · BSL/SSL" value={fmt(s.tp2)} valueColor={colors.success} />
          {s.tp3 !== null && (
            <LevelRow label="T3 · ext" value={fmt(s.tp3)} valueColor={colors.success} />
          )}
          {s.rrRatio !== null && (
            <LevelRow label="R:R" value={`1:${s.rrRatio.toFixed(2)}`} valueColor={colors.foreground} />
          )}
        </View>
      )}

      {/* Reference levels */}
      <View style={[card.section, { borderColor: colors.border, backgroundColor: colors.muted }]}>
        {s.bsl !== null && <LevelRow label="BSL" value={fmt(s.bsl)} valueColor={colors.mutedForeground} />}
        {s.ssl !== null && <LevelRow label="SSL" value={fmt(s.ssl)} valueColor={colors.mutedForeground} />}
        {s.keyFvg !== null && (
          <LevelRow
            label={`FVG ${s.keyFvg.type === 'BULLISH' ? '▲' : '▼'}`}
            value={`${fmt(s.keyFvg.bottom)} – ${fmt(s.keyFvg.top)}`}
            valueColor={colors.mutedForeground}
          />
        )}
      </View>

      {/* Reason text */}
      <Text style={[card.reason, { color: colors.mutedForeground }]}>{s.tradeReason}</Text>
      {s.whatToWaitFor && s.signal === 'WAIT' && (
        <Text style={[card.wait, { color: colors.mutedForeground }]}>
          Wait for: {s.whatToWaitFor}
        </Text>
      )}

      <ConfidenceBar pct={s.confidence} colors={colors} />
    </View>
  );
}

const card = StyleSheet.create({
  wrap: {
    borderRadius: 10,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 12,
    marginBottom: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  symbol: { fontSize: 16, fontFamily: 'Inter_700Bold', letterSpacing: -0.3 },
  spacer: { flex: 1 },
  biasRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  section: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  reason: { fontSize: 10, fontFamily: 'Inter_400Regular', lineHeight: 15, marginBottom: 2 },
  wait:   { fontSize: 9,  fontFamily: 'Inter_400Regular', lineHeight: 14, opacity: 0.7 },
});

// ─── Panel ────────────────────────────────────────────────────────────────────

interface IctPanelProps {
  snapshotTimestamp?: string;
}

export default function IctPanel({ snapshotTimestamp }: IctPanelProps) {
  const colors = useColors();
  const [data, setData]       = useState<IctSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      try {
        const res = await fetch(`${getApiBase()}/market/ict`, {
          credentials: 'include',
          headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as IctSnapshot;
        if (!cancelled) { setData(json); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetch_();
    const id = setInterval(() => { void fetch_(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [snapshotTimestamp]);

  const states = data ? Object.values(data.markets) : [];

  return (
    <View style={[panel.wrap, { borderTopColor: colors.border }]}>
      <View style={panel.headerRow}>
        <Ionicons name="flash-outline" size={13} color={colors.mutedForeground} />
        <Text style={[panel.title, { color: colors.mutedForeground }]}>ICT SIGNAL</Text>
        <Text style={[panel.sub, { color: colors.mutedForeground }]}>Sweep · FVG · EMA bias</Text>
      </View>

      {loading && !data ? (
        <ActivityIndicator size="small" color={colors.primary} style={panel.loader} />
      ) : error ? (
        <Text style={[panel.note, { color: colors.mutedForeground }]}>Unable to load ICT data</Text>
      ) : states.length === 0 ? (
        <Text style={[panel.note, { color: colors.mutedForeground }]}>No symbols tracked</Text>
      ) : (
        states.map((s) => <IctCard key={s.symbol} s={s} colors={colors} />)
      )}
    </View>
  );
}

const panel = StyleSheet.create({
  wrap: {
    marginTop: 8,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  title: { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8 },
  sub:   { fontSize: 10, fontFamily: 'Inter_400Regular', letterSpacing: 0.2 },
  loader: { marginVertical: 16 },
  note:   { fontSize: 12, fontFamily: 'Inter_400Regular', marginBottom: 12 },
});
