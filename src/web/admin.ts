import { Router, type Request, type RequestHandler } from "express";
import type { Db } from "../db.js";
import { auditReq, audit } from "../audit.js";
import { hashPassword, passwordProblem } from "../privacy.js";
import { SERVICES } from "../referrals.js";
import { LANGUAGES } from "../i18n.js";
import { sendSms } from "../channels/sms.js";
import { csrfField } from "../security/csrf.js";
import { activeAdminCount, cleanKenyanPhone, createStaffToken, findStaffToken, LOGIN_RE, tokenLink } from "../staffAccounts.js";
import { ROLES, ROLE_LABEL, requireRole, revokeAllSessions, staffOf, type Role } from "./auth.js";
import { page, esc, h1, field, select, checks, textarea, many, notice, when } from "./html.js";
import { nav } from "./nav.js";

// Admin: staff accounts, clinics, sites with their protection pathway. Every change is audited.

const back = (href: string, label: string) => `<p class="noprint"><a href="${href}">← ${esc(label)}</a></p>`;
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const text = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

export function adminRouter(db: Db, opts: { tokenLimiter: RequestHandler }): Router {
  const r = Router();
  const admin = requireRole(db, ["admin"]);

  const sites = () => db.query<{ id: number; name: string }>(`SELECT id, name FROM sites WHERE active ORDER BY name`);
  const clinicsList = () => db.query<{ id: number; name: string }>(`SELECT id, name FROM clinics WHERE active ORDER BY name`);

  r.get("/admin", admin, async (req, res) => {
    const [c] = await db.query(
      `SELECT (SELECT count(*)::int FROM staff WHERE active) AS staff, (SELECT count(*)::int FROM clinics WHERE active) AS clinics,
              (SELECT count(*)::int FROM sites WHERE active) AS sites,
              (SELECT count(*)::int FROM protection_contacts WHERE active AND NOT verified) AS unverified`,
    );
    const tile = (href: string, title: string, note: string) => `<a class="card" href="${href}" style="text-decoration:none;display:block"><h2>${title}</h2><p class="muted">${note}</p></a>`;
    res.send(
      page(
        "Admin",
        `${h1("Admin", "", "Ubah team")}<div class="cols">
${tile("/staff/admin/staff", "<em>Staff</em> accounts", `${c.staff} active · invite, change roles, reset logins`)}
${tile("/staff/admin/clinics", "<em>Partner</em> clinics", `${c.clinics} active · services, hours, verified, MFL code`)}
${tile("/staff/admin/sites", "<em>Sites</em> and protection", `${c.sites} sites · ${c.unverified} referral contacts not yet verified`)}
${tile("/staff/audit", "<em>Audit</em> log", "Who viewed, sent and changed what")}
</div>`,
        nav(req),
      ),
    );
  });

  // ============ Staff ============

  r.get("/admin/staff", admin, async (req, res) => {
    const role = ROLES.includes(req.query.role as Role) ? String(req.query.role) : "";
    const showAll = req.query.all === "1";
    const rows = await db.query(
      `SELECT s.id, s.name, s.login, s.role, s.active, s.phone, s.locked_until, s.totp_enabled_at, s.last_login_at, c.name AS clinic
         FROM staff s LEFT JOIN clinics c ON c.id = s.clinic_id
        WHERE ($1 = '' OR s.role = $1) AND ($2 OR s.active) ORDER BY s.active DESC, s.role, s.name`,
      [role, showAll],
    );
    const list = rows
      .map(
        (s) => `<tr><td><a href="/staff/admin/staff/${s.id}"><strong>${esc(s.name)}</strong></a><div class="muted">${esc(s.login)}</div></td><td>${esc(ROLE_LABEL[s.role as Role] ?? s.role)}${s.clinic ? `<div class="muted">${esc(s.clinic)}</div>` : ""}</td>
<td>${s.active ? (s.locked_until && new Date(s.locked_until) > new Date() ? `<span class="tag urgent">Locked</span>` : `<span class="tag ok">Active</span>`) : `<span class="tag">Deactivated</span>`}</td><td class="muted">${when(s.last_login_at)}</td></tr>`,
      )
      .join("");
    res.send(
      page(
        "Staff",
        `${back("/staff/admin", "Admin")}<div class="row between">${h1("Staff", "accounts", "Admin")}<a class="btn accent" href="/staff/admin/staff/new">Invite someone</a></div>${notice(req.query)}
<form method="get" class="row pills" style="margin-bottom:14px"><a class="btn ${role ? "secondary" : ""}" href="/staff/admin/staff${showAll ? "?all=1" : ""}">All roles</a>${ROLES.map((r2) => `<a class="btn ${role === r2 ? "" : "secondary"}" href="?role=${r2}${showAll ? "&all=1" : ""}">${esc(ROLE_LABEL[r2])}</a>`).join("")}
<a class="btn secondary" href="?${new URLSearchParams({ ...(role ? { role } : {}), ...(showAll ? {} : { all: "1" }) })}">${showAll ? "Hide deactivated" : "Show deactivated"}</a></form>
<div class="card"><div class="scroll"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead><tbody>${list || `<tr><td colspan="4">No staff match.</td></tr>`}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  const staffForm = async (req: Request, s: any, action: string, isNew: boolean) => {
    const [siteRows, clinicRows] = await Promise.all([sites(), clinicsList()]);
    return `<form method="post" action="${action}" class="card">${csrfField(req)}<div class="fields">
${field("Full name", "name", s.name, { required: true })}
${isNew ? field("Login", "login", s.login, { required: true, hint: "Lower-case letters, numbers, dot, dash or underscore (3–40)", attrs: 'autocapitalize="none" pattern="[a-z0-9][a-z0-9._-]{2,39}"' }) : `<div><label>Login</label><p><code>${esc(s.login)}</code></p></div>`}
${select("Role", "role", ROLES.map((r2) => [r2, ROLE_LABEL[r2]]), s.role, { required: true })}
${field("Phone", "phone", s.phone ?? "", { type: "tel", hint: "Kenyan mobile. Needed for Dadas (login codes, M-Pesa pay) and clinic SMS pass checks." })}
${select("Clinic (clinic desk only)", "clinic_id", clinicRows.map((c) => [String(c.id), c.name]), s.clinic_id ?? "", { blank: "None" })}
${select("Site", "site_id", siteRows.map((c) => [String(c.id), c.name]), s.site_id ?? "", { blank: "All / not set" })}
${field("Job title", "title", s.title ?? "", { hint: "Shown with every approval, e.g. Clinical officer" })}
${field("Organisation", "organisation", s.organisation ?? "")}
</div>${checks("Languages they work in", "languages", Object.entries(LANGUAGES), s.languages ?? [])}
${isNew ? `<label class="inline"><input type="checkbox" name="send_sms" value="1"> Also send the set-password link to their phone by SMS</label>` : ""}
<p><button class="accent">${isNew ? "Create account and get invite link" : "Save changes"}</button></p></form>`;
  };

  // Validates the shared staff fields. Returns null when something is invalid.
  async function readStaffBody(req: Request) {
    const role = String(req.body.role ?? "") as Role;
    if (!ROLES.includes(role)) return null;
    const name = text(req.body.name, 100);
    if (!name) return null;
    const rawPhone = text(req.body.phone, 30);
    const phone = rawPhone ? cleanKenyanPhone(rawPhone) : null;
    if (rawPhone && !phone) return null;
    if (role === "dada" && !phone) return null;
    const clinicId = int(req.body.clinic_id);
    if (role === "clinic" && !clinicId) return null;
    const languages = many(req.body.languages).filter((l) => l in LANGUAGES);
    return {
      name,
      role,
      phone,
      clinicId: role === "clinic" ? clinicId : null,
      siteId: int(req.body.site_id),
      title: text(req.body.title, 100),
      organisation: text(req.body.organisation, 100),
      languages,
    };
  }

  r.get("/admin/staff/new", admin, async (req, res) => {
    res.send(page("Invite staff", `${back("/staff/admin/staff", "Staff")}${h1("Invite", "someone", "Staff accounts")}${notice(req.query)}${await staffForm(req, { role: "dada" }, "/staff/admin/staff", true)}`, nav(req)));
  });

  r.post("/admin/staff", admin, async (req, res) => {
    const body = await readStaffBody(req);
    const login = text(req.body.login, 40).toLowerCase();
    if (!body || !LOGIN_RE.test(login)) return res.redirect("/staff/admin/staff/new?error=invalid");
    const [exists] = await db.query(`SELECT 1 FROM staff WHERE login = $1`, [login]);
    if (exists) return res.redirect("/staff/admin/staff/new?error=exists");
    // No usable password until they open their invite link.
    const [s] = await db.query<{ id: number }>(
      `INSERT INTO staff (name, role, login, password_hash, clinic_id, phone, site_id, title, organisation, languages) VALUES ($1,$2,$3,'!',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [body.name, body.role, login, body.clinicId, body.phone, body.siteId, body.title, body.organisation, body.languages],
    );
    const token = await createStaffToken(db, s.id, "invite", staffOf(req).id);
    const smsSent = Boolean(req.body.send_sms && body.phone);
    if (smsSent) await sendSms(body.phone!, `You have been invited to Ubah. Set your password here (valid 72 hours): ${tokenLink(token)}`);
    await auditReq(db, req, { action: "staff.create", targetType: "staff", targetId: s.id, details: { login, role: body.role, smsSent } });
    res.send(linkPage(req, "Account created", body.name, tokenLink(token), smsSent, 72, s.id));
  });

  const linkPage = (req: Request, title: string, name: string, link: string, smsSent: boolean, hours: number, id: number) =>
    page(
      title,
      `${back(`/staff/admin/staff/${id}`, name)}${h1(title.split(" ")[0], title.split(" ").slice(1).join(" "), "Staff accounts")}
<div class="card"><p>Give <strong>${esc(name)}</strong> this one-time link to set their password. It works once and expires in ${hours} hours.${smsSent ? " It was also sent to their phone by SMS." : ""} It is not shown again.</p>
<p><code style="word-break:break-all;font-size:15px">${esc(link)}</code></p><p class="muted">Share it privately (in person or by SMS), never in a group chat.</p></div>`,
      nav(req),
    );

  r.get("/admin/staff/:id", admin, async (req, res) => {
    const id = int(req.params.id);
    const [s] = id ? await db.query(`SELECT * FROM staff WHERE id = $1`, [id]) : [];
    if (!s) return res.status(404).send(page("Not found", "Staff member not found.", nav(req)));
    const locked = s.locked_until && new Date(s.locked_until) > new Date();
    const action = (path: string, label: string, cls = "secondary", confirmText = "") =>
      `<form method="post" action="/staff/admin/staff/${s.id}/${path}" style="display:inline">${csrfField(req)}${confirmText ? `<input type="hidden" name="confirm" value="1">` : ""}<button class="${cls} small">${esc(label)}</button></form>`;
    res.send(
      page(
        s.name,
        `${back("/staff/admin/staff", "Staff")}${h1(s.name.split(" ")[0], s.name.split(" ").slice(1).join(" ") || "", ROLE_LABEL[s.role as Role] ?? s.role)}${notice(req.query)}
<div class="card"><p class="muted">Login <code>${esc(s.login)}</code> · ${s.active ? "Active" : `Deactivated ${when(s.deactivated_at)}`} · two-step login ${s.totp_enabled_at ? "set up" : s.role === "dada" ? "by SMS" : "not set up yet"} · last login ${when(s.last_login_at)}${locked ? ` · <strong>locked until ${when(s.locked_until)}</strong>` : ""}</p>
<div class="row">${action("reset-password", "Reset password")}${s.totp_enabled_at ? action("reset-2fa", "Reset two-step login") : ""}${locked ? action("unlock", "Unlock") : ""}
${s.active ? action("deactivate", "Deactivate", "danger") : action("reactivate", "Reactivate")}</div></div>
${await staffForm(req, s, `/staff/admin/staff/${s.id}`, false)}`,
        nav(req),
      ),
    );
  });

  r.post("/admin/staff/:id", admin, async (req, res) => {
    const id = int(req.params.id);
    const [s] = id ? await db.query(`SELECT id, role, login FROM staff WHERE id = $1`, [id]) : [];
    if (!s) return res.status(404).send("Not found");
    const body = await readStaffBody(req);
    if (!body) return res.redirect(`/staff/admin/staff/${s.id}?error=invalid`);
    if (s.id === staffOf(req).id && body.role !== "admin") return res.redirect(`/staff/admin/staff/${s.id}?error=self`);
    await db.query(
      `UPDATE staff SET name=$2, role=$3, phone=$4, clinic_id=$5, site_id=$6, title=$7, organisation=$8, languages=$9 WHERE id = $1`,
      [s.id, body.name, body.role, body.phone, body.clinicId, body.siteId, body.title, body.organisation, body.languages],
    );
    // A role change ends their sessions so new permissions apply at once.
    if (body.role !== s.role) await revokeAllSessions(db, s.id);
    await auditReq(db, req, { action: "staff.update", targetType: "staff", targetId: s.id, details: { role: body.role, roleChanged: body.role !== s.role } });
    res.redirect(`/staff/admin/staff/${s.id}?done=saved`);
  });

  const staffAction = (path: string, fn: (req: Request, s: any) => Promise<string | void>) =>
    r.post(`/admin/staff/:id/${path}`, admin, async (req, res) => {
      const id = int(req.params.id);
      const [s] = id ? await db.query(`SELECT * FROM staff WHERE id = $1`, [id]) : [];
      if (!s) return res.status(404).send("Not found");
      const out = await fn(req, s);
      if (out && out.startsWith("<")) return res.send(out);
      res.redirect(`/staff/admin/staff/${s.id}${out ?? ""}`);
    });

  staffAction("deactivate", async (req, s) => {
    if (s.id === staffOf(req).id) return "?error=self";
    if (s.role === "admin" && s.active && (await activeAdminCount(db)) <= 1) return "?error=self";
    await db.query(`UPDATE staff SET active = FALSE, deactivated_at = now() WHERE id = $1`, [s.id]);
    await revokeAllSessions(db, s.id);
    await db.query(`UPDATE cases SET assigned_to = NULL, assigned_at = NULL WHERE assigned_to = $1 AND status = 'open'`, [s.id]);
    await auditReq(db, req, { action: "staff.deactivate", targetType: "staff", targetId: s.id });
    return "?done=deactivated";
  });
  staffAction("reactivate", async (req, s) => {
    await db.query(`UPDATE staff SET active = TRUE, deactivated_at = NULL, failed_logins = 0, locked_until = NULL WHERE id = $1`, [s.id]);
    await auditReq(db, req, { action: "staff.reactivate", targetType: "staff", targetId: s.id });
    return "?done=reactivated";
  });
  staffAction("unlock", async (req, s) => {
    await db.query(`UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [s.id]);
    await auditReq(db, req, { action: "staff.unlock", targetType: "staff", targetId: s.id });
    return "?done=saved";
  });
  staffAction("reset-2fa", async (req, s) => {
    await db.query(`UPDATE staff SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1`, [s.id]);
    await db.query(`DELETE FROM staff_recovery_codes WHERE staff_id = $1`, [s.id]);
    await revokeAllSessions(db, s.id);
    await auditReq(db, req, { action: "staff.reset_2fa", targetType: "staff", targetId: s.id });
    return "?done=2fa-reset";
  });
  staffAction("reset-password", async (req, s) => {
    if (s.id === staffOf(req).id) return "?error=self";
    // The old password stops working at once.
    await db.query(`UPDATE staff SET password_hash = '!', failed_logins = 0, locked_until = NULL WHERE id = $1`, [s.id]);
    await revokeAllSessions(db, s.id);
    const token = await createStaffToken(db, s.id, "reset", staffOf(req).id);
    const smsSent = Boolean(s.phone);
    if (smsSent) await sendSms(s.phone, `Your Ubah password was reset by an admin. Set a new one here (valid 24 hours): ${tokenLink(token)}`);
    await auditReq(db, req, { action: "staff.reset_password", targetType: "staff", targetId: s.id, details: { smsSent } });
    return linkPage(req, "Password reset", s.name, tokenLink(token), smsSent, 24, s.id);
  });

  // ---- Invite / reset link (no login needed: the link is the proof) ----
  const tokenPage = (req: Request, t: { name: string; login: string; purpose: string }, token: string, error = "") =>
    page(
      "Set your password",
      `<div class="card" style="max-width:460px;margin:32px auto;padding:28px">${h1("Set", "your password", t.purpose === "invite" ? "Welcome to Ubah" : "Password reset")}
<p>Hello ${esc(t.name)}. Your login is <code>${esc(t.login)}</code>.</p><p class="muted">At least 12 characters. A short sentence is easy to remember and hard to guess.</p>
${error ? `<div class="notice" role="alert">${esc(error)}</div>` : ""}<form method="post" action="/staff/invite/${esc(token)}">${csrfField(req)}
<label for="new">New password</label><input id="new" name="new" type="password" autocomplete="new-password" minlength="12" required>
<label for="confirm">New password again</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="12" required>
<p><button class="accent" style="width:100%">Save password</button></p></form></div>`,
    );
  const expired = () =>
    page("Link expired", `<div class="card" style="max-width:460px;margin:32px auto">${h1("Link", "expired")}<p>This link has expired or was already used. Ask an admin for a new one.</p></div>`);

  r.get("/invite/:token", opts.tokenLimiter, async (req, res) => {
    const t = await findStaffToken(db, String(req.params.token));
    if (!t) return res.status(410).send(expired());
    res.send(tokenPage(req, t, String(req.params.token)));
  });
  r.post("/invite/:token", opts.tokenLimiter, async (req, res) => {
    const token = String(req.params.token);
    const t = await findStaffToken(db, token);
    if (!t) return res.status(410).send(expired());
    const pw = String(req.body.new ?? "");
    if (pw !== String(req.body.confirm ?? "")) return res.send(tokenPage(req, t, token, "The two passwords don't match."));
    const problem = passwordProblem(pw, t.login);
    if (problem) return res.send(tokenPage(req, t, token, problem));
    await db.query(`UPDATE staff SET password_hash = $2, must_change_password = FALSE, password_changed_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1`, [
      t.staff_id,
      hashPassword(pw),
    ]);
    await db.query(`UPDATE staff_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL`, [t.staff_id]);
    await audit(db, { staffId: t.staff_id, staffLogin: t.login, action: "password.changed", targetType: "staff", targetId: t.staff_id, details: { via: t.purpose }, ip: req.ip });
    res.redirect("/staff/login?done=password");
  });

  // ============ Clinics ============

  r.get("/admin/clinics", admin, async (req, res) => {
    const rows = await db.query(
      `SELECT c.*, s.name AS site FROM clinics c LEFT JOIN sites s ON s.id = c.site_id ORDER BY c.active DESC, c.name`,
    );
    const list = rows
      .map(
        (c) => `<tr><td><a href="/staff/admin/clinics/${c.id}"><strong>${esc(c.name)}</strong></a><div class="muted">${esc(c.area)}${c.site ? ` · ${esc(c.site)}` : ""}</div></td>
<td>${c.services.map((x: string) => esc(SERVICES[x] ?? x)).join(", ")}</td><td>${esc(c.mfl_code ?? "—")}</td>
<td>${c.active ? (c.verified ? `<span class="tag ok">Verified</span>` : `<span class="tag">Not verified</span>`) : `<span class="tag">Deactivated</span>`}</td></tr>`,
      )
      .join("");
    res.send(
      page(
        "Clinics",
        `${back("/staff/admin", "Admin")}<div class="row between">${h1("Partner", "clinics", "Admin")}<a class="btn accent" href="/staff/admin/clinics/new">Add a clinic</a></div>${notice(req.query)}
<p class="lead">Girls are only referred to active clinics. Unverified clinics are suggested after verified ones.</p>
<div class="card"><div class="scroll"><table><thead><tr><th>Clinic</th><th>Services</th><th>MFL code</th><th>Status</th></tr></thead><tbody>${list || `<tr><td colspan="4">No clinics yet.</td></tr>`}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  const clinicForm = async (req: Request, c: any, action: string) => {
    const siteRows = await sites();
    return `<form method="post" action="${action}" class="card">${csrfField(req)}<div class="fields">
${field("Clinic name", "name", c.name, { required: true })}
${field("Area / block / town", "area", c.area, { required: true })}
${field("Opening hours", "hours", c.hours, { required: true, hint: "e.g. Mon–Fri 8am–5pm" })}
${field("Kenya Master Facility List code", "mfl_code", c.mfl_code ?? "", { hint: "5 digits, from kmhfr.health.go.ke", attrs: 'inputmode="numeric" pattern="\\d{5}"' })}
${select("Site", "site_id", siteRows.map((s) => [String(s.id), s.name]), c.site_id ?? "", { blank: "Not set" })}
</div>${checks("Services offered", "services", Object.entries(SERVICES), c.services ?? [])}
<label class="inline"><input type="checkbox" name="free" value="1"${c.free !== false ? " checked" : ""}> Services are free for girls</label>
<label class="inline"><input type="checkbox" name="verified" value="1"${c.verified ? " checked" : ""}> Verified: a staff member has visited and confirmed the services, hours and youth-friendly care</label>
${textarea("Notes for staff", "notes", c.notes ?? "", { rows: 2 })}
<p><button class="accent">Save clinic</button></p></form>`;
  };

  function readClinicBody(req: Request) {
    const name = text(req.body.name, 120);
    const area = text(req.body.area, 120);
    const hours = text(req.body.hours, 120);
    const mfl = text(req.body.mfl_code, 10);
    const services = many(req.body.services).filter((s) => s in SERVICES);
    if (!name || !area || !hours || services.length === 0 || (mfl && !/^\d{5}$/.test(mfl))) return null;
    return { name, area, hours, mfl: mfl || null, services, siteId: int(req.body.site_id), free: Boolean(req.body.free), verified: Boolean(req.body.verified), notes: text(req.body.notes, 1000) };
  }

  r.get("/admin/clinics/new", admin, async (req, res) => {
    res.send(page("Add clinic", `${back("/staff/admin/clinics", "Clinics")}${h1("Add", "a clinic", "Partner clinics")}${notice(req.query)}${await clinicForm(req, { services: [] }, "/staff/admin/clinics")}`, nav(req)));
  });
  r.post("/admin/clinics", admin, async (req, res) => {
    const b = readClinicBody(req);
    if (!b) return res.redirect("/staff/admin/clinics/new?error=invalid");
    const [c] = await db.query<{ id: number }>(
      `INSERT INTO clinics (name, area, hours, mfl_code, services, site_id, free, verified, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.name, b.area, b.hours, b.mfl, b.services, b.siteId, b.free, b.verified, b.notes],
    );
    await auditReq(db, req, { action: "clinic.create", targetType: "clinic", targetId: c.id, details: { verified: b.verified } });
    res.redirect(`/staff/admin/clinics/${c.id}?done=created`);
  });
  r.get("/admin/clinics/:id", admin, async (req, res) => {
    const id = int(req.params.id);
    const [c] = id ? await db.query(`SELECT * FROM clinics WHERE id = $1`, [id]) : [];
    if (!c) return res.status(404).send(page("Not found", "Clinic not found.", nav(req)));
    const toggle = c.active
      ? `<form method="post" action="/staff/admin/clinics/${c.id}/deactivate">${csrfField(req)}<button class="danger small">Deactivate (stop referring girls here)</button></form>`
      : `<form method="post" action="/staff/admin/clinics/${c.id}/reactivate">${csrfField(req)}<button class="secondary small">Reactivate</button></form>`;
    res.send(page(c.name, `${back("/staff/admin/clinics", "Clinics")}${h1(c.name, "", c.active ? "Partner clinic" : "Deactivated clinic")}${notice(req.query)}${await clinicForm(req, c, `/staff/admin/clinics/${c.id}`)}<div class="card">${toggle}</div>`, nav(req)));
  });
  r.post("/admin/clinics/:id", admin, async (req, res) => {
    const id = int(req.params.id);
    const b = readClinicBody(req);
    if (!id) return res.status(404).send("Not found");
    if (!b) return res.redirect(`/staff/admin/clinics/${id}?error=invalid`);
    const done = await db.query(
      `UPDATE clinics SET name=$2, area=$3, hours=$4, mfl_code=$5, services=$6, site_id=$7, free=$8, verified=$9, notes=$10, updated_at=now() WHERE id=$1 RETURNING id`,
      [id, b.name, b.area, b.hours, b.mfl, b.services, b.siteId, b.free, b.verified, b.notes],
    );
    if (!done.length) return res.status(404).send("Not found");
    await auditReq(db, req, { action: "clinic.update", targetType: "clinic", targetId: id, details: { verified: b.verified, services: b.services } });
    res.redirect(`/staff/admin/clinics/${id}?done=saved`);
  });
  for (const [path, active] of [["deactivate", false], ["reactivate", true]] as const) {
    r.post(`/admin/clinics/:id/${path}`, admin, async (req, res) => {
      const id = int(req.params.id);
      const done = id ? await db.query(`UPDATE clinics SET active = $2, updated_at = now() WHERE id = $1 RETURNING id`, [id, active]) : [];
      if (!done.length) return res.status(404).send("Not found");
      await auditReq(db, req, { action: `clinic.${path}`, targetType: "clinic", targetId: id! });
      res.redirect(`/staff/admin/clinics/${id}?done=${active ? "reactivated" : "deactivated"}`);
    });
  }

  // ============ Sites and protection pathway ============

  r.get("/admin/sites", admin, async (req, res) => {
    const rows = await db.query(
      `SELECT s.*, (SELECT count(*)::int FROM protection_steps p WHERE p.site_id = s.id AND p.active) AS steps,
              (SELECT count(*)::int FROM protection_contacts c WHERE c.site_id = s.id AND c.active) AS contacts,
              (SELECT count(*)::int FROM protection_contacts c WHERE c.site_id = s.id AND c.active AND NOT c.verified) AS unverified
         FROM sites s ORDER BY s.active DESC, s.name`,
    );
    res.send(
      page(
        "Sites",
        `${back("/staff/admin", "Admin")}${h1("Sites", "and protection", "Admin")}${notice(req.query)}
<p class="lead">Each site has its own protection pathway: the checklist a Dada or nurse follows for a safety case, and the referral contacts agreed with protection partners there.</p>
<div class="card"><div class="scroll"><table><thead><tr><th>Site</th><th>Checklist steps</th><th>Referral contacts</th></tr></thead><tbody>${
          rows
            .map(
              (s) => `<tr><td><a href="/staff/admin/sites/${s.id}"><strong>${esc(s.name)}</strong></a><div class="muted">${esc(s.county)}${s.active ? "" : " · deactivated"}</div></td><td>${s.steps}</td>
<td>${s.contacts}${s.unverified ? ` <span class="tag urgent">${s.unverified} not verified</span>` : ""}</td></tr>`,
            )
            .join("") || `<tr><td colspan="3">No sites yet. Add the first one below.</td></tr>`
        }</tbody></table></div></div>
<form method="post" action="/staff/admin/sites" class="card">${csrfField(req)}<h2>Add a site</h2><div class="fields">${field("Site name", "name", "", { required: true, hint: "e.g. a camp or town" })}${field("County", "county", "")}</div><p><button class="accent">Add site</button></p></form>`,
        nav(req),
      ),
    );
  });
  r.post("/admin/sites", admin, async (req, res) => {
    const name = text(req.body.name, 100);
    if (!name) return res.redirect("/staff/admin/sites?error=invalid");
    const rows = await db.query<{ id: number }>(`INSERT INTO sites (name, county) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING RETURNING id`, [name, text(req.body.county, 100)]);
    if (!rows.length) return res.redirect("/staff/admin/sites?error=exists");
    await auditReq(db, req, { action: "site.create", targetType: "site", targetId: rows[0].id });
    res.redirect(`/staff/admin/sites/${rows[0].id}?done=created`);
  });

  r.get("/admin/sites/:id", admin, async (req, res) => {
    const id = int(req.params.id);
    const [s] = id ? await db.query(`SELECT * FROM sites WHERE id = $1`, [id]) : [];
    if (!s) return res.status(404).send(page("Not found", "Site not found.", nav(req)));
    const steps = await db.query(`SELECT * FROM protection_steps WHERE site_id = $1 ORDER BY active DESC, position, id`, [s.id]);
    const contacts = await db.query(
      `SELECT c.*, v.name AS verifier FROM protection_contacts c LEFT JOIN staff v ON v.id = c.verified_by WHERE c.site_id = $1 ORDER BY c.active DESC, c.name`,
      [s.id],
    );
    const stepRows = steps
      .map(
        (p, i) => `<li style="padding:10px 0;border-bottom:1px solid var(--line)${p.active ? "" : ";opacity:.55"}"><form method="post" action="/staff/admin/sites/${s.id}/steps/${p.id}">${csrfField(req)}
<div class="fields">${field(`Step ${i + 1}`, "title", p.title, { required: true })}${field("Details", "details", p.details)}</div>
<div class="row"><button class="small" name="action" value="save">Save</button>${i > 0 && p.active ? `<button class="secondary small" name="action" value="up">Move up</button>` : ""}
${p.active ? `<button class="danger small" name="action" value="remove">Remove</button>` : `<button class="secondary small" name="action" value="restore">Restore</button>`}</div></form></li>`,
      )
      .join("");
    const contactRows = contacts
      .map(
        (c) => `<details class="card" style="margin:0 0 10px${c.active ? "" : ";opacity:.55"}"><summary>${esc(c.name)} · ${esc(c.organisation)} ${c.verified ? `<span class="tag ok">Verified by ${esc(c.verifier ?? "staff")} ${when(c.verified_at)}</span>` : `<span class="tag urgent">Not verified</span>`}${c.active ? "" : " (removed)"}</summary>
<form method="post" action="/staff/admin/sites/${s.id}/contacts/${c.id}">${csrfField(req)}${contactFields(c)}
<div class="row"><button class="small" name="action" value="save">Save</button>${c.verified ? `<button class="secondary small" name="action" value="unverify">Mark not verified</button>` : `<button class="secondary small" name="action" value="verify">I have confirmed these details with the organisation</button>`}
${c.active ? `<button class="danger small" name="action" value="remove">Remove</button>` : `<button class="secondary small" name="action" value="restore">Restore</button>`}</div></form></details>`,
      )
      .join("");
    res.send(
      page(
        s.name,
        `${back("/staff/admin/sites", "Sites")}${h1(s.name, "", "Site")}${notice(req.query)}
<form method="post" action="/staff/admin/sites/${s.id}" class="card">${csrfField(req)}<div class="fields">${field("Site name", "name", s.name, { required: true })}${field("County", "county", s.county)}</div>
<label class="inline"><input type="checkbox" name="active" value="1"${s.active ? " checked" : ""}> Active</label><p><button class="small">Save site</button></p></form>
<div class="card"><div class="eyebrow">Protection pathway</div><h2><em>Checklist</em> for safety cases</h2><p class="muted">Shown on every safety case at this site. Agree each step with your protection partners.</p>
<ol style="list-style:none;padding:0;margin:0">${stepRows || `<li class="muted">No steps yet.</li>`}</ol>
<form method="post" action="/staff/admin/sites/${s.id}/steps" style="margin-top:12px">${csrfField(req)}<div class="fields">${field("New step", "title", "", { required: true })}${field("Details", "details", "")}</div><p><button class="secondary small">Add step</button></p></form></div>
<div class="card"><div class="eyebrow">Protection pathway</div><h2><em>Referral</em> contacts</h2><p class="muted">Enter only contacts agreed with the organisation. A contact stays marked "Not verified" until a staff member confirms its details.</p>
${contactRows || `<p class="muted">No contacts yet.</p>`}
<form method="post" action="/staff/admin/sites/${s.id}/contacts">${csrfField(req)}<h3>Add a contact</h3>${contactFields({})}<p><button class="secondary small">Add contact</button></p></form></div>`,
        nav(req),
      ),
    );
  });

  const contactFields = (c: any) =>
    `<div class="fields">${field("Contact name", "name", c.name ?? "", { required: true })}${field("Organisation", "organisation", c.organisation ?? "")}${field("Service", "service", c.service ?? "", { hint: "e.g. GBV case management" })}
${field("Phone", "phone", c.phone ?? "", { type: "tel" })}${field("Hours", "hours", c.hours ?? "")}${field("Notes", "notes", c.notes ?? "")}</div>`;
  const readContact = (req: Request) => ({
    name: text(req.body.name, 120),
    organisation: text(req.body.organisation, 120),
    service: text(req.body.service, 120),
    phone: text(req.body.phone, 40),
    hours: text(req.body.hours, 120),
    notes: text(req.body.notes, 500),
  });

  const siteOr404 = async (req: Request) => {
    const id = int(req.params.id);
    const [s] = id ? await db.query<{ id: number }>(`SELECT id FROM sites WHERE id = $1`, [id]) : [];
    return s ?? null;
  };

  r.post("/admin/sites/:id", admin, async (req, res) => {
    const s = await siteOr404(req);
    if (!s) return res.status(404).send("Not found");
    const name = text(req.body.name, 100);
    if (!name) return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
    try {
      await db.query(`UPDATE sites SET name = $2, county = $3, active = $4 WHERE id = $1`, [s.id, name, text(req.body.county, 100), Boolean(req.body.active)]);
    } catch {
      return res.redirect(`/staff/admin/sites/${s.id}?error=exists`);
    }
    await auditReq(db, req, { action: "site.update", targetType: "site", targetId: s.id });
    res.redirect(`/staff/admin/sites/${s.id}?done=saved`);
  });

  r.post("/admin/sites/:id/steps", admin, async (req, res) => {
    const s = await siteOr404(req);
    if (!s) return res.status(404).send("Not found");
    const title = text(req.body.title, 200);
    if (!title) return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
    const [p] = await db.query<{ id: number }>(
      `INSERT INTO protection_steps (site_id, position, title, details) VALUES ($1, (SELECT coalesce(max(position), 0) + 1 FROM protection_steps WHERE site_id = $1), $2, $3) RETURNING id`,
      [s.id, title, text(req.body.details, 1000)],
    );
    await auditReq(db, req, { action: "protection.step_add", targetType: "site", targetId: s.id, details: { stepId: p.id } });
    res.redirect(`/staff/admin/sites/${s.id}?done=saved`);
  });

  r.post("/admin/sites/:id/steps/:stepId", admin, async (req, res) => {
    const s = await siteOr404(req);
    const stepId = int(req.params.stepId);
    const [p] = s && stepId ? await db.query(`SELECT * FROM protection_steps WHERE id = $1 AND site_id = $2`, [stepId, s.id]) : [];
    if (!s || !p) return res.status(404).send("Not found");
    const action = String(req.body.action ?? "save");
    if (action === "save") {
      const title = text(req.body.title, 200);
      if (!title) return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
      await db.query(`UPDATE protection_steps SET title = $2, details = $3 WHERE id = $1`, [p.id, title, text(req.body.details, 1000)]);
    } else if (action === "up") {
      const [prev] = await db.query(`SELECT id, position FROM protection_steps WHERE site_id = $1 AND active AND (position, id) < ($2, $3) ORDER BY position DESC, id DESC LIMIT 1`, [s.id, p.position, p.id]);
      if (prev) {
        await db.tx(async (t) => {
          await t.query(`UPDATE protection_steps SET position = $2 WHERE id = $1`, [p.id, prev.position]);
          await t.query(`UPDATE protection_steps SET position = $2 WHERE id = $1`, [prev.id, p.position === prev.position ? p.position + 1 : p.position]);
        });
      }
    } else if (action === "remove" || action === "restore") {
      await db.query(`UPDATE protection_steps SET active = $2 WHERE id = $1`, [p.id, action === "restore"]);
    } else return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
    await auditReq(db, req, { action: `protection.step_${action}`, targetType: "site", targetId: s.id, details: { stepId: p.id } });
    res.redirect(`/staff/admin/sites/${s.id}?done=saved`);
  });

  r.post("/admin/sites/:id/contacts", admin, async (req, res) => {
    const s = await siteOr404(req);
    if (!s) return res.status(404).send("Not found");
    const c = readContact(req);
    if (!c.name) return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
    const [row] = await db.query<{ id: number }>(
      `INSERT INTO protection_contacts (site_id, name, organisation, service, phone, hours, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [s.id, c.name, c.organisation, c.service, c.phone, c.hours, c.notes],
    );
    await auditReq(db, req, { action: "protection.contact_add", targetType: "site", targetId: s.id, details: { contactId: row.id } });
    res.redirect(`/staff/admin/sites/${s.id}?done=saved`);
  });

  r.post("/admin/sites/:id/contacts/:cid", admin, async (req, res) => {
    const s = await siteOr404(req);
    const cid = int(req.params.cid);
    const [c] = s && cid ? await db.query(`SELECT id FROM protection_contacts WHERE id = $1 AND site_id = $2`, [cid, s.id]) : [];
    if (!s || !c) return res.status(404).send("Not found");
    const action = String(req.body.action ?? "save");
    const me = staffOf(req).id;
    if (action === "save") {
      const b = readContact(req);
      if (!b.name) return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
      // Changed details must be confirmed again.
      await db.query(
        `UPDATE protection_contacts SET name=$2, organisation=$3, service=$4, phone=$5, hours=$6, notes=$7, verified=FALSE, verified_by=NULL, verified_at=NULL WHERE id=$1`,
        [c.id, b.name, b.organisation, b.service, b.phone, b.hours, b.notes],
      );
    } else if (action === "verify") await db.query(`UPDATE protection_contacts SET verified = TRUE, verified_by = $2, verified_at = now() WHERE id = $1`, [c.id, me]);
    else if (action === "unverify") await db.query(`UPDATE protection_contacts SET verified = FALSE, verified_by = NULL, verified_at = NULL WHERE id = $1`, [c.id]);
    else if (action === "remove" || action === "restore") await db.query(`UPDATE protection_contacts SET active = $2 WHERE id = $1`, [c.id, action === "restore"]);
    else return res.redirect(`/staff/admin/sites/${s.id}?error=invalid`);
    await auditReq(db, req, { action: `protection.contact_${action}`, targetType: "site", targetId: s.id, details: { contactId: c.id } });
    res.redirect(`/staff/admin/sites/${s.id}?done=saved`);
  });

  return r;
}
