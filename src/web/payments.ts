import { Router, type Request } from "express";
import type { Db } from "../db.js";
import { config, mockMode } from "../config.js";
import { auditReq } from "../audit.js";
import { paymentsAvailable, startBatchPayment } from "../payments/mpesa.js";
import { cleanKenyanPhone } from "../staffAccounts.js";
import { csrfField } from "../security/csrf.js";
import { requireRole, staffOf } from "./auth.js";
import { page, esc, h1, field, select, many, notice, when } from "./html.js";
import { nav } from "./nav.js";

// Dada payments: approve in batches, pay through M-Pesa, reconcile the results.

const STATUSES = ["pending", "approved", "processing", "paid", "failed", "cancelled"] as const;
const LABEL: Record<string, string> = { pending: "Waiting for approval", approved: "Approved", processing: "Sent to M-Pesa", paid: "Paid", failed: "Failed", cancelled: "Cancelled" };
const tag = (s: string) => `<span class="tag ${s === "approved" ? "approved" : s === "pending" ? "draft" : s}">${esc(LABEL[s] ?? s)}</span>`;
const kes = (n: number) => `KES ${Number(n).toLocaleString("en-KE")}`;
const back = (href: string, label: string) => `<p class="noprint"><a href="${href}">← ${esc(label)}</a></p>`;

