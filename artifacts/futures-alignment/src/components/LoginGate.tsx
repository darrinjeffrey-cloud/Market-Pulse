/**
 * LoginGate — Password-protected entry screen.
 * Submits the password to POST /api/login; on success the session cookie is set
 * and the app renders normally.
 */

import { type FormEvent, type ReactNode, useState } from 'react';
import { useAuth } from '@workspace/replit-auth-web';

interface Props {
  children: ReactNode;
}

export function LoginGate({ children }: Props) {
  const { isLoading, isAuthenticated, login } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
      </div>
    );
  }

  if (isAuthenticated) return <>{children}</>;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!password.trim() || submitting) return;
    setError('');
    setSubmitting(true);
    const ok = await login(password);
    setSubmitting(false);
    if (!ok) {
      setError('Incorrect password. Try again.');
      setPassword('');
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-5 flex flex-col items-center gap-2" aria-label="Market Pulse">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-[hsl(var(--primary)/.5)] bg-[hsl(var(--primary)/.1)] text-xl font-black tracking-[-.1em] text-[hsl(var(--primary))] shadow-[0_0_30px_hsl(var(--primary)/.15)]">
            MP
          </div>
          <div className="fam-display text-sm font-extrabold uppercase tracking-[-.035em] text-[hsl(var(--primary))]">
            Market Pulse
          </div>
        </div>
        <div className="mb-8 text-sm text-zinc-500">
          Multi-timeframe futures command center
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            autoComplete="current-password"
            className="w-full bg-zinc-900 border border-zinc-700 text-white text-sm placeholder-zinc-600 py-2.5 px-4 rounded-md focus:outline-none focus:border-zinc-500 transition-colors"
          />

          {error && (
            <p className="text-xs text-red-400 text-left">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !password.trim()}
            className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 border border-zinc-700 text-white text-sm font-medium py-2.5 px-4 rounded-md transition-colors"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-xs text-zinc-600">
          Your session persists until you sign out.
        </p>
      </div>
    </div>
  );
}
