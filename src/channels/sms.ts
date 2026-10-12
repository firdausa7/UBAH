import { config, mockMode } from "../config.js";
import { normalizePhone } from "../privacy.js";
import { log } from "../log.js";

// Africa's Talking SMS.
//   Inbound:          POST /webhooks/sms?key=…           (form: from, to, text, id)
//   Delivery reports: POST /webhooks/sms/delivery?key=…  (form: id, status, failureReason)
//   Opt-outs:         POST /webhooks/sms/optout?key=…    (form: phoneNumber, senderId)
// Docs: https://developers.africastalking.com/docs/sms/overview

// In mock mode, sent messages are kept in memory (newest last) so tests and local logins can read them.
export const mockSmsSent: Array<{ to: string; message: string; at: number; id: string }> = [];
let mockSeq = 0;

export interface SmsResult {
  status: "sent" | "mock";
  providerId: string | null;
}

export async function sendSmsDetailed(to: string, message: string): Promise<SmsResult> {
  if (mockMode.sms()) {
    // Mock mode never runs in production (config refuses), so showing the text here is safe.
    log.info({ channel: "sms", mock: true, toPrefix: normalizePhone(to).slice(0, 6) }, `[sms:mock] ${message.replace(/\n/g, " | ")}`);
    const id = `ATmock-${++mockSeq}`;
    mockSmsSent.push({ to: normalizePhone(to), message, at: Date.now(), id });
    if (mockSmsSent.length > 500) mockSmsSent.shift();
    return { status: "mock", providerId: id };
  }
  const host = config.africasTalking.sandbox ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  const body = new URLSearchParams({ username: config.africasTalking.username, to: `+${normalizePhone(to)}`, message });
  if (config.africasTalking.senderId) body.set("from", config.africasTalking.senderId);
  const res = await fetch(`https://${host}/version1/messaging`, {
    method: "POST",
    headers: { apiKey: config.africasTalking.apiKey, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json: any = await res.json();
  const recipient = json?.SMSMessageData?.Recipients?.[0];
  if (!recipient || recipient.status !== "Success") throw new Error(`Africa's Talking: ${recipient?.status ?? json?.SMSMessageData?.Message ?? "no recipient"}`);
  return { status: "sent", providerId: recipient.messageId ? String(recipient.messageId) : null };
}

// Kept for callers that only need the status (staff alerts, login codes).
export async function sendSms(to: string, message: string): Promise<string> {
  return (await sendSmsDetailed(to, message)).status;
}

// Long answers are sent as numbered parts, cut at sentence or line breaks, each at most `max`
// characters (3 SMS segments by default, so every part arrives as one message on any phone).
export function splitSms(text: string, max = config.smsPartChars): string[] {
  const clean = text.trim();
  if (clean.length <= max) return [clean];
  const budget = max - 8; // room for " (1/3)"
  const pieces = clean.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const parts: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) parts.push(cur.trim());
    cur = "";
  };
  for (const piece of pieces) {
    if (piece.length > budget) {
      push();
      for (let i = 0; i < piece.length; i += budget) parts.push(piece.slice(i, i + budget).trim());
      continue;
    }
    if ((cur ? `${cur} ${piece}` : piece).length > budget) push();
    cur = cur ? `${cur} ${piece}` : piece;
  }
  push();
  return parts.map((p, i) => `${p} (${i + 1}/${parts.length})`);
}

export function parseInboundSms(body: Record<string, string>): { from: string; text: string; id: string | null } | null {
  if (!body.from || typeof body.text !== "string") return null;
  return { from: body.from, text: body.text, id: body.id ? String(body.id).slice(0, 100) : null };
}

// Africa's Talking delivery statuses that mean "never arrived".
export const SMS_FAILED = new Set(["Failed", "Rejected", "AbsentSubscriber", "Expired", "InsufficientBalance", "UserInBlacklist", "UserInactive", "UserNotFound"]);
