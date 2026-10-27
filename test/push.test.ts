import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import { createPublicKey, verify } from "node:crypto";
import { freshDb, lastSmsCode } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { handleIncoming } from "../src/engine.js";
import { hashPhone } from "../src/privacy.js";
import { newVapidKeys, notifyGirl, validEndpoint, vapidJwt } from "../src/push.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
const H = { "x-ubah": "1" };
const saved = { ...config.push };
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";

beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});
afterEach(() => {
  Object.assign(config.push, saved);
  vi.unstubAllGlobals();
});

async function webGirl(phone: string) {
  const a = request.agent(app);
  await a.post("/api/auth/girl/code").set(H).send({ phone });
  await a.post("/api/auth/girl/verify").set(H).send({ phone, code: lastSmsCode(phone.replace(/^0/, "254")), pin: "2580", language: "en" });
  const [u] = await db.query(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
  return { a, user: u };
}

function keys() {
  const k = newVapidKeys();
  config.push.publicKey = k.publicKey;
  config.push.privateKey = k.privateKey;
  config.push.subject = "mailto:test@example.org";
  return k;
}

describe("web push keys and signature", () => {
  it("signs a VAPID token the push service can check with the public key", () => {
    const k = keys();
    const raw = Buffer.from(k.publicKey, "base64url");
    expect(raw.length).toBe(65);
    const [h, c, sig] = vapidJwt(ENDPOINT).split(".");
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:test@example.org" });
  });

  it("accepts only the browsers' push services, never an address inside the server's network", () => {
    for (const ok of [ENDPOINT, "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/abc", "https://wns2-by3p.notify.windows.com/w/?token=1"]) expect(validEndpoint(ok), ok).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://fcm.googleapis.com:8443/x", "https://evil.example.org/fcm.googleapis.com", "not a url", 42]) expect(validEndpoint(bad), String(bad)).toBe(false);
  });
});

describe("web push for the girls' space", () => {
  it("is off without keys", async () => {
    const { a } = await webGirl("0712900001");
    expect((await a.get("/api/me/push")).body).toMatchObject({ enabled: false, publicKey: null });
    expect((await a.put("/api/me/push").set(H).send({ endpoint: ENDPOINT })).status).toBe(404);
  });

  it("sends an empty push (nothing of hers) when a message arrives in her app, at most every 2 minutes", async () => {
    keys();
    const { a, user } = await webGirl("0712900002");
    expect((await a.put("/api/me/push").set(H).send({ endpoint: "https://10.0.0.5/x" })).status).toBe(400);
    expect((await a.put("/api/me/push").set(H).send({ endpoint: ENDPOINT })).status).toBe(200);
    expect((await a.get("/api/me/push")).body).toMatchObject({ enabled: true, devices: 1 });

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 201 }))));
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "my period is two weeks late, what should i do" });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].init.body).toBeUndefined(); // no data at all
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(headers.TTL).toBe("86400");

    // A second message straight after: no second notice.
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "thank you" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
  });

  it("forgets a phone that unsubscribed, and when she switches it off or wipes her history", async () => {
    keys();
    const { a, user } = await webGirl("0712900003");
    await a.put("/api/me/push").set(H).send({ endpoint: ENDPOINT + "-3" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
    await notifyGirl(db, user.id);
    expect((await a.get("/api/me/push")).body.devices).toBe(0);

    await a.put("/api/me/push").set(H).send({ endpoint: ENDPOINT + "-4" });
    await a.delete("/api/me/push").set(H).send({ endpoint: ENDPOINT + "-4" });
    expect((await a.get("/api/me/push")).body.devices).toBe(0);

    await a.put("/api/me/push").set(H).send({ endpoint: ENDPOINT + "-5" });
    await a.delete("/api/me").set(H);
    expect((await db.query(`SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`, [user.id]))[0].n).toBe(0);
  });
});
