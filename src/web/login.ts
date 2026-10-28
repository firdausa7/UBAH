import { randomInt, randomBytes } from "node:crypto";
import { Router, type Request, type Response, type RequestHandler } from "express";
import QRCode from "qrcode";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { audit, auditReq } from "../audit.js";
import { DUMMY_PASSWORD_HASH, decryptSecret, encryptSecret, hashPassword, passwordProblem, sha256, verifyPassword } from "../privacy.js";
import { newTotpSecret, otpauthUri, verifyTotp } from "../security/totp.js";
import { csrfField } from "../security/csrf.js";
import { sendSms } from "../channels/sms.js";
import { ALL_ROLES, createSession, endSession, mfaMethod, readSession, requirePendingSession, requireRole, revokeAllSessions, sessionOf, staffOf, upgradeSession, type Role } from "./auth.js";
import { page, esc, h1 } from "./html.js";
import { nav } from "./nav.js";

// Staff sign-in: password, then a second factor (authenticator app or SMS code), then the app.

export const HOME: Record<Role, string> = {
  admin: "/staff/inbox",
  nurse: "/staff/inbox",
  dada: "/staff/inbox",
  clinic: "/staff/clinic",
  partner: "/staff/dashboard",
  reviewer: "/staff/content",
  editor: "/staff/content",
  protection: "/staff/safeguarding",
};

const SMS_CODE_MINUTES = 5;
const SMS_CODE_MAX_ATTEMPTS = 5;
const RECOVERY_CODES = 8;

// Only same-site staff paths are allowed as a post-login destination.
const safeNext = (v: unknown) => {
  const s = String(v ?? "");
  return s.startsWith("/staff/") && !s.startsWith("//") && !s.includes("\\") ? s : "";
};

const card = (body: string) => `<div class="card" style="max-width:460px;margin:32px auto;padding:28px">${body}</div>`;

export interface LoginRow {
  id: number;
  login: string;
  role: Role;
  password_hash: string;
  active: boolean;
  locked_until: string | null;
  phone: string | null;
  totp_secret_enc: string | null;
  totp_enabled_at: string | null;
  totp_last_step: string | null;
  must_change_password: boolean;
}

export async function loadStaff(db: Db, where: "id" | "login", value: unknown): Promise<LoginRow | undefined> {
  const [row] = await db.query<LoginRow>(
    `SELECT id, login, role, password_hash, active, locked_until, phone, totp_secret_enc, totp_enabled_at, totp_last_step, must_change_password
       FROM staff WHERE ${where === "login" ? "lower(login) = lower($1)" : "id = $1"}`,
    [value],
  );
  return row;
}

