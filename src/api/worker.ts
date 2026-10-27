import { Router } from "express";
import type { Db } from "../db.js";
import { languageConfig, workerLabel } from "../languages/index.js";
import { requireRole, workerOf } from "../auth/roles.js";
import { consents, isAssigned, logAccess } from "../auth/access.js";
import { checkAudioSignature, loadVoiceNote, signedAudioUrl } from "../voice/store.js";
import { auditReq } from "../audit.js";
import { replyToMessage, resolveMessage, reviewedTemplates } from "../replies.js";

const MESSAGE_COLUMNS = `m.id, m.user_id, m.direction, m.channel, m.kind, m.body, m.original_text, m.english_text, m.english_source, m.translation_failed,
  m.detected_language, m.chosen_language, m.stt_confidence, m.language_mismatch, m.voice_unclear, m.urgent, m.urgent_reason, m.status, m.audio_ref, m.sent_by_staff, m.created_at`;

// What a worker sees of one message. Machine translations are labelled; the original is always there.
function toWorkerMessage(m: any, workerId: number, shareVoice: boolean) {
  return {
    id: m.id,
    girlId: m.user_id,
    direction: m.direction,
    sender: m.direction === "in" ? "girl" : m.sent_by_staff ? "worker" : "ubah",
    channel: m.channel,
    kind: m.kind,
    text: m.original_text ?? m.body,
    english: m.english_text,
    englishSource: m.english_source, // machine: "machine translated, check meaning"
    translationFailed: m.translation_failed,
    detectedLanguage: m.detected_language,
    detectedLanguageLabel: m.detected_language ? workerLabel(m.detected_language) : null,
    chosenLanguage: m.chosen_language,
    chosenLanguageLabel: m.chosen_language ? workerLabel(m.chosen_language) : null,
    languageMismatch: m.language_mismatch,
    confidence: m.stt_confidence,
    audioUnclear: m.voice_unclear, // "audio unclear, please listen"
    urgent: m.urgent,
    urgentReason: m.urgent_reason,
    status: m.status,
    audioUrl: m.audio_ref && shareVoice ? signedAudioUrl(m.audio_ref, workerId) : null,
    at: m.created_at,
  };
}

// Latest consent per girl and scope, as SQL (for the inbox query).
const SHARES = (scope: "messages" | "voice") =>
  `COALESCE((SELECT granted FROM consents k WHERE k.user_id = m.user_id AND k.scope = '${scope}' ORDER BY k.id DESC LIMIT 1), FALSE)`;

// /api/worker: a health worker sees only the girls assigned to them, and of each girl only what
// she agreed to share (urgent messages always). Every look is written to access_log.

