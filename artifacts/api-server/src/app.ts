import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { verifyGuestToken } from "./lib/guest-auth";

const app: Express = express();

// ── CORS first — preflight OPTIONS must get CORS headers before auth check ───
app.use(cors());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── Bearer-token auth ────────────────────────────────────────────────────────
// Accepts Authorization: Bearer <token> header, or ?token= query param
// (EventSource cannot send custom headers, so SSE uses the query param).
const API_TOKEN = process.env["API_TOKEN"];
if (!API_TOKEN) {
  logger.error("API_TOKEN is not set — all /api routes are closed until it is configured");
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") return next(); // CORS preflights pass through
  if (!req.path.startsWith("/api/")) return next(); // only protect /api/* routes

  // Fail closed: if the token is not configured, deny all API requests
  if (!API_TOKEN) {
    res.status(503).json({ error: "Service unavailable — API_TOKEN not configured" });
    return;
  }

  const authHeader = req.headers["authorization"];
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryToken = typeof req.query["token"] === "string" ? req.query["token"] : null;

  // Accept the raw admin token
  if (headerToken === API_TOKEN || queryToken === API_TOKEN) return next();

  // Accept a valid signed guest JWT
  const raw = headerToken ?? queryToken;
  if (raw && verifyGuestToken(raw)) return next();

  res.status(401).json({ error: "Unauthorized" });
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
