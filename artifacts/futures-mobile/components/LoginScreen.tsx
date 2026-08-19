import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

interface Props {
  onLogin: (password: string) => Promise<boolean>;
}

export default function LoginScreen({ onLogin }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    if (!password.trim() || loading) return;
    setError('');
    setLoading(true);
    const ok = await onLogin(password);
    setLoading(false);
    if (!ok) {
      setError('Incorrect password. Try again.');
      setPassword('');
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.card}>
        <View style={styles.brand}>
          <View style={styles.brandMark}>
            <Text style={styles.brandInitials}>MP</Text>
          </View>
          <Text style={styles.brandName}>Market Pulse</Text>
        </View>
        <Text style={styles.subtitle}>Multi-timeframe futures command center</Text>

        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#52525b"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={handleSubmit}
          returnKeyType="go"
          autoCapitalize="none"
          autoCorrect={false}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.button, (!password.trim() || loading) && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={!password.trim() || loading}
          activeOpacity={0.7}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </TouchableOpacity>

        <Text style={styles.hint}>Your session persists until you sign out.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#100D08',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  brand: {
    alignItems: 'center',
    marginBottom: 20,
  },
  brandMark: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#211907',
    borderWidth: 1,
    borderColor: '#F5A800',
    marginBottom: 8,
  },
  brandInitials: {
    color: '#F5A800',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -2,
  },
  brandName: {
    color: '#F5A800',
    fontSize: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: -0.4,
  },
  subtitle: {
    color: '#8B7A58',
    fontSize: 13,
    marginBottom: 32,
    textAlign: 'center',
  },
  input: {
    width: '100%',
    backgroundColor: '#17120B',
    borderWidth: 1,
    borderColor: '#2B2015',
    borderRadius: 8,
    color: '#EDE8DE',
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 10,
  },
  error: {
    color: '#f87171',
    fontSize: 12,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  button: {
    width: '100%',
    backgroundColor: '#201808',
    borderWidth: 1,
    borderColor: '#2B2015',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 24,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#EDE8DE',
    fontSize: 14,
    fontWeight: '500',
  },
  hint: {
    color: '#2B2015',
    fontSize: 11,
  },
});
