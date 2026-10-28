import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { freshDb, lastSmsCode, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { hashPhone } from "../src/privacy.js";
import { useTranslationProvider, type TranslationProvider } from "../src/providers/translation.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
const H = { "x-ubah": "1" };
// Counts every call to the translation service: her journal must never reach it.
let translations = 0;
const counting: TranslationProvider = { name: "google", translate: async (text, to, from) => (translations++, { ok: true, text, detected: from, provider: "google" }) };

beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
  useTranslationProvider(counting);
});
afterAll(() => useTranslationProvider(null));

async function webGirl(phone: string) {
  const a = request.agent(app);
  await a.post("/api/auth/girl/code").set(H).send({ phone });
  await a.post("/api/auth/girl/verify").set(H).send({ phone, code: lastSmsCode(phone.replace(/^0/, "254")), pin: "2580", language: "en" });
  const [u] = await db.query(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
  return { a, user: u };
}

describe("my wellbeing: private to her", () => {
  it("keeps her notes encrypted, readable only by her, never by another girl or any staff member", async () => {
    const { a, user } = await webGirl("0712970001");
    const r = await a.post("/api/me/wellbeing").set(H).send({ mood: 4, note: "Exams are hard but my sister helps me" });
    expect(r.status).toBe(201);
    expect(r.body.support).toBeNull();
    const [row] = await db.query(`SELECT note_enc FROM wellbeing_entries WHERE user_id = $1`, [user.id]);
    expect(row.note_enc).not.toContain("sister"); // encrypted at rest
    expect((await a.get("/api/me/wellbeing")).body.entries[0]).toMatchObject({ mood: 4, note: "Exams are hard but my sister helps me" });

    const { a: other } = await webGirl("0712970002");
    expect((await other.get("/api/me/wellbeing")).body.entries).toEqual([]);
    expect((await other.delete(`/api/me/wellbeing/${(await a.get("/api/me/wellbeing")).body.entries[0].id}`).set(H)).status).toBe(404);
    const nurse = await staffClient(app, db, "nurse");
    expect((await nurse.agent.get("/api/me/wellbeing")).status).toBe(403);
  });

  it("offers HER a person when what she writes sounds serious: tells no staff, sends nothing out", async () => {
    const { a, user } = await webGirl("0712970003");
    translations = 0;
    const r = await a.post("/api/me/wellbeing").set(H).send({ mood: 1, note: "I want to die, nobody would notice" });
    expect(r.body.support).toBe("urgent");
    expect(translations).toBe(0); // her journal never goes to the translation service
    expect((await db.query(`SELECT 1 FROM cases WHERE user_id = $1`, [user.id])).length).toBe(0); // no automatic escalation
    expect((await db.query(`SELECT 1 FROM messages WHERE user_id = $1 AND direction = 'in'`, [user.id])).length).toBe(0);
  });

  it("offers a person after a very low mood, or three low ones in a row", async () => {
    const { a } = await webGirl("0712970004");
    expect((await a.post("/api/me/wellbeing").set(H).send({ mood: 1 })).body.support).toBe("low");
    const { a: b } = await webGirl("0712970005");
    expect((await b.post("/api/me/wellbeing").set(H).send({ mood: 2 })).body.support).toBeNull();
    expect((await b.post("/api/me/wellbeing").set(H).send({ mood: 2 })).body.support).toBeNull();
    expect((await b.post("/api/me/wellbeing").set(H).send({ mood: 2 })).body.support).toBe("low");
    expect((await b.post("/api/me/wellbeing").set(H).send({ mood: 9 })).status).toBe(400);
    expect((await b.post("/api/me/wellbeing").set(H).send({})).status).toBe(400);
  });

  it("I need help now: an urgent case at once, at the top of her worker's inbox, and help sent to her", async () => {
    const { a, user } = await webGirl("0712970006");
    const r = await a.post("/api/me/urgent").set(H).send({ kind: "selfharm" });
    expect(r.status).toBe(200);
    expect(r.body.messages.at(-1).text).toMatch(/not alone/i);
    const [c] = await db.query(`SELECT reason, urgent, level FROM cases WHERE user_id = $1`, [user.id]);
    expect(c).toEqual({ reason: "danger_selfharm", urgent: true, level: "nurse" });
    const [m] = await db.query(`SELECT urgent, channel FROM messages WHERE user_id = $1 AND direction = 'in'`, [user.id]);
    expect(m).toEqual({ urgent: true, channel: "web" });
    const med = await a.post("/api/me/urgent").set(H).send({ kind: "medical" });
    expect(med.body.messages.map((x: any) => x.text).join("\n")).toMatch(/UB-[A-Z0-9]{4}/); // an urgent clinic pass
    expect((await a.post("/api/me/urgent").set(H).send({ kind: "other" })).status).toBe(400);
  });

  it("is in her copy of her data, and goes when she wipes her history", async () => {
    const { a, user } = await webGirl("0712970007");
    await a.post("/api/me/wellbeing").set(H).send({ mood: 3, note: "an ordinary day" });
    const d = (await a.get("/api/me/data")).body;
    expect(d.counts.wellbeingEntries).toBe(1);
    expect(d.wellbeing[0].note).toBe("an ordinary day");
    await a.delete("/api/me").set(H);
    expect((await db.query(`SELECT 1 FROM wellbeing_entries WHERE user_id = $1`, [user.id])).length).toBe(0);
  });
});
