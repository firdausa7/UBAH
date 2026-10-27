import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { freshDb } from "./helpers.js";
import { createApp } from "../src/server.js";
import { sendDueCheckins } from "../src/engine.js";
import { clinicRatings } from "../src/ratings.js";
import { refreshCaches } from "../src/caches.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
const later = (h: number) => new Date(Date.now() + h * 3600e3);

async function session() {
  const res = await request(app).post("/app/api/session");
  expect(res.status).toBe(201);
  const token = res.body.token as string;
  const call = (method: "get" | "post" | "patch" | "delete", path: string) => request(app)[method](`/app/api${path}`).set("authorization", `Bearer ${token}`);
  return { token, call };
}

// Five girls who went to clinic 1 and answered the check-in, 4 of them "treated with respect".
async function seedRatings(clinicId: number, answers: string[]) {
  for (const [i, respect] of answers.entries()) {
    const [u] = await db.query(`INSERT INTO users (anon_id, phone_hash, phone_enc, channel) VALUES ($1,$2,'x','sms') RETURNING id`, [`R${clinicId}${i}${Date.now() % 1000}`, `rating-${clinicId}-${i}-${Math.random()}`]);
    const code = `UB-R${clinicId}${i}${Math.floor(Math.random() * 1000)}`;
    await db.query(`INSERT INTO passes (code, user_id, services, suggested_clinic, expires_at) VALUES ($1,$2,'{sti}',$3, now() + interval '7 days')`, [code, u.id, clinicId]);
    await db.query(`INSERT INTO checkins (pass_code, user_id, due_at, visited, clinic_id, respect, completed_at) VALUES ($1,$2, now(), TRUE, $3, $4, now())`, [code, u.id, clinicId, respect]);
  }
}

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000, appApi: { sessionsPerHour: 1000, requestsPerMin: 10_000 } });
});

describe("the retired app (/app)", () => {
  it("sends girls to /me, retires the old service worker, and keeps the icons /me uses", async () => {
    for (const path of ["/app", "/app/", "/app/index.html"]) {
      const res = await request(app).get(path);
      expect([res.status, res.headers.location], path).toEqual([302, "/me"]);
    }
    // Phones that installed the old app get a service worker that clears it and removes itself.
    const sw = await request(app).get("/app/sw.js");
    expect(sw.headers["service-worker-allowed"]).toBe("/app/");
    expect(sw.text).toContain("self.registration.unregister()");
    expect(sw.text).toContain('caches.delete');
    expect(sw.text).not.toContain("addAll");
    expect((await request(app).get("/app/app.js")).status).toBe(404);
    for (const size of [192, 512]) {
      const png = await request(app).get(`/app/icon-${size}.png`).buffer(true).parse((res: any, cb: any) => {
        const c: Buffer[] = [];
        res.on("data", (x: Buffer) => c.push(x));
        res.on("end", () => cb(null, Buffer.concat(c)));
      });
      const buf = png.body as Buffer;
      expect(buf.subarray(1, 4).toString()).toBe("PNG");
      expect(buf.readUInt32BE(16)).toBe(size);
    }
    expect((await request(app).get("/app/icon-77.png")).status).toBe(404);
  });
});

