import type { Db } from "../db.js";
import { config } from "../config.js";
import { decryptPhone, encryptSecret, decryptSecret, hashPhone } from "../privacy.js";
import { t } from "../i18n.js";
import { audioPayload, menuPayload, sendWhatsApp, templatePayload, textPayload, uploadWhatsAppMedia, WhatsAppError, WINDOW_CLOSED_CODE, type WhatsAppPayload } from "./whatsapp.js";
import { sendSmsDetailed, splitSms, SMS_FAILED } from "./sms.js";
import { parseMenu } from "./menu.js";
import { enqueue, wakeWorker, backoffMs } from "../jobs/queue.js";
import { log } from "../log.js";

export interface UserRow {
  id: number;
  anon_id: string;
  phone_hash: string;
  phone_enc: string;
  channel: string;
  language: string | null;
  state: any;
  opted_out: boolean;
  wa_last_inbound_at?: string | null;
  site_id?: number | null;
  area?: string | null;
}

// The transports, swappable in tests to simulate an outage.
export const transports = {
  whatsapp: sendWhatsApp,
  sms: sendSmsDetailed,
  uploadMedia: uploadWhatsAppMedia,
};

export interface SendOptions {
  contentVersionId?: number | null;
  // "checkin": the day-3 check-in, which may use an approved template or SMS outside the window.
  kind?: "normal" | "checkin";
  checkinCode?: string;
  // A recorded voice answer to send after the text (WhatsApp only).
  audioMediaId?: number | null;
  // Only the "you won't get more messages" confirmation is sent after STOP.
  allowOptedOut?: boolean;
}

// WhatsApp only allows free-form messages within 24 hours of her last message (minus a safety margin).
const WINDOW_MS = 24 * 3600e3 - 10 * 60e3;
export const waWindowOpen = (u: Pick<UserRow, "wa_last_inbound_at">, now = Date.now()) =>
  Boolean(u.wa_last_inbound_at && now - new Date(u.wa_last_inbound_at).getTime() < WINDOW_MS);

interface Delivery {
  status: "sent" | "mock" | "failed" | "held";
  providerId: string | null;
  via: string;
  error: string | null;
  retry: boolean;
}

async function outboxRow(db: Db, channel: string, toHash: string, body: string, d: Delivery, kind = "girl"): Promise<number> {
  const [o] = await db.query<{ id: number }>(
    `INSERT INTO outbox (channel, to_hash, body, status, error, kind, last_attempt_at, provider_id, via) VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8) RETURNING id`,
    [channel, toHash, body, d.status, d.error, kind, d.providerId, d.via],
  );
  return o.id;
}

async function whatsappSend(to: string, payload: WhatsAppPayload, via: string): Promise<Delivery> {
  try {
    const id = await transports.whatsapp(to, payload);
    return { status: id.startsWith("wamid.mock") ? "mock" : "sent", providerId: id || null, via, error: null, retry: false };
  } catch (err) {
    const e = err as WhatsAppError;
    if (e.code === WINDOW_CLOSED_CODE) return { status: "held", providerId: null, via, error: e.message, retry: false };
    return { status: "failed", providerId: null, via, error: e.message, retry: e.retryable !== false };
  }
}

// Sends an SMS (split into parts if long). One outbox row per part.
async function smsSend(db: Db, phone: string, toHash: string, body: string, kind = "girl"): Promise<Delivery> {
  let last: Delivery = { status: "sent", providerId: null, via: "sms", error: null, retry: false };
  const parts = splitSms(body);
  for (const part of parts) {
    try {
      const r = await transports.sms(phone, part);
      last = { status: r.status, providerId: r.providerId, via: "sms", error: null, retry: false };
      if (parts.length > 1) await outboxRow(db, "sms", toHash, part, last, kind);
    } catch (err) {
      return { status: "failed", providerId: null, via: "sms", error: (err as Error).message, retry: true };
    }
  }
  // A single-part message gets its outbox row from the caller (keeps one row = one message).
  return parts.length > 1 ? { ...last, via: "sms-parts" } : last;
}

