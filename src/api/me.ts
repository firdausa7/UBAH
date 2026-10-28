import express, { Router } from "express";
import type { Db } from "../db.js";
import { girlLanguages, languageConfig } from "../languages/index.js";
import { endGirlSession, girlOf, requireRole } from "../auth/roles.js";
import { consents, setConsents } from "../auth/access.js";
import { handleIncoming } from "../engine.js";
import { rateLimit } from "../security/rateLimit.js";
import { clinicsFor, issuePassFor, lessonsFor, passesFor } from "../girlCare.js";
import { eraseGirl } from "../erase.js";
import { parseMenu } from "../channels/menu.js";
import { pushEnabled, subscribe, unsubscribe, validEndpoint } from "../push.js";
import { config } from "../config.js";

// Her conversation as she sees it: her messages, Ubah's answers, and her health worker's replies in
// her language, with the English the worker wrote available on tap.
async function conversation(db: Db, girlId: number, after: number) {
  const rows = await db.query<any>(
    `SELECT m.id, m.direction, m.kind, m.body, m.english_text, m.english_source, m.sent_by_staff, m.created_at, r.voice_ref
       FROM messages m LEFT JOIN replies r ON r.sent_message_id = m.id
      WHERE m.user_id = $1 AND m.id > $2 AND m.kind <> 'location' ORDER BY m.id LIMIT 200`,
    [girlId, after],
  );
  // What her app has now shown her counts as seen (her worker sees "Seen" on the reply).
  const unseen = rows.filter((m) => m.direction === "out" && m.sent_by_staff).map((m) => m.id);
  if (unseen.length) await db.query(`UPDATE messages SET read_at = now() WHERE id = ANY($1::int[]) AND read_at IS NULL`, [unseen]);
  return rows.map((m) => {
    const from = m.direction === "in" ? "me" : m.sent_by_staff ? "worker" : "ubah";
    // Ubah's numbered menus ("1 Find a clinic…") become buttons, as on WhatsApp. A worker's own
    // words are never read as a menu.
    const menu = from === "ubah" ? parseMenu(m.body) : { body: m.body, options: [] };
    const text = menu.options.length && /^[^\n]{0,40}:\s*$/.test(menu.body) ? "" : menu.options.length ? menu.body : m.body;
    return {
      id: m.id,
      from,
      kind: m.kind,
      text,
      options: menu.options,
      english: m.direction === "out" && m.english_source && m.english_source !== "none" ? m.english_text : null,
      // A spoken version of her worker's reply (only when voice replies are on and her language has an approved voice).
      audio: m.voice_ref ? `/api/me/audio/${m.voice_ref}` : null,
      at: m.created_at,
    };
  });
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

  // Her right to see her data: everything Ubah keeps about her (never her phone number in clear,
  // and never staff names or notes about her case).
  r.get("/data", async (req, res) => {
    const g = girlOf(req);
    const [u] = await db.query<any>(`SELECT anon_id, language, channel, created_at FROM users WHERE id = $1`, [g.id]);
    const [worker] = await db.query<{ role: string }>(
      `SELECT s.role FROM assignments a JOIN staff s ON s.id = a.health_worker_id WHERE a.girl_id = $1 AND a.ended_at IS NULL AND s.active`,
      [g.id],
    );
    const messages = await db.query<any>(
      `SELECT direction, kind, body, english_text, sent_by_staff, created_at FROM messages WHERE user_id = $1 AND kind <> 'location' ORDER BY id`,
      [g.id],
    );
    const passes = await passesFor(db, g.id);
    const [voice] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM voice_notes WHERE user_id = $1`, [g.id]);
    const [devices] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [g.id]);
    res.json({
      account: { code: u.anon_id, language: u.language, channel: u.channel, joined: u.created_at, phone: "locked" },
      sharing: await consents(db, g.id),
      healthWorker: worker ? worker.role : null,
      counts: { messages: messages.length, passes: passes.length, voiceRecordings: voice.n, notificationDevices: devices.n },
      messages: messages.map((m) => ({
        at: m.created_at,
        from: m.direction === "in" ? "me" : m.sent_by_staff ? "health worker" : "Ubah",
        kind: m.kind,
        text: m.body,
        ...(m.direction === "out" && m.sent_by_staff && m.english_text ? { english: m.english_text } : {}),
      })),
      passes,
    });
  });

  // "Wipe my history": deletes her account and everything Ubah holds about her, and signs her out.
  r.delete("/", async (req, res) => {
    await eraseGirl(db, girlOf(req));
    await endGirlSession(db, req, res);
    res.status(204).end();
  });

  // "Tell me when a reply arrives": off until she switches it on on this phone.
  r.get("/push", async (req, res) => {
    const [n] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [girlOf(req).id]);
    res.json({ enabled: pushEnabled(), publicKey: pushEnabled() ? config.push.publicKey : null, devices: n.n });
  });

  r.put("/push", async (req, res) => {
    if (!pushEnabled()) return res.status(404).json({ error: "not_available" });
    if (!validEndpoint(req.body?.endpoint)) return res.status(400).json({ error: "endpoint" });
    await subscribe(db, girlOf(req).id, req.body.endpoint);
    res.json({ ok: true });
  });

  r.delete("/push", async (req, res) => {
    await unsubscribe(db, girlOf(req).id, validEndpoint(req.body?.endpoint) ? req.body.endpoint : undefined);
    res.json({ ok: true });
  });

  // What she shares with her health worker. She can change her mind at any time.
  r.put("/consents", async (req, res) => {
    const g = girlOf(req);
    const b = req.body ?? {};
    for (const k of ["messages", "voice"]) if (k in b && typeof b[k] !== "boolean") return res.status(400).json({ error: k });
    await setConsents(db, g.id, { messages: b.messages, voice: b.voice });
    res.json({ consents: await consents(db, g.id) });
  });

  // The spoken version of a reply sent to her, and only to her.
  r.get("/audio/:id", async (req, res) => {
    const id = Number(req.params.id);
    const [a] = Number.isInteger(id)
      ? await db.query<{ mime: string; bytes: Buffer | Uint8Array }>(
          `SELECT md.mime, md.bytes FROM replies r JOIN messages m ON m.id = r.sent_message_id JOIN media md ON md.id = r.voice_ref
            WHERE r.voice_ref = $1 AND m.user_id = $2 LIMIT 1`,
          [id, girlOf(req).id],
        )
      : [];
    if (!a) return res.status(404).json({ error: "not_found" });
    res.setHeader("Cache-Control", "no-store");
    res.type(a.mime).send(Buffer.from(a.bytes));
  });

  // Care: partner clinics for what she needs, and a free pass. The pass message goes into her web
  // conversation (not to WhatsApp or SMS, where someone else may read her phone).
  r.get("/clinics", async (req, res) => {
    res.json(await clinicsFor(db, String(req.query.services ?? "").split(",")));
  });

  r.post("/passes", sendLimit, async (req, res) => {
    const result = await issuePassFor(db, { ...girlOf(req), channel: "web" }, req.body?.services);
    if (result === "services") return res.status(400).json({ error: "services" });
    res.status(result.code ? 201 : 200).json(result);
  });

  r.get("/passes", async (req, res) => {
    res.json({ passes: await passesFor(db, girlOf(req).id) });
  });

  // Lessons checked by health workers, in her language.
  r.get("/learn", async (req, res) => {
    res.json(await lessonsFor(db, girlOf(req).language ?? "en"));
  });

  r.get("/messages", async (req, res) => {
    res.json({ messages: await conversation(db, girlOf(req).id, Math.max(0, Number(req.query.after) || 0)) });
  });

  // A resent message (her connection dropped after we had it) is handled once: the phone gives each
  // message an id and reuses it when it retries, like WhatsApp and Africa's Talking do.
  async function firstTime(girlId: number, raw: unknown): Promise<boolean | "invalid"> {
    if (raw === undefined || raw === null || raw === "") return true; // older clients: no id
    const id = String(raw);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return "invalid";
    const rows = await db.query(
      `INSERT INTO inbound_messages (provider, provider_id, processed_at) VALUES ('web', $1, now()) ON CONFLICT (provider, provider_id) DO NOTHING RETURNING id`,
      [`${girlId}:${id}`],
    );
    return rows.length > 0;
  }
  // If handling fails, release the id, so her phone's retry is handled instead of skipped.
  async function handleOnce(girlId: number, raw: unknown, handle: () => Promise<void>) {
    try {
      await handle();
    } catch (err) {
      if (raw) await db.query(`DELETE FROM inbound_messages WHERE provider = 'web' AND provider_id = $1`, [`${girlId}:${String(raw)}`]);
      throw err;
    }
  }

  // Text, through the same pipeline as WhatsApp and SMS.
  r.post("/messages", sendLimit, async (req, res) => {
    const g = girlOf(req);
    const text = String(req.body?.text ?? "").trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: "empty" });
    const first = await firstTime(g.id, req.body?.id);
    if (first === "invalid") return res.status(400).json({ error: "id" });
    if (first) await handleOnce(g.id, req.body?.id, () => handleIncoming(db, { channel: "web", from: "", userId: g.id, text }));
    res.json({ messages: await conversation(db, g.id, Math.max(0, Number(req.query.after) || 0)) });
  });

  // A recorded voice note (raw audio body), through the same pipeline.
  r.post("/voice", sendLimit, express.raw({ type: ["audio/*", "application/octet-stream"], limit: "2mb" }), async (req, res) => {
    const g = girlOf(req);
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length === 0) return res.status(400).json({ error: "empty" });
    const mimeType = String(req.headers["content-type"] ?? "audio/webm").split(";")[0];
    const first = await firstTime(g.id, req.headers["x-ubah-id"]);
    if (first === "invalid") return res.status(400).json({ error: "id" });
    if (first) await handleOnce(g.id, req.headers["x-ubah-id"], () => handleIncoming(db, { channel: "web", from: "", userId: g.id, voice: { audio, mimeType } }));
    res.json({ messages: await conversation(db, g.id, Math.max(0, Number(req.query.after) || 0)) });
  });

  return r;
}
