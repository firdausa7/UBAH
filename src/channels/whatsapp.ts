import { config, mockMode } from "../config.js";
import { normalizePhone } from "../privacy.js";
import { log } from "../log.js";
import { clip, type MenuOption } from "./menu.js";

// WhatsApp Cloud API (Meta). Webhook: GET /webhooks/whatsapp (verification), POST (messages + statuses).
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api

const graph = () => `https://graph.facebook.com/${config.whatsapp.graphVersion}`;

export class WhatsAppError extends Error {
  constructor(
    message: string,
    public code: number | null,
    public retryable: boolean,
  ) {
    super(message);
  }
}
// Meta error 131047: "Re-engagement message" — more than 24 hours since she last wrote.
export const WINDOW_CLOSED_CODE = 131047;

export type WhatsAppPayload =
  | { type: "text"; text: { body: string; preview_url: false } }
  | { type: "interactive"; interactive: Record<string, unknown> }
  | { type: "template"; template: Record<string, unknown> }
  | { type: "audio"; audio: { id: string } };

// In mock mode, sent payloads are kept in memory so tests and local runs can read them.
export const mockWhatsAppSent: Array<{ to: string; payload: WhatsAppPayload; at: number }> = [];
let mockSeq = 0;

export async function sendWhatsApp(to: string, payload: WhatsAppPayload): Promise<string> {
  if (mockMode.whatsapp()) {
    const summary = payload.type === "text" ? payload.text.body : payload.type;
    log.info({ channel: "whatsapp", mock: true, toPrefix: normalizePhone(to).slice(0, 6), type: payload.type }, `[whatsapp:mock] ${String(summary).replace(/\n/g, " | ")}`);
    mockWhatsAppSent.push({ to: normalizePhone(to), payload, at: Date.now() });
    if (mockWhatsAppSent.length > 500) mockWhatsAppSent.shift();
    return `wamid.mock.${++mockSeq}`;
  }
  const res = await fetch(`${graph()}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.whatsapp.token}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: normalizePhone(to), ...payload }),
    signal: AbortSignal.timeout(15000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = Number(json?.error?.code ?? json?.error?.error_subcode) || null;
    const retryable = res.status === 429 || res.status >= 500 || code === 131000 || code === 130429;
    throw new WhatsAppError(`WhatsApp HTTP ${res.status}${code ? ` (${code})` : ""}: ${json?.error?.message ?? ""}`.trim(), code, retryable);
  }
  return String(json?.messages?.[0]?.id ?? "");
}

export const textPayload = (body: string): WhatsAppPayload => ({ type: "text", text: { body: body.slice(0, 4096), preview_url: false } });

// Up to 3 options: reply buttons. Up to 10: a list. More: plain text (the numbers still work).
export function menuPayload(body: string, options: MenuOption[], listButton: string): WhatsAppPayload | null {
  if (options.length < 2 || options.length > 10) return null;
  if (options.length <= 3) {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: { buttons: options.map((o) => ({ type: "reply", reply: { id: o.id, title: clip(o.title, 20) } })) },
      },
    };
  }
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body.slice(0, 4096) },
      action: { button: clip(listButton, 20), sections: [{ title: clip(listButton, 24), rows: options.map((o) => ({ id: o.id, title: clip(o.title, 24) })) }] },
    },
  };
}

// An approved template (for messages outside the 24-hour window). Quick-reply buttons carry the
// number the engine expects as their payload.
export function templatePayload(name: string, language: string, bodyParams: string[], quickReplies: string[] = []): WhatsAppPayload {
  const components: unknown[] = [];
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) });
  quickReplies.forEach((payload, index) => components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] }));
  return { type: "template", template: { name, language: { code: language }, components } };
}

export const audioPayload = (mediaId: string): WhatsAppPayload => ({ type: "audio", audio: { id: mediaId } });

// Uploads a recorded answer to WhatsApp; the returned id can be sent for 30 days.
export async function uploadWhatsAppMedia(bytes: Buffer, mime: string, filename: string): Promise<string> {
  if (mockMode.whatsapp()) return `mock-media-${bytes.length}`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename || "answer.ogg");
  const res = await fetch(`${graph()}/${config.whatsapp.phoneNumberId}/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.whatsapp.token}` },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id) throw new WhatsAppError(`WhatsApp media upload HTTP ${res.status}`, Number(json?.error?.code) || null, res.status >= 500);
  return String(json.id);
}

const VOICE_TYPES = ["audio/ogg", "audio/opus", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "audio/webm", "audio/wav"];

export async function downloadWhatsAppMedia(mediaId: string): Promise<{ audio: Buffer; mimeType: string }> {
  const meta = await fetch(`${graph()}/${encodeURIComponent(mediaId)}`, { headers: { authorization: `Bearer ${config.whatsapp.token}` }, signal: AbortSignal.timeout(15000) });
  if (!meta.ok) throw new Error(`WhatsApp media lookup HTTP ${meta.status}`);
  const info: any = await meta.json();
  const mimeType = String(info.mime_type ?? "audio/ogg").split(";")[0].trim();
  if (!VOICE_TYPES.includes(mimeType)) throw new Error(`Unsupported voice note type ${mimeType}`);
  if (Number(info.file_size ?? 0) > config.whatsapp.maxVoiceBytes) throw new Error("Voice note too large");
  // Only download from Meta's own servers.
  if (!/^https:\/\/([a-z0-9-]+\.)*(fbsbx|facebook|whatsapp)\.(com|net)\//i.test(String(info.url ?? ""))) throw new Error("Unexpected media URL");
  const file = await fetch(info.url, { headers: { authorization: `Bearer ${config.whatsapp.token}` }, signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new Error(`WhatsApp media download HTTP ${file.status}`);
  const audio = Buffer.from(await file.arrayBuffer());
  if (audio.length > config.whatsapp.maxVoiceBytes) throw new Error("Voice note too large");
  return { audio, mimeType };
}

export interface InboundWhatsApp {
  id: string;
  from: string;
  timestamp: number | null;
  type: "text" | "audio" | "interactive" | "location" | "other";
  text?: string;
  mediaId?: string;
  mimeType?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
}

export interface WhatsAppStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  errorCode: number | null;
  errorTitle: string | null;
}

// Pulls the messages and delivery statuses out of a Cloud API webhook payload.
export function parseWhatsAppWebhook(payload: any): { messages: InboundWhatsApp[]; statuses: WhatsAppStatus[] } {
  const messages: InboundWhatsApp[] = [];
  const statuses: WhatsAppStatus[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      for (const m of value.messages ?? []) {
        const from = String(m.from ?? "");
        if (!from) continue;
        const base = { id: String(m.id ?? `${from}:${m.timestamp}`), from, timestamp: Number(m.timestamp) || null };
        if (m.type === "text") messages.push({ ...base, type: "text", text: String(m.text?.body ?? "") });
        else if (m.type === "audio" || m.type === "voice") messages.push({ ...base, type: "audio", mediaId: m.audio?.id ?? m.voice?.id, mimeType: m.audio?.mime_type });
        else if (m.type === "interactive") messages.push({ ...base, type: "interactive", text: String(m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? "") });
        // Template quick-reply buttons: we set the payload to the number the engine expects.
        else if (m.type === "button") messages.push({ ...base, type: "interactive", text: String(m.button?.payload ?? m.button?.text ?? "") });
        else if (m.type === "location" && Number.isFinite(Number(m.location?.latitude)) && Number.isFinite(Number(m.location?.longitude)))
          messages.push({ ...base, type: "location", location: { lat: Number(m.location.latitude), lng: Number(m.location.longitude), name: m.location.name, address: m.location.address } });
        else messages.push({ ...base, type: "other" });
      }
      for (const s of value.statuses ?? []) {
        if (!s?.id) continue;
        statuses.push({ id: String(s.id), status: String(s.status ?? ""), errorCode: Number(s.errors?.[0]?.code) || null, errorTitle: s.errors?.[0]?.title ?? null });
      }
    }
  }
  return { messages, statuses };
}
