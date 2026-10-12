import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { config, mockMode } from "../config.js";
import { enqueue, wakeWorker } from "../jobs/queue.js";
import { normalizePhone } from "../privacy.js";
import { log } from "../log.js";

// Dada payments through M-Pesa B2C (Safaricom Daraja).
//   pending -> approved (in a batch, by an admin) -> processing (sent to M-Pesa) -> paid | failed
// A request is sent at most once automatically. If M-Pesa's answer is unclear (timeout, network
// error), the payout is marked failed with a note to check the M-Pesa portal before retrying,
// so a Dada is never paid twice by accident.
// Mock mode (no MPESA_CONSUMER_KEY) pretends M-Pesa answered "success", outside production only.

const base = () => (config.mpesa.env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");

let cachedToken: { value: string; expires: number } | null = null;
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${config.mpesa.consumerKey}:${config.mpesa.consumerSecret}`).toString("base64");
  const res = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`M-Pesa auth HTTP ${res.status}`);
  const json: any = await res.json();
  cachedToken = { value: json.access_token, expires: Date.now() + Number(json.expires_in ?? 3599) * 1000 };
  return cachedToken.value;
}

export const paymentsAvailable = () => !(mockMode.mpesa() && config.production);

// Puts approved payouts of a batch into "processing" and queues one send job each.
export async function startBatchPayment(db: Db, batchId: number, staffId: number): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `UPDATE dada_payouts SET status = 'processing', request_id = $2 || '-' || id, sent_at = NULL, receipt = NULL, result_code = NULL, result_desc = NULL, updated_at = now()
      WHERE batch_id = $1 AND status = 'approved' RETURNING id`,
    [batchId, `ubah-${randomUUID().slice(0, 8)}`],
  );
  await db.query(`UPDATE payout_batches SET paid_by = $2, pay_started_at = now() WHERE id = $1`, [batchId, staffId]);
  for (const r of rows) await enqueue(db, "mpesa.pay", { payoutId: r.id }, { maxAttempts: 1, uniqueKey: `mpesa:${r.id}` });
  wakeWorker();
  return rows.length;
}

// Job: send one payout to M-Pesa. Never throws after a request may have reached M-Pesa.
export async function sendPayout(db: Db, payoutId: number): Promise<void> {
  const [p] = await db.query(
    `SELECT d.id, d.amount_kes, d.request_id, d.status, d.sent_at, s.phone FROM dada_payouts d JOIN staff s ON s.id = d.staff_id WHERE d.id = $1`,
    [payoutId],
  );
  if (!p || p.status !== "processing" || p.sent_at) return; // already sent or changed
  const phone = normalizePhone(String(p.phone ?? ""));
  if (!/^254[17]\d{8}$/.test(phone)) {
    await fail(db, p.id, "No valid M-Pesa phone number for this Dada");
    return;
  }
  // Claim it before calling M-Pesa, so no second worker can send it too.
  const claimed = await db.query(`UPDATE dada_payouts SET sent_at = now(), updated_at = now() WHERE id = $1 AND sent_at IS NULL RETURNING id`, [p.id]);
  if (!claimed.length) return;

  if (mockMode.mpesa()) {
    if (config.production) return fail(db, p.id, "M-Pesa is not configured");
    await db.query(`UPDATE dada_payouts SET conversation_id = $2 WHERE id = $1`, [p.id, `MOCK-${p.id}`]);
    // Pretend M-Pesa calls back a moment later.
    await enqueue(db, "mpesa.mock_result", { requestId: p.request_id, amount: p.amount_kes }, { runAt: new Date(Date.now() + 1500), maxAttempts: 3 });
    wakeWorker();
    return;
  }

  try {
    const token = await accessToken();
    const callback = `${config.baseUrl}/webhooks/mpesa/${config.mpesa.callbackToken}`;
    const res = await fetch(`${base()}/mpesa/b2c/v3/paymentrequest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        OriginatorConversationID: p.request_id,
        InitiatorName: config.mpesa.initiatorName,
        SecurityCredential: config.mpesa.securityCredential,
        CommandID: "BusinessPayment",
        Amount: p.amount_kes,
        PartyA: config.mpesa.shortcode,
        PartyB: phone,
        Remarks: "Ubah Dada payment",
        QueueTimeOutURL: `${callback}/timeout`,
        ResultURL: `${callback}/result`,
        Occasion: `payout-${p.id}`,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok && String(json.ResponseCode) === "0") {
      await db.query(`UPDATE dada_payouts SET conversation_id = $2, updated_at = now() WHERE id = $1`, [p.id, json.ConversationID ?? null]);
      return; // the result arrives on the callback
    }
    // M-Pesa refused the request outright: nothing was paid, safe to retry after fixing the cause.
    await fail(db, p.id, `Refused by M-Pesa: ${json.errorMessage ?? json.ResponseDescription ?? `HTTP ${res.status}`}`);
  } catch (err) {
    log.error({ payoutId: p.id, err: (err as Error).message }, "M-Pesa request outcome unknown");
    await fail(db, p.id, `Outcome unknown (${(err as Error).message}). Check the M-Pesa portal before retrying.`);
  }
}

async function fail(db: Db, id: number, desc: string) {
  await db.query(`UPDATE dada_payouts SET status = 'failed', result_desc = $2, updated_at = now() WHERE id = $1`, [id, desc.slice(0, 500)]);
}

// Applies a result or timeout callback. Idempotent: only a payout still "processing" changes.
export async function applyMpesaResult(db: Db, kind: "result" | "timeout", payload: any): Promise<boolean> {
  const r = payload?.Result ?? payload ?? {};
  const requestId = String(r.OriginatorConversationID ?? "").slice(0, 100) || null;
  const conversationId = String(r.ConversationID ?? "").slice(0, 100) || null;
  await db.query(`INSERT INTO mpesa_callbacks (kind, request_id, payload) VALUES ($1,$2,$3)`, [kind, requestId, JSON.stringify(payload ?? {})]);
  if (!requestId && !conversationId) return false;
  const code = String(r.ResultCode ?? (kind === "timeout" ? "timeout" : ""));
  const desc = String(r.ResultDesc ?? (kind === "timeout" ? "M-Pesa queue timeout" : "")).slice(0, 500);
  const ok = kind === "result" && code === "0";
  const rows = await db.query(
    `UPDATE dada_payouts SET status = $3, result_code = $4, result_desc = $5, receipt = $6, paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE NULL END, updated_at = now()
      WHERE (request_id = $1 OR ($1 IS NULL AND conversation_id = $2)) AND status = 'processing' RETURNING id`,
    [requestId, conversationId, ok ? "paid" : "failed", code, desc, ok ? String(r.TransactionID ?? "").slice(0, 40) || null : null],
  );
  return rows.length > 0;
}
