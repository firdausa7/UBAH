import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import type { Db } from "../db.js";
import { randomToken, sha256 } from "../privacy.js";
import { readCookie } from "./cookies.js";
import { refreshCaches } from "../caches.js";

// Staff sessions live in the database (only a hash of the token is stored), so logout,
// deactivation and password changes end a session at once. No girl ever logs in.

export type Role = "admin" | "nurse" | "dada" | "clinic" | "partner" | "reviewer" | "editor" | "protection";
export const ROLES: Role[] = ["admin", "nurse", "dada", "clinic", "partner", "reviewer", "editor", "protection"];
export const ALL_ROLES = ROLES;
export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  nurse: "Nurse",
  dada: "Dada",
  clinic: "Clinic desk",
  partner: "Partner (reports only)",
  reviewer: "Health-partner reviewer",
  editor: "Content editor / translator",
  protection: "Protection officer (confidential reports)",
};
export interface Staff {
  id: number;
  name: string;
  role: Role;
  login: string;
  clinic_id: number | null;
  must_change_password: boolean;
  languages: string[];
}

export type MfaMethod = "totp" | "sms" | null;

// Admin, nurse, partner, reviewer and editor use an authenticator app; Dadas get an SMS code.
// Clinic desks see only the services on a pass, so they log in with a password alone.
export function mfaMethod(role: Role): MfaMethod {
  if (!config.security.mfaRequired) return null;
  if (role === "admin" || role === "nurse" || role === "partner" || role === "reviewer" || role === "editor" || role === "protection") return "totp";
  if (role === "dada") return "sms";
  return null;
}

const COOKIE = "ubah_staff";

export interface SessionRow {
  token_hash: string;
  staff_id: number;
  mfa_passed: boolean;
}

function setCookie(res: Response, token: string) {
  const secure = config.baseUrl.startsWith("https") ? "; Secure" : "";
  res.append("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${config.security.sessionHours * 3600}`);
}

export async function createSession(db: Db, req: Request, res: Response, staffId: number, mfaPassed: boolean) {
  const token = randomToken();
  await db.query(
    `INSERT INTO staff_sessions (token_hash, staff_id, mfa_passed, expires_at, ip, user_agent) VALUES ($1,$2,$3, now() + make_interval(hours => $4), $5, $6)`,
    [sha256(token), staffId, mfaPassed, config.security.sessionHours, req.ip ?? null, String(req.headers["user-agent"] ?? "").slice(0, 200)],
  );
  setCookie(res, token);
}

// After the second factor: replace the session with a new token (prevents session fixation).
export async function upgradeSession(db: Db, req: Request, res: Response, session: SessionRow) {
  await db.query(`UPDATE staff_sessions SET revoked_at = now() WHERE token_hash = $1`, [session.token_hash]);
  await createSession(db, req, res, session.staff_id, true);
}

export async function endSession(db: Db, req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) await db.query(`UPDATE staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  res.append("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export async function revokeAllSessions(db: Db, staffId: number, exceptHash?: string) {
  await db.query(`UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL AND token_hash IS DISTINCT FROM $2`, [staffId, exceptHash ?? null]);
}

export async function readSession(db: Db, req: Request): Promise<{ session: SessionRow; staff: Staff } | null> {
  const token = readCookie(req, COOKIE);
  if (!token || token.length > 100) return null;
  const [row] = await db.query(
    `SELECT s.token_hash, s.staff_id, s.mfa_passed, s.last_seen_at,
            st.id, st.name, st.role, st.login, st.clinic_id, st.must_change_password, st.languages
       FROM staff_sessions s JOIN staff st ON st.id = s.staff_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(mins => $2) AND st.active`,
    [sha256(token), config.security.sessionIdleMinutes],
  );
  if (!row) return null;
  // Touch at most once a minute to keep writes low.
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60_000) {
    await db.query(`UPDATE staff_sessions SET last_seen_at = now() WHERE token_hash = $1`, [row.token_hash]);
  }
  return {
    session: { token_hash: row.token_hash, staff_id: row.staff_id, mfa_passed: row.mfa_passed },
    staff: { id: row.id, name: row.name, role: row.role, login: row.login, clinic_id: row.clinic_id, must_change_password: row.must_change_password, languages: row.languages ?? [] },
  };
}

const loginRedirect = (req: Request, res: Response) => res.redirect(`/staff/login?next=${encodeURIComponent(req.originalUrl)}`);

// Pages for fully signed-in staff with one of the given roles.
export function requireRole(db: Db, roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    await refreshCaches(db); // at most every 30 s: keeps published content and the DEMO DATA banner current
    const s = await readSession(db, req);
    if (!s) return loginRedirect(req, res);
    if (!s.session.mfa_passed) return res.redirect("/staff/2fa");
    if (s.staff.must_change_password && !req.path.startsWith("/password")) return res.redirect("/staff/password");
    if (!roles.includes(s.staff.role)) return res.status(403).type("html").send(`<!doctype html><meta charset="utf-8"><p>You don't have access to this page.</p><p><a href="/staff">Back</a></p>`);
    (req as any).staff = s.staff;
    (req as any).session = s.session;
    next();
  };
}

// Pages in the middle of logging in (second factor, first-time 2FA setup).
export function requirePendingSession(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const s = await readSession(db, req);
    if (!s) return res.redirect("/staff/login");
    if (s.session.mfa_passed) return res.redirect("/staff");
    (req as any).staff = s.staff;
    (req as any).session = s.session;
    next();
  };
}

export const staffOf = (req: Request): Staff => (req as any).staff;
export const sessionOf = (req: Request): SessionRow => (req as any).session;
