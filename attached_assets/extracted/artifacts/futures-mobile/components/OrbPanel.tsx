/**
 * OrbPanel.tsx — Opening Range Breakout panel for the mobile app.
 *
 * Fetches /api/market/orb on mount and every 30 s, then renders one card
 * per watched symbol matching the dark terminal aesthetic of ContractCard.
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

// ─── Types (mirror orb-engine.ts) ────────────────────────────────────────────

type OrbStatus =
  | 'inactive'
  | 'building'
  | 'ready'
  | 'triggered'
  | 'expired';

interface OrbState {
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
}

interface OrbSnapshot {
  timestamp: string;
  markets:   Record<string, OrbState>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiBase(): string {
  const domain = process.env['EXPO_PUBLIC_DOMAIN'];
  return domain ? `https://${domain}/api` : '/api';
}

function getAuthHeaders(): Record<string, string> {
  const token = process.env['EXPO_PUBLIC_API_TOKEN'];
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

function baseSymbol(s: string): string {
  return s.split('.')[0] ?? s;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

interface BadgeProps {
  status:  OrbStatus;
  signal:  'BULL' | 'BEAR' | null;
  colors:  ReturnType<typeof useColors>;
}

function StatusBadge({ status, signal, colors }: BadgeProps) {
  let label: string;
  let bg: string;
  let fg: string;

  if (status === 'triggered' && signal) {
    label = signal === 'BULL' ? '▲ BULL' : '▼ BEAR';
    bg    = signal === 'BULL' ? colors.success : colors.destructive;
    fg    = colors.primaryForeground;
  } else if (status === 'building') {
    label = 'BUILDING';
    bg    = colors.primary;
    fg    = colors.primaryForeground;
  } else if (status === 'ready') {
    label = 'WATCHING';
    bg    = colors.accent;
    fg    = colors.accentForeground;
  } else if (status === 'expired') {
    label = 'EXPIRED';
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

// ─── Trade level grid (triggered state) ──────────────────────────────────────

interface LevelGridProps {
  orb: OrbState;
  colors: ReturnType<typeof useColors>;
}

function LevelGrid({ orb, colors }: LevelGridProps) {
  const cells = [
    { label: 'ENTRY',  value: fmtPrice(orb.entry),   color: colors.foreground },
    { label: 'STOP',   value: fmtPrice(orb.stop),    color: colors.destructive },
    { label: 'T1',     value: fmtPrice(orb.target1), color: colors.success },
    { label: 'T2',     value: fmtPrice(orb.target2), color: colors.success },
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

// ─── Range row (building / ready / triggered) ─────────────────────────────────

interface RangeRowProps {
  orb: OrbState;
  colors: ReturnType<typeof useColors>;
}

function RangeRow({ orb, colors }: RangeRowProps) {
  if (orb.orbHigh == null || orb.orbLow == null) return null;
  return (
    <View style={rangeRow.wrap}>
      <View style={rangeRow.pill}>
        <Text style={[rangeRow.label, { color: colors.mutedForeground }]}>H</Text>
        <Text style={[rangeRow.value, { color: colors.foreground }]}>{fmtPrice(orb.orbHigh)}</Text>
      </View>
      <View style={[rangeRow.divider, { backgroundColor: colors.border }]} />
      <View style={rangeRow.pill}>
        <Text style={[rangeRow.label, { color: colors.mutedForeground }]}>L</Text>
        <Text style={[rangeRow.value, { color: colors.foreground }]}>{fmtPrice(orb.orbLow)}</Text>
      </View>
      {orb.rangeTicks != null && (
        <>
          <View style={[rangeRow.divider, { backgroundColor: colors.border }]} />
          <View style={rangeRow.pill}>
            <Text style={[rangeRow.label, { color: colors.mutedForeground }]}>RNG</Text>
            <Text style={[rangeRow.value, { color: colors.accent }]}>{orb.rangeTicks}t</Text>
          </View>
        </>
      )}
      {orb.status === 'building' && (
        <>
          <View style={[rangeRow.divider, { backgroundColor: colors.border }]} />
          <View style={rangeRow.pill}>
            <Text style={[rangeRow.label, { color: colors.mutedForeground }]}>BARS</Text>
            <Text style={[rangeRow.value, { color: colors.mutedForeground }]}>{orb.barsInWindow}/30</Text>
          </View>
        </>
      )}
    </View>
  );
}

const rangeRow = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    flexWrap: 'wrap',
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

// ─── Individual ORB card ──────────────────────────────────────────────────────

interface OrbCardProps {
  orb: OrbState;
}

function OrbCard({ orb }: OrbCardProps) {
  const colors = useColors();

  const accentColor =
    orb.status === 'triggered' && orb.signal === 'BULL'
      ? colors.success
      : orb.status === 'triggered' && orb.signal === 'BEAR'
      ? colors.destructive
      : orb.status === 'building'
      ? colors.primary
      : orb.status === 'ready'
      ? colors.accent
      : colors.border;

  return (
    <View
      style={[
        card.wrap,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderLeftColor: accentColor,
        },
      ]}
    >
      {/* Header row */}
      <View style={card.header}>
        <Text style={[card.symbol, { color: colors.foreground }]}>
          {baseSymbol(orb.displayName)}
        </Text>
        <Text style={[card.display, { color: colors.mutedForeground }]}>
          {orb.displayName}
        </Text>
        <View style={card.spacer} />
        <StatusBadge status={orb.status} signal={orb.signal} colors={colors} />
      </View>

      {/* Range row */}
      <RangeRow orb={orb} colors={colors} />

      {/* Trade levels when triggered */}
      {orb.status === 'triggered' && (
        <LevelGrid orb={orb} colors={colors} />
      )}

      {/* Inactive / expired placeholder */}
      {(orb.status === 'inactive' || orb.status === 'expired') && (
        <Text style={[card.hint, { color: colors.mutedForeground }]}>
          {orb.status === 'expired'
            ? 'Session closed — resets at next RTH open'
            : 'ORB signals active 09:30–16:00 ET on trading days'}
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
    letterSpacing: 0.1,
  },
  spacer: { flex: 1 },
  hint: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    lineHeight: 16,
    marginTop: 8,
  },
});

