import { Router, type Request, type Response } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { logAccess } from "../auth/access.js";
import { workerLabel } from "../languages/index.js";
import { csrfField } from "../security/csrf.js";
import { decrypt, encrypt, NEXT, STATUSES, type Status } from "../safeguarding.js";
import { requireRole, staffOf } from "./auth.js";
import { esc, h1, notice, page, select, textarea, when } from "./html.js";
import { nav } from "./nav.js";
import { sendToUser, type UserRow } from "../channels/outbound.js";
import { chooseTranslation, type ReplySource } from "../replies.js";

// Confidential reports: protection officers only (not nurses, Dadas or admins), apart from the
// ordinary inbox. Every look goes in the access log, every step in the report's history (with a
// note for each status change) and the audit log. The priority hint is a suggestion: the officer decides.

const CATEGORY: Record<string, string> = {
  harassment: "Harassment",
  abuse: "Abuse or violence",
  exploitation: "Exploitation (sex, money, work, marriage)",
  online: "Online harm",
  other: "Something else",
};
const WHO: Record<string, string> = { family: "Family", partner: "Boyfriend or husband", school: "Someone at school", stranger: "A stranger", online: "Someone online", other: "Someone else", not_said: "Rather not say" };
const WHEN: Record<string, string> = { now: "Happening now", days: "Last few days", weeks: "Last few weeks", longer: "Longer ago", not_said: "Rather not say" };
const STATUS: Record<Status, string> = { new: "New", in_review: "In review", referred: "Referred", follow_up: "Follow-up", closed: "Closed" };