describe("app API", () => {
  it("creates anonymous sessions, storing only a hash of the device secret", async () => {
    const { token } = await session();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.query(`SELECT phone_hash, phone_enc FROM users WHERE channel = 'app'`);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await request(app).get("/app/api/me")).status).toBe(401);
    expect((await request(app).get("/app/api/me").set("authorization", "Bearer nope")).status).toBe(401);
    const limited = createApp(db, { appApi: { sessionsPerHour: 1 } });
    await request(limited).post("/app/api/session");
    expect((await request(limited).post("/app/api/session")).status).toBe(429);
  });

  it("serves the app's text in her language, from published translations", async () => {
    await db.query(`INSERT INTO string_versions (key, language, version, text, status) VALUES ('app_greeting','so',1,'[DRAFT so greeting]','published')`);
    await refreshCaches(db, { force: true });
    const en = await request(app).get("/app/api/strings?lang=en");
    expect(en.body.strings.app_home_ask).toBe("Ask a private question");
    expect(en.body.languages.so).toBe("Soomaali");
    const so = await request(app).get("/app/api/strings?lang=so");
    expect(so.body.strings.app_greeting).toBe("[DRAFT so greeting]");
    expect(so.body.strings.app_send).toBe("Send"); // not translated yet: English
    expect(en.body.strings.app_pass_valid).toBe("Valid until {date}"); // placeholders left for the app
  });

  it("gives every word the girls' space (/me) shows a translatable string", async () => {
    const dir = new URL("../web/src/", import.meta.url);
    const files = ["pages/girl/GirlApp.jsx", "pages/girl/Chat.jsx", "pages/girl/Settings.jsx", "pages/girl/Care.jsx", "pages/girl/Passes.jsx", "pages/girl/Learn.jsx", "pages/auth/Login.jsx"];
    const src = files.map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    const used = new Set([...src.matchAll(/\bt\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
    for (const m of src.matchAll(/\['\/me[^']*', '([a-z0-9_]+)'/g)) used.add(m[1]); // the bottom bar's words
    expect(used.size).toBeGreaterThan(40);
    const strings = (await request(app).get("/api/strings?lang=en")).body.strings;
    for (const k of used) expect(strings[k], k).toBeTruthy();
  });

  it("the Talk to a person button opens a case for the care team", async () => {
    const { token } = await session();
    await request(app).patch("/app/api/me").set("authorization", `Bearer ${token}`).send({ language: "so" });
    await request(app).post("/app/api/messages").set("authorization", `Bearer ${token}`).send({ text: "DADA" });
    const cases = await db.query(`SELECT reason FROM cases ORDER BY id DESC LIMIT 1`);
    expect(cases[0].reason).toBe("asked_for_person");
  });

  it("sends a danger sign to a human from the very first message", async () => {
    const { call } = await session();
    const res = await call("post", "/messages").send({ text: "i want to end my life" });
    expect(res.body.messages.at(-1).text).toMatch(/not alone/i);
    const [c] = await db.query(`SELECT reason, urgent FROM cases ORDER BY id DESC LIMIT 1`);
    expect(c).toEqual({ reason: "danger_selfharm", urgent: true });
  });

  it("chats through the same engine: language, answer with tap-able options, then a pass", async () => {
    const { call } = await session();
    expect((await call("patch", "/me").send({ language: "xx" })).status).toBe(400);
    expect((await call("patch", "/me").send({ language: "en" })).body.language).toBe("en");
    expect((await call("get", "/me")).body.language).toBe("en");
    const ans = await call("post", "/messages").send({ text: "my period is two weeks late" });
    const out = ans.body.messages.filter((m: any) => m.from === "ubah");
    expect(out[0].text).toMatch(/pregnancy test/i);
    expect(out.at(-1).options.map((o: any) => o.id)).toEqual(["1", "2", "3"]);
    const pass = await call("post", "/messages").send({ text: "1", after: ans.body.messages.at(-1).id });
    expect(pass.body.messages.map((m: any) => m.text).join()).toMatch(/UB-[A-Z0-9]{4}/);
    expect((await call("post", "/messages").send({ text: "  " })).status).toBe(400);
    const all = await call("get", "/messages?after=0");
    expect(all.body.messages[0].from).toBe("me");
    // The day-3 check-in arrives inside the app.
    await sendDueCheckins(db, later(73));
    const after = await call("get", `/messages?after=${all.body.messages.at(-1).id}`);
    expect(after.body.messages.at(-1).text).toContain("Did you visit a clinic");
    expect(after.body.messages.at(-1).options.map((o: any) => o.title)).toEqual(["Yes", "Not yet"]);
  });

  it("accepts a recorded voice note", async () => {
    const { call } = await session();
    await call("patch", "/me").send({ language: "en" });
    const res = await call("post", "/voice").set("content-type", "audio/webm").send(Buffer.from("fake audio"));
    expect(res.status).toBe(200);
    // No speech model in tests: she is asked to try again or type.
    expect(res.body.messages.at(-1).text).toMatch(/couldn't hear that voice note/);
    expect((await call("post", "/voice").set("content-type", "audio/webm").send(Buffer.alloc(3 * 1024 * 1024))).status).toBe(413);
  });

  it("finds care by service and issues a pass", async () => {
    const { call } = await session();
    await call("patch", "/me").send({ language: "en" });
    const list = await call("get", "/clinics?services=safety");
    expect(list.body.clinics.map((c: any) => c.name)).toEqual(["[Health post B]"]);
    expect(list.body.services).toContain("pregnancy_test");
    expect((await call("post", "/passes").send({ services: ["made_up"] })).status).toBe(400);
    const p = await call("post", "/passes").send({ services: ["family_planning"] });
    expect(p.status).toBe(201);
    expect(p.body.code).toMatch(/^UB-/);
    const passes = await call("get", "/passes");
    expect(passes.body.passes[0]).toMatchObject({ code: p.body.code, valid: true, redeemed: false, services: ["family_planning"] });
  });

  it("shows clinic ratings to girls only once a clinic has 5 or more", async () => {
    await seedRatings(2, ["yes", "yes", "no", "yes"]);
    expect((await clinicRatings(db)).get(2)).toBeUndefined(); // 4 answers: hidden
    await seedRatings(2, ["partly"]);
    expect((await clinicRatings(db)).get(2)).toEqual({ respectful: 3, total: 5 });
    const { call } = await session();
    await call("patch", "/me").send({ language: "en" });
    const list = await call("get", "/clinics?services=safety");
    expect(list.body.clinics[0].rating).toEqual({ respectful: 3, total: 5 });
    expect((await call("get", "/clinics?services=family_planning")).body.clinics.find((c: any) => c.id === 1).rating).toBeNull();
    // The pass message mentions the rating, on every channel.
    await call("post", "/passes").send({ services: ["safety"] });
    const msgs = await call("get", "/messages?after=0");
    expect(msgs.body.messages.map((m: any) => m.text).join("\n")).toContain("3 of 5 girls who went there said they were treated with respect.");
  });

  it("serves published lessons, with audio only for recordings attached to served content", async () => {
    await db.query(`INSERT INTO media (mime, bytes, size, sha256) VALUES ('audio/ogg', '\\x4f6767', 3, 'a'), ('audio/ogg', '\\x4f6767', 3, 'b')`);
    const [m1, m2] = await db.query(`SELECT id FROM media ORDER BY id DESC LIMIT 2`);
    await db.query(`UPDATE content_versions SET audio_media_id = $1 WHERE topic_id = 'feelings' AND language = 'en'`, [m2.id]);
    await refreshCaches(db, { force: true });
    const learn = await request(app).get("/app/api/learn?lang=en");
    const feelings = learn.body.lessons.find((l: any) => l.id === "feelings");
    expect(feelings.audio).toBe(`/app/api/audio/${m2.id}`);
    expect((await request(app).get(feelings.audio)).headers["content-type"]).toBe("audio/ogg");
    expect((await request(app).get(`/app/api/audio/${m1.id}`)).status).toBe(404); // not attached to served content
    const so = await request(app).get("/app/api/learn?lang=so");
    expect(so.body.lessons.find((l: any) => l.id === "feelings")).toMatchObject({ translated: false, audio: null });
  });

  it("wipes her history completely", async () => {
    const { call } = await session();
    await call("patch", "/me").send({ language: "en" });
    await call("post", "/messages").send({ text: "how do i use a pad" });
    expect((await call("delete", "/me")).status).toBe(204);
    expect((await call("get", "/me")).status).toBe(401);
    expect((await db.query(`SELECT 1 FROM messages WHERE body = 'how do i use a pad'`)).length).toBe(0);
  });

  it("never caches personal responses", async () => {
    const { call } = await session();
    expect((await call("get", "/passes")).headers["cache-control"]).toBe("no-store");
  });
});
