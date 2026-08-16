import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

// CORS — credentials: true required for cookie-based session auth
app.use(cors({ credentials: true, origin: true }));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session-based auth — loads user from session cookie or Bearer token on every request
app.use(authMiddleware);

// Gate all /api/market/* routes — require an authenticated session
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS") return next();
  if (!req.path.startsWith("/api/market/")) return next();
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Unauthorized" });
});

app.use("/api", router);

export default app;
