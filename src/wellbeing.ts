import type { Db } from "./db.js";
import { decryptSecret, encryptSecret } from "./privacy.js";
import { findDangerWords, worstDanger } from "./ml/dangerWords.js";
import { analyse } from "./ml/models.js";

// Her private wellbeing: mood check-ins (1 very low … 5 very good) and a journal.
// - Only she can read it: no staff route exists. The text is encrypted at rest.
// - It is never sent anywhere (no translation, no AI): danger is checked with Ubah's own word lists
//   and rules only.
// - Nothing here tells staff. If she writes about danger, or her mood has been very low, Ubah offers
//   HER a way to reach a person now; she decides. (Messages she sends to Ubah are different: urgent
//   ones always reach a person.) Not therapy, no diagnosis, no automatic decisions about risk.

export type SupportOffer = "urgent" | "low" | null;

export interface Entry {
  id: number;
  mood: number | null;
  note: string | null;
  at: string;
}

export async function addEntry(db: Db, userId: number, lang: string | null, mood: number | null, note: string | null): Promise<{ id: number; support: SupportOffer }> {
  const [e] = await db.query<{ id: number }>(`INSERT INTO wellbeing_entries (user_id, mood, note_enc) VALUES ($1,$2,$3) RETURNING id`, [
    userId,
    mood,
    note ? encryptSecret(note) : null,
  ]);
  return { id: e.id, support: await supportFor(db, userId, lang, mood, note) };
}

async function supportFor(db: Db, userId: number, lang: string | null, mood: number | null, note: string | null): Promise<SupportOffer> {
  if (note && (worstDanger(findDangerWords(note)) || analyse(note, lang).danger !== "none")) return "urgent";
  if (mood === 1) return "low";
  // Three low check-ins in a row (very low or low).
  const last = await db.query<{ mood: number | null }>(`SELECT mood FROM wellbeing_entries WHERE user_id = $1 AND mood IS NOT NULL ORDER BY id DESC LIMIT 3`, [userId]);
  if (last.length === 3 && last.every((m) => (m.mood ?? 5) <= 2)) return "low";
  return null;
}

export async function entriesOf(db: Db, userId: number, limit = 100): Promise<Entry[]> {
  const rows = await db.query<{ id: number; mood: number | null; note_enc: string | null; created_at: string }>(
    `SELECT id, mood, note_enc, created_at FROM wellbeing_entries WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ id: r.id, mood: r.mood, note: r.note_enc ? decryptSecret(r.note_enc) : null, at: r.created_at }));
}

export async function deleteEntry(db: Db, userId: number, id: number): Promise<boolean> {
  return (await db.query(`DELETE FROM wellbeing_entries WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId])).length > 0;
}
