import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useMarketData, type DirectionChange, type MarketState } from '@/hooks/useMarketData';
import { useNotifications } from '@/hooks/useNotifications';
import { useAlertSettings } from '@/hooks/useAlertSettings';
import { useAuth } from '@/lib/auth';
import ContractCard from '@/components/ContractCard';
import OrbPanel from '@/components/OrbPanel';
import VwapPanel from '@/components/VwapPanel';
import IctPanel from '@/components/IctPanel';
import { getCMESession, formatCountdown } from '@/lib/session';

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function directionLabel(dir: 'BULL' | 'BEAR' | 'NEUTRAL'): string {
  return dir === 'BULL' ? '🟢 BULL' : dir === 'BEAR' ? '🔴 BEAR' : '⚪ NEUTRAL';
}

// ─── Session Clock ───────────────────────────────────────────────────────────

function SessionClock() {
  const colors = useColors();
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const session = getCMESession(new Date(tick));

  const dotColor =
    session.name === 'RTH'
      ? '#4ade80'
      : session.open
      ? '#facc15'
      : '#6b7280';

  const nameColor =
    session.name === 'RTH'
      ? '#4ade80'
      : session.open
      ? '#facc15'
      : colors.mutedForeground;

  const subtitle =
    session.name === 'RTH'
      ? 'Regular trading hours · 9:30 AM – 4:15 PM ET'
      : session.name === 'Globex'
      ? 'Electronic session · CME Equity Index Futures'
      : session.name === 'Maintenance'
      ? 'Daily maintenance break · 5:00 – 6:00 PM ET'
      : 'Weekend close · reopens Sunday 6:00 PM ET';

  return (
    <View style={[clockStyles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={clockStyles.left}>
        <View style={[clockStyles.dot, { backgroundColor: dotColor }]} />
        <View style={clockStyles.labelGroup}>
          <Text style={[clockStyles.sessionName, { color: nameColor }]}>
            {session.name.toUpperCase()}
          </Text>
          <Text style={[clockStyles.subtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>
      <View style={clockStyles.right}>
        <Ionicons name="time-outline" size={12} color={colors.mutedForeground} />
        <Text style={[clockStyles.countdown, { color: colors.mutedForeground }]}>
          {session.nextLabel}{' '}
          <Text style={[clockStyles.countdownValue, { color: colors.foreground }]}>
            in {formatCountdown(session.msUntilNext)}
          </Text>
        </Text>
      </View>
    </View>
  );
}

const clockStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    flexWrap: 'wrap',
    gap: 6,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  labelGroup: {
    flexShrink: 1,
  },
  sessionName: {
    fontSize: 11,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.9,
  },
  subtitle: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  countdown: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  countdownValue: {
    fontSize: 10,
    fontFamily: 'Inter_600SemiBold',
  },
});

// ─── Threshold Step Picker ────────────────────────────────────────────────────

const THRESHOLD_STEPS = [0, 50, 60, 70, 75, 80, 85, 90];

interface ThresholdPickerProps {
  value: number;
  onChange: (v: number) => void;
  colors: ReturnType<typeof useColors>;
}

function ThresholdPicker({ value, onChange, colors }: ThresholdPickerProps) {
  return (
    <View style={pickerStyles.row}>
      {THRESHOLD_STEPS.map((step) => {
        const active = value === step;
        return (
          <Pressable
            key={step}
            onPress={() => onChange(step)}
            style={[
              pickerStyles.chip,
              {
                backgroundColor: active ? colors.accent : colors.secondary,
                borderColor: active ? colors.accent : colors.border,
              },
            ]}
          >
            <Text
              style={[
                pickerStyles.chipLabel,
                { color: active ? '#fff' : colors.mutedForeground },
              ]}
            >
              {step === 0 ? 'Any' : `${step}%`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  chipLabel: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
});

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const listRef = useRef<FlatList<MarketState>>(null);

  // ── Alert settings ──────────────────────────────────────────────────────
  const { threshold, setThreshold } = useAlertSettings();
  const { logout } = useAuth();

  // ── Notification tap → scroll to card ──────────────────────────────────
  const handleNotificationTap = useCallback(
    (symbol: string) => {
      // Defer slightly so the list has time to render if app just cold-started
      setTimeout(() => {
        listRef.current?.scrollToIndex({
          index: 0, // will be resolved below via viewabilityConfig
          animated: true,
        });
        // Actually find the index by symbol
        if (marketsRef.current) {
          const idx = marketsRef.current.findIndex(
            (m) => m.symbol === symbol || m.symbol.startsWith(symbol.split('.')[0] ?? symbol),
          );
          if (idx >= 0) {
            listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0 });
          }
        }
      }, 300);
    },
    [],
  );

  // ── Notifications hook ──────────────────────────────────────────────────
  const { sendNotification } = useNotifications(handleNotificationTap);

  // ── Direction change handler ────────────────────────────────────────────
  const handleDirectionChanges = useCallback(
    (changes: DirectionChange[]) => {
      for (const change of changes) {
        const baseSymbol = change.symbol.split('.')[0] ?? change.symbol;
        const title = `${baseSymbol} flipped ${change.newDirection}`;
        const body = `${directionLabel(change.previousDirection)} → ${directionLabel(change.newDirection)}  ·  Confidence ${change.confidence}%`;
        void sendNotification(title, body, change.symbol);
      }
    },
    [sendNotification],
  );

  // ── Market data ─────────────────────────────────────────────────────────
  const { snapshot, isConnected, isLoading, lastUpdated } = useMarketData({
    onDirectionChanges: handleDirectionChanges,
    confidenceThreshold: threshold,
  });

  // ── Session clock ────────────────────────────────────────────────────────
  const [sessionTick, setSessionTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSessionTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const session = getCMESession(new Date(sessionTick));
  const marketClosed = !session.open;

  const markets: MarketState[] = snapshot ? Object.values(snapshot.markets) : [];

  // Keep a ref so the notification tap handler can find the right index
  const marketsRef = useRef<MarketState[]>(markets);
  marketsRef.current = markets;

  const isUnavailable = snapshot?.source === 'unavailable';
  const statusMessage = isUnavailable
    ? (snapshot?.message ?? 'Market data unavailable')
    : !isConnected
    ? 'Streaming paused — polling every 30 s'
    : null;

  // ── Styles ──────────────────────────────────────────────────────────────
  const headerPaddingTop = Platform.OS === 'web' ? 67 : insets.top + 10;
  const listPaddingBottom = Platform.OS === 'web' ? 34 : insets.bottom + 12;
  const modalPaddingBottom = Platform.OS === 'web' ? 24 : insets.bottom + 16;

  return (
    <View style={[s.root, { backgroundColor: colors.background }]}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      {/* ── Sticky header ── */}
      <View
        style={[
          s.header,
          {
            paddingTop: headerPaddingTop,
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View style={s.headerInner}>
          {/* Brand */}
          <View>
            <Text style={[s.brandName, { color: colors.primary }]}>Market Posture</Text>
          </View>

          <View style={s.headerRight}>
            {/* Alerts settings button */}
            <Pressable
              onPress={() => setSettingsOpen(true)}
              style={[s.settingsBtn, { borderColor: colors.border }]}
              hitSlop={8}
            >
              <Ionicons name="notifications-outline" size={14} color={colors.accent} />
              <Text style={[s.settingsBtnLabel, { color: colors.accent }]}>
                {threshold === 0 ? 'All' : `≥${threshold}%`}
              </Text>
            </Pressable>

            {/* Sign out */}
            <Pressable
              onPress={() => void logout()}
              style={[s.settingsBtn, { borderColor: colors.border }]}
              hitSlop={8}
            >
              <Ionicons name="log-out-outline" size={14} color={colors.mutedForeground} />
            </Pressable>

            {/* Live / polling indicator */}
            <View style={s.statusGroup}>
              <View
                style={[
                  s.statusDot,
                  {
                    backgroundColor: isConnected
                      ? colors.success
                      : colors.mutedForeground,
                  },
                ]}
              />
              <Text style={[s.statusText, { color: colors.mutedForeground }]}>
                {isConnected ? 'LIVE' : 'POLLING'}
              </Text>
            </View>
          </View>
        </View>

        {/* Timestamp */}
        {lastUpdated ? (
          <Text style={[s.timestamp, { color: colors.mutedForeground }]}>
            {formatTime(lastUpdated)}
          </Text>
        ) : null}
      </View>

      {/* ── Offline / unavailable banner ── */}
      {statusMessage ? (
        <View
          style={[
            s.banner,
            { backgroundColor: colors.secondary, borderBottomColor: colors.border },
          ]}
        >
          <Ionicons
            name={isUnavailable ? 'warning-outline' : 'cloud-offline-outline'}
            size={13}
            color={colors.mutedForeground}
          />
          <Text style={[s.bannerText, { color: colors.mutedForeground }]}>
            {statusMessage}
          </Text>
        </View>
      ) : null}

      {/* ── Contract list ── */}
      <FlatList<MarketState>
        ref={listRef}
        data={markets}
        keyExtractor={(item) => item.symbol}
        renderItem={({ item }) => <ContractCard market={item} marketClosed={marketClosed} />}
        contentContainerStyle={[
          s.listContent,
          { paddingBottom: listPaddingBottom },
        ]}
        scrollEnabled={markets.length > 0}
        showsVerticalScrollIndicator={false}
        onScrollToIndexFailed={() => {
          // Silently swallow — list may not be fully laid out yet
        }}
        refreshControl={
          <RefreshControl
            refreshing={isLoading && snapshot == null}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListHeaderComponent={<SessionClock />}
        ListFooterComponent={
          <>
            <OrbPanel snapshotTimestamp={lastUpdated?.toISOString() ?? undefined} />
            <VwapPanel snapshotTimestamp={lastUpdated?.toISOString() ?? undefined} />
            <IctPanel snapshotTimestamp={lastUpdated?.toISOString() ?? undefined} />
          </>
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <Ionicons
              name={isLoading ? 'hourglass-outline' : 'analytics-outline'}
              size={36}
              color={colors.mutedForeground}
            />
            <Text style={[s.emptyTitle, { color: colors.foreground }]}>
              {isLoading ? 'Connecting…' : 'No contracts'}
            </Text>
            <Text style={[s.emptyBody, { color: colors.mutedForeground }]}>
              {isLoading
                ? 'Establishing live feed with the market engine'
                : 'No market data is currently available from the engine'}
            </Text>
          </View>
        }
      />

      {/* ── Alert settings modal ── */}
      <Modal
        visible={settingsOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setSettingsOpen(false)}
      >
        <Pressable style={s.modalBackdrop} onPress={() => setSettingsOpen(false)} />
        <View
          style={[
            s.modalSheet,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              paddingBottom: modalPaddingBottom,
            },
          ]}
        >
          {/* Handle */}
          <View style={[s.modalHandle, { backgroundColor: colors.border }]} />

          <View style={s.modalHeader}>
            <Ionicons name="notifications-outline" size={18} color={colors.primary} />
            <Text style={[s.modalTitle, { color: colors.foreground }]}>
              Alert Settings
            </Text>
          </View>

          <Text style={[s.modalDesc, { color: colors.mutedForeground }]}>
            Notify me when a contract flips direction — only if confidence is at or above:
          </Text>

          <ThresholdPicker
            value={threshold}
            onChange={setThreshold}
            colors={colors}
          />

          <Text style={[s.modalHint, { color: colors.mutedForeground }]}>
            {threshold === 0
              ? 'You will receive alerts for every direction flip, regardless of confidence.'
              : `You will only receive alerts when confidence reaches ${threshold}% or higher.`}
          </Text>

          <Pressable
            onPress={() => setSettingsOpen(false)}
            style={[s.modalDone, { backgroundColor: colors.accent }]}
          >
            <Text style={s.modalDoneText}>Done</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

// ─── Static styles ───────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 2,
  },
  brandName: {
    fontSize: 26,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.8,
  },
  brandSub: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.2,
    marginTop: -2,
  },
  settingsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  settingsBtnLabel: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 0.2,
  },
  statusGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statusText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
  },
  timestamp: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.1,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    flex: 1,
  },
  listContent: {
    padding: 12,
    paddingTop: 14,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: 'Inter_600SemiBold',
    marginTop: 8,
  },
  emptyBody: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 18,
  },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.3,
  },
  modalDesc: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 19,
  },
  modalHint: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    lineHeight: 17,
    marginTop: 14,
    fontStyle: 'italic',
  },
  modalDone: {
    marginTop: 20,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  modalDoneText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    color: '#fff',
  },
});