export function workerApi(db: Db): Router {
  const r = Router();
  r.use(requireRole(db, ["health_worker"]));

  r.get("/girls", async (req, res) => {
    const w = workerOf(req);
    const rows = await db.query<{ id: number; anon_id: string; language: string | null; channel: string; last_in: string | null }>(
      `SELECT u.id, u.anon_id, u.language, u.channel,
              (SELECT max(created_at) FROM messages m WHERE m.user_id = u.id AND m.direction = 'in') AS last_in
         FROM assignments a JOIN users u ON u.id = a.girl_id
        WHERE a.health_worker_id = $1 AND a.ended_at IS NULL
        ORDER BY last_in DESC NULLS LAST, u.id`,
      [w.id],
    );
    const girls = [];
    for (const g of rows) {
      await logAccess(db, req, g.id, "profile");
      girls.push({ id: g.id, anonId: g.anon_id, language: g.language, languageLabel: workerLabel(g.language), channel: g.channel, lastMessageAt: g.last_in, consents: await consents(db, g.id) });
    }
    res.json({ girls });
  });

  // Messages from her girls: urgent first, then newest. Only what each girl shares (urgent always),
  // and only real messages: menu numbers and commands (DADA, STOP…) are left out.
  r.get("/inbox", async (req, res) => {
    const w = workerOf(req);
    const q = (k: string, ok: (v: string) => boolean) => {
      const v = String(req.query[k] ?? "");
      return ok(v) ? v : "";
    };
    const language = q("language", (v) => Boolean(languageConfig(v)));
    const channel = q("channel", (v) => ["web", "whatsapp", "sms", "app", "simulator"].includes(v));
    const status = q("status", (v) => ["new", "open", "resolved"].includes(v));
    const rows = await db.query<any>(
      `SELECT ${MESSAGE_COLUMNS}, u.anon_id, u.language AS girl_language, ${SHARES("voice")} AS share_voice
         FROM messages m
         JOIN assignments a ON a.girl_id = m.user_id AND a.health_worker_id = $1 AND a.ended_at IS NULL
         JOIN users u ON u.id = m.user_id
        WHERE m.direction = 'in' AND (m.urgent OR ${SHARES("messages")})
          AND (m.urgent OR (m.body ~ '[[:alpha:]]{3,}' AND upper(btrim(m.body)) NOT IN ('STOP','DELETE','HELP','MENU','DADA','SHARE','VOICE','PRIVATE')))
          AND ($2 = '' OR u.language = $2) AND ($3 = '' OR m.channel = $3) AND ($4 = '' OR m.status = $4)
        ORDER BY m.urgent DESC, m.created_at DESC, m.id DESC LIMIT 200`,
      [w.id, language, channel, status],
    );
    for (const id of new Set(rows.map((m) => m.user_id as number))) await logAccess(db, req, id, "messages");
    res.json({
      messages: rows.map((m) => ({ ...toWorkerMessage(m, w.id, m.share_voice), girl: { id: m.user_id, anonId: m.anon_id, language: m.girl_language, languageLabel: workerLabel(m.girl_language) } })),
    });
  });

  // One message, its replies, and the reply suggestions for her language. Opening it marks it "open".
  async function loadMine(req: any, res: any) {
    const w = workerOf(req);
    const id = Number(req.params.id);
    const [m] = Number.isInteger(id) ? await db.query<any>(`SELECT ${MESSAGE_COLUMNS}, ${SHARES("messages")} AS share_messages, ${SHARES("voice")} AS share_voice FROM messages m WHERE m.id = $1 AND m.direction = 'in'`, [id]) : [];
    // "Not yours", "not shared" and "doesn't exist" look the same.
    if (!m || !(await isAssigned(db, w.id, m.user_id)) || !(m.urgent || m.share_messages)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return m;
  }

  r.get("/messages/:id", async (req, res) => {
    const w = workerOf(req);
    const m = await loadMine(req, res);
    if (!m) return;
    await logAccess(db, req, m.user_id, "message", m.id);
    if (m.status === "new") {
      await db.query(`UPDATE messages SET status = 'open' WHERE id = $1`, [m.id]);
      m.status = "open";
    }
    const [girl] = await db.query<any>(`SELECT id, anon_id, language, channel FROM users WHERE id = $1`, [m.user_id]);
    const replies = await db.query<any>(
      `SELECT r.id, r.english_text, r.translated_text, r.translation_source, r.created_at, s.name AS worker FROM replies r JOIN staff s ON s.id = r.worker_id WHERE r.message_id = $1 ORDER BY r.id`,
      [m.id],
    );
    res.json({
      message: toWorkerMessage(m, w.id, m.share_voice),
      girl: { id: girl.id, anonId: girl.anon_id, language: girl.language, languageLabel: workerLabel(girl.language) },
      replies: replies.map((r) => ({ id: r.id, english: r.english_text, translated: r.translated_text, source: r.translation_source, worker: r.worker, at: r.created_at })),
      templates: (await reviewedTemplates(db, girl.language ?? "en")).map((t) => ({ id: t.id, english: t.english, translated: t.translated })),
    });
  });

  r.post("/messages/:id/reply", async (req, res) => {
    const w = workerOf(req);
    const m = await loadMine(req, res);
    if (!m) return;
    const result = await replyToMessage(db, w.id, m.id, String(req.body?.english ?? ""));
    if (!result.ok) return res.status(result.error === "translation_failed" ? 502 : 400).json({ error: result.error });
    await logAccess(db, req, m.user_id, "message", m.id);
    await auditReq(db, req, { action: "message.reply", targetType: "message", targetId: m.id, details: { replyId: result.replyId, source: result.source } });
    res.json({ replyId: result.replyId, source: result.source, translated: result.translated });
  });

  r.post("/messages/:id/resolve", async (req, res) => {
    const m = await loadMine(req, res);
    if (!m) return;
    await resolveMessage(db, m.id);
    await auditReq(db, req, { action: "message.resolve", targetType: "message", targetId: m.id });
    res.json({ status: "resolved" });
  });

  r.get("/girls/:id/messages", async (req, res) => {
    const w = workerOf(req);
    const girlId = Number(req.params.id);
    // The same answer for "not yours" and "doesn't exist".
    if (!Number.isInteger(girlId) || !(await isAssigned(db, w.id, girlId))) return res.status(404).json({ error: "not_found" });
    const c = await consents(db, girlId);
    // The last 50, oldest first: enough context for a reply.
    const rows = (await db.query(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.user_id = $1 AND ($2 OR m.urgent) AND m.kind <> 'location' ORDER BY m.id DESC LIMIT 50`, [girlId, c.messages])).reverse();
    await logAccess(db, req, girlId, "messages");
    res.json({ consents: c, messages: rows.map((m) => toWorkerMessage(m, w.id, c.voice)) });
  });

  return r;
}

// /api/audio/:id — a voice note, for the one worker the link was made for, within 5 minutes,
// while she is still assigned to them and still shares her voice.
export function audioApi(db: Db): Router {
  const r = Router();
  r.get("/:id", requireRole(db, ["health_worker"]), async (req, res) => {
    const w = workerOf(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !checkAudioSignature(id, w.id, req.query.exp, req.query.sig)) return res.status(403).json({ error: "link" });
    const note = await loadVoiceNote(db, id);
    if (!note || !(await isAssigned(db, w.id, note.userId)) || !(await consents(db, note.userId)).voice) return res.status(404).json({ error: "not_found" });
    await logAccess(db, req, note.userId, "voice", id);
    res.setHeader("Cache-Control", "no-store");
    res.type(note.mime).send(note.audio);
  });
  return r;
}