// ─── Panel ────────────────────────────────────────────────────────────────────

interface OrbPanelProps {
  /** Pass snapshot.timestamp to trigger a refetch whenever a new snapshot arrives. */
  snapshotTimestamp?: string;
}

export default function OrbPanel({ snapshotTimestamp }: OrbPanelProps) {
  const colors = useColors();
  const [data, setData]       = useState<OrbSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetch_() {
      try {
        const res = await fetch(`${getApiBase()}/market/orb`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as OrbSnapshot;
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

  const orbs = data ? Object.values(data.markets) : [];

  return (
    <View style={[panel.wrap, { borderTopColor: colors.border }]}>
      {/* Section header */}
      <View style={panel.headerRow}>
        <Ionicons name="stats-chart-outline" size={13} color={colors.mutedForeground} />
        <Text style={[panel.title, { color: colors.mutedForeground }]}>
          OPENING RANGE BREAKOUT
        </Text>
        <Text style={[panel.sub, { color: colors.mutedForeground }]}>
          09:30–10:00 ET
        </Text>
      </View>

      {loading && !data ? (
        <ActivityIndicator size="small" color={colors.primary} style={panel.loader} />
      ) : error ? (
        <Text style={[panel.errorText, { color: colors.mutedForeground }]}>
          Unable to load ORB data
        </Text>
      ) : orbs.length === 0 ? (
        <Text style={[panel.errorText, { color: colors.mutedForeground }]}>
          No symbols tracked
        </Text>
      ) : (
        orbs.map((orb) => <OrbCard key={orb.symbol} orb={orb} />)
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
  loader: {
    marginVertical: 16,
  },
  errorText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginBottom: 12,
  },
});
