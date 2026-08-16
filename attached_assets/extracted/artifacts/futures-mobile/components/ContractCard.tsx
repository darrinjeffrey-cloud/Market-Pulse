import React, { memo, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { MarketState, TimeframeState, TradeSetup } from '@/hooks/useMarketData';

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEFRAMES = ['1m', '5m', '15m'] as const;

const SYMBOL_LABELS: Record<string, string> = {
  ES: 'E-mini S&P 500',
  NQ: 'E-mini NASDAQ-100',
  RTY: 'E-mini Russell 2000',
  YM: 'E-mini Dow Jones',
  MES: 'Micro E-mini S&P 500',
  MNQ: 'Micro E-mini NASDAQ-100',
  GC: 'Gold Futures',
  CL: 'Crude Oil Futures',
  ZB: '30Y Treasury Bond',
  ZN: '10Y Treasury Note',
};

// ─── Types ───────────────────────────────────────────────────────────────────

type Direction = 'BULL' | 'BEAR' | 'NEUTRAL';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeOverallDirection(timeframes: Record<string, TimeframeState>): Direction {
  const states = TIMEFRAMES.map((tf) => timeframes[tf]).filter(Boolean);
  if (!states.length) return 'NEUTRAL';
  const bull = states.filter((s) => s.direction === 'BULL').length;
  const bear = states.filter((s) => s.direction === 'BEAR').length;
  if (bull > bear && bull >= 2) return 'BULL';
  if (bear > bull && bear >= 2) return 'BEAR';
  return 'NEUTRAL';
}

function computeConfidence(
  timeframes: Record<string, TimeframeState>,
  direction: Direction,
): number {
  const states = TIMEFRAMES.map((tf) => timeframes[tf]).filter(Boolean);
  if (!states.length) return 0;
  const avgConfluence = states.reduce((s, tf) => s + tf.confluenceScore, 0) / states.length;
  const avgAdx = states.reduce((s, tf) => s + Math.min(tf.adx, 50), 0) / states.length;
  const avgRsiDist = states.reduce((s, tf) => s + Math.abs(tf.rsi - 50), 0) / states.length;
  const raw =
    (avgConfluence / 5) * 100 * 0.6 +
    (avgAdx / 50) * 100 * 0.2 +
    (avgRsiDist / 50) * 100 * 0.2;
  return direction === 'NEUTRAL' ? Math.min(raw, 60) : raw;
}

/** Per-timeframe confidence, mirrors the web dashboard's computeConfidencePct. */
function computeConfidencePctForTf(tfState: TimeframeState): number {
  const score = tfState.confluenceScore ?? 0;
  const adx   = tfState.adx ?? 0;
  const rsi   = tfState.rsi ?? 50;
  const base      = (score / 5) * 60;
  const adxBonus  = (Math.min(adx, 60) / 60) * 20;
  const rsiBonus  = (Math.min(Math.abs(rsi - 50), 40) / 40) * 20;
  const raw = Math.min(100, Math.round(base + adxBonus + rsiBonus));
  return tfState.direction === 'NEUTRAL' ? Math.min(raw, 60) : raw;
}

/** Returns the timeframe key with the highest per-timeframe confidence, or null. */
function getBestTimeframe(timeframes: Record<string, TimeframeState>): string | null {
  let bestTf: string | null = null;
  let bestPct = -1;
  for (const [tfKey, tfState] of Object.entries(timeframes)) {
    if (!tfState) continue;
    const pct = computeConfidencePctForTf(tfState);
    if (pct > bestPct) {
      bestPct = pct;
      bestTf = tfKey;
    }
  }
  return bestTf;
}

function getBestSetup(market: MarketState): TradeSetup | null {
  if (!market.perTimeframeSetup) return null;
  return (
    market.perTimeframeSetup['15m'] ??
    market.perTimeframeSetup['5m'] ??
    market.perTimeframeSetup['1m'] ??
    null
  );
}

function fmtPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

// ─── Staleness helpers ───────────────────────────────────────────────────────

/** Maximum age (ms) before a timeframe's data is considered stale. Mirrors the web dashboard. */
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

function formatTimestamp(value?: string | null): string {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatStaleAge(tfState: TimeframeState, now: number): string {
  const lu = (tfState as unknown as { lastUpdated?: string }).lastUpdated;
  if (!lu) return 'stale';
  const ageMs = now - new Date(lu).getTime();
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 1) return '<1m ago';
  if (ageMin < 60) return `${ageMin}m ago`;
  return `${Math.floor(ageMin / 60)}h ago`;
}

// ─── Direction Badge ─────────────────────────────────────────────────────────

interface DirectionBadgeProps {
  direction: Direction;
  bullColor: string;
  bearColor: string;
  mutedFg: string;
  cardBg: string;
  border: string;
}

function DirectionBadge({ direction, bullColor, bearColor, mutedFg, cardBg, border }: DirectionBadgeProps) {
  const bg =
    direction === 'BULL' ? bullColor : direction === 'BEAR' ? bearColor : 'transparent';
  const fg =
    direction === 'BULL' || direction === 'BEAR' ? cardBg : mutedFg;
  const iconName =
    direction === 'BULL' ? 'trending-up' : direction === 'BEAR' ? 'trending-down' : 'remove';

  return (
    <View
      style={[
        badgeStyles.badge,
        {
          backgroundColor: bg,
          borderColor: border,
          borderWidth: direction === 'NEUTRAL' ? 1 : 0,
        },
      ]}
    >
      <Ionicons name={iconName} size={11} color={fg} />
      <Text style={[badgeStyles.label, { color: fg }]}>{direction}</Text>
    </View>
  );
}

const badgeStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
  },
  label: {
    fontSize: 10,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
});

