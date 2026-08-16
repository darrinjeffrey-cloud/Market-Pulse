/**
 * auth.ts — Runtime token management for the web dashboard.
 *
 * The operator enters their API token once per session via the LoginGate.
 * Guests land via an invite link (?token=...) which is auto-read on load.
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

/**
 * Read a ?token= query param from the current URL, store it in sessionStorage,
 * and strip it from the URL bar so it doesn't stay visible or get bookmarked.
 * Returns the token if one was found and stored, or null otherwise.
 */
export function consumeUrlToken(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (!t) return null;
    setStoredToken(t);
    // Remove ?token= from the address bar without a page reload
    params.delete('token');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
    return t;
  } catch {
    return null;
  }
}
