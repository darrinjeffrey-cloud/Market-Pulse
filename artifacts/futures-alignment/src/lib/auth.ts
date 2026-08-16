/**
 * auth.ts — Runtime token management for the web dashboard.
 *
 * The operator enters their API token once per session via the LoginGate.
 * The token is stored in sessionStorage (cleared on tab close, never baked
 * into the JS bundle) and read back via getAuthHeaders() for every fetch.
 */

const SESSION_KEY = 'market_api_token';

export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, token);
  } catch {}
}

export function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

/** Returns the Authorization header object, or an empty object if unauthenticated. */
export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
