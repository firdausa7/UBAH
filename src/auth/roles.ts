import type { Request, Response, NextFunction } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { randomToken, sha256 } from "../privacy.js";
import { readCookie } from "../web/cookies.js";
import { readSession, type Role as StaffRole, type Staff } from "../web/auth.js";
import type { UserRow } from "../channels/outbound.js";

// One login for everyone, routed by role:
//   girl           a girl (users table), signed in with her phone and PIN
//   health_worker  a nurse or Dada (staff table)
//   admin          an admin (staff table)
//   staff          other back-office roles (clinic desk, partner, reviewer, editor): they work in /staff
// Staff keep their existing sessions and two-step login; girls get their own session cookie.

export type AppRole = "girl" | "health_worker" | "admin" | "staff";

export function appRoleOf(role: StaffRole): AppRole {
  if (role === "nurse" || role === "dada") return "health_worker";
  if (role === "admin") return "admin";
  return "staff";
}

export const HOME: Record<AppRole, string> = { girl: "/me", health_worker: "/worker", admin: "/admin", staff: "/staff" };

export type Actor = { role: "girl"; girl: UserRow } | { role: Exclude<AppRole, "girl">; staff: Staff };

// ---- Girls' sessions ----

const GIRL_COOKIE = "ubah_girl";
const GIRL_SESSION_DAYS = 7;
const GIRL_IDLE_HOURS = 48; // a shared phone left signed in locks itself

function girlCookie(res: Response, token: string, maxAge: number) {
  const secure = config.baseUrl.startsWith("https") ? "; Secure" : "";
  res.append("Set-Cookie", `${GIRL_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${maxAge}`);
}

export async function createGirlSession(db: Db, res: Response, userId: number) {
  const token = randomToken();
  await db.query(`INSERT INTO girl_sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))`, [sha256(token), userId, GIRL_SESSION_DAYS]);
  girlCookie(res, token, GIRL_SESSION_DAYS * 86400);
}

export async function endGirlSession(db: Db, req: Request, res: Response) {
  const token = readCookie(req, GIRL_COOKIE);
  if (token) await db.query(`UPDATE girl_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  girlCookie(res, "", 0);
}

export async function readGirlSession(db: Db, req: Request): Promise<UserRow | null> {
  const token = readCookie(req, GIRL_COOKIE);
  if (!token || token.length > 100) return null;
  const [row] = await db.query<UserRow & { session_seen: string }>(
    `SELECT u.*, s.last_seen_at AS session_seen FROM girl_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(hours => $2)`,
    [sha256(token), GIRL_IDLE_HOURS],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.session_seen).getTime() > 60_000) await db.query(`UPDATE girl_sessions SET last_seen_at = now() WHERE token_hash = $1`, [sha256(token)]);
  delete (row as any).session_seen;
  return row;
}

// Whoever is signed in (a girl, or fully signed-in staff), or null.
export async function readActor(db: Db, req: Request): Promise<Actor | null> {
  const s = await readSession(db, req);
  if (s && s.session.mfa_passed && !s.staff.must_change_password) return { role: appRoleOf(s.staff.role) as Exclude<AppRole, "girl">, staff: s.staff };
  const girl = await readGirlSession(db, req);
  return girl ? { role: "girl", girl } : null;
}

// Server-side guard for every /api/me, /api/worker and /api/admin route. The React guards are only for comfort.
export function requireRole(db: Db, roles: AppRole[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const actor = await readActor(db, req);
    if (!actor) return res.status(401).json({ error: "not_signed_in" });
    if (!roles.includes(actor.role)) return res.status(403).json({ error: "forbidden" });
    (req as any).actor = actor;
    if (actor.role !== "girl") (req as any).staff = actor.staff; // for auditReq()
    next();
  };
}

export const actorOf = (req: Request): Actor => (req as any).actor;
export const girlOf = (req: Request): UserRow => (actorOf(req) as Extract<Actor, { role: "girl" }>).girl;
export const workerOf = (req: Request): Staff => (actorOf(req) as Extract<Actor, { staff: Staff }>).staff;
