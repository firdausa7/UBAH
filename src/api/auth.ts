import { Router, type RequestHandler } from "express";
import type { Db } from "../db.js";
import { audit } from "../audit.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../privacy.js";
import { createSession, endSession, mfaMethod, readSession, upgradeSession } from "../web/auth.js";
import { checkSmsCode, checkTotp, isLocked, loadStaff, registerFailure, sendLoginCode, useRecoveryCode } from "../web/login.js";
import { appRoleOf, createGirlSession, endGirlSession, HOME, lockGirlSession, readActor, readGirlSession, unlockGirlSession } from "../auth/roles.js";
import { checkPin, sendGirlCode, verifyCodeAndSetPin, verifyGirlPin } from "../auth/girls.js";
import { languageConfig } from "../languages/index.js";

// /api/auth: one login for everyone. Girls: phone + SMS code (once) + PIN. Staff: login + password,
// then their usual second step (authenticator app or SMS code). Errors never say whether an account exists.

export function authApi(db: Db, opts: { loginLimiter: RequestHandler }): Router {
  const r = Router();
  const str = (v: unknown, max = 100) => String(v ?? "").trim().slice(0, max);

  r.get("/session", async (req, res) => {
    const a = await readActor(db, req);
    if (!a) return res.status(401).json({ error: "not_signed_in" });
    if (a.role === "girl") return res.json({ role: "girl", home: HOME.girl, language: a.girl.language, locked: a.locked, ...(a.locked ? {} : { anonId: a.girl.anon_id }) });
    res.json({ role: a.role, home: HOME[a.role], name: a.staff.name });
  });

  // ---- Girls ----

  r.post("/girl/code", opts.loginLimiter, async (req, res) => {
    const result = await sendGirlCode(db, str(req.body?.phone, 30));
    if (result === "invalid") return res.status(400).json({ error: "phone" });
    if (result === "wait") return res.status(429).json({ error: "wait" });
    res.json({ ok: true });
  });

  // First time on this phone, or a forgotten PIN: the SMS code, then her new PIN.
  r.post("/girl/verify", opts.loginLimiter, async (req, res) => {
    const lang = str(req.body?.language, 5);
    const u = await verifyCodeAndSetPin(db, str(req.body?.phone, 30), str(req.body?.code, 10), str(req.body?.pin, 10), languageConfig(lang) ? lang : undefined);
    if (typeof u === "string") return res.status(u === "bad_code" ? 401 : 400).json({ error: u });
    await createGirlSession(db, res, u.id);
    res.json({ role: "girl", home: HOME.girl, language: u.language });
  });

  r.post("/girl/pin", opts.loginLimiter, async (req, res) => {
    const u = await checkPin(db, str(req.body?.phone, 30), str(req.body?.pin, 10));
    if (u === "wrong") return res.status(401).json({ error: "wrong" });
    if (u === "locked") return res.status(423).json({ error: "locked" });
    await createGirlSession(db, res, u.id);
    res.json({ role: "girl", home: HOME.girl, language: u.language });
  });

  // Her session locked itself (unused for a while): her PIN opens it again. Too many wrong PINs end
  // the session, and she signs in again with an SMS code.
  r.post("/girl/unlock", opts.loginLimiter, async (req, res) => {
    const g = await readGirlSession(db, req);
    if (!g) return res.status(401).json({ error: "not_signed_in" });
    const [u] = await db.query(`SELECT * FROM users WHERE id = $1`, [g.user.id]);
    const r = await verifyGirlPin(db, u, str(req.body?.pin, 10));
    if (r === "wrong") return res.status(401).json({ error: "wrong" });
    if (r === "locked") {
      await endGirlSession(db, req, res);
      return res.status(423).json({ error: "locked" });
    }
    await unlockGirlSession(db, g.tokenHash);
    res.json({ ok: true });
  });

  // Quick exit: lock her session at once, so the next person to open the phone needs her PIN.
  r.post("/girl/lock", async (req, res) => {
    const g = await readGirlSession(db, req);
    if (g) await lockGirlSession(db, g.tokenHash);
    res.json({ ok: true });
  });

  // ---- Staff (same accounts, sessions and two-step login as /staff/login) ----

  r.post("/staff", opts.loginLimiter, async (req, res) => {
    const login = str(req.body?.login).toLowerCase();
    const password = String(req.body?.password ?? "");
    const s = login ? await loadStaff(db, "login", login) : undefined;
    if (!s || !s.active) {
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      await audit(db, { action: "login.failed", details: { reason: "unknown_or_inactive", via: "api" }, ip: req.ip });
      return res.status(401).json({ error: "wrong" });
    }
    if (isLocked(s) || !verifyPassword(password, s.password_hash)) {
      if (!isLocked(s)) await registerFailure(db, req, s, "password");
      return res.status(401).json({ error: "wrong" });
    }
    const method = mfaMethod(s.role);
    await createSession(db, req, res, s.id, method === null);
    if (method === null) return res.json(await done(s.id, req.ip));
    // First-time authenticator setup shows a QR code: it stays on the existing page.
    if (method === "totp" && !s.totp_enabled_at) return res.json({ step: "setup", redirect: "/staff/2fa/setup" });
    if (method === "sms" && (await sendLoginCode(db, s, req)) === "no_phone") {
      await endSession(db, req, res);
      return res.status(409).json({ error: "no_phone" });
    }
    res.json({ step: "code", method });
  });

  r.post("/staff/code", opts.loginLimiter, async (req, res) => {
    const pending = await readSession(db, req);
    if (!pending || pending.session.mfa_passed) return res.status(401).json({ error: "not_signed_in" });
    const s = (await loadStaff(db, "id", pending.staff.id))!;
    const method = mfaMethod(s.role);
    const recovery = str(req.body?.recovery, 40);
    const code = str(req.body?.code, 10);
    let ok = false;
    if (isLocked(s)) ok = false;
    else if (method === "totp" && recovery) ok = await useRecoveryCode(db, s, recovery);
    else if (method === "totp") ok = await checkTotp(db, s, code);
    else if (method === "sms") ok = await checkSmsCode(db, s, code);
    if (!ok) {
      if (isLocked(s) || (await registerFailure(db, req, s, "mfa"))) {
        await endSession(db, req, res);
        return res.status(423).json({ error: "locked" });
      }
      return res.status(401).json({ error: "wrong" });
    }
    if (recovery) await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.recovery_code_used", targetType: "staff", targetId: s.id, ip: req.ip });
    await upgradeSession(db, req, res, pending.session);
    res.json(await done(s.id, req.ip));
  });

  r.post("/staff/code/resend", opts.loginLimiter, async (req, res) => {
    const pending = await readSession(db, req);
    if (!pending || pending.session.mfa_passed) return res.status(401).json({ error: "not_signed_in" });
    const s = (await loadStaff(db, "id", pending.staff.id))!;
    if (mfaMethod(s.role) !== "sms") return res.status(400).json({ error: "not_sms" });
    const sent = await sendLoginCode(db, s, req);
    res.status(sent === "sent" ? 200 : 429).json(sent === "sent" ? { ok: true } : { error: sent });
  });

  async function done(staffId: number, ip: string | undefined) {
    const s = (await loadStaff(db, "id", staffId))!;
    await db.query(`UPDATE staff SET failed_logins = 0, last_login_at = now() WHERE id = $1`, [s.id]);
    await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.success", targetType: "staff", targetId: s.id, details: { via: "api" }, ip });
    if (s.must_change_password) return { step: "password", redirect: "/staff/password" };
    const role = appRoleOf(s.role);
    return { step: "done", role, home: HOME[role] };
  }

  r.post("/logout", async (req, res) => {
    await endSession(db, req, res);
    await endGirlSession(db, req, res);
    res.json({ ok: true });
  });

  return r;
}
