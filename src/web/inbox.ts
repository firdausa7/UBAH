import { Router, type Request, type Response } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { auditReq } from "../audit.js";
import { LANGUAGES } from "../i18n.js";
import { workerLabel } from "../languages/index.js";
import { sendToUser, type UserRow } from "../channels/outbound.js";
import { canSee, caseBus, caseEvent, escalateToNurse, REASON_LABEL, visibleSql, type CaseSignal } from "../cases.js";
import { csrfField } from "../security/csrf.js";
import { requireRole, staffOf } from "./auth.js";
import { page, esc, h1, notice, select, textarea, when } from "./html.js";
import { nav } from "./nav.js";

// Dada and nurse inbox: claim and assign cases, internal notes, history, escalation,
// the protection pathway for safety cases, and live updates.

const ago = (d: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const EVENT_LABEL: Record<string, string> = {
  opened: "Case opened",
  claimed: "Claimed",
  assigned: "Assigned",
  unassigned: "Returned to the shared queue",
  note: "Internal note added",
  reply: "Reply sent to the girl",
  escalated: "Escalated to a nurse",
  handled: "Marked as handled",
  reopened: "Reopened",
  site: "Site set",
  step: "Protection step done",
  step_undone: "Protection step un-ticked",
  reminder: "No reply yet: nurses reminded",
};

// The inbox page's live-update script (served as a file: the CSP forbids inline scripts).
export const LIVE_JS = `
(function () {
  var box = document.getElementById('live');
  if (!box || !window.EventSource) return;
  var es = new EventSource('/staff/events');
  es.addEventListener('case', function (e) {
    var c = JSON.parse(e.data);
    box.hidden = false;
    box.querySelector('[data-msg]').textContent = (c.urgent ? 'New urgent case' : 'New case') + (c.kind === 'escalated' ? ' escalated to nurses' : '') + ' (#' + c.id + ').';
  });
})();
`;

// What the speech model made of a voice note: shown above its transcript. The audio itself is not kept.
function voiceNote(m: { detected_language: string | null; stt_confidence: number | null; language_mismatch: boolean; voice_unclear: boolean }, chosen: string | null): string {
  const bits = [`<span class="muted">Voice note${m.stt_confidence !== null ? ` · ${Math.round(m.stt_confidence * 100)}% sure` : ""} · </span>`];
  if (m.voice_unclear) bits.push(`<span class="tag urgent">Audio unclear: she was asked to try again or type</span> `);
  if (m.language_mismatch) bits.push(`<span class="tag">Sounded like ${esc(workerLabel(m.detected_language))}, she chose ${esc(workerLabel(chosen))}</span> `);
  return bits.join("");
}

export function inboxRouter(db: Db): Router {
  const r = Router();
  const careTeam = requireRole(db, ["admin", "nurse", "dada"]);
  const leads = requireRole(db, ["admin", "nurse"]);

  async function loadCase(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [c] = Number.isInteger(id)
      ? await db.query(
          `SELECT c.*, u.anon_id, u.language, u.channel, a.name AS assignee, a.role AS assignee_role, s.name AS site_name
             FROM cases c JOIN users u ON u.id = c.user_id LEFT JOIN staff a ON a.id = c.assigned_to LEFT JOIN sites s ON s.id = c.site_id WHERE c.id = $1`,
          [id],
        )
      : [];
    if (!c) {
      res.status(404).send(page("Not found", `${h1("Case", "not found")}<p><a href="/staff/inbox">Back to the inbox</a></p>`, nav(req)));
      return null;
    }
    if (!canSee(staffOf(req), c)) {
      res.status(403).send(page("Not your case", `${h1("Not", "your case")}<p>This case is handled by nurses.</p><p><a href="/staff/inbox">Back to the inbox</a></p>`, nav(req)));
      return null;
    }
    return c;
  }

  // ---- Inbox ----
  r.get("/inbox", careTeam, async (req, res) => {
    const me = staffOf(req);
    const status = req.query.status === "handled" ? "handled" : "open";
    const f = {
      urgent: req.query.urgent === "1",
      mine: req.query.mine === "1",
      unassigned: req.query.unassigned === "1",
      lang: String(req.query.lang ?? "") in LANGUAGES ? String(req.query.lang) : "",
    };
    const cases = await db.query(
      `SELECT c.*, u.anon_id, u.language, u.channel, a.name AS assignee FROM cases c JOIN users u ON u.id = c.user_id LEFT JOIN staff a ON a.id = c.assigned_to
        WHERE c.status = $1 AND ${visibleSql(me, "$2")}
          AND (NOT $3 OR c.urgent) AND (NOT $4 OR c.assigned_to = $2) AND (NOT $5 OR c.assigned_to IS NULL) AND ($6 = '' OR u.language = $6)
        ORDER BY c.urgent DESC, c.created_at ${status === "open" ? "ASC" : "DESC"} LIMIT 200`,
      [status, me.id, f.urgent, f.mine, f.unassigned, f.lang],
    );
    const qs = (patch: Record<string, string | null>) => {
      const p = new URLSearchParams();
      const cur: Record<string, string> = { status, ...(f.urgent ? { urgent: "1" } : {}), ...(f.mine ? { mine: "1" } : {}), ...(f.unassigned ? { unassigned: "1" } : {}), ...(f.lang ? { lang: f.lang } : {}) };
      for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) p.set(k, v);
      return `/staff/inbox?${p}`;
    };
    const pill = (label: string, on: boolean, href: string) => `<a class="btn ${on ? "" : "secondary"}" href="${href}">${label}</a>`;
    const cards = cases
      .map(
        (c) => `<div class="card"><div class="row between"><span><span class="tag ${c.urgent ? "urgent" : ""}">${esc(REASON_LABEL[c.reason] ?? c.reason)}</span> ${c.level === "nurse" ? `<span class="tag">Nurse</span>` : ""}</span><span class="muted">${ago(c.created_at)}</span></div>
<p class="muted">Girl ${esc(c.anon_id)} · ${esc(workerLabel(c.language))} · ${esc(c.channel)} · ${c.assignee ? `with ${esc(c.assignee)}` : "<strong>unassigned</strong>"}</p><p>${esc(c.summary)}</p><a class="btn secondary" href="/staff/cases/${c.id}">Open case</a></div>`,
      )
      .join("");
    res.send(
      page(
        "Inbox",
        `<div id="live" class="notice live" role="status" hidden><span data-msg></span> <a class="btn small" href="${qs({})}">Show</a></div>
${h1("Dada", "inbox", "Care team")}${notice(req.query)}<p class="lead">Urgent cases come first. The AI drafts; a Dada or nurse always decides what is sent.${me.role === "dada" ? " Medical and self-harm cases go to nurses; escalate any case you need help with." : ""}</p>
<div class="row pills" style="margin-bottom:10px">${pill("Open", status === "open", qs({ status: "open" }))}${pill("Handled", status === "handled", qs({ status: "handled" }))}</div>
<div class="row pills" style="margin-bottom:18px">${pill("Urgent", f.urgent, qs({ urgent: f.urgent ? null : "1" }))}${pill("Mine", f.mine, qs({ mine: f.mine ? null : "1", unassigned: null }))}${pill("Unassigned", f.unassigned, qs({ unassigned: f.unassigned ? null : "1", mine: null }))}
${Object.keys(LANGUAGES).map((l) => pill(workerLabel(l), f.lang === l, qs({ lang: f.lang === l ? null : l }))).join("")}</div>
${cards || `<div class="card">No ${status} cases match.</div>`}<script src="/staff/assets/live.js" defer></script>`,
        nav(req),
      ),
    );
  });

  // ---- Live updates (server-sent events) ----
  r.get("/events", careTeam, async (req, res) => {
    const me = staffOf(req);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 10000\n\n");
    const send = (c: CaseSignal) => {
      if (!canSee(me, { level: c.level, assigned_to: null })) return;
      res.write(`event: case\ndata: ${JSON.stringify({ id: c.id, urgent: c.urgent, kind: c.kind })}\n\n`);
    };
    caseBus.on("case", send);
    // Cases opened on another app instance: look every 15 seconds.
    const [{ max }] = await db.query<{ max: number }>(`SELECT coalesce(max(id), 0)::int AS max FROM cases`);
    let lastId = max;
    const poll = setInterval(async () => {
      try {
        const rows = await db.query(`SELECT id, urgent, level FROM cases WHERE id > $1 ORDER BY id`, [lastId]);
        for (const c of rows) {
          lastId = Math.max(lastId, c.id);
          if (!seenLocally.has(c.id)) send({ id: c.id, urgent: c.urgent, level: c.level, kind: "opened" });
        }
      } catch {
        /* the next poll retries */
      }
    }, 15_000);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    req.on("close", () => {
      caseBus.off("case", send);
      clearInterval(poll);
      clearInterval(beat);
    });
  });
  // Ids already announced on this instance, so the poll doesn't repeat them.
  const seenLocally = new Set<number>();
  caseBus.on("case", (c: CaseSignal) => {
    seenLocally.add(c.id);
    if (seenLocally.size > 5000) seenLocally.clear();
  });

  // ---- One case ----
  r.get("/cases/:id", careTeam, async (req, res) => {
    const c = await loadCase(req, res);
    if (!c) return;
    const me = staffOf(req);
    await auditReq(db, req, { action: "case.view", targetType: "case", targetId: c.id });
    const msgs = await db.query(`SELECT m.direction, m.kind, m.body, m.created_at, m.detected_language, m.stt_confidence, m.language_mismatch, m.voice_unclear, s.name AS sender FROM messages m LEFT JOIN staff s ON s.id = m.sent_by_staff WHERE m.user_id = $1 ORDER BY m.id DESC LIMIT 40`, [c.user_id]);
    const notes = await db.query(`SELECT n.body, n.created_at, s.name FROM case_notes n JOIN staff s ON s.id = n.staff_id WHERE n.case_id = $1 ORDER BY n.id`, [c.id]);
    const events = await db.query(`SELECT e.kind, e.at, e.details, s.name FROM case_events e LEFT JOIN staff s ON s.id = e.staff_id WHERE e.case_id = $1 ORDER BY e.id`, [c.id]);
    const team = me.role === "dada" ? [] : await db.query(`SELECT id, name, role FROM staff WHERE active AND role IN ('nurse','dada') ORDER BY role DESC, name`);
    const sites = await db.query(`SELECT id, name FROM sites WHERE active ORDER BY name`);
    const steps = c.site_id ? await db.query(`SELECT p.*, cp.done_at, s.name AS done_by FROM protection_steps p LEFT JOIN case_protection cp ON cp.step_id = p.id AND cp.case_id = $2 LEFT JOIN staff s ON s.id = cp.done_by WHERE p.site_id = $1 AND p.active ORDER BY p.position, p.id`, [c.site_id, c.id]) : [];
    const contacts = c.site_id ? await db.query(`SELECT * FROM protection_contacts WHERE site_id = $1 AND active ORDER BY verified DESC, name`, [c.site_id]) : [];
    const post = (path: string, label: string, cls = "secondary", extra = "") => `<form method="post" action="/staff/cases/${c.id}/${path}" style="display:inline">${csrfField(req)}${extra}<button class="${cls} small">${esc(label)}</button></form>`;
    const open = c.status === "open";

    const actions = [
      open && !c.assigned_to ? post("claim", "Claim: I'll handle this", "accent") : "",
      open && c.assigned_to && (c.assigned_to === me.id || me.role !== "dada") ? post("unassign", "Return to shared queue") : "",
      open && c.level === "dada" ? post("escalate", "Escalate to nurse", "danger") : "",
      open ? post("handled", "Mark as handled") : post("reopen", "Reopen"),
    ].join("");
    const assignForm =
      open && team.length
        ? `<form method="post" action="/staff/cases/${c.id}/assign" class="row" style="margin-top:10px">${csrfField(req)}${select("Assign to", "staff_id", team.map((t) => [String(t.id), `${t.name} (${t.role})`]), c.assigned_to ?? "")}<button class="secondary small" style="align-self:flex-end">Assign</button></form>`
        : "";

    const thread = msgs
      .reverse()
      .map((m) => `<div class="bubble ${m.direction === "in" ? "in" : "out"}">${m.kind === "voice" ? voiceNote(m, c.language) : ""}${esc(m.body)}${m.sender ? `<div class="muted">— ${esc(m.sender)}</div>` : ""}</div>`)
      .join("");
    const protection =
      c.reason === "danger_safety" || c.site_id
        ? `<div class="card"><div class="eyebrow">Protection pathway</div><h2><em>Safety</em> steps${c.site_name ? ` · ${esc(c.site_name)}` : ""}</h2>
<form method="post" action="/staff/cases/${c.id}/site" class="row">${csrfField(req)}${select("Site", "site_id", sites.map((s) => [String(s.id), s.name]), c.site_id ?? "", { blank: "Choose the girl's site" })}<button class="secondary small" style="align-self:flex-end">Set site</button></form>
${c.site_id ? (steps.length ? `<ul class="timeline">${steps.map((p) => `<li><form method="post" action="/staff/cases/${c.id}/steps/${p.id}" class="row between">${csrfField(req)}<span>${p.done_at ? "✓ " : ""}<strong>${esc(p.title)}</strong>${p.details ? `<br><span class="muted">${esc(p.details)}</span>` : ""}${p.done_at ? `<br><span class="muted">done by ${esc(p.done_by)} ${when(p.done_at)}</span>` : ""}</span><button class="${p.done_at ? "secondary" : ""} small">${p.done_at ? "Undo" : "Mark done"}</button></form></li>`).join("")}</ul>` : `<p class="muted">No checklist for this site yet. An admin adds it under Admin → Sites.</p>`) : ""}
${contacts.length ? `<h3>Referral contacts</h3><ul class="timeline">${contacts.map((k) => `<li><strong>${esc(k.name)}</strong> · ${esc(k.organisation)} ${k.verified ? `<span class="tag ok">Verified</span>` : `<span class="tag urgent">Not verified</span>`}<time>${esc(k.service)} · ${esc(k.phone)} · ${esc(k.hours)}${k.notes ? ` · ${esc(k.notes)}` : ""}</time></li>`).join("")}</ul>` : ""}</div>`
        : "";

    res.send(
      page(
        `Case ${c.id}`,
        `<p class="noprint"><a href="/staff/inbox">← Inbox</a></p>${notice(req.query)}<div class="card"><span class="tag ${c.urgent ? "urgent" : ""}">${esc(REASON_LABEL[c.reason] ?? c.reason)}</span> <span class="tag">${c.level === "nurse" ? "Nurse level" : "Dada level"}</span> ${open ? "" : `<span class="tag ok">Handled</span>`}
<h1 style="margin-top:10px"><em>Girl</em> ${esc(c.anon_id)}</h1><p class="muted">${esc(workerLabel(c.language))} · ${esc(c.channel)} · opened ${ago(c.created_at)} · ${c.assignee ? `with ${esc(c.assignee)}` : "unassigned"}</p>
<div class="row">${actions}</div>${assignForm}</div>
<div class="card"><h2>Conversation</h2>${thread}</div>
${open ? `<div class="card"><h2>Reply</h2><form method="post" action="/staff/cases/${c.id}/reply">${csrfField(req)}
<label for="body">Message to girl ${esc(c.anon_id)} (AI draft — check before sending)</label><textarea id="body" name="body" rows="4" required maxlength="1600">${esc(c.draft_reply)}</textarea>
<label class="inline"><input type="checkbox" name="handled" value="1"> Mark as handled after sending</label>
<p><button class="accent">Send to girl ${esc(c.anon_id)}</button></p></form></div>` : ""}
${protection}
<div class="card"><h2>Internal notes</h2><p class="muted">Only the care team sees these. Never write her name or number.</p>${notes.map((n) => `<div class="bubble out" style="max-width:100%">${esc(n.body)}<div class="muted">— ${esc(n.name)}, ${when(n.created_at)}</div></div>`).join("")}
<form method="post" action="/staff/cases/${c.id}/notes">${csrfField(req)}${textarea("Add a note", "body", "", { rows: 2, required: true })}<p><button class="secondary small">Add note</button></p></form></div>
<div class="card"><h2>History</h2><ul class="timeline">${events.map((e) => `<li>${esc(EVENT_LABEL[e.kind] ?? e.kind)}${e.name ? ` by ${esc(e.name)}` : ""}${e.details?.to ? ` → ${esc(e.details.to)}` : ""}${e.details?.step ? `: ${esc(e.details.step)}` : ""}<time>${when(e.at)}</time></li>`).join("")}</ul></div>`,
        nav(req),
      ),
    );
  });

  r.post("/cases/:id/reply", careTeam, async (req, res) => {
    const c = await loadCase(req, res);
    if (!c) return;
    const s = staffOf(req);
    const [user] = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [c.user_id]);
    const body = String(req.body.body ?? "").trim().slice(0, 1600);
    if (user && body) {
      const messageId = await sendToUser(db, user, body, null, s.id);
      await auditReq(db, req, { action: "case.reply", targetType: "case", targetId: c.id, details: { messageId } });
      await caseEvent(db, c.id, s.id, "reply", { messageId });
      await db.query(
        `UPDATE cases SET first_reply_at = COALESCE(first_reply_at, now()), assigned_to = COALESCE(assigned_to, $2), assigned_at = COALESCE(assigned_at, now()) WHERE id = $1`,
        [c.id, s.id],
      );
    }
    if (req.body.handled) return markHandled(req, res, c);
    res.redirect(`/staff/cases/${c.id}?done=sent`);
  });

  async function markHandled(req: Request, res: Response, c: any) {
    const s = staffOf(req);
    const done = await db.query(`UPDATE cases SET status = 'handled', handled_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [c.id]);
    if (done.length) {
      await auditReq(db, req, { action: "case.handled", targetType: "case", targetId: c.id });
      await caseEvent(db, c.id, s.id, "handled");
      // Dadas are paid per handled case (approved and paid from Payments).
      if (s.role === "dada" && config.dadaPayPerCaseKes > 0) {
        await db.query(`INSERT INTO dada_payouts (staff_id, case_id, amount_kes) VALUES ($1,$2,$3) ON CONFLICT (case_id) WHERE case_id IS NOT NULL DO NOTHING`, [s.id, c.id, config.dadaPayPerCaseKes]);
      }
    }
    res.redirect(`/staff/inbox?done=handled`);
  }

  const action = (path: string, roles: typeof careTeam, fn: (req: Request, res: Response, c: any) => Promise<void>) =>
    r.post(`/cases/:id/${path}`, roles, async (req, res) => {
      const c = await loadCase(req, res);
      if (c) await fn(req, res, c);
    });

  action("handled", careTeam, markHandled);
  action("reopen", careTeam, async (req, res, c) => {
    const done = await db.query(`UPDATE cases SET status = 'open', handled_at = NULL WHERE id = $1 AND status = 'handled' RETURNING id`, [c.id]);
    if (done.length) {
      await auditReq(db, req, { action: "case.reopen", targetType: "case", targetId: c.id });
      await caseEvent(db, c.id, staffOf(req).id, "reopened");
    }
    res.redirect(`/staff/cases/${c.id}?done=reopened`);
  });
  action("claim", careTeam, async (req, res, c) => {
    const me = staffOf(req);
    const done = await db.query(`UPDATE cases SET assigned_to = $2, assigned_at = now() WHERE id = $1 AND assigned_to IS NULL AND status = 'open' RETURNING id`, [c.id, me.id]);
    if (!done.length) return res.redirect(`/staff/cases/${c.id}?error=state`);
    await auditReq(db, req, { action: "case.claim", targetType: "case", targetId: c.id });
    await caseEvent(db, c.id, me.id, "claimed");
    res.redirect(`/staff/cases/${c.id}?done=claimed`);
  });
  action("unassign", careTeam, async (req, res, c) => {
    const me = staffOf(req);
    if (me.role === "dada" && c.assigned_to !== me.id) return res.redirect(`/staff/cases/${c.id}?error=state`);
    await db.query(`UPDATE cases SET assigned_to = NULL, assigned_at = NULL WHERE id = $1`, [c.id]);
    await auditReq(db, req, { action: "case.unassign", targetType: "case", targetId: c.id });
    await caseEvent(db, c.id, me.id, "unassigned");
    res.redirect(`/staff/cases/${c.id}?done=unassigned`);
  });
  action("assign", leads, async (req, res, c) => {
    const id = Number(req.body.staff_id);
    const [t] = Number.isInteger(id) ? await db.query(`SELECT id, name, role FROM staff WHERE id = $1 AND active AND role IN ('nurse','dada')`, [id]) : [];
    // A Dada can't be given a nurse-level case.
    if (!t || (t.role === "dada" && c.level === "nurse")) return res.redirect(`/staff/cases/${c.id}?error=invalid`);
    await db.query(`UPDATE cases SET assigned_to = $2, assigned_at = now() WHERE id = $1`, [c.id, t.id]);
    await auditReq(db, req, { action: "case.assign", targetType: "case", targetId: c.id, details: { to: t.id } });
    await caseEvent(db, c.id, staffOf(req).id, "assigned", { to: t.name });
    res.redirect(`/staff/cases/${c.id}?done=assigned`);
  });
  action("escalate", careTeam, async (req, res, c) => {
    const ok = await escalateToNurse(db, c.id, staffOf(req).id, String(req.body.reason ?? ""));
    if (!ok) return res.redirect(`/staff/cases/${c.id}?error=state`);
    await auditReq(db, req, { action: "case.escalate", targetType: "case", targetId: c.id });
    // A Dada who escalated may no longer see the case: send her back to the inbox.
    res.redirect(staffOf(req).role === "dada" ? "/staff/inbox?done=escalated" : `/staff/cases/${c.id}?done=escalated`);
  });
  action("notes", careTeam, async (req, res, c) => {
    const body = String(req.body.body ?? "").trim().slice(0, 2000);
    if (!body) return res.redirect(`/staff/cases/${c.id}?error=invalid`);
    await db.query(`INSERT INTO case_notes (case_id, staff_id, body) VALUES ($1,$2,$3)`, [c.id, staffOf(req).id, body]);
    await auditReq(db, req, { action: "case.note", targetType: "case", targetId: c.id });
    await caseEvent(db, c.id, staffOf(req).id, "note");
    res.redirect(`/staff/cases/${c.id}?done=noted`);
  });
  action("site", careTeam, async (req, res, c) => {
    const id = Number(req.body.site_id);
    const [s] = Number.isInteger(id) && id > 0 ? await db.query(`SELECT id, name FROM sites WHERE id = $1 AND active`, [id]) : [];
    if (!s) return res.redirect(`/staff/cases/${c.id}?error=invalid`);
    await db.query(`UPDATE cases SET site_id = $2 WHERE id = $1`, [c.id, s.id]);
    await auditReq(db, req, { action: "case.site", targetType: "case", targetId: c.id, details: { siteId: s.id } });
    await caseEvent(db, c.id, staffOf(req).id, "site", { to: s.name });
    res.redirect(`/staff/cases/${c.id}?done=saved`);
  });
  r.post("/cases/:id/steps/:stepId", careTeam, async (req, res) => {
    const c = await loadCase(req, res);
    if (!c) return;
    const stepId = Number(req.params.stepId);
    const [p] = Number.isInteger(stepId) && c.site_id ? await db.query(`SELECT id, title FROM protection_steps WHERE id = $1 AND site_id = $2`, [stepId, c.site_id]) : [];
    if (!p) return res.redirect(`/staff/cases/${c.id}?error=invalid`);
    const removed = await db.query(`DELETE FROM case_protection WHERE case_id = $1 AND step_id = $2 RETURNING step_id`, [c.id, p.id]);
    if (!removed.length) await db.query(`INSERT INTO case_protection (case_id, step_id, done_by) VALUES ($1,$2,$3)`, [c.id, p.id, staffOf(req).id]);
    await auditReq(db, req, { action: removed.length ? "case.step_undone" : "case.step_done", targetType: "case", targetId: c.id, details: { stepId: p.id } });
    await caseEvent(db, c.id, staffOf(req).id, removed.length ? "step_undone" : "step", { step: p.title });
    res.redirect(`/staff/cases/${c.id}?done=saved`);
  });

  return r;
}
