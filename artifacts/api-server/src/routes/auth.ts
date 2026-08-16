import { GetCurrentAuthUserResponse } from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';

import {
  clearSession,
  createSession,
  deleteSession,
  getSessionId,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from '../lib/auth';
import { logger } from '../lib/logger';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  logger.warn('ADMIN_PASSWORD is not set — login will be rejected for all requests');
}

const router: IRouter = Router();

function setSessionCookie(res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

// ── GET /api/auth/user ───────────────────────────────────────────────────────
router.get('/auth/user', (req: Request, res: Response) => {
  res.json(GetCurrentAuthUserResponse.parse({ user: req.isAuthenticated() ? req.user : null }));
});

// ── POST /api/login ──────────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ error: 'ADMIN_PASSWORD is not configured on the server.' });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    logger.warn('Failed login attempt');
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  const sessionData: SessionData = {
    user: { id: 'admin', email: null, firstName: null, lastName: null, profileImageUrl: null },
  };
  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);
  res.json({ ok: true });
});

// ── POST /api/logout ─────────────────────────────────────────────────────────
router.post('/logout', async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.json({ ok: true });
});

// ── Mobile: POST /api/mobile-auth/login ──────────────────────────────────────
// Same password check; returns a Bearer token (the session ID) instead of a cookie.
router.post('/mobile-auth/login', async (req: Request, res: Response) => {
  if (!ADMIN_PASSWORD) {
    res.status(503).json({ error: 'ADMIN_PASSWORD is not configured on the server.' });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Incorrect password.' });
    return;
  }

  const sessionData: SessionData = {
    user: { id: 'admin', email: null, firstName: null, lastName: null, profileImageUrl: null },
  };
  const sid = await createSession(sessionData);
  res.json({ token: sid });
});

// ── Mobile: POST /api/mobile-auth/logout ─────────────────────────────────────
router.post('/mobile-auth/logout', async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) await deleteSession(sid);
  res.json({ success: true });
});

export default router;
