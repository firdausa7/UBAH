import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { freshDb, girl, lastSmsCode, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { handleIncoming } from "../src/engine.js";
import { config } from "../src/config.js";
import { hashPhone } from "../src/privacy.js";
import { search } from "../src/content/content.js";
import { useTranslationProvider, type TranslationProvider } from "../src/providers/translation.js";
import type { Db } from "../src/db.js";

// A pretend Google: a few known sentences, everything else marked, and every call recorded.
const TO_EN: Record<string, string> = {
  "Caadadaydu way soo daahday": "My period is late",
  "Waxaan rabaa inaan naftayda ka takhaluso": "I want to kill myself",
  "Hedhi yangu imechelewa": "My period is late",
  "Nina maswali kuhusu uzazi wa mpango": "I have a question about family planning",
};
const calls: Array<{ text: string; to: string; from: string | null }> = [];
let failNext = false;
const dictionary: TranslationProvider = {
  name: "google",
  async translate(text, to, from) {
    calls.push({ text, to, from });
    if (failNext) {
      failNext = false;
      return { ok: false, text, detected: null, provider: "google" };
    }
    if (to === "en") return { ok: true, text: TO_EN[text] ?? `EN(${text})`, detected: from, provider: "google" };
    return { ok: true, text: `${to.toUpperCase()}(${text})`, detected: "en", provider: "google" };
  },
};

let db: Db;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;
const H = { "x-ubah": "1" };

beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
  useTranslationProvider(dictionary);
});
afterAll(() => useTranslationProvider(null));
afterEach(() => vi.unstubAllGlobals());

const ageCodes = () => db.query(`UPDATE girl_otp SET created_at = created_at - interval '2 minutes'`).then(() => db.query(`UPDATE staff_otp SET created_at = created_at - interval '2 minutes'`));
const agents = new Map<string, Agent>();
async function staff(login: string): Promise<Agent> {
  await ageCodes();
  if (!agents.has(login)) agents.set(login, (await staffClient(app, db, login)).agent);
  return agents.get(login)!;
}
const staffId = async (login: string) => (await db.query(`SELECT id FROM staff WHERE login = $1`, [login]))[0].id as number;