// ─── Timeframe Chip ──────────────────────────────────────────────────────────

interface TimeframeChipProps {
  label: string;
  direction: Direction;
  bullColor: string;
  bearColor: string;
  mutedFg: string;
  secondary: string;
  border: string;
}

function TimeframeChip({ label, direction, bullColor, bearColor, mutedFg, secondary, border }: TimeframeChipProps) {
  const iconName =
    direction === 'BULL' ? 'arrow-up' : direction === 'BEAR' ? 'arrow-down' : 'remove';
  const iconColor =
    direction === 'BULL' ? bullColor : direction === 'BEAR' ? bearColor : mutedFg;

  return (
    <View style={[chipStyles.chip, { backgroundColor: secondary, borderColor: border }]}>
      <Text style={[chipStyles.label, { color: mutedFg }]}>{label}</Text>
      <Ionicons name={iconName} size={10} color={iconColor} />
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 5,
    borderWidth: 1,
  },
  label: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 0.2,
  },
});

// ─── Trade Level Grid ────────────────────────────────────────────────────────

interface TradeLevelGridProps {
  setup: TradeSetup;
  mutedFg: string;
  foreground: string;
  secondary: string;
  border: string;
  successColor: string;
  destructiveColor: string;
}

function TradeLevelGrid({
  setup,
  mutedFg,
  foreground,
  secondary,
  border,
  successColor,
  destructiveColor,
}: TradeLevelGridProps) {
  const cells = [
    { label: 'ENTRY', value: fmtPrice(setup.entry), color: foreground },
    { label: 'STOP', value: fmtPrice(setup.stopLoss), color: destructiveColor },
    { label: 'TP1', value: fmtPrice(setup.tp1), color: successColor },
    { label: 'TP2', value: fmtPrice(setup.tp2), color: successColor },
  ] as const;

  return (
    <View style={[gridStyles.container, { backgroundColor: secondary, borderColor: border }]}>
      {cells.map((cell, idx) => (
        <View
          key={cell.label}
          style={[
            gridStyles.cell,
            idx % 2 === 0
              ? { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: border }
              : {},
            idx < 2
              ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border }
              : {},
          ]}
        >
          <Text style={[gridStyles.cellLabel, { color: mutedFg }]}>{cell.label}</Text>
          <Text style={[gridStyles.cellValue, { color: cell.color }]}>{cell.value}</Text>
        </View>
      ))}
    </View>
  );
}

const gridStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    marginTop: 12,
  },
  cell: {
    width: '50%',
    padding: 10,
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

// ─── Contract Card ───────────────────────────────────────────────────────────

interface ContractCardProps {
  market: MarketState;
  marketClosed?: boolean;
}

function ContractCard({ market, marketClosed = false }: ContractCardProps) {
  const colors = useColors();

  // Ticks every 30 s so staleness warnings update without manual refresh
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const direction = computeOverallDirection(market.timeframes);
  const confidence = computeConfidence(market.timeframes, direction);
  const setup = getBestSetup(market);
  // Strip roll suffix (e.g. "ES.c.0" → "ES", "NQ.v.0" → "NQ")
  const baseSymbol = market.symbol.split('.')[0] ?? market.symbol;
  const symbolLabel = SYMBOL_LABELS[baseSymbol] ?? 'Futures Contract';

  const accentColor = marketClosed
    ? colors.border
    : direction === 'BULL'
    ? colors.success
    : direction === 'BEAR'
    ? colors.destructive
    : colors.border;

  const confidenceColor = marketClosed
    ? colors.mutedForeground
    : confidence >= 70
    ? colors.success
    : confidence >= 50
    ? colors.primary
    : colors.mutedForeground;

  // Aggregate indicator averages across timeframes
  const tfStates = TIMEFRAMES.map((tf) => market.timeframes[tf]).filter(Boolean);
  const avgAdx = tfStates.length
    ? tfStates.reduce((s, tf) => s + tf.adx, 0) / tfStates.length
    : 0;
  const avgRsi = tfStates.length
    ? tfStates.reduce((s, tf) => s + tf.rsi, 0) / tfStates.length
    : 0;
  const avgRvol = tfStates.length
    ? tfStates.reduce((s, tf) => s + tf.rvol, 0) / tfStates.length
    : 0;

  const adxLabel =
    avgAdx >= 40 ? 'strong' : avgAdx >= 20 ? 'trending' : 'ranging';

  const rawConfidencePct = Math.round(Math.min(Math.max(confidence, 0), 100));
  const confidencePct = marketClosed ? 0 : rawConfidencePct;
  const drivingTf = marketClosed ? null : getBestTimeframe(market.timeframes);

  return (
    <View
      style={[
        cardStyles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderLeftColor: accentColor,
        },
      ]}
    >
      {/* ── Header: symbol / direction / price ── */}
      <View style={cardStyles.headerRow}>
        <View style={cardStyles.symbolGroup}>
          <Text style={[cardStyles.symbol, { color: marketClosed ? colors.mutedForeground : colors.foreground }]}>
            {market.symbol}
          </Text>
          {marketClosed ? (
            <View style={[cardStyles.closedBadge, { borderColor: colors.border, backgroundColor: colors.muted }]}>
              <Text style={[cardStyles.closedBadgeText, { color: colors.mutedForeground }]}>CLOSED</Text>
            </View>
          ) : (
            <DirectionBadge
              direction={direction}
              bullColor={colors.success}
              bearColor={colors.destructive}
              mutedFg={colors.mutedForeground}
              cardBg={colors.card}
              border={colors.border}
            />
          )}
        </View>

        <View style={cardStyles.priceGroup}>
          <Text style={[cardStyles.price, { color: marketClosed ? colors.mutedForeground : colors.foreground }]}>
            {marketClosed ? '—' : fmtPrice(market.lastPrice)}
          </Text>
          <Text style={[cardStyles.priceLabel, { color: colors.mutedForeground }]}>
            last
          </Text>
        </View>
      </View>

      <Text style={[cardStyles.symbolLabel, { color: colors.mutedForeground }]}>
        {symbolLabel}
      </Text>

      {/* ── Confidence bar ── */}
      <View style={cardStyles.confidenceRow}>
        <View style={[cardStyles.confidenceTrack, { backgroundColor: colors.secondary }]}>
          <View
            style={[
              cardStyles.confidenceFill,
              {
                width: `${confidencePct}%`,
                backgroundColor: confidenceColor,
              },
            ]}
          />
        </View>
        <View style={cardStyles.confidencePctGroup}>
          <Text style={[cardStyles.confidencePct, { color: confidenceColor }]}>
            {marketClosed ? '—' : `${confidencePct}%`}
          </Text>
          {drivingTf != null && (
            <Text style={[cardStyles.confidenceTfLabel, { color: colors.mutedForeground }]}>
              {drivingTf}
            </Text>
          )}
        </View>
      </View>

      {/* ── Divider ── */}
      <View style={[cardStyles.divider, { backgroundColor: colors.border }]} />

      {/* ── Timeframe chips + trend label ── */}
      <View style={cardStyles.chipRow}>
        {TIMEFRAMES.map((tf) => {
          const tfState = market.timeframes[tf];
          return (
            <TimeframeChip
              key={tf}
              label={tf}
              direction={tfState?.direction ?? 'NEUTRAL'}
              bullColor={colors.success}
              bearColor={colors.destructive}
              mutedFg={colors.mutedForeground}
              secondary={colors.secondary}
              border={colors.border}
            />
          );
        })}
        <View style={cardStyles.chipSpacer} />
        <View
          style={[
            cardStyles.adxTag,
            { borderColor: colors.border, backgroundColor: colors.muted },
          ]}
        >
          <Text style={[cardStyles.adxTagText, { color: colors.mutedForeground }]}>
            {adxLabel}
          </Text>
        </View>
      </View>

      {/* ── Per-timeframe feed stale warnings ── */}
      {TIMEFRAMES.map((tf) => {
        const tfState = market.timeframes[tf];
        if (!tfState || !isTimeframeStale(tfState, tf, now)) return null;
        const lu = (tfState as unknown as { lastUpdated?: string }).lastUpdated;
        return (
          <View
            key={`stale-${tf}`}
            style={staleStyles.row}
          >
            <Ionicons name="warning-outline" size={11} color="#f59e0b" style={staleStyles.icon} />
            <Text style={staleStyles.text}>
              {tf} feed stale · last seen {formatTimestamp(lu)} · {formatStaleAge(tfState, now)}
            </Text>
          </View>
        );
      })}

      {/* ── Key indicators ── */}
      <View style={cardStyles.indicatorRow}>
        <View style={cardStyles.indicator}>
          <Text style={[cardStyles.indLabel, { color: colors.mutedForeground }]}>ADX</Text>
          <Text
            style={[
              cardStyles.indValue,
              {
                color: marketClosed
                  ? colors.mutedForeground
                  : avgAdx >= 40
                  ? colors.primary
                  : avgAdx >= 20
                  ? colors.accent
                  : colors.mutedForeground,
              },
            ]}
          >
            {marketClosed ? '—' : fmtNum(avgAdx, 0)}
          </Text>
        </View>

        <View style={[cardStyles.indSep, { backgroundColor: colors.border }]} />

        <View style={cardStyles.indicator}>
          <Text style={[cardStyles.indLabel, { color: colors.mutedForeground }]}>RSI</Text>
          <Text
            style={[
              cardStyles.indValue,
              {
                color: marketClosed
                  ? colors.mutedForeground
                  : avgRsi > 70 || avgRsi < 30
                  ? colors.destructive
                  : avgRsi > 55
                  ? colors.success
                  : avgRsi < 45
                  ? colors.destructive
                  : colors.foreground,
              },
            ]}
          >
            {marketClosed ? '—' : fmtNum(avgRsi, 1)}
          </Text>
        </View>

        <View style={[cardStyles.indSep, { backgroundColor: colors.border }]} />

        <View style={cardStyles.indicator}>
          <Text style={[cardStyles.indLabel, { color: colors.mutedForeground }]}>rVOL</Text>
          <Text
            style={[
              cardStyles.indValue,
              {
                color: marketClosed
                  ? colors.mutedForeground
                  : avgRvol >= 1.5
                  ? colors.primary
                  : avgRvol >= 1.0
                  ? colors.foreground
                  : colors.mutedForeground,
              },
            ]}
          >
            {marketClosed ? '—' : `${fmtNum(avgRvol, 2)}×`}
          </Text>
        </View>
      </View>

      {/* ── Market closed notice ── */}
      {marketClosed && (
        <View style={[cardStyles.closedNotice, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Text style={[cardStyles.closedNoticeText, { color: colors.mutedForeground }]}>
            Market closed · values resume at next session open
          </Text>
        </View>
      )}

      {/* ── Trade setup (best available timeframe) ── */}
      {setup != null && !marketClosed && (
        <TradeLevelGrid
          setup={setup}
          mutedFg={colors.mutedForeground}
          foreground={colors.foreground}
          secondary={colors.secondary}
          border={colors.border}
          successColor={colors.success}
          destructiveColor={colors.destructive}
        />
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 14,
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  symbolGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  symbol: {
    fontSize: 22,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
  },
  symbolLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    marginBottom: 10,
  },
  priceGroup: {
    alignItems: 'flex-end',
  },
  price: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.5,
  },
  priceLabel: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 1,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  confidenceTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  confidenceFill: {
    height: '100%',
    borderRadius: 2,
  },
  confidencePctGroup: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  confidencePct: {
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
    textAlign: 'right',
  },
  confidenceTfLabel: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    opacity: 0.55,
    letterSpacing: 0.3,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  chipSpacer: {
    flex: 1,
  },
  adxTag: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  adxTagText: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 0.3,
  },
  indicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  indicator: {
    alignItems: 'center',
  },
  indLabel: {
    fontSize: 9,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  indValue: {
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.3,
  },
  indSep: {
    width: 1,
    height: 24,
    marginHorizontal: 2,
  },
  closedBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
  },
  closedBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
  },
  closedNotice: {
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center',
  },
  closedNoticeText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.2,
  },
});

const staleStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.30)',
    backgroundColor: 'rgba(245,158,11,0.08)',
    gap: 5,
  },
  icon: {
    flexShrink: 0,
  },
  text: {
    fontSize: 10,
    fontFamily: 'Inter_500Medium',
    color: 'rgba(251,191,36,0.90)',
    flexShrink: 1,
  },
});

export default memo(ContractCard);
