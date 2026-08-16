/**
 * tokenStore.ts — Runtime API-token management for the mobile app.
 *
 * The token is loaded from expo-secure-store at startup and cached in a
 * module-level variable so getAuthHeaders() can remain synchronous.
 * Nothing is ever embedded in the JS bundle via EXPO_PUBLIC_* env vars.
 */

import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'market_api_token';

let _token: string | null = null;

/** Load the persisted token from SecureStore. Call once at app startup. */
export async function loadToken(): Promise<string | null> {
  try {
    _token = await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    _token = null;
  }
  return _token;
}

/** Persist the token and update the in-memory cache. */
export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  _token = token;
}

/** Clear the persisted token. */
export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // ignore
  }
  _token = null;
}

/** Synchronous read from the in-memory cache (populated after loadToken()). */
export function getCachedToken(): string | null {
  return _token;
}

/** Returns the Authorization header object, or {} if unauthenticated. */
export function getAuthHeaders(): Record<string, string> {
  return _token ? { Authorization: `Bearer ${_token}` } : {};
}

/** Returns the base URL for the API server. */
export function getApiBase(): string {
  const domain = process.env['EXPO_PUBLIC_DOMAIN'];
  return domain ? `https://${domain}/api` : '/api';
}