// Counts a failed password or code. Locks the account after too many in a row.
export async function registerFailure(db: Db, req: Request, s: LoginRow, kind: "password" | "mfa"): Promise<boolean> {
  const [r] = await db.query<{ locked: boolean }>(
    `UPDATE staff SET
        locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
      WHERE id = $1 RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
    [s.id, config.security.loginMaxFailures, config.security.loginLockMinutes],
  );
  const locked = Boolean(r?.locked);
  await audit(db, {
    staffId: s.id,
    staffLogin: s.login,
    action: locked ? "login.locked" : kind === "password" ? "login.failed" : "login.mfa_failed",
    targetType: "staff",
    targetId: s.id,
    ip: req.ip,
  });
  if (locked) await revokeAllSessions(db, s.id);
  return locked;
}

export const isLocked = (s: LoginRow) => Boolean(s.locked_until && new Date(s.locked_until) > new Date());

async function completeLogin(db: Db, req: Request, s: LoginRow, next: string) {
  await db.query(`UPDATE staff SET failed_logins = 0, last_login_at = now() WHERE id = $1`, [s.id]);
  await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.success", targetType: "staff", targetId: s.id, ip: req.ip });
  if (s.must_change_password) return "/staff/password";
  return next || HOME[s.role];
}

// ---- SMS login codes (Dadas) ----

export async function sendLoginCode(db: Db, s: LoginRow, req: Request): Promise<"sent" | "wait" | "no_phone"> {
  if (!s.phone) return "no_phone";
  const recent = await db.query<{ created_at: string }>(
    `SELECT created_at FROM staff_otp WHERE staff_id = $1 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC`,
    [s.id],
  );
  if (recent.length >= 5 || (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < 60_000)) return "wait";
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(`UPDATE staff_otp SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL`, [s.id]);
  await db.query(`INSERT INTO staff_otp (staff_id, code_hash, expires_at) VALUES ($1,$2, now() + make_interval(mins => $3))`, [
    s.id,
    sha256(`${s.id}:${code}`),
    SMS_CODE_MINUTES,
  ]);
  // Sent directly (not through the outbox) so the code is never stored anywhere in clear.
  await sendSms(s.phone, `Ubah login code: ${code}. It expires in ${SMS_CODE_MINUTES} minutes. Never share it.`);
  await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.sms_code_sent", targetType: "staff", targetId: s.id, ip: req.ip });
  return "sent";
}

export async function checkSmsCode(db: Db, s: LoginRow, code: string): Promise<boolean> {
  const [otp] = await db.query<{ id: number; code_hash: string; attempts: number }>(
    `SELECT id, code_hash, attempts FROM staff_otp WHERE staff_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [s.id],
  );
  if (!otp || otp.attempts >= SMS_CODE_MAX_ATTEMPTS) return false;
  if (otp.code_hash !== sha256(`${s.id}:${code.replace(/\s/g, "")}`)) {
    await db.query(`UPDATE staff_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return false;
  }
  await db.query(`UPDATE staff_otp SET used_at = now() WHERE id = $1`, [otp.id]);
  return true;
}

// ---- Authenticator app (TOTP) ----

export async function checkTotp(db: Db, s: LoginRow, code: string): Promise<boolean> {
  if (!s.totp_secret_enc) return false;
  const step = verifyTotp(decryptSecret(s.totp_secret_enc), code, s.totp_last_step == null ? null : Number(s.totp_last_step));
  if (step == null) return false;
  await db.query(`UPDATE staff SET totp_last_step = $2 WHERE id = $1`, [s.id, step]);
  return true;
}

const normRecovery = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function useRecoveryCode(db: Db, s: LoginRow, code: string): Promise<boolean> {
  const hash = sha256(`${s.id}:${normRecovery(code)}`);
  const rows = await db.query(`UPDATE staff_recovery_codes SET used_at = now() WHERE staff_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`, [s.id, hash]);
  return rows.length > 0;
}

async function newRecoveryCodes(db: Db, staffId: number): Promise<string[]> {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
  await db.query(`DELETE FROM staff_recovery_codes WHERE staff_id = $1`, [staffId]);
  for (const c of codes) await db.query(`INSERT INTO staff_recovery_codes (staff_id, code_hash) VALUES ($1,$2)`, [staffId, sha256(`${staffId}:${normRecovery(c)}`)]);
  return codes;
}

export function loginRouter(db: Db, opts: { loginLimiter: RequestHandler }): Router {
  const r = Router();
  const pending = requirePendingSession(db);

  // ---- Password ----
  r.get("/login", async (req, res) => {
    const existing = await readSession(db, req);
    if (existing?.session.mfa_passed) return res.redirect(HOME[existing.staff.role]);
    const err = req.query.error
      ? `<div class="notice" role="alert">Wrong login or password. After ${config.security.loginMaxFailures} wrong tries an account is locked for ${config.security.loginLockMinutes} minutes.</div>`
      : req.query.expired
        ? `<div class="notice" role="alert">Your sign-in expired. Please log in again.</div>`
        : req.query.done === "password"
          ? `<div class="notice ok-notice" role="status">Password saved. Log in with your new password.</div>`
          : "";
    res.send(
      page(
        "Staff login",
        card(`${h1("Staff", "login", "Ubah team")}<p class="muted">For Dadas, nurses, clinics and partners. Girls never need an account.</p>${err}
<form method="post" action="/staff/login">${csrfField(req)}<input type="hidden" name="next" value="${esc(safeNext(req.query.next))}">
<label for="login">Login</label><input id="login" name="login" autocomplete="username" autocapitalize="none" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p style="margin-top:20px"><button class="accent" style="width:100%">Log in</button></p></form>`),
      ),
    );
  });

  r.post("/login", opts.loginLimiter, async (req, res) => {
    // Logins are lower-case; phones often capitalise the first letter, so ignore case and spaces.
    const login = String(req.body.login ?? "").trim().toLowerCase().slice(0, 100);
    const password = String(req.body.password ?? "");
    const next = safeNext(req.body.next);
    const s = login ? await loadStaff(db, "login", login) : undefined;
    if (!s || !s.active) {
      verifyPassword(password, DUMMY_PASSWORD_HASH); // same timing as a real account
      await audit(db, { action: "login.failed", details: { reason: "unknown_or_inactive" }, ip: req.ip });
      return res.redirect("/staff/login?error=1");
    }
    if (isLocked(s)) {
      await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.locked", targetType: "staff", targetId: s.id, ip: req.ip });
      return res.redirect("/staff/login?error=1");
    }
    if (!verifyPassword(password, s.password_hash)) {
      await registerFailure(db, req, s, "password");
      return res.redirect("/staff/login?error=1");
    }
    const method = mfaMethod(s.role);
    await createSession(db, req, res, s.id, method === null);
    const q = next ? `?next=${encodeURIComponent(next)}` : "";
    if (method === null) return res.redirect(await completeLogin(db, req, s, next));
    if (method === "totp" && !s.totp_enabled_at) return res.redirect(`/staff/2fa/setup${q}`);
    if (method === "sms") {
      const sent = await sendLoginCode(db, s, req);
      if (sent === "no_phone") return res.redirect("/staff/2fa?nophone=1");
    }
    res.redirect(`/staff/2fa${q}`);
  });

  // ---- Second factor ----
  r.get("/2fa", pending, async (req, res) => {
    const s = (await loadStaff(db, "id", staffOf(req).id))!;
    const method = mfaMethod(s.role);
    const next = safeNext(req.query.next);
    const nextField = `<input type="hidden" name="next" value="${esc(next)}">`;
    if (method === "totp" && !s.totp_enabled_at) return res.redirect("/staff/2fa/setup");
    if (method === "sms" && (!s.phone || req.query.nophone)) {
      await endSession(db, req, res);
      return res.send(page("No phone", card(`${h1("Login", "code", "Two-step login")}<p>Your account has no phone number for login codes. Ask an admin to add your number, then log in again.</p><p><a class="btn secondary" href="/staff/login">Back to login</a></p>`)));
    }
    const msg =
      req.query.error === "1"
        ? `<div class="notice" role="alert">That code didn't work. Check it and try again.</div>`
        : req.query.wait
          ? `<div class="notice" role="status">A code was sent recently. Please wait a minute before asking for another.</div>`
          : req.query.resent
            ? `<div class="notice" role="status">A new code is on its way.</div>`
            : "";
    const body =
      method === "sms"
        ? `${h1("Enter", "your code", "Two-step login")}<p class="muted">We sent a 6-digit code by SMS to your phone. It expires in ${SMS_CODE_MINUTES} minutes.</p>${msg}
<form method="post" action="/staff/2fa">${csrfField(req)}${nextField}<label for="code">Code from SMS</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required style="font-size:24px;letter-spacing:4px">
<p><button class="accent" style="width:100%">Continue</button></p></form>
<form method="post" action="/staff/2fa/resend">${csrfField(req)}${nextField}<button class="secondary" style="width:100%">Send a new code</button></form>`
        : `${h1("Enter", "your code", "Two-step login")}<p class="muted">Open your authenticator app and type the 6-digit code for Ubah.</p>${msg}
<form method="post" action="/staff/2fa">${csrfField(req)}${nextField}<label for="code">Code from your app</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" required style="font-size:24px;letter-spacing:4px">
<p><button class="accent" style="width:100%">Continue</button></p></form>
<details><summary>Lost your phone? Use a recovery code</summary>
<form method="post" action="/staff/2fa">${csrfField(req)}${nextField}<label for="recovery">Recovery code</label><input id="recovery" name="recovery" autocomplete="off" required>
<p><button class="secondary">Use recovery code</button></p></form></details>`;
    res.send(page("Two-step login", card(`${body}<form method="post" action="/staff/logout" style="margin-top:12px">${csrfField(req)}<button class="secondary" style="width:100%">Cancel and log out</button></form>`)));
  });

  r.post("/2fa", opts.loginLimiter, pending, async (req, res) => {
    const s = (await loadStaff(db, "id", staffOf(req).id))!;
    const next = safeNext(req.body.next);
    const method = mfaMethod(s.role);
    if (isLocked(s)) {
      await endSession(db, req, res);
      return res.redirect("/staff/login?error=1");
    }
    let ok = false;
    const recovery = String(req.body.recovery ?? "").trim();
    const code = String(req.body.code ?? "").trim();
    if (method === "totp" && recovery) {
      ok = await useRecoveryCode(db, s, recovery);
      if (ok) await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.recovery_code_used", targetType: "staff", targetId: s.id, ip: req.ip });
    } else if (method === "totp") ok = await checkTotp(db, s, code);
    else if (method === "sms") ok = await checkSmsCode(db, s, code);
    else ok = true;
    if (!ok) {
      if (await registerFailure(db, req, s, "mfa")) {
        await endSession(db, req, res);
        return res.redirect("/staff/login?error=1");
      }
      return res.redirect(`/staff/2fa?error=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
    }
    await upgradeSession(db, req, res, sessionOf(req));
    res.redirect(await completeLogin(db, req, s, next));
  });

  r.post("/2fa/resend", opts.loginLimiter, pending, async (req, res) => {
    const s = (await loadStaff(db, "id", staffOf(req).id))!;
    const next = safeNext(req.body.next);
    const q = next ? `&next=${encodeURIComponent(next)}` : "";
    if (mfaMethod(s.role) !== "sms") return res.redirect("/staff/2fa");
    const sent = await sendLoginCode(db, s, req);
    res.redirect(sent === "sent" ? `/staff/2fa?resent=1${q}` : sent === "wait" ? `/staff/2fa?wait=1${q}` : "/staff/2fa?nophone=1");
  });

  // ---- First-time authenticator setup ----
  r.get("/2fa/setup", pending, async (req, res) => {
    const s = (await loadStaff(db, "id", staffOf(req).id))!;
    if (mfaMethod(s.role) !== "totp" || s.totp_enabled_at) return res.redirect("/staff/2fa");
    // Keep the same secret if the page is reloaded, so an app that already scanned it still works.
    let secret = s.totp_secret_enc ? decryptSecret(s.totp_secret_enc) : "";
    if (!secret) {
      secret = newTotpSecret();
      await db.query(`UPDATE staff SET totp_secret_enc = $2 WHERE id = $1`, [s.id, encryptSecret(secret)]);
    }
    const uri = otpauthUri(secret, s.login);
    const qr = await QRCode.toString(uri, { type: "svg", margin: 1, width: 220, errorCorrectionLevel: "M" });
    const next = safeNext(req.query.next);
    const err = req.query.error ? `<div class="notice" role="alert">That code didn't match. Check the time on your phone is correct and try again.</div>` : "";
    res.send(
      page(
        "Set up two-step login",
        card(`${h1("Set up", "two-step login", "Protecting girls' data")}<p>Your role can see sensitive information, so every login needs a code from an authenticator app (for example Aegis, FreeOTP or Google Authenticator).</p>
<ol><li>Install an authenticator app on your phone.</li><li>Scan this code with it.</li><li>Type the 6-digit code the app shows.</li></ol>
<div style="display:flex;justify-content:center;margin:12px 0" role="img" aria-label="QR code for your authenticator app">${qr}</div>
<p class="muted">Can't scan? Enter this key in the app: <code style="word-break:break-all">${esc(secret.match(/.{1,4}/g)!.join(" "))}</code></p>${err}
<form method="post" action="/staff/2fa/setup">${csrfField(req)}<input type="hidden" name="next" value="${esc(next)}"><label for="code">6-digit code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required style="font-size:24px;letter-spacing:4px">
<p><button class="accent" style="width:100%">Turn on two-step login</button></p></form>`),
      ),
    );
  });

  r.post("/2fa/setup", opts.loginLimiter, pending, async (req, res) => {
    const s = (await loadStaff(db, "id", staffOf(req).id))!;
    const next = safeNext(req.body.next);
    if (mfaMethod(s.role) !== "totp" || s.totp_enabled_at || !s.totp_secret_enc) return res.redirect("/staff/2fa");
    if (!(await checkTotp(db, s, String(req.body.code ?? "")))) {
      if (await registerFailure(db, req, s, "mfa")) {
        await endSession(db, req, res);
        return res.redirect("/staff/login?error=1");
      }
      return res.redirect(`/staff/2fa/setup?error=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
    }
    await db.query(`UPDATE staff SET totp_enabled_at = now() WHERE id = $1`, [s.id]);
    const codes = await newRecoveryCodes(db, s.id);
    await audit(db, { staffId: s.id, staffLogin: s.login, action: "login.mfa_enrolled", targetType: "staff", targetId: s.id, ip: req.ip });
    await upgradeSession(db, req, res, sessionOf(req));
    const dest = await completeLogin(db, req, s, next);
    res.send(
      page(
        "Recovery codes",
        card(`${h1("Save", "your recovery codes", "Two-step login is on")}<p>If you lose your phone, each of these codes lets you log in once. Write them down and keep them somewhere private. They will not be shown again.</p>
<ul style="font-family:ui-monospace,monospace;font-size:18px;columns:2;list-style:none;padding:0">${codes.map((c) => `<li>${c}</li>`).join("")}</ul>
<p><a class="btn accent" href="${esc(dest)}" style="width:100%">I've saved them, continue</a></p>`),
      ),
    );
  });

  // ---- Change password (also forced after an admin reset or first login) ----
  const anyStaff = requireRole(db, ALL_ROLES);
  const passwordPage = (req: Request, res: Response, error = "") => {
    const s = staffOf(req);
    res.send(
      page(
        "Change password",
        card(`${h1("Change", "your password", "Account")}${s.must_change_password ? `<p>Please choose your own password before you continue.</p>` : ""}<p class="muted">At least 12 characters. A short sentence is easy to remember and hard to guess.</p>
${error ? `<div class="notice" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/staff/password">${csrfField(req)}
<label for="current">Current password</label><input id="current" name="current" type="password" autocomplete="current-password" required>
<label for="new">New password</label><input id="new" name="new" type="password" autocomplete="new-password" minlength="12" required>
<label for="confirm">New password again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>
<p><button class="accent" style="width:100%">Save new password</button></p></form>
${s.must_change_password ? "" : `<p><a href="${HOME[s.role]}">Cancel</a></p>`}`),
        s.must_change_password
          ? `<form method="post" action="/staff/logout" style="display:inline">${csrfField(req)}<button class="secondary" style="min-height:36px;padding:0 16px">Log out</button></form>`
          : nav(req),
      ),
    );
  };
  r.get("/password", anyStaff, (req, res) => passwordPage(req, res));
  r.post("/password", opts.loginLimiter, anyStaff, async (req, res) => {
    const me = staffOf(req);
    const s = (await loadStaff(db, "id", me.id))!;
    const current = String(req.body.current ?? "");
    const next = String(req.body.new ?? "");
    if (!verifyPassword(current, s.password_hash)) {
      if (await registerFailure(db, req, s, "password")) {
        await endSession(db, req, res);
        return res.redirect("/staff/login?error=1");
      }
      return passwordPage(req, res, "Your current password is wrong.");
    }
    if (next !== String(req.body.confirm ?? "")) return passwordPage(req, res, "The two new passwords don't match.");
    if (next === current) return passwordPage(req, res, "Choose a password you haven't used here.");
    const problem = passwordProblem(next, s.login);
    if (problem) return passwordPage(req, res, problem);
    await db.query(`UPDATE staff SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(), failed_logins = 0 WHERE id = $1`, [
      s.id,
      hashPassword(next),
    ]);
    // Sign out every other device that knew the old password.
    await revokeAllSessions(db, s.id, sessionOf(req).token_hash);
    await auditReq(db, req, { action: "password.changed", targetType: "staff", targetId: s.id });
    res.redirect(HOME[s.role]);
  });

  r.post("/logout", async (req, res) => {
    const s = await readSession(db, req);
    await endSession(db, req, res);
    if (s) await audit(db, { staffId: s.staff.id, staffLogin: s.staff.login, action: "logout", targetType: "staff", targetId: s.staff.id, ip: req.ip });
    res.redirect("/staff/login");
  });

  return r;
}
