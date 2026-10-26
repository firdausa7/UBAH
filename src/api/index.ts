import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import type { Db } from "../db.js";
import { log, safePath } from "../log.js";
import { authApi } from "./auth.js";
import { meApi } from "./me.js";
import { workerApi, audioApi } from "./worker.js";
import { adminApi } from "./admin.js";

// The JSON API for the React app (/login, /me, /worker, /admin).
// Cookies carry the session; every request that changes something must also carry "X-Ubah: 1",
// which a page on another site can't add without the browser asking us first (and we never allow it).

export function apiRouter(db: Db, opts: { loginLimiter: RequestHandler }): Router {
  const r = Router();
  r.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(req.method) && req.get("x-ubah") !== "1") return res.status(403).json({ error: "csrf" });
    next();
  });
  r.use("/auth", authApi(db, opts));
  r.use("/me", meApi(db));
  r.use("/worker", workerApi(db));
  r.use("/admin", adminApi(db));
  r.use("/audio", audioApi(db));
  r.use((_req, res) => res.status(404).json({ error: "not_found" }));
  // No girl data in errors: the log gets the error and the path, the client a bare code.
  r.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status ?? err?.statusCode) || 500;
    if (status >= 500) log.error({ err, path: safePath(req.originalUrl) }, "api error");
    if (res.headersSent) return;
    res.status(status).json({ error: status >= 500 ? "server" : "bad_request" });
  });
  return r;
}