// Holds a message until her WhatsApp window reopens, and tells her (once) that something is waiting.
async function hold(db: Db, user: UserRow, body: string, contentId: string | null, sentByStaff: number | null): Promise<void> {
  const [already] = await db.query(`SELECT 1 FROM pending_outbound WHERE user_id = $1 LIMIT 1`, [user.id]);
  await db.query(`INSERT INTO pending_outbound (user_id, body, content_id, sent_by_staff) VALUES ($1,$2,$3,$4)`, [user.id, body, contentId, sentByStaff]);
  if (already) return;
  const phone = decryptPhone(user.phone_enc);
  const lang = user.language ?? "en";
  const tplLang = config.whatsapp.templateLanguages[lang];
  let d: Delivery;
  let note: string;
  if (config.whatsapp.templateNotify && tplLang) {
    note = `[template ${config.whatsapp.templateNotify}]`;
    d = await whatsappSend(phone, templatePayload(config.whatsapp.templateNotify, tplLang, []), "template");
  } else {
    // No approved template for her language: a short SMS that reveals nothing about the message.
    note = t(lang, "wa_waiting_sms");
    d = await smsSend(db, phone, user.phone_hash, note);
    if (d.via === "sms-parts") return;
  }
  await outboxRow(db, d.via === "template" ? "whatsapp" : "sms", user.phone_hash, note, d);
}

// Delivers one message to a girl on her channel. Used for first sends and for retries.
async function deliverToUser(db: Db, user: UserRow, body: string, opts: SendOptions, contentId: string | null, sentByStaff: number | null): Promise<Delivery> {
  const phone = decryptPhone(user.phone_enc);
  if (user.channel === "whatsapp") {
    if (waWindowOpen(user)) {
      const menu = parseMenu(body);
      const payload = menuPayload(menu.body, menu.options, t(user.language, "wa_list_button")) ?? textPayload(body);
      const d = await whatsappSend(phone, payload, payload.type);
      if (d.status !== "held") return d;
    }
    // Window closed.
    const tplLang = config.whatsapp.templateLanguages[user.language ?? "en"];
    if (opts.kind === "checkin") {
      if (config.whatsapp.templateCheckin && tplLang) {
        return whatsappSend(phone, templatePayload(config.whatsapp.templateCheckin, tplLang, [opts.checkinCode ?? ""], ["1", "2"]), "template");
      }
      return smsSend(db, phone, user.phone_hash, body); // the brief's SMS fallback for the check-in
    }
    await hold(db, user, body, contentId, sentByStaff);
    return { status: "held", providerId: null, via: "pending", error: null, retry: false };
  }
  if (user.channel === "sms") return smsSend(db, phone, user.phone_hash, body);
  return { status: "mock", providerId: null, via: "simulator", error: null, retry: false };
}

// Sends a message to a girl, records it in her conversation, and retries in the background if it fails.
// Returns the conversation message id, or null if nothing was sent (she said STOP).
export async function sendToUser(db: Db, user: UserRow, body: string, contentId: string | null = null, sentByStaff: number | null = null, opts: SendOptions = {}): Promise<number | null> {
  if (user.opted_out && !opts.allowOptedOut) {
    log.info({ userId: user.id }, "not sending: she opted out");
    return null;
  }
  const d = await deliverToUser(db, user, body, opts, contentId, sentByStaff);
  if (d.via !== "sms-parts") {
    const oid = await outboxRow(db, d.via === "sms" ? "sms" : user.channel, user.phone_hash, body, d);
    if (d.status === "failed") {
      if (d.retry) await scheduleRetry(db, oid, {});
      log.warn({ channel: user.channel, err: d.error, retry: d.retry }, "send failed");
    }
  }
  const [m] = await db.query<{ id: number }>(
    `INSERT INTO messages (user_id, direction, channel, body, content_id, sent_by_staff, content_version_id) VALUES ($1,'out',$2,$3,$4,$5,$6) RETURNING id`,
    [user.id, user.channel, body, contentId, sentByStaff, opts.contentVersionId ?? null],
  );
  if (opts.audioMediaId && user.channel === "whatsapp" && waWindowOpen(user) && d.status !== "failed" && d.status !== "held") {
    await sendVoiceAnswer(db, user, opts.audioMediaId);
  }
  return m.id;
}

