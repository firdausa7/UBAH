import express, { Router } from "express";
import type { Db } from "../db.js";
import { girlLanguages, languageConfig } from "../languages/index.js";
import { girlOf, requireRole } from "../auth/roles.js";
import { consents, setConsents } from "../auth/access.js";
import { handleIncoming } from "../engine.js";
import { rateLimit } from "../security/rateLimit.js";

// Her conversation as she sees it: her messages, Ubah's answers, and her health worker's replies in
// her language, with the English the worker wrote available on tap.
async function conversation(db: Db, girlId: number, after: number) {
  const rows = await db.query<any>(
    `SELECT id, direction, kind, body, english_text, english_source, sent_by_staff, created_at FROM messages
      WHERE user_id = $1 AND id > $2 AND kind <> 'location' ORDER BY id LIMIT 200`,
    [girlId, after],
  );
  return rows.map((m) => ({
    id: m.id,
    from: m.direction === "in" ? "me" : m.sent_by_staff ? "worker" : "ubah",
    kind: m.kind,
    text: m.body,
    english: m.direction === "out" && m.english_source && m.english_source !== "none" ? m.english_text : null,
    at: m.created_at,
  }));
}

// /api/me: the girl's own space. She sees only her own data.

export function meApi(db: Db): Router {
  const r = Router();
  r.use(requireRole(db, ["girl"]));
  const sendLimit = rateLimit({ name: "me-send", windowMs: 60_000, max: 30, key: (req) => `girl:${girlOf(req).id}` });

  r.get("/", async (req, res) => {
    const g = girlOf(req);
    res.json({
      anonId: g.anon_id,
      language: g.language,
      // Her four options; a disabled language is never offered, and girls never see "Beta".
      languages: girlLanguages().map((l) => ({ code: l.code, name: l.name })),
      consents: await consents(db, g.id),
    });
  });

  r.patch("/", async (req, res) => {
    const g = girlOf(req);
    const lang = String(req.body?.language ?? "");
    const l = languageConfig(lang);
    if (!l || l.status === "disabled") return res.status(400).json({ error: "language" });
    await db.query(`UPDATE users SET language = $2 WHERE id = $1`, [g.id, l.code]);
    res.json({ language: l.code });
  });

  // What she shares with her health worker. She can change her mind at any time.
  r.put("/consents", async (req, res) => {
    const g = girlOf(req);
    const b = req.body ?? {};
    for (const k of ["messages", "voice"]) if (k in b && typeof b[k] !== "boolean") return res.status(400).json({ error: k });
    await setConsents(db, g.id, { messages: b.messages, voice: b.voice });
    res.json({ consents: await consents(db, g.id) });
  });

  r.get("/messages", async (req, res) => {
    res.json({ messages: await conversation(db, girlOf(req).id, Math.max(0, Number(req.query.after) || 0)) });
  });

  // Text, through the same pipeline as WhatsApp and SMS.
  r.post("/messages", sendLimit, async (req, res) => {
    const g = girlOf(req);
    const text = String(req.body?.text ?? "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "empty" });
    await handleIncoming(db, { channel: "web", from: "", userId: g.id, text });
    res.json({ messages: await conversation(db, g.id, Math.max(0, Number(req.query.after) || 0)) });
  });

  // A recorded voice note (raw audio body), through the same pipeline.
  r.post("/voice", sendLimit, express.raw({ type: ["audio/*", "application/octet-stream"], limit: "2mb" }), async (req, res) => {
    const g = girlOf(req);
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) return res.status(400).json({ error: "empty" });
    const mimeType = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
    await handleIncoming(db, { channel: "web", from: "", userId: g.id, voice: { audio, mimeType } });
    res.json({ messages: await conversation(db, g.id, Math.max(0, Number(req.query.after) || 0)) });
  });

  return r;
}
