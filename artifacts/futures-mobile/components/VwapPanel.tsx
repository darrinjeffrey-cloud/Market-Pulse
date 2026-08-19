/**
 * VwapPanel.tsx — VWAP Reversion panel for the mobile app.
 *
 * Fetches /api/market/vwap on mount and every 30 s. Active throughout Globex.
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

type VwapStatus = 'inactive' | 'watching' | 'long_setup' | 'short_setup' | 'expired';

interface VwapState {
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
}

interface VwapSnapshot {
  timestamp: string;
  markets:   Record<string, VwapState>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

function baseSymbol(s: string): string {
  return s.split('.')[0] ?? s;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, signal, colors }: {
  status: VwapStatus;
  signal: 'LONG' | 'SHORT' | null;
  colors: ReturnType<typeof useColors>;
}) {
  let label: string;
  let bg: string;
  let fg: string;

  if (status === 'long_setup') {
    label = '▲ LONG';
    bg    = colors.success;
    fg    = colors.primaryForeground;
  } else if (status === 'short_setup') {
    label = '▼ SHORT';
    bg    = colors.destructive;
    fg    = colors.primaryForeground;
  } else if (status === 'watching') {
    label = '— WATCHING';
    bg    = colors.secondary;
    fg    = colors.mutedForeground;
  } else {
    label = 'INACTIVE';
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
  wrap: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
  },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.7,
  },
});

// ─── Deviation gauge ──────────────────────────────────────────────────────────

function DeviationGauge({ sigmas, colors }: {
  sigmas: number;
  colors: ReturnType<typeof useColors>;
}) {
  const clamped = Math.max(-2.5, Math.min(2.5, sigmas));
  const pct     = ((clamped + 2.5) / 5) * 100;

  const needleColor =
    sigmas <= -1 ? colors.success :
    sigmas >= 1  ? colors.destructive :
    colors.mutedForeground;

  return (
    <View style={gauge.wrap}>
      <View style={[gauge.track, { backgroundColor: colors.secondary }]}>
        {/* ±1σ zone */}
        <View style={[gauge.zone, { backgroundColor: colors.muted }]} />
        {/* Needle */}
        <View
          style={[
            gauge.needle,
            { left: `${pct}%` as unknown as number, backgroundColor: needleColor },
          ]}
        />
      </View>
      <View style={gauge.labels}>
        <Text style={[gauge.labelText, { color: colors.mutedForeground }]}>−2σ</Text>
        <Text style={[gauge.sigmaValue, { color: needleColor }]}>
          {sigmas >= 0 ? '+' : ''}{sigmas.toFixed(2)}σ
        </Text>
        <Text style={[gauge.labelText, { color: colors.mutedForeground }]}>+2σ</Text>
      </View>
    </View>
  );
}

const gauge = StyleSheet.create({
  wrap: { marginTop: 6 },
  track: {
    height: 5,
    borderRadius: 3,
    overflow: 'hidden',
    position: 'relative',
  },
  zone: {
    position: 'absolute',
    top: 0, bottom: 0,
    left: '30%' as unknown as number,
    width: '40%' as unknown as number,
  },
  needle: {
    position: 'absolute',
    top: 0, bottom: 0,
    width: 2,
    borderRadius: 1,
    marginLeft: -1,
  },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  labelText: {
    fontSize: 8,
    fontFamily: 'Inter_400Regular',
  },
  sigmaValue: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
  },
});

// ─── Trade level grid ─────────────────────────────────────────────────────────

function LevelGrid({ v, colors }: { v: VwapState; colors: ReturnType<typeof useColors> }) {
  const cells = [
    { label: 'ENTRY',  value: fmtPrice(v.entry),   color: colors.foreground },
    { label: 'STOP',   value: fmtPrice(v.stop),    color: colors.destructive },
    { label: 'T1·VWAP', value: fmtPrice(v.target1), color: colors.success },
    { label: 'T2·±1σ',  value: fmtPrice(v.target2), color: colors.success },
  ] as const;

  return (
    <View style={[grid.container, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      {cells.map((cell, idx) => (
        <View
          key={cell.label}
          style={[
            grid.cell,
            idx % 2 === 0
              ? { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border }
              : {},
            idx < 2
              ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }
              : {},
          ]}
        >
          <Text style={[grid.cellLabel, { color: colors.mutedForeground }]}>{cell.label}</Text>
          <Text style={[grid.cellValue, { color: cell.color }]}>{cell.value}</Text>
        </View>
      ))}
    </View>
  );
}

const grid = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    marginTop: 10,
  },
  cell: {
    width: '50%',
    paddingVertical: 9,
    alignItems: 'center',
  },
  cellLabel: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  cellValue: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.3,
  },
});

// ─── VWAP info row ────────────────────────────────────────────────────────────

