import { Router, type Request } from "express";
import type { Db } from "../db.js";
import { ALL_ROLES, requireRole, staffOf } from "./auth.js";
import { csrfField } from "../security/csrf.js";
import { auditReq } from "../audit.js";
import { HOME } from "./login.js";
import { page, esc, h1 } from "./html.js";
import { nav } from "./nav.js";
import { sendDueCheckins } from "../engine.js";
import { LIVE_JS } from "./inbox.js";

// Home redirect, the labelling tool, the audit log and small admin actions.
// Other staff pages: inbox.ts, clinic.ts, dashboard.ts, content.ts, strings.ts, admin.ts, payments.ts.

const TOPICS = ["periods", "pregnancy", "family_planning", "sti", "safety", "body", "feelings", "other"];
const DANGER = ["none", "medical", "safety", "selfharm"];

export function staffRouter(db: Db): Router {
  const r = Router();
  const careTeam = requireRole(db, ["admin", "nurse", "dada"]);

  r.get("/", requireRole(db, ALL_ROLES), (req, res) => res.redirect(HOME[staffOf(req).role]));

  // Scripts are served as files so the Content-Security-Policy can forbid inline scripts.
  r.get("/assets/live.js", (_req, res) => {
    res.type("application/javascript").setHeader("Cache-Control", "public, max-age=3600");
    res.send(LIVE_JS);
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
