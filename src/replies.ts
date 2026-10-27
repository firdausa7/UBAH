import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { sendToUser, type UserRow } from "./channels/outbound.js";
import { fromEnglish } from "./providers/translation.js";
import { spokenReply } from "./providers/voice.js";
import { caseEvent } from "./cases.js";
import { FALLBACK } from "./languages/index.js";

// A health worker's reply. The worker writes in English; she receives it in her language:
//   1. an approved answer template (checked by a native speaker) when the English matches one;
//   2. otherwise machine translation, marked as such;
//   3. English needs neither.
// It goes back over the channel her message came in on. A person always wrote it: nothing here
// generates health advice, and if translation fails nothing is sent (the worker is told to retry).

export type ReplySource = "template" | "machine" | "none";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");

export interface Template {
  id: number;
  language: string;
  english: string;
  translated: string;
  reviewedBy: string;
}

// Templates a native speaker has checked, for one language.
export async function reviewedTemplates(db: Db, language: string): Promise<Template[]> {
  const rows = await db.query<any>(
    `SELECT id, language, english_text, translated_text, reviewed_by FROM answer_templates
      WHERE active AND language = $1 AND reviewed_by <> '' AND translated_text <> '' ORDER BY english_text`,
    [language],
  );
  return rows.map((r) => ({ id: r.id, language: r.language, english: r.english_text, translated: r.translated_text, reviewedBy: r.reviewed_by }));
}

export async function matchTemplate(db: Db, language: string, english: string): Promise<Template | null> {
  const n = norm(english);
  return (await reviewedTemplates(db, language)).find((t) => norm(t.english) === n) ?? null;
}

export async function chooseTranslation(db: Db, language: string, english: string): Promise<{ ok: true; text: string; source: ReplySource } | { ok: false }> {
  if (language === FALLBACK) return { ok: true, text: english, source: "none" };
  const t = await matchTemplate(db, language, english);
  if (t) return { ok: true, text: t.translated, source: "template" };
  const m = await fromEnglish(english, language);
  if (!m.ok) return { ok: false };
  return { ok: true, text: m.text, source: m.provider === "none" ? "none" : "machine" };
}

export type ReplyResult = { ok: true; replyId: number; source: ReplySource; translated: string; sentMessageId: number | null } | { ok: false; error: "not_found" | "empty" | "translation_failed" };

export async function replyToMessage(db: Db, workerId: number, messageId: number, englishRaw: string): Promise<ReplyResult> {
  const english = englishRaw.trim().slice(0, 1600);
  if (!english) return { ok: false, error: "empty" };
  const [m] = await db.query<{ id: number; user_id: number; channel: string; status: string }>(`SELECT id, user_id, channel, status FROM messages WHERE id = $1 AND direction = 'in'`, [messageId]);
  if (!m) return { ok: false, error: "not_found" };
  const [user] = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [m.user_id]);
  if (!user) return { ok: false, error: "not_found" };
  const language = user.language ?? FALLBACK;
  const t = await chooseTranslation(db, language, english);
  if (!t.ok) return { ok: false, error: "translation_failed" };

  // A spoken version only when switched on and her language has an approved voice.
  let voiceRef: number | null = null;
  const spoken = await spokenReply(t.text, language);
  if (spoken) {
    const [v] = await db.query<{ id: number }>(`INSERT INTO media (mime, bytes, size, sha256, filename) VALUES ($1,$2,$3,$4,'reply.mp3') RETURNING id`, [
      spoken.mime,
      spoken.audio,
      spoken.audio.length,
      createHash("sha256").update(spoken.audio).digest("hex"),
    ]);
    voiceRef = v.id;
  }

  // Back over the channel her message came in on.
  const channel = m.channel === "simulator" ? user.channel : m.channel;
  const sentMessageId = await sendToUser(db, { ...user, channel }, t.text, null, workerId, { englishText: english, englishSource: t.source, audioMediaId: voiceRef });
  const [r] = await db.query<{ id: number }>(
    `INSERT INTO replies (message_id, worker_id, english_text, translated_text, translation_source, voice_ref, sent_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [m.id, workerId, english, t.text, t.source, voiceRef, sentMessageId],
  );
  if (m.status === "new") await db.query(`UPDATE messages SET status = 'open' WHERE id = $1`, [m.id]);
  // Her open case (if any) records the reply, so /staff and the reminders see it was answered.
  const cases = await db.query<{ id: number }>(
    `UPDATE cases SET first_reply_at = COALESCE(first_reply_at, now()) WHERE user_id = $1 AND status = 'open' RETURNING id`,
    [user.id],
  );
  for (const c of cases) await caseEvent(db, c.id, workerId, "reply", { messageId: sentMessageId, via: "worker" });
  return { ok: true, replyId: r.id, source: t.source, translated: t.text, sentMessageId };
}

// Resolved: the conversation is done for now, and her recording is deleted at once.
export async function resolveMessage(db: Db, messageId: number): Promise<boolean> {
  const [m] = await db.query<{ audio_ref: number | null }>(`UPDATE messages SET status = 'resolved' WHERE id = $1 AND direction = 'in' RETURNING audio_ref`, [messageId]);
  if (!m) return false;
  if (m.audio_ref) await db.query(`DELETE FROM voice_notes WHERE id = $1`, [m.audio_ref]);
  return true;
}
