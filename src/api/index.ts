import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import type { Db } from "../db.js";
import { log, safePath } from "../log.js";
import { authApi } from "./auth.js";
import { meApi } from "./me.js";
import { workerApi, audioApi } from "./worker.js";
import { adminApi } from "./admin.js";
import { en, rawString } from "../i18n.js";
import { girlLanguages, languageConfig } from "../languages/index.js";
import { refreshCaches } from "../caches.js";

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
  // Girl-facing words for /login and /me, in her language (published translations; English until then).
  r.get("/strings", async (req, res) => {
    await refreshCaches(db);
    const asked = String(req.query.lang ?? "");
    const l = languageConfig(asked);
    const lang = l && l.status !== "disabled" ? l.code : "en";
    // Her space reuses the app's words for care, passes and lessons (app_, svc_, cat_).
    const keys = Object.keys(en).filter((k) => /^(web_|app_|svc_|cat_|wb_)/.test(k) || ["clinic_rating", "translation_pending", "answer_not_advice"].includes(k));
    res.setHeader("Cache-Control", "no-cache");
    res.json({ lang, languages: girlLanguages().map((x) => ({ code: x.code, name: x.name })), strings: Object.fromEntries(keys.map((k) => [k, rawString(lang, k)])) });
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
