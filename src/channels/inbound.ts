import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { decryptSecret, encryptSecret } from "../privacy.js";
import { handleIncoming } from "../engine.js";
import { downloadWhatsAppMedia, type InboundWhatsApp } from "./whatsapp.js";
import { enqueue } from "../jobs/queue.js";
import { log } from "../log.js";

// Every inbound message is first written down (encrypted), keyed by the provider's message id:
//   - Meta and Africa's Talking retry webhooks, so the same message can arrive twice: it is handled once.
//   - If the app stops halfway, the recovery job handles it later, so a girl's message is never lost.
// Once handled, the stored copy is deleted (the conversation itself lives in `messages`).

export type InboundPayload =
  | { provider: "whatsapp"; message: InboundWhatsApp }
  | { provider: "sms"; from: string; text: string };

export async function recordInbound(db: Db, p: InboundPayload): Promise<number | null> {
  const providerId = p.provider === "whatsapp" ? p.message.id : `sms:${randomUUID()}`;
  const rows = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages (provider, provider_id, payload_enc) VALUES ($1,$2,$3) ON CONFLICT (provider, provider_id) DO NOTHING RETURNING id`,
    [p.provider, providerId, encryptSecret(JSON.stringify(p))],
  );
  return rows[0]?.id ?? null;
}

// Same as recordInbound, but keyed by an id the provider gave us (Africa's Talking `id`).
export async function recordInboundWithId(db: Db, provider: "sms", providerId: string, p: InboundPayload): Promise<number | null> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages (provider, provider_id, payload_enc) VALUES ($1,$2,$3) ON CONFLICT (provider, provider_id) DO NOTHING RETURNING id`,
    [provider, providerId, encryptSecret(JSON.stringify(p))],
  );
  return rows[0]?.id ?? null;
}

export async function processInbound(db: Db, id: number): Promise<void> {
  const claimed = await db.query<{ payload_enc: string }>(
    `UPDATE inbound_messages SET attempts = attempts + 1 WHERE id = $1 AND processed_at IS NULL AND payload_enc IS NOT NULL RETURNING payload_enc`,
    [id],
  );
  if (!claimed.length) return;
  const p = JSON.parse(decryptSecret(claimed[0].payload_enc)) as InboundPayload;
  try {
    if (p.provider === "sms") {
      await handleIncoming(db, { channel: "sms", from: p.from, text: p.text.slice(0, 1600) });
    } else {
      const m = p.message;
      if (m.type === "audio" && m.mediaId) {
        let voice: { audio: Buffer; mimeType: string } | null = null;
        try {
          voice = await downloadWhatsAppMedia(m.mediaId);
        } catch (err) {
          log.warn({ err: (err as Error).message }, "voice note download failed");
        }
        // A voice note we can't fetch is handled like one we can't understand: she is asked to retry or type.
        await handleIncoming(db, { channel: "whatsapp", from: m.from, voice: voice ?? { audio: Buffer.alloc(0), mimeType: "audio/ogg" } });
      } else if (m.type === "location" && m.location) {
        await handleIncoming(db, { channel: "whatsapp", from: m.from, location: m.location });
      } else if (m.type === "text" || m.type === "interactive") {
        await handleIncoming(db, { channel: "whatsapp", from: m.from, text: (m.text ?? "").slice(0, 1600) });
      } else {
        await handleIncoming(db, { channel: "whatsapp", from: m.from, text: "HELP" });
      }
    }
    await db.query(`UPDATE inbound_messages SET processed_at = now(), payload_enc = NULL, error = NULL WHERE id = $1`, [id]);
  } catch (err) {
    await db.query(`UPDATE inbound_messages SET error = $2 WHERE id = $1`, [id, (err as Error).message.slice(0, 500)]);
    log.error({ inboundId: id, provider: p.provider, err: (err as Error).message }, "failed to handle inbound message; will retry");
  }
}

// Recovery: messages not handled after 2 minutes (app stopped, or an error) are tried again, up to 5 times.
export async function recoverInbound(db: Db): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `SELECT id FROM inbound_messages WHERE processed_at IS NULL AND payload_enc IS NOT NULL AND attempts < 5 AND received_at < now() - interval '2 minutes' ORDER BY id LIMIT 100`,
  );
  for (const r of rows) await processInbound(db, r.id);
  // Old handled rows are kept only as ids for de-duplication, then cleaned up.
  await db.query(`DELETE FROM inbound_messages WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'`);
  return rows.length;
}

const RECOVER_MS = 2 * 60_000;
export async function scheduleInboundRecovery(db: Db, from = Date.now()) {
  const slot = Math.floor(from / RECOVER_MS) * RECOVER_MS + RECOVER_MS;
  await enqueue(db, "inbound.recover", {}, { runAt: new Date(slot), uniqueKey: `inbound.recover:${slot}`, maxAttempts: 2 });
}
