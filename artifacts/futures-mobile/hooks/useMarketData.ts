import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { fetch } from 'expo/fetch';
import { getAuthHeaders as _getAuthHeadersFromStore } from '@/hooks/tokenStore';

// ─── Types (mirrored from OpenAPI spec) ─────────────────────────────────────

export interface TimeframeState {
  rvol: number;
  atr: number;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  volSpike: boolean;
  close: number;
  volume: number;
  adx: number;
  rsi: number;
  vwap: number;
  vwapStd1Up: number;
  vwapStd1Down: number;
  vwapStd2Up: number;
  vwapStd2Down: number;
  isRTH: boolean;
  vwapReversionStatus: 'inactive' | 'watching' | 'long_setup' | 'short_setup' | 'expired';
  confluenceScore: number;
  lastUpdated: string;
}

export interface TradeSetup {
  strategy: 'VWAP_REVERSION';
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  riskPts: number;
  riskDollarsPerContract: number;
  tp1: number;
  tp2: number;
}

export interface MarketState {
  symbol: string;
  lastPrice: number;
  /** Overnight (Globex) session high; null until overnight bars exist */
  onHigh?: number | null;
  /** Overnight (Globex) session low; null until overnight bars exist */
  onLow?: number | null;
  perTimeframeSetup?: Record<string, TradeSetup>;
  timeframes: Record<string, TimeframeState>;
}

export interface MarketSnapshot {
  timestamp: string;
  source: 'databento' | 'unavailable';
  markets: Record<string, MarketState>;
  message: string | null;
}

/** Emitted when a contract's overall direction changes between snapshots. */
export interface DirectionChange {
  symbol: string;
  previousDirection: 'BULL' | 'BEAR' | 'NEUTRAL';
  newDirection: 'BULL' | 'BEAR' | 'NEUTRAL';
  confidence: number;
}

// ─── Internal helpers (mirrored from ContractCard logic) ─────────────────────

const TIMEFRAMES = ['1m', '5m', '15m'] as const;

function computeOverallDirection(
  timeframes: Record<string, TimeframeState>,
): 'BULL' | 'BEAR' | 'NEUTRAL' {
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
  direction: 'BULL' | 'BEAR' | 'NEUTRAL',
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

// ─── Hook ────────────────────────────────────────────────────────────────────

function getApiBase(): string {
  if (Platform.OS === 'web') return '/api';
  const domain = process.env['EXPO_PUBLIC_DOMAIN'];
  return domain ? `https://${domain}/api` : '/api';
}

function getAuthHeaders(): Record<string, string> {
  return _getAuthHeadersFromStore();
}

export interface UseMarketDataOptions {
  /** Called (synchronously in the render cycle) each time direction changes are detected. */
  onDirectionChanges?: (changes: DirectionChange[]) => void;
  /** Minimum confidence (0–100) a change must have before it is reported. Default: 0. */
  confidenceThreshold?: number;
}

export function useMarketData(options?: UseMarketDataOptions) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const mountedRef = useRef(true);

  // Keep stable refs to the callback and threshold to avoid re-creating closures
  const prevSnapshotRef = useRef<MarketSnapshot | null>(null);
  const onDirectionChangesRef = useRef(options?.onDirectionChanges);
  const thresholdRef = useRef(options?.confidenceThreshold ?? 0);

  useEffect(() => {
    onDirectionChangesRef.current = options?.onDirectionChanges;
    thresholdRef.current = options?.confidenceThreshold ?? 0;
  });

  // Detect direction changes between two snapshots
  const detectChanges = useCallback(
    (prev: MarketSnapshot | null, next: MarketSnapshot): DirectionChange[] => {
      if (!prev) return [];
      const changes: DirectionChange[] = [];
      for (const [symbol, nextMarket] of Object.entries(next.markets)) {
        const prevMarket = prev.markets[symbol];
        if (!prevMarket) continue;
        const prevDir = computeOverallDirection(prevMarket.timeframes);
        const nextDir = computeOverallDirection(nextMarket.timeframes);
        if (prevDir === nextDir) continue;
        const confidence = Math.round(
          Math.min(Math.max(computeConfidence(nextMarket.timeframes, nextDir), 0), 100),
        );
        if (confidence < thresholdRef.current) continue;
        changes.push({ symbol, previousDirection: prevDir, newDirection: nextDir, confidence });
      }
      return changes;
    },
    [],
  );

  const applySnapshot = useCallback(
    (data: MarketSnapshot) => {
      if (!mountedRef.current) return;

      const changes = detectChanges(prevSnapshotRef.current, data);
      prevSnapshotRef.current = data;

      setSnapshot(data);
      setLastUpdated(new Date());
      setIsLoading(false);

      if (changes.length > 0) {
        onDirectionChangesRef.current?.(changes);
      }
    },
    [detectChanges],
  );

  // ── Poll fallback (used when backgrounded) ──────────────────────────────
  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBase()}/market/snapshot`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      if (!res.ok || !mountedRef.current) return;
      const data = (await res.json()) as MarketSnapshot;
      applySnapshot(data);
    } catch {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [applySnapshot]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (mountedRef.current) setIsConnected(false);

    fetchSnapshot();
    pollRef.current = setInterval(fetchSnapshot, 30_000);
  }, [fetchSnapshot]);

  // ── SSE stream (used when foregrounded) ────────────────────────────────
  // Backoff delay for reconnects — resets to 3s on a successful connection,
  // doubles on each failure up to 30s.
  const reconnectDelayRef = useRef(3_000);

  const connectSSE = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(`${getApiBase()}/market/stream`, {
        signal: controller.signal,
        credentials: 'include',
        headers: { Accept: 'text/event-stream', ...getAuthHeaders() },
      });

      if (controller.signal.aborted || !mountedRef.current) return;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('No response body');

      // Successful connection — reset backoff
      reconnectDelayRef.current = 3_000;
      if (mountedRef.current) setIsConnected(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = 'message';
      let currentData = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done || controller.signal.aborted || !mountedRef.current) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6).trim();
          } else if (line === '' && currentData) {
            if (currentEvent === 'market' || currentEvent === 'message') {
              try {
                applySnapshot(JSON.parse(currentData) as MarketSnapshot);
              } catch {
                /* ignore parse errors */
              }
            }
            currentEvent = 'message';
            currentData = '';
          }
        }
      }
    } catch {
      // Increase backoff on failure (doubles up to 30 s)
      reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30_000);
    }

    // Reconnect unless we were intentionally torn down (abort = unmount or new
    // connectSSE call). This handles both clean stream closes (done=true) and
    // errors — previously only errors triggered a reconnect, leaving the app
    // silently dark if the server closed the connection cleanly.
    if (!controller.signal.aborted && mountedRef.current) {
      if (mountedRef.current) setIsConnected(false);
      setTimeout(() => {
        if (mountedRef.current) connectSSE();
      }, reconnectDelayRef.current);
    }
  }, [applySnapshot]);

  // ── AppState lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;

    const handleAppState = (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (next === 'active' && prev !== 'active') {
        stopPolling();
        connectSSE();
      } else if (next !== 'active' && prev === 'active') {
        startPolling();
      }
    };

    const sub = AppState.addEventListener('change', handleAppState);
    connectSSE(); // start SSE immediately on mount

    return () => {
      mountedRef.current = false;
      sub.remove();
      abortRef.current?.abort();
      stopPolling();
    };
  }, [connectSSE, startPolling, stopPolling]);

  return { snapshot, isConnected, isLoading, lastUpdated };
}
