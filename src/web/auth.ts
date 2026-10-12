import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import type { Db } from "../db.js";

// Staff sessions: a signed cookie "<staffId>.<expiresMs>.<signature>". No girl ever logs in.

export type Role = "admin" | "nurse" | "dada" | "clinic" | "partner";
export interface Staff {
  id: number;
  name: string;
  role: Role;
  login: string;
  clinic_id: number | null;
}

const COOKIE = "ubah_staff";
const sign = (v: string) => createHmac("sha256", config.sessionSecret).update(v).digest("base64url");

export function setSession(res: Response, staffId: number, hours = 12) {
  const value = `${staffId}.${Date.now() + hours * 3600e3}`;
  const secure = config.baseUrl.startsWith("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${value}.${sign(value)}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${hours * 3600}`);
}

export function clearSession(res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function readSession(req: Request): number | null {
  const raw = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [id, exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!id || !exp || !sig) return null;
  const expected = Buffer.from(sign(`${id}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(id);
}

export function requireRole(db: Db, roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const id = readSession(req);
    if (!id) return res.redirect(`/staff/login?next=${encodeURIComponent(req.originalUrl)}`);
    const [staff] = await db.query<Staff>(`SELECT id, name, role, login, clinic_id FROM staff WHERE id = $1 AND active`, [id]);
    if (!staff) return res.redirect("/staff/login");
    if (!roles.includes(staff.role)) return res.status(403).send("You don't have access to this page.");
    (req as any).staff = staff;
    next();
  };
}

export const staffOf = (req: Request): Staff => (req as any).staff;
