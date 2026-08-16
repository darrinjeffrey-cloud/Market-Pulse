/**
 * guest-auth.ts — Signed, time-limited guest JWT generation and verification.
 *
 * Guest tokens are JWTs signed with SESSION_SECRET. They are short-lived and
 * carry no sensitive data — just a role and an expiry. The auth middleware
 * accepts them alongside the raw API_TOKEN so guests can view the dashboard
 * without ever seeing the main operator token.
 */

import jwt from "jsonwebtoken";
import { logger } from "./logger";

const SECRET = process.env["SESSION_SECRET"];
if (!SECRET) {
  logger.warn("SESSION_SECRET is not set — guest token generation will fail");
}

export interface GuestPayload {
  role: "guest";
  /** Human-readable label shown in the UI */
  label: string;
  /** Unix epoch seconds (standard JWT claim, also set as exp) */
  iat: number;
  exp: number;
}

export type InviteTtl = "1h" | "8h" | "24h" | "7d" | "30d";

const TTL_SECONDS: Record<InviteTtl, number> = {
  "1h":  60 * 60,
  "8h":  8 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d":  7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

/**
 * Generate a signed guest JWT.
 * @param ttl  How long the token should remain valid.
 * @param label  Optional display name shown in the guest's browser.
 */
export function signGuestToken(ttl: InviteTtl, label = "Guest"): string {
  if (!SECRET) throw new Error("SESSION_SECRET is not set");
  return jwt.sign({ role: "guest", label } as Omit<GuestPayload, "iat" | "exp">, SECRET, {
    expiresIn: TTL_SECONDS[ttl],
  });
}

/**
 * Verify a token string as a guest JWT.
 * Returns the decoded payload, or null if invalid / expired / wrong role.
 */
export function verifyGuestToken(token: string): GuestPayload | null {
  if (!SECRET) return null;
  try {
    const payload = jwt.verify(token, SECRET) as GuestPayload;
    if (payload.role !== "guest") return null;
    return payload;
  } catch {
    return null;
  }
}
