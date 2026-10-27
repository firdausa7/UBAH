import { randomInt } from "node:crypto";
import type { Db } from "../db.js";
import { encryptPhone, hashPassword, hashPhone, newAnonId, normalizePhone, sha256, verifyPassword, DUMMY_PASSWORD_HASH } from "../privacy.js";
import { sendSms } from "../channels/sms.js";
import { resolveLanguage } from "../languages/index.js";
import type { UserRow } from "../channels/outbound.js";

// Girls sign in on the web with her phone: an SMS code once (to prove the number is hers), then a
// 4-digit PIN she chooses. Five wrong PINs and she needs a new SMS code.
// The same phone on WhatsApp or SMS is the same girl (same row in users).

const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MINUTES = 30;

export function validPhone(raw: string): boolean {
  const p = normalizePhone(String(raw ?? ""));
  return /^\d{9,15}$/.test(p);
}

export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "pin_format";
  if (/^(\d)\1{3}$/.test(pin) || ["1234", "4321", "0123", "9876"].includes(pin)) return "pin_too_easy";
  return null;
}

// Sends a 6-digit code. The SMS never says "Ubah" or anything about health: phones are shared.
export async function sendGirlCode(db: Db, phone: string): Promise<"sent" | "wait" | "invalid"> {
  if (!validPhone(phone)) return "invalid";
  const hash = hashPhone(phone);
  const recent = await db.query<{ created_at: string }>(
    `SELECT created_at FROM girl_otp WHERE phone_hash = $1 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC`,
    [hash],
  );
  if (recent.length >= 5 || (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60_000)) return "wait";
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(`UPDATE girl_otp SET used_at = now() WHERE phone_hash = $1 AND used_at IS NULL`, [hash]);
  await db.query(`INSERT INTO girl_otp (phone_hash, code_hash, expires_at) VALUES ($1,$2, now() + make_interval(mins => $3))`, [hash, sha256(`${hash}:${code}`), CODE_MINUTES]);
  await sendSms(phone, `Your code: ${code}`);
  return "sent";
}

async function checkCode(db: Db, hash: string, code: string): Promise<boolean> {
  const [otp] = await db.query<{ id: number; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM girl_otp WHERE phone_hash = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [hash],
  );
  if (!otp || otp.attempts >= CODE_MAX_ATTEMPTS) return false;
  if (otp.code_hash !== sha256(`${hash}:${code.replace(/\s/g, "")}`)) {
    await db.query(`UPDATE girl_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return false;
  }
  await db.query(`UPDATE girl_otp SET used_at = now() WHERE id = $1`, [otp.id]);
  return true;
}

// A correct code proves the phone is hers: finds her (from any channel) or creates her, and sets her PIN.
// Her channel is left as it is: a girl who uses WhatsApp keeps getting replies there.
export async function verifyCodeAndSetPin(db: Db, phone: string, code: string, pin: string, language?: string): Promise<UserRow | "bad_code" | string> {
  if (!validPhone(phone)) return "bad_code";
  const problem = pinProblem(pin);
  if (problem) return problem;
  const hash = hashPhone(phone);
  if (!(await checkCode(db, hash, code))) return "bad_code";
  await db.query(`DELETE FROM pin_attempts WHERE phone_hash = $1`, [hash]); // a new SMS code unlocks
  const lang = language ? resolveLanguage(language) : null;
  const [existing] = await db.query<UserRow>(`SELECT * FROM users WHERE phone_hash = $1`, [hash]);
  if (existing) {
    const [u] = await db.query<UserRow>(
      `UPDATE users SET pin_hash = $2, phone_verified_at = now(), language = COALESCE($3, language), last_seen_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, hashPassword(pin), lang],
    );
    return u;
  }
  let anon = newAnonId();
  while ((await db.query(`SELECT 1 FROM users WHERE anon_id = $1`, [anon])).length) anon = newAnonId();
  const [u] = await db.query<UserRow>(
    `INSERT INTO users (anon_id, phone_hash, phone_enc, channel, language, state, pin_hash, phone_verified_at) VALUES ($1,$2,$3,'web',$4,$5,$6, now()) RETURNING *`,
    [anon, hash, encryptPhone(phone), lang ?? "en", JSON.stringify({ step: "free" }), hashPassword(pin)],
  );
  return u;
}

// Phone + PIN. An unknown phone and a wrong PIN get the same answer, take the same time, and lock
// out the same way: wrong tries are counted per phone number, account or not, so nobody can find out
// whether a number uses Ubah by guessing PINs.
export async function checkPin(db: Db, phone: string, pin: string): Promise<UserRow | "wrong" | "locked"> {
  if (!validPhone(phone)) {
    verifyPassword(pin, DUMMY_PASSWORD_HASH);
    return "wrong";
  }
  const hash = hashPhone(phone);
  const [u] = await db.query<UserRow & { pin_hash: string | null }>(`SELECT * FROM users WHERE phone_hash = $1`, [hash]);
  return verifyPinFor(db, hash, u, pin);
}

// Her PIN when her session locked itself: the same count of wrong tries as signing in.
export async function verifyGirlPin(db: Db, u: (UserRow & { pin_hash?: string | null }) | undefined, pin: string): Promise<UserRow | "wrong" | "locked"> {
  if (!u) {
    verifyPassword(pin, DUMMY_PASSWORD_HASH);
    return "wrong";
  }
  return verifyPinFor(db, u.phone_hash, u, pin);
}

async function verifyPinFor(db: Db, hash: string, u: (UserRow & { pin_hash?: string | null }) | undefined, pin: string): Promise<UserRow | "wrong" | "locked"> {
  const [attempts] = await db.query<{ locked: boolean }>(`SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM pin_attempts WHERE phone_hash = $1`, [hash]);
  if (attempts?.locked) return "locked";
  const ok = u?.pin_hash ? verifyPassword(pin, u.pin_hash) : (verifyPassword(pin, DUMMY_PASSWORD_HASH), false);
  if (!ok || !u) {
    const [r] = await db.query<{ locked: boolean }>(
      `INSERT INTO pin_attempts (phone_hash, failures) VALUES ($1, 1)
       ON CONFLICT (phone_hash) DO UPDATE SET
         locked_until = CASE WHEN pin_attempts.failures + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE pin_attempts.locked_until END,
         failures = CASE WHEN pin_attempts.failures + 1 >= $2 THEN 0 ELSE pin_attempts.failures + 1 END,
         updated_at = now()
       RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
      [hash, PIN_MAX_FAILURES, PIN_LOCK_MINUTES],
    );
    return r?.locked ? "locked" : "wrong";
  }
  await db.query(`DELETE FROM pin_attempts WHERE phone_hash = $1`, [hash]);
  await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [u.id]);
  return u;
}
