/**
 * OvernightPanel.tsx — Overnight High/Low reference level panel for mobile.
 *
 * Shows the Globex overnight session high and low (prev RTH close → current
 * RTH open). During RTH these become key support/resistance reference levels.
 *
 * Fetches /api/market/overnight on mount and every 30 s.
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

type OvernightStatus = 'forming' | 'reference' | 'expired';

type OvernightContext =
  | 'above_both'
  | 'below_both'
  | 'near_high'
  | 'near_low'
  | 'inside'
  | null;

interface OvernightState {
  symbol:        string;
  displayName:   string;
  status:        OvernightStatus;
  overnightHigh: number | null;
  overnightLow:  number | null;
  rangeTicks:    number | null;
  barsInSession: number;
  currentPrice:  number | null;
  context:       OvernightContext;
  distToHigh:    number | null;
  distToLow:     number | null;
  lastUpdated:   string;
}

interface OvernightSnapshot {
  timestamp: string;
  markets:   Record<string, OvernightState>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

function fmtDist(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function baseSymbol(s: string): string {
  return s.split('.')[0] ?? s;
}

const DISPLAY_ORDER = ['ES', 'NQ', 'MES', 'MNQ'];
function sortKey(displayName: string): number {
  const root = displayName.replace('.c.0', '');
  const idx  = DISPLAY_ORDER.indexOf(root);
  return idx < 0 ? 99 : idx;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, colors }: {
  status: OvernightStatus;
  colors: ReturnType<typeof useColors>;
}) {
  let label: string;
  let bg: string;
  let fg: string;

  if (status === 'forming') {
    label = '● FORMING';
    bg    = colors.primary + '22';
    fg    = colors.primary;
  } else if (status === 'reference') {
    label = 'REFERENCE';
    bg    = colors.secondary;
    fg    = colors.mutedForeground;
  } else {
    label = 'OFF';
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

// ─── Context badge ────────────────────────────────────────────────────────────

function ContextBadge({ context, colors }: {
  context: OvernightContext;
  colors:  ReturnType<typeof useColors>;
}) {
  if (!context) return null;

  type Cfg = { label: string; color: string; icon: string };
  const configs: Record<NonNullable<OvernightContext>, Cfg> = {
    above_both: { label: 'Above O/N High',  color: colors.success,     icon: 'arrow-up' },
    below_both: { label: 'Below O/N Low',   color: colors.destructive, icon: 'arrow-down' },
    near_high:  { label: 'Near O/N High',   color: colors.success,     icon: 'arrow-up-circle' },
    near_low:   { label: 'Near O/N Low',    color: colors.destructive, icon: 'arrow-down-circle' },
    inside:     { label: 'Inside Range',    color: colors.mutedForeground, icon: 'remove' },
  };

  const cfg = configs[context];
  return (
    <View style={[ctx.wrap, { backgroundColor: cfg.color + '18', borderColor: cfg.color + '44' }]}>
      <Ionicons name={cfg.icon as any} size={11} color={cfg.color} />
      <Text style={[ctx.label, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

const ctx = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.6,
  },
});

// ─── Per-symbol card ──────────────────────────────────────────────────────────

function OvernightCard({ state, colors }: {
  state:  OvernightState;
  colors: ReturnType<typeof useColors>;
}) {
  const sym       = baseSymbol(state.displayName);
  const isForming = state.status === 'forming';
  const isRef     = state.status === 'reference';
  const hasLevels = state.overnightHigh !== null && state.overnightLow !== null;

  const isAbove = state.context === 'above_both';
  const isBelow = state.context === 'below_both';

  const borderColor =
    isAbove  ? colors.success + '66' :
    isBelow  ? colors.destructive + '66' :
    isForming ? colors.primary + '44' :
    colors.border;

  const bgColor =
    isAbove  ? colors.success + '0A' :
    isBelow  ? colors.destructive + '0A' :
    colors.card;

  return (
    <View style={[card.wrap, { backgroundColor: bgColor, borderColor }]}>
      {/* Header */}
      <View style={card.header}>
        <Text style={[card.sym, { color: colors.foreground }]}>{sym}</Text>
        <StatusBadge status={state.status} colors={colors} />
      </View>

      {/* Overnight range */}
      {hasLevels ? (
        <View style={[card.rangeBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Text style={[card.rangeTitle, { color: colors.mutedForeground }]}>
            O/N RANGE{isForming && state.barsInSession > 0 ? `  ·  ${state.barsInSession} bars` : ''}
          </Text>
          <View style={card.rangeRow}>
            {/* High */}
            <View>
              <Text style={[card.bandLabel, { color: colors.mutedForeground }]}>High</Text>
              <Text style={[card.bandValue, { color: colors.success }]}>
                {fmtPrice(state.overnightHigh)}
              </Text>
            </View>
            {/* Range ticks */}
            <View style={card.rangeCenter}>
              <Text style={[card.pipeChar, { color: colors.mutedForeground + '60' }]}>│</Text>
              <Text style={[card.rangeTicks, { color: colors.mutedForeground }]}>
                {state.rangeTicks != null ? `${state.rangeTicks}T` : '—'}
              </Text>
              <Text style={[card.pipeChar, { color: colors.mutedForeground + '60' }]}>│</Text>
            </View>
            {/* Low */}
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[card.bandLabel, { color: colors.mutedForeground }]}>Low</Text>
              <Text style={[card.bandValue, { color: colors.destructive }]}>
                {fmtPrice(state.overnightLow)}
              </Text>
            </View>
          </View>
        </View>
      ) : isForming ? (
        <View style={[card.collectingBox, { backgroundColor: colors.primary + '0F', borderColor: colors.primary + '33' }]}>
          <Text style={[card.collectingText, { color: colors.primary }]}>
            Collecting overnight bars…
          </Text>
          <Text style={[card.collectingSub, { color: colors.mutedForeground }]}>
            Levels lock at RTH open 09:30 ET
          </Text>
        </View>
      ) : null}

      {/* Distance to levels (RTH only) */}
      {isRef && hasLevels && state.distToHigh !== null && state.distToLow !== null && (
        <View style={dist.wrap}>
          <View style={dist.row}>
            <Text style={[dist.label, { color: colors.mutedForeground }]}>Dist to High</Text>
            <Text style={[dist.value, { color: state.distToHigh >= 0 ? colors.success : colors.destructive }]}>
              {fmtDist(-state.distToHigh)} pts
            </Text>
          </View>
          <View style={dist.row}>
            <Text style={[dist.label, { color: colors.mutedForeground }]}>Dist to Low</Text>
            <Text style={[dist.value, { color: state.distToLow >= 0 ? colors.success : colors.destructive }]}>
              {fmtDist(state.distToLow)} pts
            </Text>
          </View>
        </View>
      )}

      {/* Context badge */}
      {isRef && <ContextBadge context={state.context} colors={colors} />}
    </View>
  );
}