function VwapRow({ v, colors }: { v: VwapState; colors: ReturnType<typeof useColors> }) {
  if (v.vwap == null) return null;
  return (
    <View style={vrow.wrap}>
      <View style={vrow.pill}>
        <Text style={[vrow.label, { color: colors.destructive + '88' }]}>+2σ</Text>
        <Text style={[vrow.value, { color: colors.destructive + 'AA', fontSize: 10 }]}>{fmtPrice(v.band2Upper)}</Text>
      </View>
      <View style={[vrow.divider, { backgroundColor: colors.border }]} />
      <View style={vrow.pill}>
        <Text style={[vrow.label, { color: colors.destructive + 'CC' }]}>+1σ</Text>
        <Text style={[vrow.value, { color: colors.destructive, fontSize: 11 }]}>{fmtPrice(v.band1Upper)}</Text>
      </View>
      <View style={[vrow.divider, { backgroundColor: colors.border }]} />
      <View style={vrow.pill}>
        <Text style={[vrow.label, { color: colors.mutedForeground }]}>VWAP</Text>
        <Text style={[vrow.value, { color: colors.foreground }]}>{fmtPrice(v.vwap)}</Text>
      </View>
      <View style={[vrow.divider, { backgroundColor: colors.border }]} />
      <View style={vrow.pill}>
        <Text style={[vrow.label, { color: colors.success + 'CC' }]}>−1σ</Text>
        <Text style={[vrow.value, { color: colors.success, fontSize: 11 }]}>{fmtPrice(v.band1Lower)}</Text>
      </View>
      <View style={[vrow.divider, { backgroundColor: colors.border }]} />
      <View style={vrow.pill}>
        <Text style={[vrow.label, { color: colors.success + '88' }]}>−2σ</Text>
        <Text style={[vrow.value, { color: colors.success + 'AA', fontSize: 10 }]}>{fmtPrice(v.band2Lower)}</Text>
      </View>
    </View>
  );
}

const vrow = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  label: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.6,
  },
  value: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.2,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 10,
  },
});

// ─── Individual VWAP card ─────────────────────────────────────────────────────

function VwapCard({ v }: { v: VwapState }) {
  const colors = useColors();
  const isLong   = v.status === 'long_setup';
  const isShort  = v.status === 'short_setup';

  const accentColor =
    isLong  ? colors.success :
    isShort ? colors.destructive :
    v.status === 'watching' ? colors.accent :
    colors.border;

  return (
    <View style={[card.wrap, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: accentColor }]}>
      {/* Header */}
      <View style={card.header}>
        <Text style={[card.symbol, { color: colors.foreground }]}>
          {baseSymbol(v.displayName)}
        </Text>
        <Text style={[card.display, { color: colors.mutedForeground }]}>
          {v.displayName}
        </Text>
        <View style={card.spacer} />
        <StatusBadge status={v.status} signal={v.signal} colors={colors} />
      </View>

      {/* VWAP row */}
      <VwapRow v={v} colors={colors} />

      {/* Deviation gauge */}
      {v.deviationSigmas != null && (
        <DeviationGauge sigmas={v.deviationSigmas} colors={colors} />
      )}

      {/* Trade levels */}
      {(isLong || isShort) && <LevelGrid v={v} colors={colors} />}

      {/* Watching hint */}
      {v.status === 'watching' && v.band1Upper != null && v.band1Lower != null && (
        <View style={card.hintRow}>
          <Text style={[card.hintLabel, { color: colors.mutedForeground }]}>Short zone</Text>
          <Text style={[card.hintValue, { color: colors.destructive }]}>{fmtPrice(v.band1Upper)}</Text>
          <Text style={[card.hintSep, { color: colors.border }]}>·</Text>
          <Text style={[card.hintLabel, { color: colors.mutedForeground }]}>Long zone</Text>
          <Text style={[card.hintValue, { color: colors.success }]}>{fmtPrice(v.band1Lower)}</Text>
        </View>
      )}

      {/* Inactive hint */}
      {(v.status === 'inactive' || v.status === 'expired') && (
        <Text style={[card.hint, { color: colors.mutedForeground }]}>
          {v.status === 'expired'
            ? 'CME closed — resets Sunday at 6:00 PM ET'
            : 'VWAP pauses during the 5:00–6:00 PM ET maintenance break'}
        </Text>
      )}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  symbol: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.3,
  },
  display: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  spacer: { flex: 1 },
  hint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    lineHeight: 16,
    marginTop: 8,
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  hintLabel: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  hintValue: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
  },
  hintSep: {
    fontSize: 10,
  },
});

// ─── Panel ────────────────────────────────────────────────────────────────────

interface VwapPanelProps {
  snapshotTimestamp?: string;
}

export default function VwapPanel({ snapshotTimestamp }: VwapPanelProps) {
  const colors = useColors();
  const [data, setData]       = useState<VwapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      try {
        const res = await fetch(`${getApiBase()}/market/vwap`, { credentials: 'include', headers: getAuthHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as VwapSnapshot;
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

  const vwaps = data ? Object.values(data.markets) : [];

  return (
    <View style={[panel.wrap, { borderTopColor: colors.border }]}>
      {/* Section header */}
      <View style={panel.headerRow}>
        <Ionicons name="analytics-outline" size={13} color={colors.mutedForeground} />
        <Text style={[panel.title, { color: colors.mutedForeground }]}>VWAP REVERSION</Text>
        <Text style={[panel.sub, { color: colors.mutedForeground }]}>Globex · ±1σ entry</Text>
      </View>

      {loading && !data ? (
        <ActivityIndicator size="small" color={colors.primary} style={panel.loader} />
      ) : error ? (
        <Text style={[panel.note, { color: colors.mutedForeground }]}>
          Unable to load VWAP data
        </Text>
      ) : vwaps.length === 0 ? (
        <Text style={[panel.note, { color: colors.mutedForeground }]}>
          No symbols tracked
        </Text>
      ) : (
        vwaps.map((v) => (
          <VwapCard key={v.symbol} v={v} />
        ))
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
  title: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
  },
  sub: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.2,
  },
  loader: { marginVertical: 16 },
  note: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginBottom: 12,
  },
});
