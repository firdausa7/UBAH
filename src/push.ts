import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import type { Db } from "./db.js";
import { config } from "./config.js";
import { log } from "./log.js";

// Web push for the girls' space: "you have a new message", nothing more.
// Pushes carry NO data: the phone wakes, and the girls' space shows a neutral notice in her language
// ("New message / Tap to open"). So nothing she wrote or received passes through the push services.
// Signed with VAPID (RFC 8292). Off until VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set
// (npm run vapid-keys), and per girl until she switches it on.

const THROTTLE_MS = 2 * 60_000; // at most one notice every 2 minutes

export const pushEnabled = () => Boolean(config.push.publicKey && config.push.privateKey);

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function newVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  return { publicKey: b64url(raw), privateKey: privateKey.export({ format: "jwk" }).d! };
}

// The signed token a push service checks: ES256 over {aud, exp, sub}.
export function vapidJwt(endpoint: string, now = Date.now()): string {
  const raw = Buffer.from(config.push.publicKey, "base64url");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: config.push.privateKey, x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) },
    format: "jwk",
  });
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: config.push.subject }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(signature)}`;
}

// Ubah sends requests to the address a phone gives it: only the browsers' own push services are
// accepted (never an address inside the server's network).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/];
export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export async function subscribe(db: Db, userId: number, endpoint: string) {
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint) VALUES ($1,$2) ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [userId, endpoint],
  );
}

export async function unsubscribe(db: Db, userId: number, endpoint?: string) {
  if (endpoint) await db.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
  else await db.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [userId]);
}

// Tell her phone(s) there is something new. Best effort: a failure never stops the message itself.
export async function notifyGirl(db: Db, userId: number): Promise<number> {
  if (!pushEnabled()) return 0;
  const subs = await db.query<{ id: number; endpoint: string }>(
    `SELECT id, endpoint FROM push_subscriptions WHERE user_id = $1 AND (last_push_at IS NULL OR last_push_at < now() - make_interval(secs => $2))`,
    [userId, THROTTLE_MS / 1000],
  );
  let sent = 0;
  for (const s of subs) {
    try {
      const res = await fetch(s.endpoint, {
        method: "POST",
        headers: { TTL: "86400", Urgency: "normal", authorization: `vapid t=${vapidJwt(s.endpoint)}, k=${config.push.publicKey}`, "content-length": "0" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]); // the phone unsubscribed
      else if (res.ok) {
        await db.query(`UPDATE push_subscriptions SET last_push_at = now() WHERE id = $1`, [s.id]);
        sent++;
      } else throw new Error(`push HTTP ${res.status}`);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "web push failed");
    }
  }
  return sent;
}
