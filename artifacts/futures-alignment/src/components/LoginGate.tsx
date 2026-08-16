/**
 * LoginGate — Shows a "Sign in" screen until the user authenticates via Replit Auth.
 * Uses the useAuth() hook; login redirects to /api/login (Replit OIDC flow).
 */

import { type ReactNode } from 'react';
import { useAuth } from '@workspace/replit-auth-web';

interface Props {
  children: ReactNode;
}

export function LoginGate({ children }: Props) {
  const { isLoading, isAuthenticated, login } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
      </div>
    );
  }

  if (isAuthenticated) return <>{children}</>;

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center">
        <div className="mb-2 text-2xl font-bold text-white tracking-tight">
          Market Posture
        </div>
        <div className="mb-8 text-sm text-zinc-500">
          Multi-timeframe futures command center
        </div>

        <button
          type="button"
          onClick={login}
          className="w-full bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white text-sm font-medium py-2.5 px-4 rounded-md transition-colors"
        >
          Sign in to continue
        </button>

        <p className="mt-6 text-xs text-zinc-600">
          Your session persists until you sign out.
        </p>
      </div>
    </div>
  );
}
