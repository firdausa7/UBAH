import request from "supertest";
import type { Express } from "express";
import { createDb, type Db } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { handleIncoming } from "../src/engine.js";
import { decryptSecret, hashPhone } from "../src/privacy.js";
import { currentStep, totpAt } from "../src/security/totp.js";
import { mockSmsSent } from "../src/channels/sms.js";

// Tests run on in-memory PGlite by default. Set TEST_DATABASE_URL to run the same tests
// against a real Postgres server; each database gets its own throwaway schema.
export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  const db = url ? await createDb({ url, schema: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }) : await createDb({ memory: true });
  await seedDemo(db, { staffPassword: "test-pass" });
  return db;
}

// A simulated girl: sends messages and reads Ubah's replies from the outbox.
export function girl(db: Db, phone = "0712000001", channel: "simulator" | "sms" | "whatsapp" = "simulator") {
  let seen = 0;
  const replies = async () => {
    const rows = await db.query<{ id: number; body: string }>(`SELECT id, body FROM outbox WHERE to_hash = $1 ORDER BY id`, [hashPhone(phone)]);
    const fresh = rows.slice(seen).map((r) => r.body);
    seen = rows.length;
    return fresh;
  };
  return {
    phone,
    async send(text: string) {
      await handleIncoming(db, { channel, from: phone, text });
      return (await replies()).join("\n---\n");
    },
    async voice(spoken: string) {
      await handleIncoming(db, { channel, from: phone, voice: { audio: Buffer.from("fake"), mimeType: "audio/ogg", mockText: spoken } });
      return (await replies()).join("\n---\n");
    },
    replies,
  };
}

export const csrfFrom = (html: string) => html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

// The next valid authenticator code for this account (skips steps already used, like a real app a moment later).
export async function totpFor(db: Db, login: string): Promise<string> {
  const [s] = await db.query(`SELECT totp_secret_enc, totp_last_step FROM staff WHERE login = $1`, [login]);
  const secret = decryptSecret(s.totp_secret_enc);
  const step = Math.max(currentStep(), s.totp_last_step == null ? 0 : Number(s.totp_last_step) + 1);
  return totpAt(secret, step);
}

export const lastSmsCode = (phone = "254700000001") => {
  const m = [...mockSmsSent].reverse().find((x) => x.to === phone);
  return m?.message.match(/\b(\d{6})\b/)?.[1] ?? "";
};

export interface StaffClient {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  get(path: string): ReturnType<ReturnType<typeof request.agent>["get"]>;
  post(path: string, form?: Record<string, string | string[]>): ReturnType<ReturnType<typeof request.agent>["post"]>;
}

// Signs in through the real pages: CSRF token, password, then the second factor.
export async function staffClient(app: Express, db: Db, login: string, password = "test-pass"): Promise<StaffClient> {
  const agent = request.agent(app);
  const csrf = csrfFrom((await agent.get("/staff/login")).text);
  const res = await agent.post("/staff/login").type("form").send({ login, password, _csrf: csrf });
  if (res.status !== 302 || String(res.headers.location).includes("error")) throw new Error(`login failed for ${login}: ${res.status} ${res.headers.location}`);
  let to = String(res.headers.location);
  if (to.startsWith("/staff/2fa/setup")) {
    await agent.get("/staff/2fa/setup"); // creates the secret
    const done = await agent.post("/staff/2fa/setup").type("form").send({ code: await totpFor(db, login), _csrf: csrf });
    if (done.status !== 200 || !done.text.includes("recovery codes")) throw new Error(`2FA setup failed for ${login}: ${done.status}`);
  } else if (to.startsWith("/staff/2fa")) {
    const [s] = await db.query(`SELECT role, phone FROM staff WHERE login = $1`, [login]);
    const code = s.role === "dada" ? lastSmsCode(String(s.phone).replace(/^\+/, "")) : await totpFor(db, login);
    const done = await agent.post("/staff/2fa").type("form").send({ code, _csrf: csrf });
    to = String(done.headers.location);
    if (done.status !== 302 || to.includes("2fa") || to.includes("login")) throw new Error(`2FA failed for ${login}: ${done.status} ${to}`);
  }
  return {
    agent,
    csrf,
    get: (path) => agent.get(path),
    post: (path, form = {}) => agent.post(path).type("form").send({ _csrf: csrf, ...form }),
  };
}
