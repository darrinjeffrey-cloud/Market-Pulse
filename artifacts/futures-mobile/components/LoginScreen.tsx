/**
 * LoginScreen.tsx — Prompts the operator for an API token at first launch.
 *
 * On submit the token is validated against /api/market/snapshot,
 * persisted to expo-secure-store, and the onSuccess callback fires
 * to reveal the main app. Nothing is baked into the JS bundle.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getApiBase, saveToken } from '@/hooks/tokenStore';

interface Props {
  onSuccess: () => void;
}

export default function LoginScreen({ onSuccess }: Props) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSignIn() {
    const t = token.trim();
    if (!t) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${getApiBase()}/market/snapshot`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) {
        await saveToken(t);
        onSuccess();
      } else if (res.status === 401) {
        setError('Invalid token — please try again.');
      } else if (res.status === 503) {
        setError('API is not configured on the server — contact your administrator.');
      } else {
        setError(`Service error (${res.status}) — try again later.`);
      }
    } catch {
      setError('Could not reach the API — check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Market Posture</Text>
        <Text style={styles.subtitle}>Enter your API token to continue</Text>

        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="API token"
          placeholderTextColor="#52525b"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={handleSignIn}
          returnKeyType="done"
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.button, (!token.trim() || loading) && styles.buttonDisabled]}
          onPress={handleSignIn}
          disabled={!token.trim() || loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.buttonText}>Sign in</Text>
          }
        </Pressable>

        <Text style={styles.hint}>
          Token is stored in device secure storage.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: '#71717a',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 28,
  },
  input: {
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 8,
    color: '#fff',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 12,
  },
  error: {
    color: '#f87171',
    fontSize: 12,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#3f3f46',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonDisabled: {
    backgroundColor: '#27272a',
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    color: '#3f3f46',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 20,
  },
});
