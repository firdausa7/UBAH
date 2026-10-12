import { Router, type Request } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { hashPassword, verifyPassword } from "../privacy.js";
import { checkPass, redeemPass, SERVICES } from "../referrals.js";
import { csrfField } from "../security/csrf.js";
import { ALL_ROLES, ROLE_LABEL, requireRole, staffOf } from "./auth.js";
import { page, esc, h1, notice } from "./html.js";
import { nav } from "./nav.js";

// Clinic desk (check and record a pass, never seeing who she is) and each person's Account page.

export function clinicRouter(db: Db): Router {
  const r = Router();
  const clinicTeam = requireRole(db, ["admin", "clinic"]);

  const clinicPage = (req: Request, result = "") =>
    page(
      "Check a pass",
      `${h1("Check", "a referral pass", "Clinic desk")}<p class="lead">Type the code she shows you. You will see the services she needs, never her name.</p><div class="card"><form method="post" action="/staff/clinic/check">${csrfField(req)}<label for="code">Pass code</label>
<input id="code" name="code" placeholder="UB-7K42" autocomplete="off" autocapitalize="characters" required style="text-transform:uppercase;font-size:22px;letter-spacing:2px">
<p><button class="accent">Check pass</button></p></form></div>${result}
<p class="muted">No internet? From your registered phone, text <code>CHECK UB-7K42 PIN</code> or <code>SEEN UB-7K42 PIN</code> to the Ubah number, or dial the Ubah USSD code. Set your desk PIN under Account.</p>`,
      nav(req),
    );

  r.get("/clinic", clinicTeam, (req, res) => res.send(clinicPage(req)));

  r.post("/clinic/check", clinicTeam, async (req, res) => {
    const s = staffOf(req);
    const chk = await checkPass(db, String(req.body.code ?? "").slice(0, 20), s.clinic_id);
    await auditReq(db, req, { action: "pass.check", targetType: "pass", targetId: chk.code ?? String(req.body.code ?? "").slice(0, 20), details: { valid: chk.valid } });
    const result = chk.valid
      ? `<div class="card"><span class="tag ok">Valid pass</span>${chk.urgent ? ` <span class="tag urgent">Urgent — see today</span>` : ""}
<h2 style="margin-top:10px">${esc(chk.code)}</h2><p>She needs: <strong>${chk.services!.map((x) => esc(SERVICES[x] ?? x)).join(", ")}</strong></p>
<p class="muted">Valid until ${new Date(chk.expiresAt!).toDateString()}. ${chk.alreadyRedeemed ? "Already recorded as seen." : ""} No name is needed.</p>
${s.clinic_id ? `<form method="post" action="/staff/clinic/redeem">${csrfField(req)}<input type="hidden" name="code" value="${esc(chk.code)}"><button>Record that she was seen here</button></form>` : ""}</div>`
      : `<div class="card"><span class="tag urgent">Not valid</span><p>${esc(chk.reason)}</p></div>`;
    res.send(clinicPage(req, result));
  });

  r.post("/clinic/redeem", clinicTeam, async (req, res) => {
    const s = staffOf(req);
    const code = String(req.body.code ?? "").slice(0, 20);
    if (!s.clinic_id) return res.send(clinicPage(req, `<div class="card"><span class="tag urgent">Not recorded</span><p>Your account isn't linked to a clinic, so visits can't be recorded from it.</p></div>`));
    const chk = await checkPass(db, code, s.clinic_id);
    if (!chk.valid) return res.send(clinicPage(req, `<div class="card"><span class="tag urgent">Not valid</span><p>${esc(chk.reason)}</p></div>`));
    await redeemPass(db, chk.code!, s.clinic_id);
    await auditReq(db, req, { action: "pass.redeem", targetType: "pass", targetId: chk.code, details: { clinicId: s.clinic_id } });
    res.send(clinicPage(req, `<div class="card"><span class="tag ok">Recorded</span><p>Thank you. Ubah will ask her about her visit in a few days.</p></div>`));
  });

  // ---- Account ----
  const anyone = requireRole(db, ALL_ROLES);
  r.get("/account", anyone, async (req, res) => {
    const [s] = await db.query(
      `SELECT s.name, s.login, s.role, s.phone, s.desk_pin_hash, s.totp_enabled_at, c.name AS clinic FROM staff s LEFT JOIN clinics c ON c.id = s.clinic_id WHERE s.id = $1`,
      [staffOf(req).id],
    );
    const masked = s.phone ? `${String(s.phone).slice(0, 7)}••••${String(s.phone).slice(-2)}` : "none";
    const pinForm =
      s.role === "clinic"
        ? `<form method="post" action="/staff/account/desk-pin" class="card">${csrfField(req)}<h2>Desk PIN for SMS and USSD</h2><p class="muted">${s.desk_pin_hash ? "A PIN is set." : "No PIN yet."} Used with your registered phone (${esc(masked)}) to check passes without internet.</p>
<div class="fields"><div><label for="pin">New PIN (4 to 6 digits)</label><input id="pin" name="pin" type="password" inputmode="numeric" pattern="\\d{4,6}" autocomplete="off" required></div>
<div><label for="current">Your current password</label><input id="current" name="current" type="password" autocomplete="current-password" required></div></div><p><button class="accent">Save PIN</button></p></form>`
        : "";
    res.send(
      page(
        "Account",
        `${h1("Your", "account", ROLE_LABEL[s.role as keyof typeof ROLE_LABEL])}${notice(req.query)}
<div class="card"><p><strong>${esc(s.name)}</strong> · login <code>${esc(s.login)}</code>${s.clinic ? ` · ${esc(s.clinic)}` : ""}</p><p class="muted">Phone on file: ${esc(masked)} (an admin can change it) · two-step login: ${s.totp_enabled_at ? "authenticator app" : s.role === "dada" ? "SMS code" : "not needed for this role"}</p>
<p><a class="btn secondary" href="/staff/password">Change password</a></p></div>${pinForm}`,
        nav(req),
      ),
    );
  });
  r.post("/account/desk-pin", requireRole(db, ["clinic"]), async (req, res) => {
    const pin = String(req.body.pin ?? "");
    const [s] = await db.query(`SELECT password_hash FROM staff WHERE id = $1`, [staffOf(req).id]);
    if (!/^\d{4,6}$/.test(pin) || /^(\d)\1+$/.test(pin) || ["1234", "123456", "4321"].includes(pin)) return res.redirect("/staff/account?error=invalid");
    if (!verifyPassword(String(req.body.current ?? ""), s.password_hash)) return res.redirect("/staff/account?error=invalid");
    await db.query(`UPDATE staff SET desk_pin_hash = $2 WHERE id = $1`, [staffOf(req).id, hashPassword(pin)]);
    await auditReq(db, req, { action: "staff.desk_pin", targetType: "staff", targetId: staffOf(req).id });
    res.redirect("/staff/account?done=saved");
  });

  return r;
}