async function webGirl(phone: string, language: string, share: { messages?: boolean; voice?: boolean } = { messages: true }) {
  const a = request.agent(app);
  await a.post("/api/auth/girl/code").set(H).send({ phone });
  expect((await a.post("/api/auth/girl/verify").set(H).send({ phone, code: lastSmsCode(phone.replace(/^0/, "254")), pin: "2580", language })).status).toBe(200);
  await a.put("/api/me/consents").set(H).send(share);
  const [u] = await db.query(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
  return { a, user: u };
}

async function assign(girlId: number, worker: string) {
  const admin = await staff("admin");
  expect((await admin.put(`/api/admin/girls/${girlId}/assignment`).set(H).send({ workerId: await staffId(worker) })).status).toBe(200);
}

describe("girl → worker → girl", () => {
  it("a Somali voice note reaches her worker in English, and the English reply reaches her in Somali", async () => {
    const { a: her, user } = await webGirl("0712600001", "so", { messages: true, voice: true });
    await assign(user.id, "nurse");
    await handleIncoming(db, {
      channel: "web",
      from: "",
      userId: user.id,
      voice: { audio: Buffer.from("OggS voice"), mimeType: "audio/ogg", mockText: "Caadadaydu way soo daahday", mockLanguage: "so", mockConfidence: 0.9 },
    });

    const nurse = await staff("nurse");
    const inbox = (await nurse.get("/api/worker/inbox")).body.messages;
    const m = inbox.find((x: any) => x.girl.id === user.id);
    expect(m).toMatchObject({
      kind: "voice",
      text: "Caadadaydu way soo daahday",
      english: "My period is late",
      englishSource: "machine", // "machine translated, check meaning"
      detectedLanguage: "so",
      chosenLanguage: "so",
      languageMismatch: false,
      urgent: false,
      status: "new",
      channel: "web",
    });
    expect(m.audioUrl).toMatch(/^\/api\/audio\/\d+\?exp=\d+&sig=/);
    expect(calls.find((c) => c.text === "Caadadaydu way soo daahday")).toEqual({ text: "Caadadaydu way soo daahday", to: "en", from: "so" });

    const view = await nurse.get(`/api/worker/messages/${m.id}`);
    expect(view.body.message.status).toBe("open");
    expect(view.body.girl.languageLabel).toBe("Soomaali");

    const sent = await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "Please visit the clinic this week." });
    expect(sent.body).toMatchObject({ source: "machine", translated: "SO(Please visit the clinic this week.)" });

    const conv = (await her.get("/api/me/messages")).body.messages;
    expect(conv.at(-1)).toMatchObject({ from: "worker", text: "SO(Please visit the clinic this week.)", english: "Please visit the clinic this week." });
    const [r] = await db.query(`SELECT translation_source, english_text FROM replies WHERE message_id = $1`, [m.id]);
    expect(r).toEqual({ translation_source: "machine", english_text: "Please visit the clinic this week." });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'message.reply' AND target_id = $1`, [String(m.id)])).length).toBe(1);
  });

  it("uses a reviewed answer template instead of machine translation when the English matches", async () => {
    const { user } = await webGirl("0712600002", "so");
    await assign(user.id, "nurse");
    const admin = await staff("admin");
    const t1 = await admin.post("/api/admin/templates").set(H).send({ language: "so", english: "Please go to the clinic today." });
    const t2 = await admin.post("/api/admin/templates").set(H).send({ language: "so", english: "Drink clean water." });
    expect(t1.status).toBe(201);
    await db.query(`UPDATE answer_templates SET translated_text = 'Fadlan maanta aad rugta caafimaadka.', reviewed_by = 'Amina (translator)', reviewed_at = now() WHERE id = $1`, [t1.body.id]);
    await db.query(`UPDATE answer_templates SET translated_text = 'Cab biyo nadiif ah.' WHERE id = $1`, [t2.body.id]); // not reviewed: never used

    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Caadadaydu way soo daahday" });
    const nurse = await staff("nurse");
    const m = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === user.id);
    const view = (await nurse.get(`/api/worker/messages/${m.id}`)).body;
    expect(view.templates).toEqual([{ id: t1.body.id, english: "Please go to the clinic today.", translated: "Fadlan maanta aad rugta caafimaadka." }]);

    const viaTemplate = await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "please go to the  clinic today" });
    expect(viaTemplate.body).toMatchObject({ source: "template", translated: "Fadlan maanta aad rugta caafimaadka." });
    const unreviewed = await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "Drink clean water." });
    expect(unreviewed.body.source).toBe("machine");
  });

  it("replies over WhatsApp to a girl who wrote on WhatsApp (asking for a person shares her messages)", async () => {
    const g = girl(db, "0712600003", "whatsapp");
    await g.send("hi");
    await g.send("2"); // Kiswahili
    const [u] = await db.query(`SELECT id FROM users WHERE phone_hash = $1`, [hashPhone("0712600003")]);
    await assign(u.id, "dada");
    const dada = await staff("dada");
    await g.send("Nina maswali kuhusu uzazi wa mpango");
    // Nothing shared yet: a non-urgent message stays private.
    expect((await dada.get("/api/worker/inbox")).body.messages.filter((x: any) => x.girl.id === u.id)).toEqual([]);
    await g.send("DADA");
    await g.send("Hedhi yangu imechelewa");
    const msgs = (await dada.get("/api/worker/inbox")).body.messages.filter((x: any) => x.girl.id === u.id);
    expect(msgs.map((x: any) => x.english)).toEqual(["My period is late", "I have a question about family planning"]);
    expect(msgs.every((x: any) => x.channel === "whatsapp")).toBe(true);
    await g.replies();
    await dada.post(`/api/worker/messages/${msgs[0].id}/reply`).set(H).send({ english: "That can be normal. Can you tell me more?" });
    expect(await g.replies()).toEqual(["SW(That can be normal. Can you tell me more?)"]);
    const [o] = await db.query(`SELECT channel FROM outbox WHERE to_hash = $1 ORDER BY id DESC LIMIT 1`, [hashPhone("0712600003")]);
    expect(o.channel).toBe("whatsapp");
  });

  it("sends nothing when the reply can't be translated, and tells the worker", async () => {
    const { a: her, user } = await webGirl("0712600004", "so");
    await assign(user.id, "nurse");
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Caadadaydu way soo daahday" });
    const nurse = await staff("nurse");
    const m = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === user.id);
    const before = (await her.get("/api/me/messages")).body.messages.length;
    failNext = true;
    const res = await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "Please come to the clinic." });
    expect([res.status, res.body]).toEqual([502, { error: "translation_failed" }]);
    expect((await her.get("/api/me/messages")).body.messages.length).toBe(before);
  });

  it("keeps a message whose translation failed, with the original and a warning", async () => {
    const { user } = await webGirl("0712600005", "sw");
    await assign(user.id, "nurse");
    failNext = true;
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Nina maswali kuhusu uzazi wa mpango" });
    const m = (await (await staff("nurse")).get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === user.id);
    expect(m).toMatchObject({ text: "Nina maswali kuhusu uzazi wa mpango", english: null, translationFailed: true });
  });
});

describe("danger words in the original or the English", () => {
  it("makes a message urgent when only its English translation matches, puts it first, and helps her at once", async () => {
    config.nurseAlertNumbers = ["+254700000888"];
    const { a: her, user } = await webGirl("0712600010", "so", { messages: false }); // shares nothing
    await assign(user.id, "dada");
    await db.query(`UPDATE staff SET phone = '+254700000555' WHERE login = 'dada'`);
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Waxaan rabaa inaan naftayda ka takhaluso" });

    // She gets help immediately, without waiting for a person.
    const conv = (await her.get("/api/me/messages")).body.messages;
    expect(conv.at(-1)).toMatchObject({ from: "ubah" });
    expect(conv.at(-1).text).toMatch(/not alone|Dada is being told/i);

    // Her worker sees it even though she shares nothing else, at the top, with the reason.
    const inbox = (await (await staff("dada")).get("/api/worker/inbox")).body.messages;
    expect(inbox[0]).toMatchObject({ urgent: true, english: "I want to kill myself", girl: { id: user.id } });
    expect(inbox[0].urgentReason).toMatch(/English translation/);

    // Her worker AND the nurses are alerted; the case is hers.
    const [c] = await db.query(`SELECT reason, urgent, assigned_to FROM cases WHERE user_id = $1`, [user.id]);
    expect(c).toEqual({ reason: "danger_selfharm", urgent: true, assigned_to: await staffId("dada") });
    const alerts = await db.query(`SELECT to_hash FROM outbox WHERE kind = 'staff_alert' AND body LIKE '%' || $1 || '%'`, [user.anon_id]);
    expect(alerts.map((x: any) => x.to_hash).sort()).toEqual([hashPhone("+254700000555"), hashPhone("+254700000888")].sort());
    config.nurseAlertNumbers = [];
  });

  it("still catches a danger word in the original language", async () => {
    const { user } = await webGirl("0712600011", "sw", { messages: false });
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Nataka kujiua" });
    const [m] = await db.query(`SELECT urgent, urgent_reason FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [user.id]);
    expect(m.urgent).toBe(true);
    expect(m.urgent_reason).toBe("list:sw:*jiua");
  });
});

