import crypto from 'crypto';
import { db, inviteTokensTable, sessionsTable } from '@workspace/db';
import { and, eq, gt } from 'drizzle-orm';
import { Router, type IRouter, type Request, type Response } from 'express';

import { createSession, SESSION_COOKIE, SESSION_TTL } from '../lib/auth';

const router: IRouter = Router();

const DURATIONS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function parseOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function getOrigin(req: Request): string {
  // The API may be mounted behind a separate internal service URL. Prefer an
  // explicit public URL, then browser headers that identify the dashboard
  // origin, before falling back to proxy headers.
  const configuredOrigin = parseOrigin(process.env.PUBLIC_APP_URL);
  const requestOrigin = parseOrigin(req.headers.origin);
  const refererOrigin = parseOrigin(req.headers.referer);

  if (configuredOrigin) return configuredOrigin;
  if (requestOrigin) return requestOrigin;
  if (refererOrigin) return refererOrigin;

  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? 'https')
    .split(',')[0]
    .trim();
  const forwardedHost = String(
    req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost',
  )
    .split(',')[0]
    .trim();
  return parseOrigin(`${forwardedProto}://${forwardedHost}`) ?? 'https://localhost';
}

function requireAdmin(req: Request, res: Response): boolean {
  if (req.user?.id !== 'admin') {
    res.status(403).json({ error: 'Admin only.' });
    return false;
  }
  return true;
}

function toRow(row: { token: string; label: string | null; expiresAt: Date; createdAt: Date }, origin: string) {
  return {
    token: row.token,
    url: `${origin}/api/invite/${row.token}`,
    label: row.label,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ── POST /api/invites — admin creates a new invite link ──────────────────────
router.post('/invites', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const { duration = '7d', label } = req.body as { duration?: string; label?: string };
  const ms = DURATIONS[duration] ?? DURATIONS['7d']!;

  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + ms);

  await db.insert(inviteTokensTable).values({
    token,
    label: label?.trim() || null,
    expiresAt,
  });

  res.json(toRow({ token, label: label?.trim() || null, expiresAt, createdAt: new Date() }, getOrigin(req)));
});

// ── GET /api/invites — admin lists active invite links ───────────────────────
router.get('/invites', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  const rows = await db
    .select()
    .from(inviteTokensTable)
    .where(gt(inviteTokensTable.expiresAt, new Date()))
    .orderBy(inviteTokensTable.createdAt);

  const origin = getOrigin(req);
  res.json({ invites: rows.map((r) => toRow(r, origin)) });
});

// ── DELETE /api/invites/:token — admin revokes an invite ─────────────────────
router.delete('/invites/:token', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  await db.delete(inviteTokensTable).where(eq(inviteTokensTable.token, req.params.token));
  res.json({ ok: true });
});

// ── GET /api/invite/:token — public: redeem invite → session + redirect ──────
router.get('/invite/:token', async (req: Request, res: Response) => {
  const [row] = await db
    .select()
    .from(inviteTokensTable)
    .where(
      and(
        eq(inviteTokensTable.token, req.params.token),
        gt(inviteTokensTable.expiresAt, new Date()),
      ),
    );

  if (!row) {
    res.status(410).send(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:4rem">' +
        '<h2>Link expired or invalid</h2>' +
        '<p>This invite link has expired or does not exist.</p>' +
        '</body></html>',
    );
    return;
  }

  const sid = await createSession({
    user: { id: 'guest', email: null, firstName: null, lastName: null, profileImageUrl: null },
  });

  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });

  res.redirect('/');
});

export default router;