// A recorded voice answer (approved with the text). Uploaded to WhatsApp once and reused for 25 days.
export async function sendVoiceAnswer(db: Db, user: UserRow, mediaId: number): Promise<boolean> {
  const [m] = await db.query(`SELECT id, mime, bytes, filename, wa_media_id, wa_media_uploaded_at FROM media WHERE id = $1`, [mediaId]);
  if (!m) return false;
  let waId: string = m.wa_media_id;
  try {
    if (!waId || !m.wa_media_uploaded_at || Date.now() - new Date(m.wa_media_uploaded_at).getTime() > 25 * 864e5) {
      waId = await transports.uploadMedia(Buffer.from(m.bytes), m.mime, m.filename);
      await db.query(`UPDATE media SET wa_media_id = $2, wa_media_uploaded_at = now() WHERE id = $1`, [m.id, waId]);
    }
  } catch (err) {
    log.warn({ mediaId, err: (err as Error).message }, "voice answer upload failed; text was sent");
    return false;
  }
  const d = await whatsappSend(decryptPhone(user.phone_enc), audioPayload(waId), "audio");
  await outboxRow(db, "whatsapp", user.phone_hash, `[voice answer ${mediaId}]`, d);
  return d.status !== "failed" && d.status !== "held";
}

// She wrote on WhatsApp, so the window is open again: send what was held for her.
export async function flushPending(db: Db, user: UserRow): Promise<number> {
  const rows = await db.query(`DELETE FROM pending_outbound WHERE user_id = $1 RETURNING body, content_id, sent_by_staff, created_at`, [user.id]);
  rows.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const r of rows) {
    const d = await deliverToUser(db, user, r.body, {}, r.content_id, r.sent_by_staff);
    if (d.via === "sms-parts") continue;
    const oid = await outboxRow(db, "whatsapp", user.phone_hash, r.body, d);
    if (d.status === "failed" && d.retry) await scheduleRetry(db, oid, {});
  }
  return rows.length;
}

// SMS alert to staff (nurse on call). Retried in the background until delivered:
// an urgent case must always reach a human.
export async function alertStaff(db: Db, phone: string, body: string): Promise<boolean> {
  let d: Delivery;
  try {
    const r = await transports.sms(phone, body);
    d = { status: r.status, providerId: r.providerId, via: "sms", error: null, retry: false };
  } catch (err) {
    d = { status: "failed", providerId: null, via: "sms", error: (err as Error).message, retry: true };
    log.error({ err: d.error }, "staff alert failed, will retry");
  }
  const oid = await outboxRow(db, "sms", hashPhone(phone), body, d, "staff_alert");
  if (d.status === "failed") await scheduleRetry(db, oid, { phoneEnc: encryptSecret(phone) }, 20);
  return d.status !== "failed";
}

async function scheduleRetry(db: Db, outboxId: number, extra: Record<string, unknown>, maxAttempts = 8, delayMs = backoffMs(1)) {
  await enqueue(db, "outbox.retry", { outboxId, ...extra }, { runAt: new Date(Date.now() + delayMs), maxAttempts, uniqueKey: `outbox:${outboxId}` });
  wakeWorker();
}