describe("the girl's own messages API", () => {
  it("sends text through the same pipeline and shows the conversation", async () => {
    const { a, user } = await webGirl("0712600020", "en");
    const res = await a.post("/api/me/messages").set(H).send({ text: "Can I talk to a person please" });
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: any) => m.from)).toEqual(["me", "ubah"]);
    const [m] = await db.query(`SELECT channel, english_text, english_source FROM messages WHERE user_id = $1 AND direction = 'in'`, [user.id]);
    expect(m).toEqual({ channel: "web", english_text: "Can I talk to a person please", english_source: "none" });
    expect((await a.post("/api/me/messages").set(H).send({ text: " " })).status).toBe(400);
  });

  it("accepts a voice note; with no words heard she is asked to try again", async () => {
    const { a } = await webGirl("0712600021", "so");
    const res = await a.post("/api/me/voice").set(H).set("content-type", "audio/webm").send(Buffer.from("fake audio"));
    expect(res.body.messages.at(-1).text).toMatch(/couldn't hear that voice note/);
  });
});

describe("voice notes are kept only with consent, and go when resolved", () => {
  it("keeps nothing without consent; with consent, deletes the recording on resolve", async () => {
    const { user: noVoice } = await webGirl("0712600030", "so", { messages: true, voice: false });
    await handleIncoming(db, { channel: "web", from: "", userId: noVoice.id, voice: { audio: Buffer.from("a"), mimeType: "audio/ogg", mockText: "Caadadaydu way soo daahday" } });
    expect((await db.query(`SELECT 1 FROM voice_notes WHERE user_id = $1`, [noVoice.id])).length).toBe(0);

    const { user } = await webGirl("0712600031", "so", { messages: true, voice: true });
    await assign(user.id, "nurse");
    // Unclear audio is kept too: that is when the worker needs to listen.
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, voice: { audio: Buffer.from("b"), mimeType: "audio/ogg", mockText: "", mockConfidence: 0 } });
    const [m] = await db.query(`SELECT id, audio_ref, voice_unclear FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [user.id]);
    expect(m.voice_unclear).toBe(true);
    expect(m.audio_ref).toBeTruthy();
    const nurse = await staff("nurse");
    const inboxItem = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.id === m.id);
    expect(inboxItem).toMatchObject({ audioUnclear: true });
    expect(inboxItem.audioUrl).toBeTruthy();
    expect((await nurse.post(`/api/worker/messages/${m.id}/resolve`).set(H)).body).toEqual({ status: "resolved" });
    expect((await db.query(`SELECT 1 FROM voice_notes WHERE id = $1`, [m.audio_ref])).length).toBe(0);
  });
});

describe("the worker inbox", () => {
  it("filters by language, channel and status, hides menu numbers, and refuses other workers' girls", async () => {
    const { user } = await webGirl("0712600040", "sw");
    await assign(user.id, "nurse");
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Hedhi yangu imechelewa" });
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "3" });
    const nurse = await staff("nurse");
    const sw = (await nurse.get("/api/worker/inbox?language=sw&channel=web&status=new")).body.messages.filter((x: any) => x.girl.id === user.id);
    expect(sw.map((x: any) => x.text)).toEqual(["Hedhi yangu imechelewa"]);
    expect((await nurse.get("/api/worker/inbox?language=so")).body.messages.some((x: any) => x.girl.id === user.id)).toBe(false);
    const dada = await staff("dada");
    expect((await dada.get(`/api/worker/messages/${sw[0].id}`)).status).toBe(404);
    expect((await dada.post(`/api/worker/messages/${sw[0].id}/reply`).set(H).send({ english: "Hi" })).status).toBe(404);
  });
});

describe("answers for a girl writing in Somali", () => {
  it("finds the right approved answer through the English translation, never by reading Somali as English", async () => {
    const { a, user } = await webGirl("0712600060", "so");
    const res = await a.post("/api/me/messages").set(H).send({ text: "Caadadaydu way soo daahday" });
    const answer = res.body.messages.filter((m: any) => m.from === "ubah").map((m: any) => m.text).join("\n");
    const right = search("My period is late", { lang: "en" })[0].item;
    expect(right.topic).toBe("periods");
    expect(answer).toContain(right.body);
    expect(answer).not.toMatch(/prevent pregnancy/i); // the old mistake: Somali "way" matched "ways to prevent pregnancy"
    void user;
  });

  it("offers a person instead of guessing when the message couldn't be translated", async () => {
    const { a } = await webGirl("0712600061", "so");
    failNext = true;
    const res = await a.post("/api/me/messages").set(H).send({ text: "Caadadaydu way soo daahday" });
    expect(res.body.messages.at(-1).text).toMatch(/I'm not sure about that/);
  });
});

describe("no machine-written health advice", () => {
  it("answers with the approved text word for word, and never asks an AI to rephrase it", async () => {
    const key = config.llm.apiKey;
    config.llm.apiKey = "sk-test";
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const g = girl(db, "0712600050");
      await g.send("hi");
      await g.send("3");
      const answer = await g.send("my period is two weeks late, what should i do");
      const best = search("my period is two weeks late, what should i do", { lang: "en" })[0].item;
      expect(answer).toContain(best.body);
      expect(fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).includes("chat/completions"))).toEqual([]);
    } finally {
      config.llm.apiKey = key;
    }
  });
});
