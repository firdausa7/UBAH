import { Router, type Request } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { requireRole, staffOf } from "./auth.js";
import { csrfField } from "../security/csrf.js";
import { auditReq } from "../audit.js";
import { HOME } from "./login.js";
import { page, esc, h1 } from "./html.js";
import { nav } from "./nav.js";
import { checkPass, redeemPass, SERVICES } from "../referrals.js";
import { sendToUser, type UserRow } from "../channels/outbound.js";
import { sendDueCheckins } from "../engine.js";
import { dashboardStats, MIN_RESPONSES } from "../stats.js";

const TOPICS = ["periods", "pregnancy", "family_planning", "sti", "safety", "body", "feelings", "other"];
const DANGER = ["none", "medical", "safety", "selfharm"];
const REASON: Record<string, string> = {
  danger_medical: "Danger sign: medical",
  danger_safety: "Safety concern",
  danger_selfharm: "Self-harm risk",
  asked_for_person: "Asked for a person",
};
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const ago = (d: string) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function staffRouter(db: Db): Router {
  const r = Router();
  const careTeam = requireRole(db, ["admin", "nurse", "dada"]);

  r.get("/", requireRole(db, ["admin", "nurse", "dada", "clinic", "partner"]), (req, res) => res.redirect(HOME[staffOf(req).role]));

  // ---- Dada & nurse inbox ----
  r.get("/inbox", careTeam, async (req, res) => {
    const status = req.query.status === "handled" ? "handled" : "open";
    const cases = await db.query(
      `SELECT c.*, u.anon_id, u.language, u.channel FROM cases c JOIN users u ON u.id = c.user_id
        WHERE c.status = $1 ORDER BY c.urgent DESC, c.created_at ${status === "open" ? "ASC" : "DESC"} LIMIT 100`,
      [status],
    );
    const cards = cases
      .map(
        (c) => `<div class="card"><div class="row between"><span class="tag ${c.urgent ? "urgent" : ""}">${esc(REASON[c.reason] ?? c.reason)}</span><span class="muted">${ago(c.created_at)}</span></div>
<p class="muted">Girl ${esc(c.anon_id)} · ${esc(c.language ?? "?")} · ${esc(c.channel)}</p><p>${esc(c.summary)}</p><a class="btn secondary" href="/staff/cases/${c.id}">Open case</a></div>`,
      )
      .join("");
    res.send(
      page(
        "Inbox",
        `${h1("Dada", "inbox", "Care team")}<p class="lead">Urgent cases come first. The AI drafts; a Dada or nurse always decides what is sent.</p><div class="row pills" style="margin-bottom:18px"><a class="btn ${status === "open" ? "" : "secondary"}" href="/staff/inbox">Open</a><a class="btn ${status === "handled" ? "" : "secondary"}" href="/staff/inbox?status=handled">Handled</a></div>${cards || `<div class="card">No ${status} cases.</div>`}`,
        nav(req),
      ),
    );
  });

  r.get("/cases/:id", careTeam, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send("Case not found");
    const [c] = await db.query(`SELECT c.*, u.anon_id, u.language, u.channel FROM cases c JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [id]);
    if (!c) return res.status(404).send("Case not found");
    await auditReq(db, req, { action: "case.view", targetType: "case", targetId: c.id });
    const msgs = await db.query(`SELECT direction, kind, body, created_at FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT 30`, [c.user_id]);
    const thread = msgs
      .reverse()
      .map((m) => `<div class="bubble ${m.direction === "in" ? "in" : "out"}">${m.kind === "voice" ? "<span class=\"muted\">Voice note · </span>" : ""}${esc(m.body)}</div>`)
      .join("");
    res.send(
      page(
        `Case ${c.id}`,
        `<p><a href="/staff/inbox">← Inbox</a></p><div class="card"><span class="tag ${c.urgent ? "urgent" : ""}">${esc(REASON[c.reason] ?? c.reason)}</span>
<h1 style="margin-top:10px"><em>Girl</em> ${esc(c.anon_id)}</h1><p class="muted">${esc(c.language ?? "?")} · ${esc(c.channel)} · opened ${ago(c.created_at)} · ${esc(c.status)}</p></div>
<div class="card"><h2>Conversation</h2>${thread}</div>
<div class="card"><h2>Reply</h2><form method="post" action="/staff/cases/${c.id}/reply">${csrfField(req)}
<label for="body">Message (AI draft — check before sending)</label><textarea id="body" name="body" rows="4" required>${esc(c.draft_reply)}</textarea>
<label class="inline"><input type="checkbox" name="handled" value="1"> Mark as handled after sending</label>
<p><button class="accent">Send to girl ${esc(c.anon_id)}</button></p></form></div>`,
        nav(req),
      ),
    );
  });

  r.post("/cases/:id/reply", careTeam, async (req, res) => {
    const s = staffOf(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send("Case not found");
    const [c] = await db.query(`SELECT * FROM cases WHERE id = $1`, [id]);
    if (!c) return res.status(404).send("Case not found");
    const [user] = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [c.user_id]);
    const body = String(req.body.body ?? "").trim().slice(0, 1600);
    if (user && body) {
      const messageId = await sendToUser(db, user, body, null, s.id);
      await auditReq(db, req, { action: "case.reply", targetType: "case", targetId: c.id, details: { messageId } });
      await db.query(`UPDATE cases SET first_reply_at = COALESCE(first_reply_at, now()), assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`, [c.id, s.id]);
    }
    if (req.body.handled) {
      const done = await db.query(`UPDATE cases SET status = 'handled', handled_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [c.id]);
      if (done.length) await auditReq(db, req, { action: "case.handled", targetType: "case", targetId: c.id });
      if (s.role === "dada" && config.dadaPayPerCaseKes > 0) {
        await db.query(`INSERT INTO dada_payouts (staff_id, case_id, amount_kes) VALUES ($1,$2,$3)`, [s.id, c.id, config.dadaPayPerCaseKes]);
      }
    }
    res.redirect(req.body.handled ? "/staff/inbox" : `/staff/cases/${c.id}`);
  });

  // ---- Clinic desk: check a pass (sees services only, never who she is) ----
  const clinicTeam = requireRole(db, ["admin", "clinic"]);
  const clinicPage = (req: Request, result = "") =>
    page(
      "Check a pass",
      `${h1("Check", "a referral pass", "Clinic desk")}<p class="lead">Type the code she shows you. You will see the services she needs, never her name.</p><div class="card"><form method="post" action="/staff/clinic/check">${csrfField(req)}<label for="code">Pass code</label>
<input id="code" name="code" placeholder="UB-7K42" autocomplete="off" required style="text-transform:uppercase;font-size:22px;letter-spacing:2px">
<p><button class="accent">Check pass</button></p></form></div>${result}`,
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

  // ---- Partner dashboard ----
  r.get("/dashboard", requireRole(db, ["admin", "nurse", "partner"]), async (req, res) => {
    const s = staffOf(req);
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const st = await dashboardStats(db, days);
    const totalTopics = st.topics.reduce((a, t) => a + t.n, 0) || 1;
    const tile = (label: string, value: string, note: string, strong = false) =>
      `<div class="card" ${strong ? 'style="border-color:var(--accent);background:var(--accent-soft)"' : ""}><div class="eyebrow">${label}</div><div class="stat">${value}</div><div class="muted">${note}</div></div>`;
    const clinicRows = st.clinics
      .map(
        (c) => `<tr><td><strong>${esc(c.name)}</strong><div class="muted">${esc(c.area)}${c.verified ? "" : " · not yet verified"}</div></td><td>${c.passes}</td><td>${c.visits}</td>
<td>${c.respectYes == null ? `<span class="muted">fewer than ${MIN_RESPONSES} answers</span>` : `${pct(c.respectYes)} yes · ${pct(c.respectPartly)} partly · ${pct(c.respectNo)} no`}</td></tr>`,
      )
      .join("");
    const topicRows = st.topics
      .map((t) => `<div style="margin:8px 0"><div class="row" style="justify-content:space-between"><span>${esc(t.topic.replace("_", " "))}</span><span class="muted">${pct(t.n / totalTopics)}</span></div><div class="bar"><span style="width:${(t.n / totalTopics) * 100}%"></span></div></div>`)
      .join("");
    const model = (task: string) => {
      const r = st.modelReports[task];
      if (!r) return "not trained";
      return `${pct(r.accuracy)} accuracy on ${r.examples} examples (${Object.entries(r.sources).map(([k, v]) => `${v} ${k}`).join(", ")})`;
    };
    res.send(
      page(
        "Dashboard",
        `<div class="row between"><div>${h1("Partner", "dashboard", `Last ${days} days`)}</div><div class="row pills">${[7, 30, 90]
          .map((d) => `<a class="btn ${d === days ? "" : "secondary"}" href="?days=${d}">${d} days</a>`)
          .join("")}</div></div>
<p class="lead">All figures are anonymous. Clinic scores appear only once ${MIN_RESPONSES} or more girls have answered.</p>
<div class="grid" style="margin-bottom:14px">
${tile("Questions answered", String(st.questions), `${st.girls} girls · ${pct(st.voiceShare)} by voice note`)}
${tile("Referral passes", String(st.passes), `across ${st.passClinics} clinics`)}
${tile("Visits confirmed", pct(st.visitRate), `${st.visitsConfirmed} of ${st.checkinsAnswered} check-in answers`, true)}
${tile("Urgent handoffs", String(st.urgentCases), st.medianUrgentReplyMin == null ? "no replies yet" : `median first reply ${Math.round(st.medianUrgentReplyMin)} min`)}
</div>
<div class="card"><div class="eyebrow">Closing the loop</div><h2><em>Clinic</em> dignity scores</h2><p class="muted">From girls' anonymous day-3 check-ins after each referral.</p><div class="scroll"><table>
<thead><tr><th>Clinic</th><th>Passes</th><th>Visits confirmed</th><th>Treated with respect</th></tr></thead><tbody>${clinicRows}</tbody></table></div></div>
<div class="grid"><div class="card"><div class="eyebrow">Unmet need</div><h2><em>What</em> girls ask about</h2>${topicRows || '<p class="muted">No questions yet.</p>'}</div>
<div class="card"><div class="eyebrow">Machine learning</div><h2><em>Ubah's</em> own models</h2><p><strong>Danger-sign classifier:</strong> ${model("danger")}</p><p><strong>Topic classifier:</strong> ${model("topic")}</p>
<p class="muted">${st.labelledMessages} messages labelled by nurses and Dadas so far · ${st.codedTermMessages} messages used coded words · ${st.openCases} open cases${
          st.dadaPayoutsPendingKes ? ` · KES ${st.dadaPayoutsPendingKes} Dada pay pending` : ""
        }</p></div></div>
${s.role === "admin" ? `<div class="card"><h2>Admin</h2><form method="post" action="/staff/admin/run-checkins">${csrfField(req)}<button class="secondary">Send due check-ins now</button></form>${req.query.sent != null ? `<p class="muted" role="status">${Number(req.query.sent)} check-in(s) sent.</p>` : ""}</div>` : ""}`,
        nav(req),
      ),
    );
  });

  r.post("/admin/run-checkins", requireRole(db, ["admin"]), async (req, res) => {
    const sent = await sendDueCheckins(db);
    await auditReq(db, req, { action: "checkins.run", details: { sent } });
    res.redirect(`/staff/dashboard?sent=${sent}`);
  });

  // ---- Labelling: nurses and Dadas create the training data for Ubah's own models ----
  r.get("/label", careTeam, async (req, res) => {
    const s = staffOf(req);
    const [m] = await db.query(
      `SELECT m.id, m.body, m.topic, m.danger, u.language FROM messages m JOIN users u ON u.id = m.user_id
        WHERE m.direction = 'in' AND m.danger IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.message_id = m.id AND l.labeled_by = $1)
        ORDER BY m.id DESC LIMIT 1`,
      [s.id],
    );
    const [{ n }] = await db.query(`SELECT count(DISTINCT message_id)::int AS n FROM labels WHERE labeled_by = $1`, [s.id]);
    const radios = (name: string, opts: string[], predicted: string | null) =>
      opts.map((o) => `<label class="inline"><input type="radio" name="${name}" value="${o}" ${o === predicted ? "checked" : ""} required> ${esc(o.replace("_", " "))}</label>`).join("");
    const body = m
      ? `<div class="card"><p class="muted">Anonymous message · ${esc(m.language ?? "?")}</p><p style="font-size:20px">${esc(m.body)}</p></div>
<form method="post" action="/staff/label" class="card">${csrfField(req)}<input type="hidden" name="message_id" value="${m.id}">
<h2>Is this urgent?</h2>${radios("danger", DANGER, m.danger)}<h2 style="margin-top:14px">Topic</h2>${radios("topic", TOPICS, m.topic)}
<p class="muted">The model's guess is pre-selected. Change it if it's wrong — that is what teaches the model.</p><p><button class="accent">Save and next</button></p></form>`
      : `<div class="card">Nothing left to label. Thank you!</div>`;
    res.send(page("Label messages", `${h1("Label", "messages", "Training data")}<p class="lead">You have labelled ${n}. Your labels train Ubah's danger-sign and topic models.</p>${body}`, nav(req)));
  });
  r.post("/label", careTeam, async (req: Request, res) => {
    const s = staffOf(req);
    const id = Number(req.body.message_id);
    if (!Number.isInteger(id)) return res.redirect("/staff/label");
    const saved: Record<string, string> = {};
    for (const task of ["danger", "topic"] as const) {
      const v = String(req.body[task] ?? "");
      if ((task === "danger" ? DANGER : TOPICS).includes(v)) {
        await db.query(
          `INSERT INTO labels (message_id, task, label, labeled_by) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id, task, labeled_by) DO UPDATE SET label = EXCLUDED.label`,
          [id, task, v, s.id],
        );
        saved[task] = v;
      }
    }
    if (Object.keys(saved).length) await auditReq(db, req, { action: "label.save", targetType: "message", targetId: id, details: saved });
    res.redirect("/staff/label");
  });

  // ---- Audit log: who viewed which case, who sent what, who changed what ----
  r.get("/audit", requireRole(db, ["admin"]), async (req, res) => {
    const PAGE = 50;
    const pageNo = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
    const f = {
      staff: String(req.query.staff ?? "").trim().slice(0, 100),
      action: String(req.query.action ?? "").trim().slice(0, 60),
      target: String(req.query.target ?? "").trim().slice(0, 60),
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from ?? "")) ? String(req.query.from) : "",
      to: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to ?? "")) ? String(req.query.to) : "",
    };
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.staff) add("staff_login = ?", f.staff);
    if (f.action) add("action LIKE ?", `${f.action.replace(/[%_]/g, "")}%`);
    if (f.target) {
      const [type, id] = f.target.split(":");
      add("target_type = ?", type);
      if (id) add("target_id = ?", id);
    }
    if (f.from) add("at >= ?::date", f.from);
    if (f.to) add("at < ?::date + 1", f.to);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await db.query(
      `SELECT id, at, staff_login, action, target_type, target_id, details, ip FROM audit_log ${whereSql} ORDER BY id DESC LIMIT ${PAGE + 1} OFFSET ${(pageNo - 1) * PAGE}`,
      params,
    );
    const more = rows.length > PAGE;
    const actions = await db.query<{ action: string }>(`SELECT DISTINCT action FROM audit_log ORDER BY action`);
    await auditReq(db, req, { action: "audit.view", details: f });
    const qs = (p: number) => `?${new URLSearchParams({ ...f, page: String(p) })}`;
    const target = (r: any) => {
      if (!r.target_type) return "";
      const label = `${esc(r.target_type)} ${esc(r.target_id ?? "")}`;
      return r.target_type === "case" ? `<a href="/staff/cases/${esc(r.target_id)}">${label}</a>` : label;
    };
    const table = rows
      .slice(0, PAGE)
      .map(
        (r) => `<tr><td style="white-space:nowrap">${esc(new Date(r.at).toISOString().replace("T", " ").slice(0, 19))} UTC</td><td>${esc(r.staff_login ?? "—")}</td><td><span class="tag">${esc(r.action)}</span></td>
<td>${target(r)}</td><td class="muted">${esc(Object.keys(r.details ?? {}).length ? JSON.stringify(r.details) : "")}</td><td class="muted">${esc(r.ip ?? "")}</td></tr>`,
      )
      .join("");
    res.send(
      page(
        "Audit log",
        `${h1("Audit", "log", "Accountability")}<p class="lead">Every login, case view, reply, pass check and change is recorded here and cannot be edited or deleted. Message text and phone numbers are never stored in the log.</p>
<form method="get" action="/staff/audit" class="card"><div class="grid" style="margin:0">
<div><label for="f-staff">Staff login</label><input id="f-staff" name="staff" value="${esc(f.staff)}"></div>
<div><label for="f-action">Action</label><select id="f-action" name="action"><option value="">Any</option>${actions.map((a) => `<option ${a.action === f.action ? "selected" : ""}>${esc(a.action)}</option>`).join("")}</select></div>
<div><label for="f-target">Target (e.g. case:12)</label><input id="f-target" name="target" value="${esc(f.target)}"></div>
<div><label for="f-from">From</label><input id="f-from" name="from" type="date" value="${esc(f.from)}"></div>
<div><label for="f-to">To</label><input id="f-to" name="to" type="date" value="${esc(f.to)}"></div></div>
<p class="row"><button>Filter</button><a class="btn secondary" href="/staff/audit">Clear</a></p></form>
<div class="card"><div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
<tbody>${table || `<tr><td colspan="6">No entries match.</td></tr>`}</tbody></table></div>
<p class="row">${pageNo > 1 ? `<a class="btn secondary" href="${qs(pageNo - 1)}">Newer</a>` : ""}${more ? `<a class="btn secondary" href="${qs(pageNo + 1)}">Older</a>` : ""}</p></div>`,
        nav(req),
      ),
    );
  });

  return r;
}
