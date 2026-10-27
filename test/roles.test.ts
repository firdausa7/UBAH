import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, girl, lastSmsCode, staffClient, totpFor } from "./helpers.js";
import { createApp } from "../src/server.js";
import { mockSmsSent } from "../src/channels/sms.js";
import { hashPhone } from "../src/privacy.js";
import { checkAudioSignature, purgeVoiceNotes, saveVoiceNote, signedAudioUrl, AUDIO_LINK_SECONDS } from "../src/voice/store.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});

type Agent = ReturnType<typeof request.agent>;
const H = { "x-ubah": "1" };
const post = (a: Agent, path: string, body: object = {}) => a.post(path).set(H).send(body);

// A girl signs up on the web: SMS code, then her PIN.
async function webGirl(phone: string, pin = "2580", language = "so") {
  const a = request.agent(app);
  expect((await post(a, "/api/auth/girl/code", { phone })).status).toBe(200);
  const res = await post(a, "/api/auth/girl/verify", { phone, code: lastSmsCode(phone.replace(/^0/, "254")), pin, language });
  expect(res.status).toBe(200);
  const [u] = await db.query(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
  return { a, user: u };
}

// Codes can only be re-sent after a minute: tests move the clock on instead of waiting.
const ageCodes = () => db.query(`UPDATE girl_otp SET created_at = created_at - interval '2 minutes'`).then(() => db.query(`UPDATE staff_otp SET created_at = created_at - interval '2 minutes'`));

const staffAgents = new Map<string, Agent>();
async function staff(login: string): Promise<Agent> {
  await ageCodes();
  if (!staffAgents.has(login)) staffAgents.set(login, (await staffClient(app, db, login)).agent);
  return staffAgents.get(login)!;
}
const staffId = async (login: string) => (await db.query(`SELECT id FROM staff WHERE login = $1`, [login]))[0].id as number;

describe("girls sign in with phone, SMS code and PIN", () => {
  it("signs up, and the SMS says nothing about Ubah or health", async () => {
    const { a, user } = await webGirl("0712555001");
    const sms = mockSmsSent.filter((m) => m.to === "254712555001").at(-1)!;
    expect(sms.message).toMatch(/^Your code: \d{6}$/);
    expect(user).toMatchObject({ channel: "web", language: "so" });
    expect(user.pin_hash).toMatch(/^scrypt\$/);
    const s = await a.get("/api/auth/session");
    expect(s.body).toMatchObject({ role: "girl", home: "/me", language: "so" });
    expect((await a.get("/api/me")).body.languages.map((l: any) => l.name)).toEqual(["Soomaali", "Kiswahili", "English", "Afaan Oromoo"]);
  });

  it("refuses an easy PIN and a wrong code", async () => {
    const a = request.agent(app);
    await post(a, "/api/auth/girl/code", { phone: "0712555002" });
    const code = lastSmsCode("254712555002");
    expect((await post(a, "/api/auth/girl/verify", { phone: "0712555002", code, pin: "1111" })).body.error).toBe("pin_too_easy");
    expect((await post(a, "/api/auth/girl/verify", { phone: "0712555002", code: "000000", pin: "2580" })).status).toBe(401);
    expect((await post(a, "/api/auth/girl/verify", { phone: "0712555002", code, pin: "2580" })).status).toBe(200);
  });

  it("signs in with phone + PIN, says the same for an unknown phone, and locks after 5 wrong PINs", async () => {
    await webGirl("0712555003", "3691");
    const a = request.agent(app);
    expect((await post(a, "/api/auth/girl/pin", { phone: "0712555003", pin: "3691" })).body).toMatchObject({ role: "girl", home: "/me" });
    const b = request.agent(app);
    const unknown = await post(b, "/api/auth/girl/pin", { phone: "0712555999", pin: "3691" });
    const wrong = await post(b, "/api/auth/girl/pin", { phone: "0712555003", pin: "0000" });
    expect([unknown.status, unknown.body]).toEqual([wrong.status, wrong.body]);
    for (let i = 0; i < 4; i++) await post(b, "/api/auth/girl/pin", { phone: "0712555003", pin: "0000" });
    expect((await post(b, "/api/auth/girl/pin", { phone: "0712555003", pin: "3691" })).status).toBe(423);
    // A new SMS code unlocks it.
    await ageCodes();
    await post(b, "/api/auth/girl/code", { phone: "0712555003" });
    expect((await post(b, "/api/auth/girl/verify", { phone: "0712555003", code: lastSmsCode("254712555003"), pin: "3692" })).status).toBe(200);
  });

  it("is the same girl as on WhatsApp, and her replies keep going to WhatsApp", async () => {
    const g = girl(db, "0712555004", "whatsapp");
    await g.send("hi");
    await g.send("2");
    const [before] = await db.query(`SELECT id, channel, language FROM users WHERE phone_hash = $1`, [hashPhone("0712555004")]);
    const { user } = await webGirl("0712555004", "2580", "sw");
    expect(user).toMatchObject({ id: before.id, channel: "whatsapp", language: "sw" });
  });

  it("lets her choose her language and what she shares", async () => {
    const { a } = await webGirl("0712555005");
    expect((await a.patch("/api/me").set(H).send({ language: "om" })).body).toEqual({ language: "om" });
    expect((await a.patch("/api/me").set(H).send({ language: "fr" })).status).toBe(400);
    expect((await a.put("/api/me/consents").set(H).send({ messages: true })).body.consents).toEqual({ messages: true, voice: false });
    expect((await a.put("/api/me/consents").set(H).send({ voice: "yes" })).status).toBe(400);
  });
});

describe("the PIN lock on a shared phone", () => {
  const lockNow = (userId: number) => db.query(`UPDATE girl_sessions SET unlocked_until = now() - interval '1 minute' WHERE user_id = $1`, [userId]);

  it("locks after a while unused: nothing of hers is sent until her PIN is entered", async () => {
    const { a, user } = await webGirl("0712555040", "2580");
    expect((await a.get("/api/me")).status).toBe(200);
    await lockNow(user.id);
    expect((await a.get("/api/me")).body).toEqual({ error: "pin_needed" });
    expect((await a.get("/api/me/messages")).status).toBe(423);
    const s = (await a.get("/api/auth/session")).body;
    expect(s).toMatchObject({ role: "girl", locked: true });
    expect(s.anonId).toBeUndefined();
    expect((await post(a, "/api/auth/girl/unlock", { pin: "1111" })).status).toBe(401);
    expect((await post(a, "/api/auth/girl/unlock", { pin: "2580" })).body).toEqual({ ok: true });
    expect((await a.get("/api/me")).status).toBe(200);
  });

  it("stays unlocked while she uses it, but the background check for replies doesn't count", async () => {
    const { a, user } = await webGirl("0712555041", "2580");
    const until = async () => new Date((await db.query(`SELECT unlocked_until FROM girl_sessions WHERE user_id = $1`, [user.id]))[0].unlocked_until).getTime();
    await db.query(`UPDATE girl_sessions SET unlocked_until = now() + interval '1 minute' WHERE user_id = $1`, [user.id]);
    await a.get("/api/me/messages").set("x-ubah-poll", "1");
    expect(await until()).toBeLessThan(Date.now() + 2 * 60_000);
    await a.get("/api/me");
    expect(await until()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("ends the session after too many wrong PINs; she signs in again with an SMS code", async () => {
    const { a, user } = await webGirl("0712555042", "2580");
    await lockNow(user.id);
    let last;
    for (let i = 0; i < 5; i++) last = await post(a, "/api/auth/girl/unlock", { pin: "0000" });
    expect([last!.status, last!.body]).toEqual([423, { error: "locked" }]);
    expect((await a.get("/api/me")).status).toBe(401);
  });
});

describe("staff sign in through the same login", () => {
  it("nurse: password, then authenticator code, then /worker", async () => {
    await staff("nurse"); // sets up the authenticator the first time
    const a = request.agent(app);
    expect((await post(a, "/api/auth/staff", { login: "Nurse ", password: "test-pass" })).body).toEqual({ step: "code", method: "totp" });
    expect((await a.get("/api/worker/girls")).status).toBe(401); // not until the second step
    const done = await post(a, "/api/auth/staff/code", { code: await totpFor(db, "nurse") });
    expect(done.body).toEqual({ step: "done", role: "health_worker", home: "/worker" });
    expect((await a.get("/api/worker/girls")).status).toBe(200);
  });

  it("Dada: SMS code; admin goes to /admin", async () => {
    await ageCodes();
    const a = request.agent(app);
    expect((await post(a, "/api/auth/staff", { login: "dada", password: "test-pass" })).body).toEqual({ step: "code", method: "sms" });
    const [d] = await db.query(`SELECT phone FROM staff WHERE login = 'dada'`);
    expect((await post(a, "/api/auth/staff/code", { code: lastSmsCode(String(d.phone).replace(/^\+/, "")) })).body.role).toBe("health_worker");
    await staff("admin");
    const b = request.agent(app);
    await post(b, "/api/auth/staff", { login: "admin", password: "test-pass" });
    expect((await post(b, "/api/auth/staff/code", { code: await totpFor(db, "admin") })).body).toEqual({ step: "done", role: "admin", home: "/admin" });
  });

  it("gives the same answer for an unknown login and a wrong password", async () => {
    const a = request.agent(app);
    const x = await post(a, "/api/auth/staff", { login: "nobody", password: "test-pass" });
    const y = await post(a, "/api/auth/staff", { login: "editor", password: "wrong-password" });
    expect([x.status, x.body]).toEqual([y.status, y.body]);
  });
});

describe("every API area checks the role on the server", () => {
  it("refuses anyone not signed in, and the wrong role", async () => {
    const anon = request.agent(app);
    for (const p of ["/api/me", "/api/worker/girls", "/api/admin/girls"]) expect((await anon.get(p)).status, p).toBe(401);
    const { a: g } = await webGirl("0712555010");
    expect((await g.get("/api/worker/girls")).status).toBe(403);
    expect((await g.get("/api/admin/girls")).status).toBe(403);
    const nurse = await staff("nurse");
    expect((await nurse.get("/api/me")).status).toBe(403);
    expect((await nurse.get("/api/admin/girls")).status).toBe(403);
    const admin = await staff("admin");
    expect((await admin.get("/api/worker/girls")).status).toBe(403);
    expect((await admin.get("/api/me")).status).toBe(403);
    // Back-office roles work in /staff, not here.
    expect((await (await staff("editor")).get("/api/worker/girls")).status).toBe(403);
  });

  it("refuses a change without the X-Ubah header (another site can't send it)", async () => {
    const { a } = await webGirl("0712555011");
    expect((await a.patch("/api/me").send({ language: "en" })).body).toEqual({ error: "csrf" });
  });

  it("answers unknown API paths with JSON, never a page", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});

describe("assignments, consent and the access log", () => {
  it("shows a worker only their girls, only what she shares (urgent always), and logs each look", async () => {
    const { a: girlAgent, user } = await webGirl("0712555020");
    await db.query(`INSERT INTO messages (user_id, direction, channel, body, urgent) VALUES ($1,'in','web','a private question',FALSE), ($1,'in','web','dhiig badan',TRUE)`, [user.id]);
    const admin = await staff("admin");
    const nurse = await staff("nurse");
    const dada = await staff("dada");
    const nurseId = await staffId("nurse");

    expect((await admin.put(`/api/admin/girls/${user.id}/assignment`).set(H).send({ workerId: nurseId })).status).toBe(200);
    expect((await admin.put(`/api/admin/girls/${user.id}/assignment`).set(H).send({ workerId: await staffId("editor") })).status).toBe(400);
    const listed = (await admin.get("/api/admin/girls")).body.girls.find((g: any) => g.id === user.id);
    expect(listed.worker).toEqual({ id: nurseId, name: expect.any(String) });
    expect(JSON.stringify(listed)).not.toMatch(/phone|private question/);

    expect((await nurse.get("/api/worker/girls")).body.girls.map((g: any) => g.id)).toContain(user.id);
    expect((await dada.get("/api/worker/girls")).body.girls.map((g: any) => g.id)).not.toContain(user.id);
    expect((await dada.get(`/api/worker/girls/${user.id}/messages`)).status).toBe(404);

    // No consent yet: only the urgent message.
    let msgs = (await nurse.get(`/api/worker/girls/${user.id}/messages`)).body.messages;
    expect(msgs.map((m: any) => m.text)).toEqual(["dhiig badan"]);
    await girlAgent.put("/api/me/consents").set(H).send({ messages: true });
    msgs = (await nurse.get(`/api/worker/girls/${user.id}/messages`)).body.messages;
    expect(msgs.map((m: any) => m.text)).toEqual(["a private question", "dhiig badan"]);

    const log = await db.query(`SELECT staff_login, what FROM access_log WHERE girl_id = $1 ORDER BY id`, [user.id]);
    expect(log).toEqual(
      expect.arrayContaining([
        { staff_login: "admin", what: "profile" },
        { staff_login: "nurse", what: "profile" },
        { staff_login: "nurse", what: "messages" },
      ]),
    );
    expect(log.filter((l: any) => l.staff_login === "dada")).toEqual([]); // refused, so nothing seen
    const [audit] = await db.query(`SELECT action FROM audit_log WHERE action = 'girl.assign' AND target_id = $1`, [String(user.id)]);
    expect(audit).toBeTruthy();

    // Unassigned: gone from the worker's view.
    await admin.delete(`/api/admin/girls/${user.id}/assignment`).set(H);
    expect((await nurse.get(`/api/worker/girls/${user.id}/messages`)).status).toBe(404);
  });

  it("keeps the access log append-only", async () => {
    await db.query(`INSERT INTO access_log (girl_id, what) VALUES (1, 'profile')`);
    await expect(db.query(`UPDATE access_log SET what = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM access_log`)).rejects.toThrow(/append-only/);
  });
});

describe("voice notes: private, short-lived links", () => {
  it("plays only for her worker, only with her consent, only within 5 minutes", async () => {
    const { a: girlAgent, user } = await webGirl("0712555030");
    const audio = Buffer.from("OggS fake voice note");
    const noteId = await saveVoiceNote(db, user.id, "audio/ogg", audio);
    const [stored] = await db.query(`SELECT bytes_enc FROM voice_notes WHERE id = $1`, [noteId]);
    expect(Buffer.from(stored.bytes_enc).includes(audio)).toBe(false); // encrypted at rest
    await db.query(`INSERT INTO messages (user_id, direction, channel, kind, body, audio_ref) VALUES ($1,'in','web','voice','hello',$2)`, [user.id, noteId]);
    const admin = await staff("admin");
    const nurse = await staff("nurse");
    await admin.put(`/api/admin/girls/${user.id}/assignment`).set(H).send({ workerId: await staffId("nurse") });
    await girlAgent.put("/api/me/consents").set(H).send({ messages: true });

    // Messages shared, voice not: no link, and a made-up link doesn't play.
    let [m] = (await nurse.get(`/api/worker/girls/${user.id}/messages`)).body.messages;
    expect(m.audioUrl).toBeNull();
    expect((await nurse.get(signedAudioUrl(noteId, await staffId("nurse")))).status).toBe(404);

    await girlAgent.put("/api/me/consents").set(H).send({ voice: true });
    [m] = (await nurse.get(`/api/worker/girls/${user.id}/messages`)).body.messages;
    const played = await nurse.get(m.audioUrl).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(played.status).toBe(200);
    expect(played.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(played.body).equals(audio)).toBe(true);
    expect((await db.query(`SELECT 1 FROM access_log WHERE girl_id = $1 AND what = 'voice'`, [user.id])).length).toBe(1);

    // Another worker can't use the link; a changed link doesn't work.
    expect((await (await staff("dada")).get(m.audioUrl)).status).toBe(403);
    // Tamper with the signature: always a different first character.
    const tampered = m.audioUrl.replace(/sig=(.)/, (_: string, c: string) => `sig=${c === "A" ? "B" : "A"}`);
    expect(tampered).not.toBe(m.audioUrl);
    expect((await nurse.get(tampered)).status).toBe(403);
    const exp = Number(new URL(m.audioUrl, "http://x").searchParams.get("exp"));
    const sig = new URL(m.audioUrl, "http://x").searchParams.get("sig");
    expect(checkAudioSignature(noteId, await staffId("nurse"), exp, sig, (exp + 1) * 1000)).toBe(false);
    expect(checkAudioSignature(noteId, await staffId("nurse"), exp, sig, (exp - AUDIO_LINK_SECONDS) * 1000)).toBe(true);

    // Resolved: the recording is deleted.
    await db.query(`UPDATE messages SET status = 'resolved' WHERE audio_ref = $1`, [noteId]);
    expect(await purgeVoiceNotes(db)).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT 1 FROM voice_notes WHERE id = $1`, [noteId])).length).toBe(0);
  });
});

describe("the access log records looks, not screen refreshes", () => {
  it("logs one line per girl when the inbox refreshes, and a new line for a new look later", async () => {
    const { user } = await webGirl("0712555050");
    const admin = await staff("admin");
    await admin.put(`/api/admin/girls/${user.id}/assignment`).set(H).send({ workerId: await staffId("nurse") });
    const nurse = await staff("nurse");
    const lines = async () => (await db.query(`SELECT count(*)::int AS n FROM access_log WHERE girl_id = $1 AND staff_login = 'nurse' AND what = 'profile'`, [user.id]))[0].n;
    for (let i = 0; i < 5; i++) await nurse.get("/api/worker/girls");
    expect(await lines()).toBe(1);
  });

  it("still logs each different thing looked at: her messages, and each message opened", async () => {
    const { a: girlAgent, user } = await webGirl("0712555051");
    await girlAgent.put("/api/me/consents").set(H).send({ messages: true });
    const ids = [];
    for (const body of ["first question", "second question"]) {
      const [m] = await db.query(`INSERT INTO messages (user_id, direction, channel, body) VALUES ($1,'in','web',$2) RETURNING id`, [user.id, body]);
      ids.push(m.id);
    }
    const admin = await staff("admin");
    await admin.put(`/api/admin/girls/${user.id}/assignment`).set(H).send({ workerId: await staffId("nurse") });
    const nurse = await staff("nurse");
    await nurse.get(`/api/worker/girls/${user.id}/messages`);
    await nurse.get(`/api/worker/girls/${user.id}/messages`);
    for (const id of ids) await nurse.get(`/api/worker/messages/${id}`);
    await nurse.get(`/api/worker/messages/${ids[0]}`);
    const log = await db.query(`SELECT what, target_id FROM access_log WHERE girl_id = $1 AND staff_login = 'nurse' AND what IN ('messages','message') ORDER BY id`, [user.id]);
    expect(log).toEqual([
      { what: "messages", target_id: null },
      { what: "message", target_id: String(ids[0]) },
      { what: "message", target_id: String(ids[1]) },
    ]);
  });
});
