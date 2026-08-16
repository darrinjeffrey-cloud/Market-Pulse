/**
 * auth.ts — Guest invite route.
 *
 * POST /api/auth/invite  (admin only — requires the main API_TOKEN)
 *   Body: { ttl: "1h" | "8h" | "24h" | "7d" | "30d", label?: string }
 *   Returns: { token: string, expiresAt: string }
 *
 * GET /api/auth/validate
 *   Returns info about the current bearer token (role, expiresAt if guest).
 *   Returns 401 if the token is absent / invalid.
 */

import { Router } from "express";
import { signGuestToken, verifyGuestToken, type InviteTtl } from "../lib/guest-auth";
import { logger } from "../lib/logger";

const TTL_VALUES: InviteTtl[] = ["1h", "8h", "24h", "7d", "30d"];

const router = Router();

// POST /api/auth/invite — generate a guest invite token
// This route is behind the global auth middleware, so only a valid API_TOKEN holder can call it.
router.post("/auth/invite", (req, res) => {
  const { ttl = "7d", label = "Guest" } = req.body as { ttl?: InviteTtl; label?: string };

  if (!TTL_VALUES.includes(ttl)) {
    res.status(400).json({ error: `ttl must be one of: ${TTL_VALUES.join(", ")}` });
    return;
  }

  let token: string;
  try {
    token = signGuestToken(ttl, String(label).slice(0, 64));
  } catch (err) {
    logger.error({ err }, "Failed to sign guest token");
    res.status(500).json({ error: "Could not generate token — SESSION_SECRET may be missing" });
    return;
  }

  // Decode immediately to surface the actual expiry to the caller
  const payload = verifyGuestToken(token);
  const expiresAt = payload ? new Date(payload.exp * 1000).toISOString() : null;

  res.json({ token, expiresAt });
});

// GET /api/auth/validate — returns info about the current bearer token
router.get("/auth/validate", (req, res) => {
  const API_TOKEN = process.env["API_TOKEN"];

  const authHeader = req.headers["authorization"];
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryToken = typeof req.query["token"] === "string" ? req.query["token"] : null;
  const raw = headerToken ?? queryToken ?? null;

  if (!raw) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  // Admin token
  if (raw === API_TOKEN) {
    res.json({ role: "admin", label: "Admin" });
    return;
  }

  // Guest JWT
  const payload = verifyGuestToken(raw);
  if (payload) {
    res.json({
      role: "guest",
      label: payload.label,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    });
    return;
  }

  res.status(401).json({ error: "Invalid or expired token" });
});

export default router;