// Job handler: re-send one failed outbox message.
export async function retryOutbox(db: Db, payload: { outboxId: number; phoneEnc?: string }): Promise<void> {
  const [o] = await db.query(`SELECT * FROM outbox WHERE id = $1`, [payload.outboxId]);
  if (!o || o.status !== "failed") return;
  if (o.kind === "staff_alert") {
    if (!payload.phoneEnc) return;
    try {
      const r = await transports.sms(decryptSecret(payload.phoneEnc), o.body);
      await db.query(`UPDATE outbox SET status = $2, provider_id = $3, error = NULL, attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`, [o.id, r.status, r.providerId]);
    } catch (err) {
      await db.query(`UPDATE outbox SET error = $2, attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`, [o.id, (err as Error).message]);
      throw err;
    }
    return;
  }
  const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE phone_hash = $1`, [o.to_hash]);
  if (!u || u.opted_out) {
    // She deleted her data or said STOP: never send.
    await db.query(`UPDATE outbox SET status = 'cancelled' WHERE id = $1`, [o.id]);
    return;
  }
  const d = await deliverToUser(db, u, o.body, {}, null, null);
  await db.query(`UPDATE outbox SET status = $2, provider_id = $3, via = $4, error = $5, attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`, [
    o.id,
    d.via === "sms-parts" ? "sent" : d.status,
    d.providerId,
    d.via,
    d.error,
  ]);
  if (d.status === "failed" && d.retry) throw new Error(d.error ?? "send failed"); // the queue schedules the next attempt
}

// ---- Delivery reports ----

// WhatsApp statuses: sent, delivered, read, failed.
export async function applyWhatsAppStatus(db: Db, s: { id: string; status: string; errorCode: number | null; errorTitle: string | null }): Promise<void> {
  const [o] = await db.query(`SELECT id, to_hash, body, kind, status FROM outbox WHERE provider_id = $1`, [s.id]);
  if (!o) return;
  if (s.status === "delivered") await db.query(`UPDATE outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [o.id]);
  else if (s.status === "read") await db.query(`UPDATE outbox SET read_at = COALESCE(read_at, now()), delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [o.id]);
  else if (s.status === "failed" && o.status !== "failed") {
    await db.query(`UPDATE outbox SET status = 'failed', error = $2 WHERE id = $1`, [o.id, `${s.errorCode ?? ""} ${s.errorTitle ?? ""}`.trim() || "failed"]);
    if (o.kind !== "girl") return;
    const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE phone_hash = $1`, [o.to_hash]);
    if (!u || u.opted_out) return;
    if (s.errorCode === WINDOW_CLOSED_CODE) {
      // Her window closed before it arrived: hold it for her next message.
      await db.query(`UPDATE outbox SET status = 'held' WHERE id = $1`, [o.id]);
      await hold(db, { ...u, wa_last_inbound_at: null }, o.body, null, null);
    } else if (s.errorCode == null || [131000, 131016, 130429, 131053].includes(s.errorCode)) {
      await scheduleRetry(db, o.id, {});
    }
  }
}

// Africa's Talking delivery reports.
export async function applySmsDelivery(db: Db, r: { id: string; status: string; failureReason?: string }): Promise<void> {
  const [o] = await db.query(`SELECT id, kind, status, attempts FROM outbox WHERE provider_id = $1`, [r.id]);
  if (!o) return;
  if (r.status === "Success") {
    await db.query(`UPDATE outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE id = $1`, [o.id]);
  } else if (SMS_FAILED.has(r.status) && o.status !== "failed") {
    await db.query(`UPDATE outbox SET status = 'failed', error = $2 WHERE id = $1`, [o.id, `${r.status}${r.failureReason ? `: ${r.failureReason}` : ""}`]);
    // Phone off or out of coverage: try again later (a few times). Other failures are permanent.
    if (r.status === "AbsentSubscriber" && o.attempts < 4) await scheduleRetry(db, o.id, {}, 4, 2 * 3600e3);
  }
}
