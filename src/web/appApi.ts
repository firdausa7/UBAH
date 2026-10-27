import express, { Router, type Request, type Response, type NextFunction } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { en, LANGUAGES, rawString } from "../i18n.js";
import { hashPhone, randomToken } from "../privacy.js";
import { handleIncoming, getOrCreateUser } from "../engine.js";
import { clinicsFor, issuePassFor, lessonsFor, passesFor } from "../girlCare.js";
import { eraseGirl } from "../erase.js";
import { parseMenu } from "../channels/menu.js";
import { type UserRow } from "../channels/outbound.js";
import { refreshCaches } from "../caches.js";
import { servingContent } from "../content/content.js";
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
  // Many girls in a camp can share one public IP (carrier NAT), so each device has its own limit, and
  // the per-IP limit is only a high ceiling against abuse.
  r.use(rateLimit({ name: "app-api-ip", windowMs: 60_000, max: (opts.requestsPerMin ?? 120) * 25, key: (req) => req.ip ?? "unknown" }));
  r.use(rateLimit({ name: "app-api", windowMs: 60_000, max: opts.requestsPerMin ?? 120, key: (req) => `${req.ip}|${String(req.headers.authorization ?? "").slice(-24)}` }));

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
  r.post("/session", rateLimit({ name: "app-session", windowMs: 3600_000, max: opts.sessionsPerHour ?? 300 }), async (_req, res) => {
    const token = randomToken(32);
    await getOrCreateUser(db, { channel: "app", from: appId(token) });
    res.status(201).json({ token });
  });

  r.get("/strings", async (req, res) => {
    await refreshCaches(db);
    const lang = String(req.query.lang ?? "en") in LANGUAGES ? String(req.query.lang) : "en";
    const keys = Object.keys(en).filter((k) => /^(app_|svc_|cat_)/.test(k) || ["answer_source", "translation_pending"].includes(k));
    res.setHeader("Cache-Control", "no-cache");
    res.json({ lang, stage: config.stage, languages: LANGUAGES, strings: Object.fromEntries(keys.map((k) => [k, rawString(lang, k)])) });
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
    await eraseGirl(db, req.appUser!);
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
    res.json(await clinicsFor(db, String(req.query.services ?? "").split(",")));
  });

  r.post("/passes", auth, async (req: AppReq, res) => {
    const r = await issuePassFor(db, req.appUser!, req.body?.services);
    if (r === "services") return res.status(400).json({ error: "services" });
    res.status(r.code ? 201 : 200).json(r);
  });

  r.get("/passes", auth, async (req: AppReq, res) => {
    res.json({ passes: await passesFor(db, req.appUser!.id) });
  });

  // Published lessons in her language (else English, marked), for reading and listening offline.
  r.get("/learn", async (req, res) => {
    const lang = String(req.query.lang ?? "en") in LANGUAGES ? String(req.query.lang) : "en";
    res.setHeader("Cache-Control", "no-cache");
    res.json(await lessonsFor(db, lang));
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
