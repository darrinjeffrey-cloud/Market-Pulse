import React, { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import LoginScreen from '@/components/LoginScreen';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { setBaseUrl } from '@workspace/api-client-react';
import { loadToken } from '@/hooks/tokenStore';

// Configure the API base URL — Expo runs outside the web proxy,
// so it needs an absolute HTTPS URL to reach the shared API server.
if (process.env['EXPO_PUBLIC_DOMAIN']) {
  setBaseUrl(`https://${process.env['EXPO_PUBLIC_DOMAIN']}`);
}

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  // null = still loading from SecureStore; false = need login; true = authed
  const [authState, setAuthState] = useState<null | boolean>(null);

  // Load persisted token once on mount, before hiding the splash screen
  useEffect(() => {
    loadToken().then((t) => {
      setAuthState(!!t);
    });
  }, []);

  useEffect(() => {
    if ((fontsLoaded || fontError) && authState !== null) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError, authState]);

  if (!fontsLoaded && !fontError) return null;
  if (authState === null) return null; // still loading token from SecureStore

  if (!authState) {
    return (
      <SafeAreaProvider>
        <LoginScreen onSuccess={() => setAuthState(true)} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
