import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = '@fam/alert_confidence_threshold';
const DEFAULT_THRESHOLD = 75;

export interface AlertSettings {
  confidenceThreshold: number;
}

export function useAlertSettings() {
  const [threshold, setThresholdState] = useState<number>(DEFAULT_THRESHOLD);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((val) => {
        if (val !== null) {
          const parsed = parseInt(val, 10);
          if (!isNaN(parsed)) setThresholdState(parsed);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const setThreshold = useCallback((value: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    setThresholdState(clamped);
    AsyncStorage.setItem(STORAGE_KEY, String(clamped)).catch(() => {});
  }, []);

  return { threshold, setThreshold, loaded };
}
