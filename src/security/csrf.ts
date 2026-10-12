import { createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { randomToken, safeEqual } from "../privacy.js";
import { readCookie } from "../web/cookies.js";

// Signed double-submit CSRF protection for every staff form (including login).
// A random value lives in an HttpOnly cookie; each form carries an HMAC of it.
// A forged cross-site request can't read either, so it can't produce a valid token.

const COOKIE = "ubah_csrf";

export function csrfCookie(req: Request, res: Response, next: NextFunction) {
  let value = readCookie(req, COOKIE);
  if (!value || value.length < 20) {
    value = randomToken(24);
    const secure = config.baseUrl.startsWith("https") ? "; Secure" : "";
    res.append("Set-Cookie", `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/staff${secure}`);
  }
  (req as any).csrfSeed = value;
  next();
}

export function csrfToken(req: Request): string {
  const seed: string = (req as any).csrfSeed ?? "";
  return createHmac("sha256", config.sessionSecret).update(`csrf:${seed}`).digest("base64url");
}

// Hidden field to put inside every <form method="post">.
export const csrfField = (req: Request) => `<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;

export function verifyCsrf(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // File uploads (multipart) carry the token in the form's action URL, since the body is parsed later.
  const multipart = String(req.headers["content-type"] ?? "").startsWith("multipart/form-data");
  const given = String(req.body?._csrf ?? (multipart ? req.query._csrf : undefined) ?? req.headers["x-csrf-token"] ?? "");
  if (!readCookie(req, COOKIE) || !given || !safeEqual(given, csrfToken(req))) {
    return res
      .status(403)
      .type("html")
      .send(`<!doctype html><meta charset="utf-8"><title>Expired form · Ubah</title><p>This form expired or came from another site. Go back, reload the page and try again.</p><p><a href="/staff">Back to Ubah</a></p>`);
  }
  next();
}
