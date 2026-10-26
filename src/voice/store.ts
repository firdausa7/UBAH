import { createHmac } from "node:crypto";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { decryptBytes, encryptBytes, safeEqual } from "../privacy.js";

// Girls' voice notes, kept only so her health worker can listen to them.
// Encrypted in the database; reached only through a link that works for one worker for 5 minutes;
// deleted after 30 days, or as soon as the message is resolved.

export const VOICE_KEEP_DAYS = 30;
export const AUDIO_LINK_SECONDS = 300;

export async function saveVoiceNote(db: Db, userId: number, mime: string, audio: Buffer): Promise<number> {
  const [v] = await db.query<{ id: number }>(
    `INSERT INTO voice_notes (user_id, mime, bytes_enc, size, delete_after) VALUES ($1,$2,$3,$4, now() + make_interval(days => $5)) RETURNING id`,
    [userId, mime, encryptBytes(audio), audio.length, VOICE_KEEP_DAYS],
  );
  return v.id;
}

export async function loadVoiceNote(db: Db, id: number): Promise<{ userId: number; mime: string; audio: Buffer } | null> {
  const [v] = await db.query<{ user_id: number; mime: string; bytes_enc: Buffer | Uint8Array }>(
    `SELECT user_id, mime, bytes_enc FROM voice_notes WHERE id = $1 AND delete_after > now()`,
    [id],
  );
  return v ? { userId: v.user_id, mime: v.mime, audio: decryptBytes(Buffer.from(v.bytes_enc)) } : null;
}

const sign = (id: number, staffId: number, exp: number) => createHmac("sha256", config.hashSecret).update(`audio:${id}:${staffId}:${exp}`).digest("base64url");

// A link to one voice note, for one worker, for a few minutes.
export function signedAudioUrl(id: number, staffId: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + AUDIO_LINK_SECONDS;
  return `/api/audio/${id}?exp=${exp}&sig=${sign(id, staffId, exp)}`;
}

export function checkAudioSignature(id: number, staffId: number, exp: unknown, sig: unknown, now = Date.now()): boolean {
  const e = Number(exp);
  if (!Number.isInteger(e) || e < Math.floor(now / 1000) || e > Math.floor(now / 1000) + AUDIO_LINK_SECONDS) return false;
  return typeof sig === "string" && safeEqual(sig, sign(id, staffId, e));
}

// Run by the job sweep: drops expired notes and the notes of resolved messages.
export async function purgeVoiceNotes(db: Db): Promise<number> {
  const gone = await db.query(
    `DELETE FROM voice_notes v WHERE v.delete_after <= now()
        OR EXISTS (SELECT 1 FROM messages m WHERE m.audio_ref = v.id AND m.status = 'resolved') RETURNING v.id`,
  );
  return gone.length;
}
