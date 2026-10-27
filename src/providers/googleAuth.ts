import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "../config.js";

// Google Cloud service-account login (OAuth 2.0 JWT bearer), for Speech-to-Text v2 (Chirp), which
// takes no API keys. The key file stays on the server; the access token is kept in memory until
// shortly before it expires.

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
let cached: { token: string; until: number; email: string } | null = null;

export function serviceAccount(): ServiceAccount | null {
  const g = config.stt.google;
  const raw = g.credentialsJson || (g.credentialsPath ? readFileSync(g.credentialsPath, "utf8") : "");
  if (!raw) return null;
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error("the Google service-account key is missing client_email, private_key or project_id");
  return sa;
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function signedAssertion(sa: ServiceAccount, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

export async function googleAccessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.email === sa.client_email && Date.now() < cached.until) return cached.token;
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Google token HTTP ${res.status}`);
  const json: any = await res.json();
  cached = { token: String(json.access_token), until: Date.now() + (Number(json.expires_in) || 3600) * 1000 - 60_000, email: sa.client_email };
  return cached.token;
}

export function forgetGoogleToken() {
  cached = null;
}
