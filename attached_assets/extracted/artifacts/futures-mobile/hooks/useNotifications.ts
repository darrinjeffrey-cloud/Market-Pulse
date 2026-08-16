import { useCallback, useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Configure how notifications are presented when the app is foregrounded.
// Only set on native — the handler throws on web.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export interface NotificationData {
  symbol: string;
}

export type NotificationResponseHandler = (symbol: string) => void;

export function useNotifications(onNotificationTap?: NotificationResponseHandler) {
  const permissionGrantedRef = useRef(false);
  const listenerRef = useRef<Notifications.EventSubscription | null>(null);

  // Request permissions and set up Android channel on mount.
  // All calls are guarded — expo-notifications has no web support for most APIs.
  useEffect(() => {
    if (Platform.OS === 'web') return;

    (async () => {
      // Android: create a high-importance notification channel
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('market-alerts', {
          name: 'Market Alerts',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 150, 100, 150],
          lightColor: '#6366f1',
          sound: 'default',
        });
      }

      const result = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: true,
        },
      });
      // PermissionResponse.granted is present at runtime; cast to satisfy older d.ts
      permissionGrantedRef.current =
        (result as unknown as { granted: boolean }).granted ?? false;

      // Handle cold-start: app launched by tapping a notification
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (response) {
          const data = response.notification.request.content.data as unknown as
            | NotificationData
            | undefined;
          if (data?.symbol) onNotificationTap?.(data.symbol);
        }
      } catch {
        // Not available on some environments — ignore
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update the foreground tap listener whenever the callback changes
  useEffect(() => {
    listenerRef.current?.remove();
    if (!onNotificationTap || Platform.OS === 'web') return;

    listenerRef.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as unknown as
          | NotificationData
          | undefined;
        if (data?.symbol) onNotificationTap(data.symbol);
      },
    );

    return () => {
      listenerRef.current?.remove();
    };
  }, [onNotificationTap]);

  const sendNotification = useCallback(
    async (title: string, body: string, symbol: string) => {
      if (Platform.OS === 'web' || !permissionGrantedRef.current) return;
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title,
            body,
            data: { symbol } satisfies NotificationData,
            sound: 'default',
          },
          trigger: null, // fire immediately
        });
      } catch {
        // Notifications unavailable in this environment — silently ignore
      }
    },
    [],
  );

  return { sendNotification };
}
