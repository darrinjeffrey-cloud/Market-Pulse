/**
 * LoginGate — Wraps the app and shows a token-entry screen until the
 * operator supplies a valid API token. The token is validated against
 * /api/market/catalog before being accepted, then stored in sessionStorage
 * for the lifetime of the tab. Nothing is ever baked into the JS bundle.
 */

import { useState, type ReactNode } from 'react';
import { getStoredToken, setStoredToken, getAuthHeaders } from '@/lib/auth';

interface Props {
  children: ReactNode;
}

export function LoginGate({ children }: Props) {
  const [authed, setAuthed] = useState(() => {
    const t = getStoredToken();
    return !!t;
  });
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (authed) return <>{children}</>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const token = input.trim();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/market/catalog', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setStoredToken(token);
        setAuthed(true);
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
