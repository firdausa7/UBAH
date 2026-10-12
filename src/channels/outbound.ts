import type { Db } from "../db.js";
import { decryptPhone, encryptSecret, decryptSecret, hashPhone } from "../privacy.js";
import { sendWhatsAppText } from "./whatsapp.js";
import { sendSms } from "./sms.js";
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
}

// The transports, swappable in tests to simulate an outage.
export const transports = {
  whatsapp: sendWhatsAppText,
  sms: sendSms,
};

async function deliver(channel: string, phone: string, body: string): Promise<string> {
  if (channel === "whatsapp") return transports.whatsapp(phone, body);
  if (channel === "sms") return transports.sms(phone, body);
  return "mock"; // simulator
}

// Sends a message to a girl on the channel she uses, and records it.
// A failed send is retried in the background (outbox.retry job) until it goes through.
export async function sendToUser(db: Db, user: UserRow, body: string, contentId: string | null = null, sentByStaff: number | null = null): Promise<number> {
  let status = "sent";
  let error: string | null = null;
  try {
    status = await deliver(user.channel, decryptPhone(user.phone_enc), body);
  } catch (err) {
    status = "failed";
    error = (err as Error).message;
    log.warn({ channel: user.channel, err: error }, "send failed, will retry");
  }
  const [o] = await db.query<{ id: number }>(
    `INSERT INTO outbox (channel, to_hash, body, status, error, kind, last_attempt_at) VALUES ($1,$2,$3,$4,$5,'girl',now()) RETURNING id`,
    [user.channel, user.phone_hash, body, status, error],
  );
  const [m] = await db.query<{ id: number }>(
    `INSERT INTO messages (user_id, direction, channel, body, content_id, sent_by_staff) VALUES ($1,'out',$2,$3,$4,$5) RETURNING id`,
    [user.id, user.channel, body, contentId, sentByStaff],
  );
  if (status === "failed") await scheduleRetry(db, o.id, {});
  return m.id;
}

// SMS alert to staff (nurse on call). Retried in the background until delivered:
// an urgent case must always reach a human.
export async function alertStaff(db: Db, phone: string, body: string): Promise<boolean> {
  let status = "sent";
  let error: string | null = null;
  try {
    status = await transports.sms(phone, body);
  } catch (err) {
    status = "failed";
    error = (err as Error).message;
    log.error({ err: error }, "nurse alert failed, will retry");
  }
  const [o] = await db.query<{ id: number }>(
    `INSERT INTO outbox (channel, to_hash, body, status, error, kind, last_attempt_at) VALUES ('sms',$1,$2,$3,$4,'staff_alert',now()) RETURNING id`,
    [hashPhone(phone), body, status, error],
  );
  if (status === "failed") await scheduleRetry(db, o.id, { phoneEnc: encryptSecret(phone) }, 20);
  return status !== "failed";
}

async function scheduleRetry(db: Db, outboxId: number, extra: Record<string, unknown>, maxAttempts = 8) {
  await enqueue(db, "outbox.retry", { outboxId, ...extra }, { runAt: new Date(Date.now() + backoffMs(1)), maxAttempts, uniqueKey: `outbox:${outboxId}` });
  wakeWorker();
}

// Job handler: re-send one failed outbox message.
export async function retryOutbox(db: Db, payload: { outboxId: number; phoneEnc?: string }): Promise<void> {
  const [o] = await db.query(`SELECT * FROM outbox WHERE id = $1`, [payload.outboxId]);
  if (!o || o.status !== "failed") return;
  let phone: string;
  if (o.kind === "staff_alert") {
    if (!payload.phoneEnc) return;
    phone = decryptSecret(payload.phoneEnc);
  } else {
    const [u] = await db.query<UserRow>(`SELECT * FROM users WHERE phone_hash = $1`, [o.to_hash]);
    if (!u || u.opted_out) {
      // She deleted her data or said STOP: never send.
      await db.query(`UPDATE outbox SET status = 'cancelled' WHERE id = $1`, [o.id]);
      return;
    }
    phone = decryptPhone(u.phone_enc);
  }
  try {
    const status = await deliver(o.channel, phone, o.body);
    await db.query(`UPDATE outbox SET status = $2, error = NULL, attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`, [o.id, status]);
  } catch (err) {
    await db.query(`UPDATE outbox SET error = $2, attempts = attempts + 1, last_attempt_at = now() WHERE id = $1`, [o.id, (err as Error).message]);
    throw err; // the queue schedules the next attempt
  }
}
