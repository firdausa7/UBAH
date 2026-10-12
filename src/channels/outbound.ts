import type { Db } from "../db.js";
import { decryptPhone, hashPhone } from "../privacy.js";
import { sendWhatsAppText } from "./whatsapp.js";
import { sendSms } from "./sms.js";

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

// Sends a message to a girl on the channel she uses, and records it.
export async function sendToUser(db: Db, user: UserRow, body: string, contentId: string | null = null) {
  let status = "sent";
  let error: string | null = null;
  try {
    if (user.channel === "whatsapp") status = await sendWhatsAppText(decryptPhone(user.phone_enc), body);
    else if (user.channel === "sms") status = await sendSms(decryptPhone(user.phone_enc), body);
    else status = "mock"; // simulator
  } catch (err) {
    status = "failed";
    error = (err as Error).message;
    console.error(`[send] ${user.channel} failed:`, error);
  }
  await db.query(`INSERT INTO outbox (channel, to_hash, body, status, error) VALUES ($1,$2,$3,$4,$5)`, [user.channel, user.phone_hash, body, status, error]);
  await db.query(`INSERT INTO messages (user_id, direction, channel, body, content_id) VALUES ($1,'out',$2,$3,$4)`, [user.id, user.channel, body, contentId]);
}

// SMS alert to staff (nurse on call). Staff numbers are not girls' numbers, so they are configured directly.
export async function alertStaff(db: Db, phone: string, body: string) {
  let status = "sent";
  let error: string | null = null;
  try {
    status = await sendSms(phone, body);
  } catch (err) {
    status = "failed";
    error = (err as Error).message;
  }
  await db.query(`INSERT INTO outbox (channel, to_hash, body, status, error) VALUES ('sms',$1,$2,$3,$4)`, [hashPhone(phone), body, status, error]);
}
