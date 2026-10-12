import { config, mockMode } from "../config.js";
import { normalizePhone } from "../privacy.js";

// Africa's Talking SMS. Inbound messages arrive at POST /webhooks/sms (form-encoded: from, to, text).
// Docs: https://developers.africastalking.com/docs/sms/sending

export async function sendSms(to: string, message: string): Promise<string> {
  if (mockMode.sms()) {
    console.log(`[sms:mock] -> ${to.slice(0, 6)}***: ${message.replace(/\n/g, " | ")}`);
    return "mock";
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
  if (!res.ok) throw new Error(`Africa's Talking HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  const recipient = json?.SMSMessageData?.Recipients?.[0];
  if (recipient && recipient.status !== "Success") throw new Error(`Africa's Talking: ${recipient.status}`);
  return "sent";
}

export function parseInboundSms(body: Record<string, string>): { from: string; text: string } | null {
  if (!body.from || typeof body.text !== "string") return null;
  return { from: body.from, text: body.text };
}
