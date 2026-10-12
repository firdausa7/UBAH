import { config, mockMode } from "../config.js";
import { normalizePhone } from "../privacy.js";
import { log } from "../log.js";

// WhatsApp Cloud API (Meta). Webhook: GET /webhooks/whatsapp (verification), POST (messages).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

const graph = () => `https://graph.facebook.com/${config.whatsapp.graphVersion}`;

export async function sendWhatsAppText(to: string, body: string): Promise<string> {
  if (mockMode.whatsapp()) {
    log.info({ channel: "whatsapp", mock: true, toPrefix: normalizePhone(to).slice(0, 6) }, `[whatsapp:mock] ${body.replace(/\n/g, " | ")}`);
    return "mock";
  }
  const res = await fetch(`${graph()}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.whatsapp.token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: normalizePhone(to), type: "text", text: { body, preview_url: false } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`WhatsApp HTTP ${res.status}: ${await res.text()}`);
  return "sent";
}

export async function downloadWhatsAppMedia(mediaId: string): Promise<{ audio: Buffer; mimeType: string }> {
  const meta = await fetch(`${graph()}/${mediaId}`, { headers: { authorization: `Bearer ${config.whatsapp.token}` }, signal: AbortSignal.timeout(15000) });
  if (!meta.ok) throw new Error(`WhatsApp media lookup HTTP ${meta.status}`);
  const info: any = await meta.json();
  const file = await fetch(info.url, { headers: { authorization: `Bearer ${config.whatsapp.token}` }, signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new Error(`WhatsApp media download HTTP ${file.status}`);
  return { audio: Buffer.from(await file.arrayBuffer()), mimeType: info.mime_type ?? "audio/ogg" };
}

export interface InboundWhatsApp {
  from: string;
  type: "text" | "audio" | "interactive" | "other";
  text?: string;
  mediaId?: string;
  mimeType?: string;
}

// Pulls the messages out of a Cloud API webhook payload.
export function parseWhatsAppWebhook(payload: any): InboundWhatsApp[] {
  const out: InboundWhatsApp[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const m of change?.value?.messages ?? []) {
        if (m.type === "text") out.push({ from: m.from, type: "text", text: m.text?.body ?? "" });
        else if (m.type === "audio") out.push({ from: m.from, type: "audio", mediaId: m.audio?.id, mimeType: m.audio?.mime_type });
        else if (m.type === "interactive")
          out.push({ from: m.from, type: "interactive", text: m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? "" });
        else if (m.type === "button") out.push({ from: m.from, type: "text", text: m.button?.text ?? "" });
        else out.push({ from: m.from, type: "other" });
      }
    }
  }
  return out;
}
