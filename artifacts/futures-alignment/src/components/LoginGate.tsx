/**
 * LoginGate — Wraps the app and shows a token-entry screen until the user
 * supplies a valid API token.
 *
 * Guests land via an invite link (?token=...) which is auto-consumed on load.
 * Operators enter the raw API token manually.
 * All tokens are validated against /api/auth/validate before being accepted.
 * Tokens are stored in sessionStorage only (cleared on tab close).
 */

import { useState, useEffect, type ReactNode } from 'react';
import { getStoredToken, setStoredToken, clearStoredToken, consumeUrlToken } from '@/lib/auth';

interface Props {
  children: ReactNode;
  /** Callback to propagate role upward so the dashboard can show admin-only UI. */
  onRole?: (role: 'admin' | 'guest') => void;
}

type AuthState = 'checking' | 'authed' | 'unauthenticated';

async function validateToken(token: string): Promise<'admin' | 'guest' | null> {
  try {
    const res = await fetch('/api/auth/validate', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { role: 'admin' | 'guest' };
    return body.role ?? null;
  } catch {
    return null;
  }
}

export function LoginGate({ children, onRole }: Props) {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // On mount: consume ?token= from URL or validate whatever is in sessionStorage
  useEffect(() => {
    async function init() {
      // 1. Prefer a URL token (guest invite link)
      const urlToken = consumeUrlToken();
      const candidate = urlToken ?? getStoredToken();
      if (!candidate) { setAuthState('unauthenticated'); return; }

      const role = await validateToken(candidate);
      if (role) {
        setStoredToken(candidate);
        onRole?.(role);
        setAuthState('authed');
      } else {
        clearStoredToken();
        setAuthState('unauthenticated');
      }
    }
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (authState === 'checking') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
      </div>
    );
  }

  if (authState === 'authed') return <>{children}</>;

  // ── Manual token entry ────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = input.trim();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const role = await validateToken(token);
      if (role) {
        setStoredToken(token);
        onRole?.(role);
        setAuthState('authed');
      } else {
        setError('Invalid or expired token — please try again.');
      }
    } catch {
      setError('Could not reach the API — check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold text-white tracking-tight mb-1">
            Market Posture
          </div>
          <div className="text-sm text-zinc-500">
            Enter your API token to continue
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="API token"
              autoFocus
              className="w-full bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-white placeholder-zinc-500 text-sm focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="w-full bg-zinc-700 hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium py-2.5 rounded-md transition-colors"
          >
            {loading ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-zinc-600">
          Token is stored for this browser session only.
        </p>
      </div>
    </div>
  );
}