const card = StyleSheet.create({
  wrap: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sym: {
    fontSize: 14,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.3,
  },
  rangeBox: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginBottom: 4,
  },
  rangeTitle: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  rangeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rangeCenter: {
    alignItems: 'center',
  },
  pipeChar: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  rangeTicks: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.2,
  },
  bandLabel: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    marginBottom: 3,
  },
  bandValue: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.3,
  },
  collectingBox: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    alignItems: 'center',
    marginBottom: 4,
  },
  collectingText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
  },
  collectingSub: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    marginTop: 3,
  },
});

const dist = StyleSheet.create({
  wrap: {
    marginTop: 6,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  value: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.2,
  },
});

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function OvernightPanel({
  snapshotTimestamp,
}: {
  snapshotTimestamp?: string;
}) {
  const colors = useColors();
  const [data, setData] = useState<OvernightSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const base    = getApiBase();
      const headers = await getAuthHeaders();
      const res     = await fetch(`${base}/api/market/overnight`, {
        headers,
        credentials: 'include',
      });
      if (!res.ok) return;
      const json = await res.json() as OvernightSnapshot;
      setData(json);
    } catch {
      // swallow network errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [snapshotTimestamp]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading && !data) {
    return (
      <View style={[panel.loadingWrap]}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

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
    'Session Ended';

  const phaseColor =
    phase === 'forming' ? colors.primary :
    colors.mutedForeground;

  return (
    <View style={panel.wrap}>
      {/* Section header */}
      <View style={panel.header}>
        <View style={panel.headerLeft}>
          <Ionicons name="moon-outline" size={13} color={colors.mutedForeground} />
          <Text style={[panel.title, { color: colors.mutedForeground }]}>
            Overnight Levels
          </Text>
        </View>
        <View style={[panel.phasePill, { borderColor: phaseColor + '55', backgroundColor: phaseColor + '15' }]}>
          {phase === 'forming' && (
            <View style={[panel.phaseDot, { backgroundColor: phaseColor }]} />
          )}
          <Text style={[panel.phaseLabel, { color: phaseColor }]}>{phaseLabel}</Text>
        </View>
      </View>

      <Text style={[panel.subtitle, { color: colors.mutedForeground + '80' }]}>
        Globex 16:00–09:30 ET · key S/R for RTH
      </Text>

      {offSession ? (
        <View style={[panel.offSession, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Ionicons name="moon" size={18} color={colors.mutedForeground} style={{ opacity: 0.4 }} />
          <Text style={[panel.offText, { color: colors.mutedForeground }]}>
            RTH session ended — overnight window opens at 16:00 ET
          </Text>
        </View>
      ) : (
        states.map((state) => (
          <OvernightCard key={state.symbol} state={state} colors={colors} />
        ))
      )}

      <Text style={[panel.footnote, { color: colors.mutedForeground + '60' }]}>
        O/N H/L = max/min of Globex bars from prior RTH close to RTH open
      </Text>
    </View>
  );
}

const panel = StyleSheet.create({
  wrap: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  loadingWrap: {
    marginTop: 24,
    alignItems: 'center',
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontSize: 11,
    fontFamily: 'Inter_800ExtraBold',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  subtitle: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginBottom: 12,
  },
  phasePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 5,
    borderWidth: 1,
  },
  phaseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  phaseLabel: {
    fontSize: 9,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  offSession: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 16,
    marginBottom: 8,
  },
  offText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  footnote: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
    marginBottom: 8,
  },
});
