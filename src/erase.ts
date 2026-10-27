import type { Db } from "./db.js";

// A girl's right to erasure: her account and everything linked to it (messages, replies, passes,
// check-ins, cases, consents, assignments, sessions, voice notes) go with the users row; the outbox
// is keyed by her phone hash, so it is cleared too. The access log keeps only that someone looked,
// never what. Used by DELETE on every channel and "Wipe my history" in the app.
export async function eraseGirl(db: Db, user: { id: number; phone_hash: string }) {
  // Spoken versions of replies to her live in media, which nothing deletes on its own: drop them first.
  const audio = await db.query<{ voice_ref: number }>(
    `SELECT DISTINCT r.voice_ref FROM replies r JOIN messages m ON m.id = r.message_id WHERE m.user_id = $1 AND r.voice_ref IS NOT NULL`,
    [user.id],
  );
  await db.query(`DELETE FROM users WHERE id = $1`, [user.id]);
  for (const a of audio) await db.query(`DELETE FROM media WHERE id = $1`, [a.voice_ref]);
  await db.query(`DELETE FROM outbox WHERE to_hash = $1`, [user.phone_hash]);
}
