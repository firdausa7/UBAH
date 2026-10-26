import { Router } from "express";
import type { Db } from "../db.js";
import { workerLabel } from "../languages/index.js";
import { requireRole, workerOf } from "../auth/roles.js";
import { consents, isAssigned, logAccess } from "../auth/access.js";
import { checkAudioSignature, loadVoiceNote, signedAudioUrl } from "../voice/store.js";

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

  r.get("/girls/:id/messages", async (req, res) => {
    const w = workerOf(req);
    const girlId = Number(req.params.id);
    // The same answer for "not yours" and "doesn't exist".
    if (!Number.isInteger(girlId) || !(await isAssigned(db, w.id, girlId))) return res.status(404).json({ error: "not_found" });
    const c = await consents(db, girlId);
    const rows = await db.query(
      `SELECT id, direction, channel, kind, body, original_text, english_text, detected_language, chosen_language, stt_confidence,
              language_mismatch, voice_unclear, urgent, status, audio_ref, created_at
         FROM messages WHERE user_id = $1 AND ($2 OR urgent) ORDER BY id`,
      [girlId, c.messages],
    );
    await logAccess(db, req, girlId, "messages");
    res.json({
      consents: c,
      messages: rows.map((m: any) => ({
        id: m.id,
        direction: m.direction,
        channel: m.channel,
        kind: m.kind,
        text: m.original_text ?? m.body,
        english: m.english_text,
        detectedLanguage: m.detected_language,
        chosenLanguage: m.chosen_language,
        confidence: m.stt_confidence,
        languageMismatch: m.language_mismatch,
        audioUnclear: m.voice_unclear,
        urgent: m.urgent,
        status: m.status,
        audioUrl: m.audio_ref && c.voice ? signedAudioUrl(m.audio_ref, w.id) : null,
        at: m.created_at,
      })),
    });
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
