import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { en, LANGUAGES, rawString } from "../i18n.js";
import { hashPhone, randomToken } from "../privacy.js";
import { handleIncoming, issueAndSend, getOrCreateUser } from "../engine.js";
import { parseMenu } from "../channels/menu.js";
import { type UserRow } from "../channels/outbound.js";
import { refreshCaches } from "../caches.js";
import { localize, servingContent } from "../content/content.js";
import { clinicRatings } from "../ratings.js";
import { SERVICES, SERVICE_MENU } from "../referrals.js";
import { rateLimit } from "../security/rateLimit.js";
import { log } from "../log.js";

// JSON API for the girls' app (/app). No account and no phone number: the app holds a random device
// secret and sends it as a bearer token; the server keeps only a keyed hash of it (like a phone number).
// The conversation goes through the same engine as WhatsApp and SMS, so the safety rules are identical.

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const appId = (token: string) => `app:${token}`;

interface AppReq extends Request {
  appUser?: UserRow;
  appToken?: string;
}

export function appApiRouter(db: Db, opts: { sessionsPerHour?: number; requestsPerMin?: number } = {}): Router {
  const r = Router();
  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  r.use(rateLimit({ name: "app-api", windowMs: 60_000, max: opts.requestsPerMin ?? 120, key: (req) => String(req.headers.authorization ?? req.ip).slice(-24) }));

  const auth = async (req: AppReq, res: Response, next: NextFunction) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!TOKEN_RE.test(token)) return res.status(401).json({ error: "no_session" });
    const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(appId(token))]);
    if (!u) return res.status(401).json({ error: "no_session" });
    req.appUser = u;
    req.appToken = token;
    next();
  };

  // A new anonymous device session.
  r.post("/session", rateLimit({ name: "app-session", windowMs: 3600_000, max: opts.sessionsPerHour ?? 30 }), async (_req, res) => {
    const token = randomToken(32);
    await getOrCreateUser(db, { channel: "app", from: appId(token) });
    res.status(201).json({ token });
  });

  r.get("/strings", async (req, res) => {
    await refreshCaches(db);
    const lang = String(req.query.lang ?? "en") in LANGUAGES ? String(req.query.lang) : "en";
    const keys = Object.keys(en).filter((k) => /^(app_|svc_|cat_)/.test(k) || ["answer_source", "translation_pending"].includes(k));
    res.setHeader("Cache-Control", "no-cache");
    res.json({ lang, languages: LANGUAGES, strings: Object.fromEntries(keys.map((k) => [k, rawString(lang, k)])) });
  });

  r.get("/me", auth, (req: AppReq, res) => {
    res.json({ language: req.appUser!.language, optedOut: req.appUser!.opted_out });
  });

  r.patch("/me", auth, async (req: AppReq, res) => {
    const lang = String(req.body?.language ?? "");
    if (!(lang in LANGUAGES)) return res.status(400).json({ error: "language" });
    const u = req.appUser!;
    const step = u.state?.step === "language" || !u.state?.step ? "free" : u.state.step;
    await db.query(`UPDATE users SET language = $2, state = jsonb_set(coalesce(state, '{}'), '{step}', to_jsonb($3::text)) WHERE id = $1`, [u.id, lang, step]);
    res.json({ language: lang });
  });

  // Wipe my history: the same as sending DELETE.
  r.delete("/me", auth, async (req: AppReq, res) => {
    await db.query(`DELETE FROM users WHERE id = $1`, [req.appUser!.id]);
    await db.query(`DELETE FROM outbox WHERE to_hash = $1`, [req.appUser!.phone_hash]);
    res.status(204).end();
  });

  const messagesFor = async (u: UserRow, after: number) => {
    const rows = await db.query<{ id: number; direction: string; kind: string; body: string; created_at: string }>(
      `SELECT id, direction, kind, body, created_at FROM messages WHERE user_id = $1 AND id > $2 ORDER BY id DESC LIMIT 100`,
      [u.id, after],
    );
    return rows.reverse().map((m) => {
      if (m.direction !== "out") return { id: m.id, from: "me", kind: m.kind, text: m.body, at: m.created_at };
      const menu = parseMenu(m.body);
      // A lone "Reply:" prompt adds nothing above the buttons.
      const text = menu.options.length ? (/^[^\n]{0,40}:\s*$/.test(menu.body) ? "" : menu.body) : m.body;
      return { id: m.id, from: "ubah", text, options: menu.options, at: m.created_at };
    });
  };

  r.get("/messages", auth, async (req: AppReq, res) => {
    res.json({ messages: await messagesFor(req.appUser!, Math.max(0, Number(req.query.after) || 0)) });
  });

  r.post("/messages", auth, async (req: AppReq, res) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 1600);
    const after = Math.max(0, Number(req.body?.after) || 0);
    if (!text) return res.status(400).json({ error: "empty" });
    await handleIncoming(db, { channel: "app", from: appId(req.appToken!), text });
    const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [req.appUser!.id]);
    res.json({ messages: u ? await messagesFor(u, after) : [] });
  });

  // A recorded voice note (raw audio body).
  r.post(
    "/voice",
    auth,
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "2mb" }),
    async (req: AppReq, res) => {
      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length === 0) return res.status(400).json({ error: "empty" });
      const mimeType = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
      await handleIncoming(db, { channel: "app", from: appId(req.appToken!), voice: { audio, mimeType } });
      res.json({ messages: await messagesFor(req.appUser!, Math.max(0, Number(req.query.after) || 0)) });
    },
  );

  r.get("/clinics", auth, async (req: AppReq, res) => {
    const want = String(req.query.services ?? "").split(",").filter((s) => s in SERVICES);
    const [clinics, ratings] = await Promise.all([
      db.query(`SELECT c.id, c.name, c.area, c.hours, c.services, c.free, c.verified, s.name AS site FROM clinics c LEFT JOIN sites s ON s.id = c.site_id WHERE c.active ORDER BY c.verified DESC, c.name`),
      clinicRatings(db),
    ]);
    const list = clinics
      .map((c) => ({ c, overlap: want.filter((s) => c.services.includes(s)).length }))
      .filter((x) => !want.length || x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .map(({ c }) => ({ id: c.id, name: c.name, area: c.area, site: c.site, hours: c.hours, free: c.free, verified: c.verified, services: c.services, rating: ratings.get(c.id) ?? null }));
    res.json({ services: SERVICE_MENU, clinics: list });
  });

  r.post("/passes", auth, async (req: AppReq, res) => {
    const services = (Array.isArray(req.body?.services) ? req.body.services : []).map(String).filter((s: string) => SERVICE_MENU.includes(s));
    if (!services.length) return res.status(400).json({ error: "services" });
    const u = req.appUser!;
    await refreshCaches(db);
    await issueAndSend(db, u, services);
    const [p] = await db.query(`SELECT code FROM passes WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1`, [u.id]);
    res.status(p ? 201 : 200).json({ code: p?.code ?? null });
  });

  r.get("/passes", auth, async (req: AppReq, res) => {
    const rows = await db.query(
      `SELECT p.code, p.services, p.urgent, p.issued_at, p.expires_at, p.redeemed_at, c.name AS clinic, c.area, c.hours,
              (SELECT respect FROM checkins ch WHERE ch.pass_code = p.code) AS respect
         FROM passes p LEFT JOIN clinics c ON c.id = p.suggested_clinic WHERE p.user_id = $1 ORDER BY p.issued_at DESC LIMIT 50`,
      [req.appUser!.id],
    );
    res.json({
      passes: rows.map((p) => ({
        code: p.code,
        services: p.services,
        urgent: p.urgent,
        issuedAt: p.issued_at,
        expiresAt: p.expires_at,
        valid: !p.redeemed_at && new Date(p.expires_at) > new Date(),
        redeemed: Boolean(p.redeemed_at),
        clinic: p.clinic,
        area: p.area,
        hours: p.hours,
        checkedIn: Boolean(p.respect),
      })),
    });
  });

  // Published lessons in her language (else English, marked), for reading and listening offline.
  r.get("/learn", async (req, res) => {
    await refreshCaches(db);
    const lang = String(req.query.lang ?? "en") in LANGUAGES ? String(req.query.lang) : "en";
    const lessons = servingContent()
      .filter((c) => c.language === "en")
      .map((c) => localize(c, lang))
      .map(({ item, translated }) => ({ id: item.id, category: item.topic, title: item.title, body: item.body, translated, audio: translated && item.audioMediaId ? `/app/api/audio/${item.audioMediaId}` : null }));
    res.setHeader("Cache-Control", "no-cache");
    res.json({ lang, lessons, draft: config.allowDraftContent });
  });

  // Audio only for recordings attached to content that is being served (public health content).
  r.get("/audio/:id", async (req, res) => {
    await refreshCaches(db);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !servingContent().some((c) => c.audioMediaId === id)) return res.status(404).end();
    const [m] = await db.query(`SELECT mime, bytes FROM media WHERE id = $1`, [id]);
    if (!m) return res.status(404).end();
    res.setHeader("Content-Type", m.mime);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(m.bytes));
  });

  r.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) log.error({ err }, "app api error");
    res.status(status).json({ error: status === 413 ? "too_large" : "error" });
  });
  return r;
}