export function paymentsRouter(db: Db): Router {
  const r = Router();
  const admin = requireRole(db, ["admin"]);

  r.get("/payments", admin, async (req, res) => {
    const status = STATUSES.includes(req.query.status as any) ? String(req.query.status) : "pending";
    const rows = await db.query(
      `SELECT d.*, s.name, s.phone, s.active AS staff_active, a.name AS approver FROM dada_payouts d JOIN staff s ON s.id = d.staff_id LEFT JOIN staff a ON a.id = d.approved_by
        WHERE d.status = $1 ORDER BY d.created_at DESC LIMIT 500`,
      [status],
    );
    const totals = await db.query<{ status: string; n: number; kes: number }>(`SELECT status, count(*)::int AS n, coalesce(sum(amount_kes),0)::int AS kes FROM dada_payouts GROUP BY status`);
    const batches = await db.query(
      `SELECT b.*, c.name AS creator, (SELECT count(*)::int FROM dada_payouts d WHERE d.batch_id = b.id AND d.status = 'approved') AS waiting FROM payout_batches b JOIN staff c ON c.id = b.created_by ORDER BY b.id DESC LIMIT 20`,
    );
    const dadas = await db.query(`SELECT id, name FROM staff WHERE role = 'dada' AND active ORDER BY name`);
    const count = (s: string) => totals.find((t) => t.status === s);
    const list = rows
      .map(
        (d) => `<tr>${status === "pending" ? `<td><input type="checkbox" name="ids" value="${d.id}" aria-label="Select payout ${d.id}"></td>` : ""}<td>${esc(d.name)}${cleanKenyanPhone(String(d.phone ?? "")) ? "" : ` <span class="tag urgent">no valid phone</span>`}<div class="muted">${d.reason === "case" ? `Handled case <a href="/staff/cases/${d.case_id}">#${d.case_id}</a>` : esc(d.reason)}</div></td>
<td>${kes(d.amount_kes)}</td><td>${tag(d.status)}${d.result_desc ? `<div class="muted">${esc(d.result_desc)}</div>` : ""}${d.receipt ? `<div class="muted">Receipt ${esc(d.receipt)}</div>` : ""}</td><td class="muted">${when(d.created_at)}${d.batch_id ? `<br>batch #${d.batch_id}` : ""}</td></tr>`,
      )
      .join("");
    const mode = mockMode.mpesa()
      ? config.production
        ? `<div class="notice" role="alert">M-Pesa is not set up, so payments can't be sent. See the README section "Dada payments" for the Safaricom Daraja setup.</div>`
        : `<div class="notice">Mock mode: no M-Pesa keys are set, so payments are simulated and marked paid with a MOCK receipt. Nothing real is sent.</div>`
      : `<p class="muted">M-Pesa ${esc(config.mpesa.env)} · short code ${esc(config.mpesa.shortcode)}</p>`;
    res.send(
      page(
        "Payments",
        `${h1("Dada", "payments", "M-Pesa")}${notice(req.query)}${mode}
<div class="row pills" style="margin-bottom:16px">${STATUSES.map((s) => `<a class="btn ${s === status ? "" : "secondary"}" href="?status=${s}">${esc(LABEL[s])} · ${count(s)?.n ?? 0}</a>`).join("")}<a class="btn secondary" href="/staff/payments/reconcile">Reconcile</a></div>
<p class="lead">${kes(count("pending")?.kes ?? 0)} waiting for approval · ${kes(count("approved")?.kes ?? 0)} approved, not yet sent · ${kes(count("paid")?.kes ?? 0)} paid in total.</p>
${status === "pending" ? `<form method="post" action="/staff/payments/approve" class="card">${csrfField(req)}` : `<div class="card">`}<div class="scroll"><table><thead><tr>${status === "pending" ? "<th></th>" : ""}<th>Dada</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
<tbody>${list || `<tr><td colspan="5">Nothing here.</td></tr>`}</tbody></table></div>${status === "pending" ? `${rows.length ? `<p><button class="accent">Approve selected into a batch</button></p>` : ""}</form>` : "</div>"}
<div class="card"><h2><em>Batches</em></h2>${
          batches.length
            ? `<ul class="timeline">${batches.map((b) => `<li><a href="/staff/payments/batches/${b.id}">Batch #${b.id}</a> · ${b.payouts} payouts · ${kes(b.total_kes)} · approved by ${esc(b.creator)}${b.waiting ? ` · <strong>${b.waiting} ready to pay</strong>` : ""}<time>${when(b.created_at)}${b.pay_started_at ? ` · payment started ${when(b.pay_started_at)}` : ""}</time></li>`).join("")}</ul>`
            : `<p class="muted">No batches yet.</p>`
        }</div>
<form method="post" action="/staff/payments/manual" class="card">${csrfField(req)}<h2>Add a payment</h2><p class="muted">For work that isn't a handled case, such as a training day. It still needs approval.</p>
<div class="fields">${select("Dada", "staff_id", dadas.map((d) => [String(d.id), d.name]), "", { required: true, blank: "Choose" })}${field("Amount (KES)", "amount", "", { type: "number", required: true, attrs: 'min="1" max="70000" step="1"' })}${field("Reason", "reason", "", { required: true })}</div><p><button class="secondary">Add payment</button></p></form>`,
        nav(req),
      ),
    );
  });

  r.post("/payments/approve", admin, async (req, res) => {
    const ids = many(req.body.ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.redirect("/staff/payments?error=invalid");
    const me = staffOf(req).id;
    const batch = await db.tx(async (t) => {
      const rows = await t.query<{ id: number; amount_kes: number }>(`SELECT id, amount_kes FROM dada_payouts WHERE id = ANY($1::int[]) AND status = 'pending' FOR UPDATE`, [ids]);
      if (!rows.length) return null;
      const total = rows.reduce((a, x) => a + x.amount_kes, 0);
      const [b] = await t.query<{ id: number }>(`INSERT INTO payout_batches (created_by, total_kes, payouts) VALUES ($1,$2,$3) RETURNING id`, [me, total, rows.length]);
      await t.query(`UPDATE dada_payouts SET status = 'approved', approved_by = $2, approved_at = now(), batch_id = $3, updated_at = now() WHERE id = ANY($1::int[])`, [rows.map((x) => x.id), me, b.id]);
      return { id: b.id, total, n: rows.length };
    });
    if (!batch) return res.redirect("/staff/payments?error=state");
    await auditReq(db, req, { action: "payments.approve", targetType: "payout_batch", targetId: batch.id, details: { payouts: batch.n, totalKes: batch.total } });
    res.redirect(`/staff/payments/batches/${batch.id}?done=approved_batch`);
  });

  r.get("/payments/batches/:id", admin, async (req, res) => {
    const id = Number(req.params.id);
    const [b] = Number.isInteger(id) ? await db.query(`SELECT b.*, c.name AS creator, p.name AS payer FROM payout_batches b JOIN staff c ON c.id = b.created_by LEFT JOIN staff p ON p.id = b.paid_by WHERE b.id = $1`, [id]) : [];
    if (!b) return res.status(404).send(page("Not found", "Batch not found.", nav(req)));
    const rows = await db.query(`SELECT d.*, s.name, s.phone FROM dada_payouts d JOIN staff s ON s.id = d.staff_id WHERE d.batch_id = $1 ORDER BY s.name`, [b.id]);
    const ready = rows.filter((d) => d.status === "approved");
    const noPhone = ready.filter((d) => !cleanKenyanPhone(String(d.phone ?? "")));
    const sum = (s: string) => rows.filter((d) => d.status === s).reduce((a, d) => a + d.amount_kes, 0);
    res.send(
      page(
        `Batch ${b.id}`,
        `${back("/staff/payments", "Payments")}${h1("Batch", `#${b.id}`, "Dada payments")}${notice(req.query)}
<div class="card"><p>${b.payouts} payouts · ${kes(b.total_kes)} · approved by ${esc(b.creator)} ${when(b.created_at)}${b.payer ? ` · payment started by ${esc(b.payer)} ${when(b.pay_started_at)}` : ""}</p>
<p class="muted">Paid ${kes(sum("paid"))} · sent, waiting for M-Pesa ${kes(sum("processing"))} · failed ${kes(sum("failed"))} · not yet sent ${kes(sum("approved"))}</p>
${noPhone.length ? `<div class="notice" role="alert">${noPhone.length} Dada(s) in this batch have no valid M-Pesa number and will fail. Fix their staff page first.</div>` : ""}
${ready.length && paymentsAvailable() ? `<form method="post" action="/staff/payments/batches/${b.id}/pay">${csrfField(req)}<button class="accent">Pay ${ready.length} payout(s), ${kes(ready.reduce((a, d) => a + d.amount_kes, 0))}, through M-Pesa</button></form>` : ""}</div>
<div class="card"><div class="scroll"><table><thead><tr><th>Dada</th><th>Amount</th><th>Status</th><th>M-Pesa</th></tr></thead><tbody>${rows
          .map((d) => `<tr><td>${esc(d.name)}</td><td>${kes(d.amount_kes)}</td><td>${tag(d.status)}${d.result_desc ? `<div class="muted">${esc(d.result_desc)}</div>` : ""}</td><td class="muted">${esc(d.receipt ?? d.conversation_id ?? "—")}</td></tr>`)
          .join("")}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  r.post("/payments/batches/:id/pay", admin, async (req, res) => {
    const id = Number(req.params.id);
    const [b] = Number.isInteger(id) ? await db.query(`SELECT id FROM payout_batches WHERE id = $1`, [id]) : [];
    if (!b) return res.status(404).send("Not found");
    if (!paymentsAvailable()) return res.redirect(`/staff/payments/batches/${id}?error=state`);
    const n = await startBatchPayment(db, b.id, staffOf(req).id);
    if (!n) return res.redirect(`/staff/payments/batches/${id}?error=state`);
    await auditReq(db, req, { action: "payments.pay", targetType: "payout_batch", targetId: b.id, details: { payouts: n, mock: mockMode.mpesa() } });
    res.redirect(`/staff/payments/batches/${id}?done=paying`);
  });

  r.get("/payments/reconcile", admin, async (req, res) => {
    const stuck = await db.query(
      `SELECT d.*, s.name FROM dada_payouts d JOIN staff s ON s.id = d.staff_id WHERE d.status = 'processing' AND d.updated_at < now() - interval '30 minutes' ORDER BY d.updated_at`,
    );
    const failed = await db.query(`SELECT d.*, s.name FROM dada_payouts d JOIN staff s ON s.id = d.staff_id WHERE d.status = 'failed' ORDER BY d.updated_at DESC LIMIT 200`);
    const callbacks = await db.query(`SELECT id, received_at, kind, request_id, payload->'Result'->>'ResultCode' AS code, payload->'Result'->>'ResultDesc' AS descr FROM mpesa_callbacks ORDER BY id DESC LIMIT 30`);
    const item = (d: any) => `<li><strong>${esc(d.name)}</strong> · ${kes(d.amount_kes)} · ${tag(d.status)} · request <code>${esc(d.request_id ?? "—")}</code>${d.result_desc ? `<br><span class="muted">${esc(d.result_desc)}</span>` : ""}
<div class="row" style="margin-top:8px">${d.status === "failed" ? `<form method="post" action="/staff/payments/${d.id}/retry">${csrfField(req)}<button class="secondary small">Checked the portal: not paid, retry</button></form>` : ""}
<form method="post" action="/staff/payments/${d.id}/mark-paid" class="row">${csrfField(req)}<input name="receipt" placeholder="M-Pesa receipt, e.g. QJK3XXXXXX" pattern="[A-Za-z0-9]{8,12}" required style="max-width:220px" aria-label="M-Pesa receipt for payout ${d.id}"><button class="secondary small">Paid (found in portal)</button></form>
<form method="post" action="/staff/payments/${d.id}/cancel">${csrfField(req)}<button class="danger small">Cancel payout</button></form></div></li>`;
    res.send(
      page(
        "Reconcile",
        `${back("/staff/payments", "Payments")}${h1("Reconcile", "payments", "M-Pesa")}${notice(req.query)}
<p class="lead">Before retrying, look the request up in the M-Pesa business portal: if it was paid there, record the receipt instead, so no one is paid twice.</p>
<div class="card"><h2>Sent but no answer for 30+ minutes</h2>${stuck.length ? `<ul class="timeline">${stuck.map(item).join("")}</ul>` : `<p class="muted">None.</p>`}</div>
<div class="card"><h2>Failed</h2>${failed.length ? `<ul class="timeline">${failed.map(item).join("")}</ul>` : `<p class="muted">None.</p>`}</div>
<div class="card"><h2>Latest M-Pesa callbacks</h2><div class="scroll"><table><thead><tr><th>Received</th><th>Kind</th><th>Request</th><th>Result</th></tr></thead><tbody>${callbacks
          .map((c) => `<tr><td class="muted">${when(c.received_at)}</td><td>${esc(c.kind)}</td><td><code>${esc(c.request_id ?? "—")}</code></td><td>${esc(c.code ?? "")} ${esc(c.descr ?? "")}</td></tr>`)
          .join("") || `<tr><td colspan="4">None yet.</td></tr>`}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  const payoutAction = (path: string, run: (req: Request, id: number) => Promise<boolean>, done: string) =>
    r.post(`/payments/:id/${path}`, admin, async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).send("Not found");
      if (!(await run(req, id))) return res.redirect("/staff/payments/reconcile?error=state");
      await auditReq(db, req, { action: `payments.${path}`, targetType: "payout", targetId: id, details: path === "mark-paid" ? { receipt: String(req.body.receipt ?? "").toUpperCase() } : {} });
      res.redirect(`/staff/payments/reconcile?done=${done}`);
    });
  // Back to "approved" in its batch, to be paid again from the batch page.
  payoutAction("retry", async (_req, id) => (await db.query(`UPDATE dada_payouts SET status = 'approved', sent_at = NULL, updated_at = now() WHERE id = $1 AND status = 'failed' RETURNING id`, [id])).length > 0, "retried");
  payoutAction(
    "mark-paid",
    async (req, id) => {
      const receipt = String(req.body.receipt ?? "").trim().toUpperCase();
      if (!/^[A-Z0-9]{8,12}$/.test(receipt)) return false;
      return (await db.query(`UPDATE dada_payouts SET status = 'paid', receipt = $2, paid_at = now(), result_desc = 'Recorded by hand after checking the M-Pesa portal', updated_at = now() WHERE id = $1 AND status IN ('failed','processing') RETURNING id`, [id, receipt])).length > 0;
    },
    "marked_paid",
  );
  payoutAction("cancel", async (_req, id) => (await db.query(`UPDATE dada_payouts SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('failed','processing','pending','approved') RETURNING id`, [id])).length > 0, "cancelled");

  r.post("/payments/manual", admin, async (req, res) => {
    const staffId = Number(req.body.staff_id);
    const amount = Number(req.body.amount);
    const reason = String(req.body.reason ?? "").trim().slice(0, 200);
    const [d] = Number.isInteger(staffId) ? await db.query(`SELECT id FROM staff WHERE id = $1 AND role = 'dada'`, [staffId]) : [];
    if (!d || !Number.isInteger(amount) || amount < 1 || amount > 70_000 || !reason) return res.redirect("/staff/payments?error=invalid");
    const [p] = await db.query<{ id: number }>(`INSERT INTO dada_payouts (staff_id, amount_kes, reason) VALUES ($1,$2,$3) RETURNING id`, [d.id, amount, reason]);
    await auditReq(db, req, { action: "payments.add", targetType: "payout", targetId: p.id, details: { amount } });
    res.redirect("/staff/payments?done=created");
  });

  return r;
}