export function safeguardingRouter(db: Db): Router {
  const r = Router();
  const officers = requireRole(db, ["protection"]);

  r.get("/safeguarding", officers, async (req, res) => {
    const status = (STATUSES as readonly string[]).includes(String(req.query.status)) ? String(req.query.status) : "";
    const rows = await db.query<any>(
      `SELECT r.id, r.category, r.in_danger, r.priority_hint, r.status, r.follow_up_at, r.created_at, r.updated_at, u.anon_id, u.language, u.age_band, s.name AS assignee
         FROM safeguarding_reports r JOIN users u ON u.id = r.user_id LEFT JOIN staff s ON s.id = r.assigned_to
        WHERE ($1 = '' AND r.status <> 'closed') OR r.status = $1
        ORDER BY r.in_danger DESC, (r.priority_hint = 'high') DESC, (r.follow_up_at IS NOT NULL AND r.follow_up_at <= now()) DESC, r.created_at`,
      [status],
    );
    const pill = (v: string, label: string) => `<a class="btn ${status === v ? "" : "secondary"} small" href="/staff/safeguarding${v ? `?status=${v}` : ""}">${esc(label)}</a>`;
    const card = (x: any) => `<div class="card"><div class="row between"><span>
${x.in_danger ? `<span class="tag urgent">In danger</span> ` : ""}${x.priority_hint === "high" ? `<span class="tag urgent">Suggested: high priority</span> ` : ""}<span class="tag">${esc(STATUS[x.status as Status])}</span>
${x.age_band === "under_15" || x.age_band === "15_17" ? ` <span class="tag urgent">Under 18</span>` : ""}</span><span class="muted">${when(x.created_at)}</span></div>
<p><strong>${esc(CATEGORY[x.category] ?? x.category)}</strong> · girl ${esc(x.anon_id)} · ${esc(workerLabel(x.language))}${x.assignee ? ` · with ${esc(x.assignee)}` : " · <strong>not taken</strong>"}${x.follow_up_at ? ` · follow up ${when(x.follow_up_at)}${new Date(x.follow_up_at) <= new Date() ? " <strong>(due)</strong>" : ""}` : ""}</p>
<a class="btn secondary" href="/staff/safeguarding/${x.id}">Open report</a></div>`;
    res.send(
      page(
        "Confidential reports",
        `${h1("Confidential", "reports", "Protection")}${notice(req.query)}
<p class="muted">Only protection officers can open these. Each look is recorded. "Suggested priority" comes from her answers and Ubah's danger lists: it is a suggestion, check it yourself.</p>
<div class="row pills" style="margin-bottom:14px">${pill("", "Open")}${STATUSES.map((s) => pill(s, STATUS[s])).join("")}</div>
${rows.map(card).join("") || `<div class="card"><p>Nothing here.</p></div>`}`,
        nav(req),
      ),
    );
  });

  async function load(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rep] = Number.isInteger(id)
      ? await db.query<any>(
          `SELECT r.*, u.anon_id, u.language, u.age_band, u.site_id, s.name AS assignee FROM safeguarding_reports r JOIN users u ON u.id = r.user_id LEFT JOIN staff s ON s.id = r.assigned_to WHERE r.id = $1`,
          [id],
        )
      : [];
    if (!rep) res.status(404).send(page("Not found", `${h1("Report", "not found")}`, nav(req)));
    return rep ?? null;
  }

  r.get("/safeguarding/:id", officers, async (req, res) => {
    const rep = await load(req, res);
    if (!rep) return;
    await logAccess(db, req, rep.user_id, "report", rep.id);
    const events = await db.query<any>(
      `SELECT e.*, s.name, c.name AS contact, c.organisation FROM safeguarding_events e LEFT JOIN staff s ON s.id = e.staff_id LEFT JOIN protection_contacts c ON c.id = e.contact_id WHERE e.report_id = $1 ORDER BY e.id`,
      [rep.id],
    );
    const contacts = await db.query<any>(
      `SELECT id, name, organisation, service FROM protection_contacts WHERE active AND verified ${rep.site_id ? "AND site_id = $1" : ""} ORDER BY name`,
      rep.site_id ? [rep.site_id] : [],
    );
    const form = (path: string, body: string, button: string) =>
      `<form method="post" action="/staff/safeguarding/${rep.id}/${path}" class="card">${csrfField(req)}${body}<p><button class="accent">${esc(button)}</button></p></form>`;
    const next = NEXT[rep.status as Status];
    const describe = (e: any) => {
      const what =
        e.kind === "created"
          ? "Report received"
          : e.kind === "status"
            ? `Status: ${STATUS[e.from_status as Status] ?? e.from_status} → ${STATUS[e.to_status as Status] ?? e.to_status}`
            : e.kind === "referral"
              ? `Referred to ${esc(e.contact)}${e.organisation ? ` (${esc(e.organisation)})` : ""}`
              : e.kind === "assigned"
                ? "Taken"
                : e.kind === "message"
                  ? "Message sent to her"
                  : "Note";
      const note = decrypt(e.note_enc);
      return `<li><strong>${what}</strong>${e.name ? ` by ${esc(e.name)}` : ""}${note ? `<br><span style="white-space:pre-wrap">${esc(note)}</span>` : ""}<time>${when(e.at)}</time></li>`;
    };
    res.send(
      page(
        `Report ${rep.id}`,
        `<p class="noprint"><a href="/staff/safeguarding">← Reports</a></p>${notice(req.query)}
<div class="card">${rep.in_danger ? `<span class="tag urgent">She said she is in danger now</span> ` : ""}${rep.priority_hint === "high" ? `<span class="tag urgent">Suggested: high priority (check yourself)</span> ` : ""}<span class="tag">${esc(STATUS[rep.status as Status])}</span>
<h1 style="margin-top:10px">${esc(CATEGORY[rep.category] ?? rep.category)}</h1>
<p class="muted">Girl ${esc(rep.anon_id)} · ${esc(workerLabel(rep.language))} · received ${when(rep.created_at)} · ${rep.assignee ? `with ${esc(rep.assignee)}` : "not taken"}</p>
${rep.age_band === "under_15" || rep.age_band === "15_17" ? `<p><span class="tag urgent">Under 18</span> She said she is ${rep.age_band === "under_15" ? "under 15" : "15 to 17"}: follow the child-safeguarding procedure.</p>` : ""}
<p><strong>Who:</strong> ${esc(WHO[rep.who] ?? "Not said")} · <strong>When:</strong> ${esc(WHEN[rep.happened] ?? "Not said")} · <strong>May we reply to her in Ubah:</strong> ${rep.contact_ok ? "Yes" : "No"}</p>
${rep.description_enc ? `<p class="muted">In her words</p><div class="bubble in" style="max-width:100%;white-space:pre-wrap">${esc(decrypt(rep.description_enc))}</div>` : `<p class="muted">She wrote nothing more.</p>`}
${rep.assigned_to ? "" : `<form method="post" action="/staff/safeguarding/${rep.id}/take" style="display:inline">${csrfField(req)}<button class="accent small">Take this report</button></form>`}</div>
${next.length ? form("status", `<h2>Change status</h2>${select("New status", "to", next.map((s) => [s, STATUS[s]]), next[0], { required: true })}${textarea("Why (required: it goes in the report's history)", "note", "", { rows: 2, required: true })}`, "Save status") : ""}
${form("referral", `<h2>Refer</h2>${contacts.length ? select("Verified contact", "contact_id", contacts.map((c) => [String(c.id), `${c.name}${c.organisation ? `, ${c.organisation}` : ""}${c.service ? ` (${c.service})` : ""}`]), "", { required: true }) : `<p class="muted">No verified referral contacts${rep.site_id ? " for her site" : ""} yet. An admin adds and verifies them under Admin → Sites.</p>`}${textarea("Note (what was agreed, with whom)", "note", "", { rows: 2, required: true })}`, "Record referral")}
${form("follow-up", `<h2>Follow up</h2><label for="at">Follow up on</label><input id="at" name="at" type="date" required${rep.follow_up_at ? ` value="${new Date(rep.follow_up_at).toISOString().slice(0, 10)}"` : ""}>`, "Set follow-up date")}
${rep.contact_ok
  ? form("message", `<h2>Write to her</h2><p class="muted">She said a protection worker may reply to her in Ubah. It appears in her conversation as "A protection worker". Never ask her to reply if it may put her at risk.</p>${textarea("Message", "body", "", { rows: 3, required: true })}${rep.language && rep.language !== "en" ? `<label class="inline"><input type="checkbox" name="translate" value="1"> I wrote in English: translate it into ${esc(workerLabel(rep.language))} for her (you'll see it before it is sent)</label>` : ""}`, "Send to her")
  : `<div class="card"><h2>Write to her</h2><p class="muted">She did not agree to be contacted in Ubah. Use the referral and her Dada instead, as your procedure says.</p></div>`}
${form("note", `<h2>Add a note</h2><p class="muted">Only protection officers can read notes. Never write her name or phone number.</p>${textarea("Note", "note", "", { rows: 3, required: true })}`, "Add note")}
<div class="card"><h2>History</h2><ul class="timeline">${events.map(describe).join("")}</ul></div>`,
        nav(req),
      ),
    );
  });

  const action = (path: string, fn: (req: Request, rep: any) => Promise<string | void>) =>
    r.post(`/safeguarding/:id/${path}`, officers, async (req, res) => {
      const rep = await load(req, res);
      if (!rep) return;
      const out = await fn(req, rep);
      res.redirect(`/staff/safeguarding/${rep.id}${out ?? "?done=saved"}`);
    });
  const note = (req: Request) => String(req.body.note ?? "").trim().slice(0, 4000);

  action("take", async (req, rep) => {
    const me = staffOf(req);
    await db.query(`UPDATE safeguarding_reports SET assigned_to = $2, updated_at = now() WHERE id = $1`, [rep.id, me.id]);
    await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind) VALUES ($1,$2,'assigned')`, [rep.id, me.id]);
    await auditReq(db, req, { action: "report.take", targetType: "report", targetId: rep.id });
  });

  action("status", async (req, rep) => {
    const to = String(req.body.to ?? "") as Status;
    if (!NEXT[rep.status as Status].includes(to) || !note(req)) return "?error=invalid";
    const me = staffOf(req);
    await db.query(`UPDATE safeguarding_reports SET status = $2, updated_at = now(), assigned_to = COALESCE(assigned_to, $3) WHERE id = $1`, [rep.id, to, me.id]);
    await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind, from_status, to_status, note_enc) VALUES ($1,$2,'status',$3,$4,$5)`, [rep.id, me.id, rep.status, to, encrypt(note(req))]);
    await auditReq(db, req, { action: "report.status", targetType: "report", targetId: rep.id, details: { from: rep.status, to } });
  });

  action("referral", async (req, rep) => {
    const contactId = Number(req.body.contact_id);
    const [c] = Number.isInteger(contactId) ? await db.query(`SELECT id FROM protection_contacts WHERE id = $1 AND active AND verified`, [contactId]) : [];
    if (!c || !note(req)) return "?error=invalid";
    const me = staffOf(req);
    await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind, contact_id, note_enc) VALUES ($1,$2,'referral',$3,$4)`, [rep.id, me.id, contactId, encrypt(note(req))]);
    // A referral moves a report being reviewed to "referred" (recorded like any status change).
    if (rep.status === "in_review" || rep.status === "follow_up") {
      await db.query(`UPDATE safeguarding_reports SET status = 'referred', updated_at = now() WHERE id = $1`, [rep.id]);
      await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind, from_status, to_status) VALUES ($1,$2,'status',$3,'referred')`, [rep.id, me.id, rep.status]);
    }
    await auditReq(db, req, { action: "report.referral", targetType: "report", targetId: rep.id, details: { contactId } });
  });

  action("follow-up", async (req, rep) => {
    const at = new Date(String(req.body.at ?? ""));
    if (Number.isNaN(at.getTime())) return "?error=invalid";
    await db.query(`UPDATE safeguarding_reports SET follow_up_at = $2, updated_at = now() WHERE id = $1`, [rep.id, at]);
    await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind, note_enc) VALUES ($1,$2,'note',$3)`, [rep.id, staffOf(req).id, encrypt(`Follow-up set for ${at.toISOString().slice(0, 10)}`)]);
    await auditReq(db, req, { action: "report.follow_up", targetType: "report", targetId: rep.id });
  });

  // A message to her, only if she agreed. Written in English for a girl who reads another language:
  // shown translated first, sent only once the officer confirms (as in the /staff case reply).
  r.post("/safeguarding/:id/message", officers, async (req, res) => {
    const rep = await load(req, res);
    if (!rep) return;
    if (!rep.contact_ok) return res.redirect(`/staff/safeguarding/${rep.id}?error=invalid`);
    const body = String(req.body.body ?? "").trim().slice(0, 1600);
    if (!body) return res.redirect(`/staff/safeguarding/${rep.id}?error=invalid`);
    const [user] = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [rep.user_id]);
    let outgoing = body;
    let english: { text: string; source: ReplySource } | null = null;
    if (req.body.translate && user.language && user.language !== "en") {
      if (!req.body.confirm) {
        const t = await chooseTranslation(db, user.language, body);
        if (!t.ok) return res.send(page("Not translated", `<div class="card"><h1><em>Not</em> translated</h1><p>The translation service didn't answer, so nothing was sent.</p><p><a href="/staff/safeguarding/${rep.id}">← Back to the report</a></p></div>`, nav(req)));
        const hidden = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
        return res.send(
          page(
            "Check the translation",
            `<div class="card"><h1>Check <em>before sending</em></h1><p class="muted">You wrote</p><div class="bubble out" style="max-width:100%">${esc(body)}</div>
<p class="muted">She will receive</p><div class="bubble in" style="max-width:100%">${esc(t.text)}</div>
<p>${t.source === "template" ? `<span class="tag ok">Checked translation</span>` : `<span class="tag urgent">Machine translated: check the meaning</span>`}</p>
<form method="post" action="/staff/safeguarding/${rep.id}/message">${csrfField(req)}${hidden("body", body)}${hidden("translate", "1")}${hidden("confirm", "1")}${hidden("translated", t.text)}${hidden("source", t.source)}<p><button class="accent">Send this to her</button></p></form>
<p><a href="/staff/safeguarding/${rep.id}">← Back to the report (nothing was sent)</a></p></div>`,
            nav(req),
          ),
        );
      }
      const source = String(req.body.source ?? "");
      outgoing = String(req.body.translated ?? "").trim().slice(0, 2000);
      if (!outgoing || !["template", "machine"].includes(source)) return res.redirect(`/staff/safeguarding/${rep.id}?error=invalid`);
      english = { text: body, source: source as ReplySource };
    }
    const me = staffOf(req);
    // Into her app conversation (the report came from the app).
    const messageId = await sendToUser(db, { ...user, channel: "web" }, outgoing, null, me.id, english ? { englishText: english.text, englishSource: english.source } : {});
    await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind, note_enc) VALUES ($1,$2,'message',$3)`, [rep.id, me.id, encrypt(english ? english.text : outgoing)]);
    await auditReq(db, req, { action: "report.message", targetType: "report", targetId: rep.id, details: { messageId } });
    res.redirect(`/staff/safeguarding/${rep.id}?done=sent`);
  });

  action("note", async (req, rep) => {
    if (!note(req)) return "?error=invalid";
    await db.query(`INSERT INTO safeguarding_events (report_id, staff_id, kind, note_enc) VALUES ($1,$2,'note',$3)`, [rep.id, staffOf(req).id, encrypt(note(req))]);
    await db.query(`UPDATE safeguarding_reports SET updated_at = now() WHERE id = $1`, [rep.id]);
    await auditReq(db, req, { action: "report.note", targetType: "report", targetId: rep.id });
  });

  return r;
}
