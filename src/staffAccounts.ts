import type { Db } from "./db.js";
import { config } from "./config.js";
import { normalizePhone, randomToken, sha256 } from "./privacy.js";

// One-time links to set a password: "invite" for a new account, "reset" when an admin resets it.
const HOURS = { invite: 72, reset: 24 } as const;
export type TokenPurpose = keyof typeof HOURS;

export async function createStaffToken(db: Db, staffId: number, purpose: TokenPurpose, createdBy: number | null): Promise<string> {
  // Only the newest link works.
  await db.query(`UPDATE staff_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL`, [staffId]);
  const token = randomToken(24);
  await db.query(`INSERT INTO staff_tokens (token_hash, staff_id, purpose, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`, [
    sha256(token),
    staffId,
    purpose,
    createdBy,
    HOURS[purpose],
  ]);
  return token;
}

export const tokenLink = (token: string) => `${config.baseUrl}/staff/invite/${token}`;

export async function findStaffToken(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db.query<{ staff_id: number; purpose: TokenPurpose; login: string; name: string }>(
    `SELECT t.staff_id, t.purpose, s.login, s.name FROM staff_tokens t JOIN staff s ON s.id = t.staff_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND s.active`,
    [sha256(token)],
  );
  return row ?? null;
}

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

// Kenyan mobile numbers only (07.., 01.., +254..), stored in international form.
export function cleanKenyanPhone(raw: string): string | null {
  const p = normalizePhone(raw.trim());
  return /^254[17]\d{8}$/.test(p) ? `+${p}` : null;
}

export async function activeAdminCount(db: Db): Promise<number> {
  const [r] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff WHERE role = 'admin' AND active`);
  return r.n;
}
