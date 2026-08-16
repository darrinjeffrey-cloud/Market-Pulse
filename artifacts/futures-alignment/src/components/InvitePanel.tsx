/**
 * InvitePanel — Admin-only dialog to generate time-limited guest invite links.
 * Only rendered when the current session is authenticated as admin (full API_TOKEN).
 */

import { useState } from 'react';
import { Copy, Check, Link, UserPlus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { getStoredToken } from '@/lib/auth';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Ttl = '1h' | '8h' | '24h' | '7d' | '30d';

const TTL_LABELS: Record<Ttl, string> = {
  '1h':  '1 hour',
  '8h':  '8 hours',
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
};

export function InvitePanel({ open, onClose }: Props) {
  const [ttl, setTtl] = useState<Ttl>('24h');
  const [label, setLabel] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function generate() {
    setLoading(true);
    setError('');
    setLink(null);
    try {
      const token = getStoredToken();
      const res = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ttl, label: label.trim() || 'Guest' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `Error ${res.status}`);
        return;
      }
      const data = await res.json() as { token: string; expiresAt: string };
      const url = `${window.location.origin}${window.location.pathname}?token=${encodeURIComponent(data.token)}`;
      setLink(url);
      setExpiresAt(data.expiresAt);
    } catch {
      setError('Could not reach the API.');
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleClose() {
    setLink(null);
    setError('');
    setLabel('');
    setTtl('24h');
    onClose();
  }

  const expiresLabel = expiresAt
    ? new Date(expiresAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-foreground">
            <UserPlus className="h-4 w-4 text-primary" />
            Generate Guest Invite
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Label */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
              Label <span className="font-normal normal-case tracking-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. John"
              maxLength={64}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          {/* TTL selector */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
              Access expires after
            </label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(TTL_LABELS) as Ttl[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTtl(t)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    ttl === t
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border bg-muted text-muted-foreground hover:border-border/80 hover:text-foreground'
                  }`}
                >
                  {TTL_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Generate button */}
          {!link && (
            <button
              type="button"
              onClick={() => void generate()}
              disabled={loading}
              className="w-full rounded-md bg-primary/90 px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary disabled:opacity-50"
            >
              {loading ? 'Generating…' : 'Generate invite link'}
            </button>
          )}

          {/* Error */}
          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* Result */}
          {link && (
            <div className="space-y-3 rounded-md border border-primary/20 bg-primary/5 p-3">
              <div className="flex items-start gap-2">
                <Link className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary" />
                <p className="break-all font-mono text-[11px] text-foreground/80">{link}</p>
              </div>

              {expiresLabel && (
                <p className="text-[10px] text-muted-foreground">
                  Expires: <span className="text-foreground/70">{expiresLabel}</span>
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className="flex flex-1 items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  type="button"
                  onClick={() => void generate()}
                  className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  New link
                </button>
              </div>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground">
            Guests get read-only access. The link works once per browser session.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
