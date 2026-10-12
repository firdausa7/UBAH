import { Router } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { invalidateCaches } from "../caches.js";
import { enqueue, wakeWorker } from "../jobs/queue.js";
import { dangerGate, promote, reject, DANGER_CLASSES, type VersionRow } from "../ml/registry.js";
import { TASKS } from "../ml/train.js";
import { csrfField } from "../security/csrf.js";
import { requireRole, staffOf } from "./auth.js";
import { page, esc, h1, notice, when } from "./html.js";
import { nav } from "./nav.js";

// Ubah's own models: versions, evaluation reports, and promotion with the danger-recall safety gate.

const pct = (x: number | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const TASK_LABEL: Record<string, string> = { danger: "Danger-sign classifier", topic: "Topic classifier" };

function reportTable(v: VersionRow, compare: VersionRow | null) {
  const labels = Object.keys(v.report.perLabel);
  const arrow = (l: string) => {
    if (!compare?.report.perLabel[l]) return "";
    const d = v.report.perLabel[l].recall - compare.report.perLabel[l].recall;
    if (Math.abs(d) < 0.005) return "";
    return d > 0 ? ` <span class="tag ok">+${Math.round(d * 100)}</span>` : ` <span class="tag urgent">${Math.round(d * 100)}</span>`;
  };
  const rows = labels
    .map((l) => {
      const m = v.report.perLabel[l];
      const danger = v.task === "danger" && (DANGER_CLASSES as readonly string[]).includes(l);
      return `<tr><td>${danger ? "<strong>" : ""}${esc(l)}${danger ? "</strong>" : ""}</td><td>${pct(m.precision)}</td><td>${pct(m.recall)}${arrow(l)}</td><td>${m.support}</td></tr>`;
    })
    .join("");
  const confusion = `<details><summary>Confusion matrix (rows: true label, columns: predicted)</summary><div class="scroll"><table><thead><tr><th></th>${labels.map((l) => `<th>${esc(l)}</th>`).join("")}</tr></thead><tbody>${labels
    .map((l) => `<tr><td>${esc(l)}</td>${labels.map((m) => `<td>${v.report.confusion[l]?.[m] ?? 0}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div></details>`;
  return `<div class="scroll"><table><thead><tr><th>Class</th><th>Precision</th><th>Recall${compare ? " (vs live)" : ""}</th><th>Examples</th></tr></thead><tbody>${rows}</tbody></table></div>${confusion}`;
}

export function modelsRouter(db: Db): Router {
  const r = Router();
  const viewers = requireRole(db, ["admin", "nurse"]);
  const admin = requireRole(db, ["admin"]);

  r.get("/models", viewers, async (req, res) => {
    const me = staffOf(req);
    const all = await db.query<VersionRow & { trainer: string | null; promoter: string | null }>(
      `SELECT v.*, t.name AS trainer, p.name AS promoter FROM model_versions v LEFT JOIN staff t ON t.id = v.trained_by LEFT JOIN staff p ON p.id = v.promoted_by ORDER BY v.task, v.version DESC`,
    );
    const [{ n: labels }] = await db.query<{ n: number }>(`SELECT count(DISTINCT message_id)::int AS n FROM labels`);
    const [{ n: training }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'ml.train' AND status IN ('queued','running')`);
    const sections = TASKS.map((task) => {
      const versions = all.filter((v) => v.task === task);
      const active = versions.find((v) => v.status === "active") ?? null;
      const candidates = versions.filter((v) => v.status === "candidate");
      const card = (v: (typeof versions)[number]) => {
        const gate = v.status === "candidate" && task === "danger" ? dangerGate(v.report, active?.report ?? null) : null;
        const actions =
          v.status === "candidate" && me.role === "admin"
            ? `<div class="row">${
                gate && !gate.ok
                  ? `<span class="notice" role="alert">Can't be promoted: recall drops for ${gate.drops.map((d) => `${esc(d.label)} (${pct(d.from)} → ${pct(d.to)})`).join(", ")}. A danger-sign model must never miss more girls than the live one.</span>`
                  : `<form method="post" action="/staff/models/${v.id}/promote">${csrfField(req)}<button class="accent small">Promote to live</button></form>`
              }<form method="post" action="/staff/models/${v.id}/reject" class="row">${csrfField(req)}<input name="note" placeholder="Why (optional)" style="max-width:220px" aria-label="Reason for rejecting"><button class="secondary small">Reject</button></form></div>`
            : "";
        return `<div class="card" style="margin:0 0 12px"><div class="row between"><h3 style="margin:0">v${v.version} <span class="tag ${v.status === "active" ? "ok" : v.status === "candidate" ? "approved" : ""}">${esc(v.status)}</span></h3><span class="muted">${when(v.trained_at)}${v.trainer ? ` by ${esc(v.trainer)}` : ""}</span></div>
<p class="muted">${v.examples} examples (${Object.entries(v.sources ?? {}).map(([k, n]) => `${n} ${esc(k)}`).join(", ")}) · 5-fold accuracy ${pct(v.report.accuracy)}${v.promoted_at ? ` · live since ${when(v.promoted_at)}${v.promoter ? ` (${esc(v.promoter)})` : ""}` : ""}${v.notes ? ` · ${esc(v.notes)}` : ""}</p>
${reportTable(v, v.status === "candidate" ? active : null)}${actions}</div>`;
      };
      const history = versions.filter((v) => v.status !== "active" && v.status !== "candidate");
      return `<div class="card"><div class="eyebrow">${esc(task)}</div><h2><em>${esc(TASK_LABEL[task].split(" ")[0])}</em> ${esc(TASK_LABEL[task].split(" ").slice(1).join(" "))}</h2>
${active ? card(active) : `<p class="muted">No live version in the registry; the model in the models/ folder is used.</p>`}${candidates.map(card).join("")}
${history.length ? `<details><summary>Older and rejected versions (${history.length})</summary>${history.map(card).join("")}</details>` : ""}</div>`;
    }).join("");
    res.send(
      page(
        "Models",
        `${h1("Ubah's", "own models", "Machine learning")}${notice(req.query)}
<p class="lead">The danger-sign classifier is a safety net behind fixed rules (danger rules always send a message to a human). Precision and recall come from 5-fold cross-validation. Seed-only numbers show the pipeline works; they are not evidence of real-world accuracy.</p>
<div class="card"><p>${labels} messages labelled by nurses and Dadas so far. <a href="/staff/label">Label more</a></p>
${me.role === "admin" ? (training ? `<p class="notice" role="status">Training a new candidate… reload in a minute.</p>` : `<form method="post" action="/staff/models/train">${csrfField(req)}<button class="secondary">Train new candidates from the labels</button></form>`) : ""}</div>
${sections}`,
        nav(req),
      ),
    );
  });

  r.post("/models/train", admin, async (req, res) => {
    await enqueue(db, "ml.train", { staffId: staffOf(req).id }, { uniqueKey: "ml.train", maxAttempts: 1 });
    wakeWorker();
    await auditReq(db, req, { action: "model.train" });
    res.redirect("/staff/models?done=saved");
  });

  r.post("/models/:id/promote", admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send("Not found");
    const out = await promote(db, id, staffOf(req).id);
    if (!out.ok) {
      await auditReq(db, req, { action: "model.promote_blocked", targetType: "model", targetId: id, details: { reason: out.reason, drops: out.gate?.drops ?? [] } });
      return res.redirect(`/staff/models?error=${out.reason === "danger_recall" ? "recall" : "state"}`);
    }
    invalidateCaches();
    await auditReq(db, req, { action: "model.promote", targetType: "model", targetId: id });
    res.redirect("/staff/models?done=saved");
  });

  r.post("/models/:id/reject", admin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !(await reject(db, id, String(req.body.note ?? "")))) return res.redirect("/staff/models?error=state");
    await auditReq(db, req, { action: "model.reject", targetType: "model", targetId: id });
    res.redirect("/staff/models?done=saved");
  });

  return r;
}
