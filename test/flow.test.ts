import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { freshDb, girl, lastSmsCode, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { handleIncoming } from "../src/engine.js";
import { config } from "../src/config.js";
import { languageConfig } from "../src/languages/index.js";
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

    // Not seen until her app shows it; then her worker sees "Seen".
    expect((await nurse.get(`/api/worker/messages/${m.id}`)).body.replies[0]).toMatchObject({ seenAt: null, channel: "web" });
    const conv = (await her.get("/api/me/messages")).body.messages;
    expect(conv.at(-1)).toMatchObject({ from: "worker", text: "SO(Please visit the clinic this week.)", english: "Please visit the clinic this week." });
    expect((await nurse.get(`/api/worker/messages/${m.id}`)).body.replies[0].seenAt).toBeTruthy();
    const [r] = await db.query(`SELECT translation_source, english_text FROM replies WHERE message_id = $1`, [m.id]);
    expect(r).toEqual({ translation_source: "machine", english_text: "Please visit the clinic this week." });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'message.reply' AND target_id = $1`, [String(m.id)])).length).toBe(1);

    // The conversation beside the message: who said what, oldest first, her words with the English.
    const thread = (await nurse.get(`/api/worker/girls/${user.id}/messages`)).body.messages;
    const mine = thread.find((x: any) => x.id === m.id);
    expect(mine).toMatchObject({ sender: "girl", text: "Caadadaydu way soo daahday", english: "My period is late" });
    expect(thread.at(-1)).toMatchObject({ sender: "worker", english: "Please visit the clinic this week." });
    expect(thread.some((x: any) => x.sender === "ubah")).toBe(true);
    const ids = thread.map((x: any) => x.id);
    expect(ids).toEqual(ids.toSorted((p: number, q: number) => p - q));
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

  it("asking for a person twice keeps one case (no two Dadas answering her); danger still opens its own", async () => {
    const g = girl(db, "0712600099");
    await g.send("hi");
    await g.send("3"); // English
    const [u] = await db.query(`SELECT id FROM users WHERE phone_hash = $1`, [hashPhone("0712600099")]);
    const cases = () => db.query<{ id: number; reason: string; urgent: boolean; status: string }>(`SELECT id, reason, urgent, status FROM cases WHERE user_id = $1 ORDER BY id`, [u.id]);
    await g.send("DADA");
    await g.send("DADA");
    const one = await cases();
    expect(one.map((c) => c.reason)).toEqual(["asked_for_person"]);
    const events = await db.query<{ kind: string }>(`SELECT kind FROM case_events WHERE case_id = $1 ORDER BY id`, [one[0].id]);
    expect(events.map((e) => e.kind)).toEqual(["opened", "asked_again"]);
    // A danger sign is never folded into an open case: it gets its own, urgent, with the alerts.
    await g.send("I am bleeding a lot and feel dizzy");
    expect((await cases()).filter((c) => c.urgent)).toHaveLength(1);
    // Once handled, asking again opens a new case.
    await db.query(`UPDATE cases SET status = 'handled' WHERE user_id = $1`, [u.id]);
    await g.send("DADA");
    expect((await cases()).filter((c) => c.status === "open").map((c) => c.reason)).toEqual(["asked_for_person"]);
  });

  it("a girl with no worker who asks for a person waits in /worker until a Dada takes her", async () => {
    const { a: her, user } = await webGirl("0712600091", "en");
    const dada = await staff("dada");
    const nurse = await staff("nurse");
    await her.post("/api/me/messages").set(H).send({ text: "DADA" });
    // A second open case (from before cases were merged): she is still listed once, her first case.
    await db.query(`INSERT INTO cases (user_id, reason, urgent, summary, level) VALUES ($1, 'voice_unclear', FALSE, 'later', 'dada')`, [user.id]);
    const waiting = (await dada.get("/api/worker/waiting")).body.waiting.filter((w: any) => w.girl.id === user.id);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ reason: "Asked for a person", urgent: false, summary: "DADA", girl: { anonId: user.anon_id } });
    // Not hers yet: nothing of the girl in the Dada's inbox.
    expect((await dada.get("/api/worker/inbox")).body.messages.filter((m: any) => m.girl.id === user.id)).toEqual([]);

    const take = await dada.post(`/api/worker/waiting/${waiting[0].caseId}/take`).set(H);
    expect(take.status).toBe(200);
    expect((await nurse.post(`/api/worker/waiting/${waiting[0].caseId}/take`).set(H)).body).toEqual({ error: "taken" });
    const [a] = await db.query(`SELECT health_worker_id FROM assignments WHERE girl_id = $1 AND ended_at IS NULL`, [user.id]);
    expect(a.health_worker_id).toBe(await staffId("dada"));
    const [c] = await db.query(`SELECT assigned_to FROM cases WHERE id = $1`, [waiting[0].caseId]);
    expect(c.assigned_to).toBe(await staffId("dada"));
    expect((await dada.get("/api/worker/waiting")).body.waiting.some((w: any) => w.girl.id === user.id)).toBe(false);
    // From now on her messages come to this Dada.
    await her.post("/api/me/messages").set(H).send({ text: "Can I talk about my mother?" });
    expect((await dada.get("/api/worker/inbox")).body.messages.some((m: any) => m.girl.id === user.id)).toBe(true);
    const [log] = await db.query(`SELECT action FROM audit_log WHERE action = 'girl.take' AND target_id = $1`, [String(user.id)]);
    expect(log).toBeTruthy();
  });

  it("the waiting list follows who may see what: nurse-level cases for nurses, her words only if she shares", async () => {
    const { a: urgentGirl, user: u1 } = await webGirl("0712600092", "en");
    await urgentGirl.post("/api/me/messages").set(H).send({ text: "I want to kill myself" });
    const dada = await staff("dada");
    const nurse = await staff("nurse");
    expect((await dada.get("/api/worker/waiting")).body.waiting.some((w: any) => w.girl.id === u1.id)).toBe(false);
    const forNurse = (await nurse.get("/api/worker/waiting")).body.waiting.find((w: any) => w.girl.id === u1.id);
    expect(forNurse).toMatchObject({ urgent: true });
    expect((await dada.post(`/api/worker/waiting/${forNurse.caseId}/take`).set(H)).status).toBe(404);

    const { a: privateGirl, user: u2 } = await webGirl("0712600093", "en", { messages: false });
    await privateGirl.post("/api/me/messages").set(H).send({ text: "DADA" });
    const w2 = (await dada.get("/api/worker/waiting")).body.waiting.find((w: any) => w.girl.id === u2.id);
    expect(w2).toMatchObject({ reason: "Asked for a person", summary: null });
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

  it("turns Ubah's numbered menus into buttons, but never a worker's words", async () => {
    const { a, user } = await webGirl("0712600022", "en");
    const res = await a.post("/api/me/messages").set(H).send({ text: "my period is two weeks late, what should i do" });
    const menu = res.body.messages.at(-1);
    expect(menu).toMatchObject({ from: "ubah", text: "", options: [{ id: "1", title: "Find a clinic" }, { id: "2", title: "Talk to a Dada" }, { id: "3", title: "Ask another question" }] });
    // Tapping a button sends its number, like typing it.
    const tapped = await a.post("/api/me/messages").set(H).send({ text: "3" });
    expect(tapped.body.messages.at(-1).text).toMatch(/Ask me anything/);
    await assign(user.id, "nurse");
    const nurse = await staff("nurse");
    const m = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === user.id);
    await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "Two options:\n1 Rest\n2 Visit the clinic" });
    const reply = (await a.get("/api/me/messages")).body.messages.at(-1);
    expect(reply).toMatchObject({ from: "worker", options: [] });
    expect(reply.text).toContain("1 Rest");
  });

  it("handles a resent message once (same id), and different messages each time", async () => {
    const { a, user } = await webGirl("0712600023", "en");
    const count = async () => (await db.query(`SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND direction = 'in'`, [user.id]))[0].n;
    const send = (text: string, id?: string) => a.post("/api/me/messages").set(H).send(id ? { text, id } : { text });
    expect((await send("is it normal to have pain during my period", "3f1c2a9e-0001")).status).toBe(200);
    expect((await send("is it normal to have pain during my period", "3f1c2a9e-0001")).status).toBe(200); // her phone retried
    expect(await count()).toBe(1);
    await send("is it normal to have pain during my period", "3f1c2a9e-0002"); // she really asked again
    expect(await count()).toBe(2);
    await send("one more without an id"); // an older phone
    expect(await count()).toBe(3);
    expect((await send("hi", "bad id!")).status).toBe(400);
    // A voice note retried with the same id is handled once too.
    for (let i = 0; i < 2; i++) await a.post("/api/me/voice").set(H).set("x-ubah-id", "3f1c2a9e-voice").set("content-type", "audio/webm").send(Buffer.from("fake"));
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE user_id = $1 AND kind = 'voice'`, [user.id]))[0].n).toBe(1);
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

describe("care, passes and lessons in her space", () => {
  it("lists clinics for what she needs and gives her a pass in her web chat, never on WhatsApp", async () => {
    const g = girl(db, "0712600080", "whatsapp");
    await g.send("hi");
    await g.send("3");
    const { a: her } = await webGirl("0712600080", "en");
    const clinics = (await her.get("/api/me/clinics?services=family_planning")).body;
    expect(clinics.services).toContain("family_planning");
    expect(clinics.clinics.length).toBeGreaterThan(0);
    expect(clinics.clinics.every((c: any) => c.services.includes("family_planning"))).toBe(true);
    await g.replies();

    const pass = await her.post("/api/me/passes").set(H).send({ services: ["family_planning"] });
    expect(pass.status).toBe(201);
    expect(pass.body.code).toMatch(/^UB-/);
    // Nothing went out on WhatsApp: the pass messages were for her web chat only.
    const sentSince = await db.query(`SELECT channel, via FROM outbox WHERE to_hash = $1 AND body LIKE '%' || $2 || '%'`, [hashPhone("0712600080"), pass.body.code]);
    expect(sentSince).toEqual([{ channel: "web", via: "app" }]);
    expect((await db.query(`SELECT 1 FROM outbox WHERE to_hash = $1 AND channel = 'whatsapp' AND body LIKE '%' || $2 || '%'`, [hashPhone("0712600080"), pass.body.code])).length).toBe(0);
    const conv = (await her.get("/api/me/messages")).body.messages;
    expect(conv.some((m: any) => m.from === "ubah" && m.text.includes(pass.body.code))).toBe(true);
    const passes = (await her.get("/api/me/passes")).body.passes;
    expect(passes[0]).toMatchObject({ code: pass.body.code, valid: true, services: ["family_planning"] });
    expect((await her.post("/api/me/passes").set(H).send({ services: ["nonsense"] })).status).toBe(400);
  });

  it("serves the published lessons in her language", async () => {
    const { a: her } = await webGirl("0712600081", "en");
    const learn = (await her.get("/api/me/learn")).body;
    expect(learn.lang).toBe("en");
    expect(learn.lessons.length).toBeGreaterThan(0);
    expect(learn.lessons[0]).toMatchObject({ title: expect.any(String), body: expect.any(String), translated: true });
  });
});

describe("USSD (fixes from the code review)", () => {
  it("an urgent-help choice on USSD is urgent for her worker, and a reply to it goes by SMS", async () => {
    const ussd = (phone: string, text: string) => request(app).post("/webhooks/ussd").type("form").send({ sessionId: "s", serviceCode: "*384#", phoneNumber: phone, text });
    const phone = "+254712600110";
    await ussd(phone, "");
    await ussd(phone, "3"); // English
    await ussd(phone, "5*2"); // Urgent help: someone is hurting me
    const [u] = await db.query(`SELECT id FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
    const [m] = await db.query(`SELECT id, urgent FROM messages WHERE user_id = $1 AND channel = 'ussd' AND direction = 'in' ORDER BY id DESC LIMIT 1`, [u.id]);
    expect(m.urgent).toBe(true);
    await assign(u.id, "dada");
    const dada = await staff("dada");
    const inbox = (await dada.get("/api/worker/inbox")).body.messages;
    expect(inbox.find((x: any) => x.id === m.id)).toMatchObject({ urgent: true }); // she shares nothing, urgent always reaches her worker
    await dada.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "I'm here. Are you safe now?" });
    const [o] = await db.query(`SELECT channel FROM outbox WHERE to_hash = $1 ORDER BY id DESC LIMIT 1`, [hashPhone(phone)]);
    expect(o.channel).toBe("sms");
  });
});

describe("age (optional) and child safeguarding", () => {
  it("keeps the age band she gives, and shows her worker 'Under 18' so they follow the procedure", async () => {
    const phone = "0712600130";
    const a = request.agent(app);
    await a.post("/api/auth/girl/code").set(H).send({ phone });
    await a.post("/api/auth/girl/verify").set(H).send({ phone, code: lastSmsCode("254712600130"), pin: "2580", language: "so", ageBand: "15_17" });
    await a.put("/api/me/consents").set(H).send({ messages: true });
    const [u] = await db.query(`SELECT id, age_band FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
    expect(u.age_band).toBe("15_17");
    expect((await a.get("/api/me")).body.ageBand).toBe("15_17");
    expect((await a.patch("/api/me").set(H).send({ ageBand: "12" })).status).toBe(400);

    await assign(u.id, "nurse");
    await handleIncoming(db, { channel: "web", from: "", userId: u.id, text: "Caadadaydu way soo daahday" });
    const nurse = await staff("nurse");
    const m = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === u.id);
    expect(m.girl.minor).toBe(true);
    expect((await nurse.get(`/api/worker/messages/${m.id}`)).body.girl).toMatchObject({ minor: true, ageBand: "15_17" });

    // On the /staff case page too.
    await a.post("/api/me/messages").set(H).send({ text: "DADA" });
    const [c] = await db.query(`SELECT id FROM cases WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [u.id]);
    const page = (await (await staff("dada")).get(`/staff/cases/${c.id}`)).text;
    expect(page).toContain("Under 18");
    expect(page).toContain("child-safeguarding procedure");

    // She can change it, or not say.
    expect((await a.patch("/api/me").set(H).send({ ageBand: "not_said" })).body).toEqual({ ageBand: "not_said" });
    expect((await nurse.get(`/api/worker/messages/${m.id}`)).body.girl.minor).toBe(false);
  });
});

describe("her right to see her data", () => {
  it("lists everything Ubah keeps about her, and never her phone number, staff names or case notes", async () => {
    const { a: her, user } = await webGirl("0712600120", "so", { messages: true });
    await assign(user.id, "nurse");
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Caadadaydu way soo daahday" });
    await her.post("/api/me/passes").set(H).send({ services: ["period_care"] });
    const nurse = await staff("nurse");
    const m = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === user.id);
    await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "Please visit the clinic." });
    await db.query(`INSERT INTO cases (user_id, reason, urgent, summary) VALUES ($1,'asked_for_person',FALSE,'internal')`, [user.id]);
    const [c] = await db.query(`SELECT id FROM cases WHERE user_id = $1 LIMIT 1`, [user.id]);
    const [st] = await db.query(`SELECT id, name FROM staff WHERE login = 'nurse'`);
    await db.query(`INSERT INTO case_notes (case_id, staff_id, body) VALUES ($1,$2,'A private note for the care team')`, [c.id, st.id]);

    const d = (await her.get("/api/me/data")).body;
    expect(d.account).toMatchObject({ code: user.anon_id, language: "so", phone: "locked" });
    expect(d.sharing).toEqual({ messages: true, voice: false });
    expect(d.healthWorker).toBe("nurse");
    expect(d.counts.passes).toBe(1);
    expect(d.messages.some((x: any) => x.from === "me" && x.text === "Caadadaydu way soo daahday")).toBe(true);
    expect(d.messages.find((x: any) => x.from === "health worker")).toMatchObject({ english: "Please visit the clinic." });
    const all = JSON.stringify(d);
    expect(all).not.toContain("712600120"); // no phone number in any form
    expect(all).not.toContain(st.name);
    expect(all).not.toContain("A private note");
    expect((await request(app).get("/api/me/data")).status).toBe(401);
  });
});

describe("wipe my history", () => {
  it("deletes her account and everything linked to it, and signs her out", async () => {
    const { a: her, user } = await webGirl("0712600090", "so", { messages: true, voice: true });
    await assign(user.id, "nurse");
    await handleIncoming(db, { channel: "web", from: "", userId: user.id, voice: { audio: Buffer.from("OggS"), mimeType: "audio/ogg", mockText: "Caadadaydu way soo daahday" } });
    await her.post("/api/me/passes").set(H).send({ services: ["period_care"] });
    const nurse = await staff("nurse");
    await nurse.get("/api/worker/inbox"); // leaves an access-log line
    const count = async (sql: string) => (await db.query(sql, [user.id]))[0].n as number;
    expect(await count(`SELECT count(*)::int AS n FROM voice_notes WHERE user_id = $1`)).toBe(1);

    // A spoken reply to her (voice replies on) is stored in media: it must go too.
    const [mm] = await db.query(`SELECT id FROM messages WHERE user_id = $1 AND direction = 'in' LIMIT 1`, [user.id]);
    const [media] = await db.query(`INSERT INTO media (mime, bytes, size, sha256, filename) VALUES ('audio/mpeg', '\\x00', 1, 'x', 'reply.mp3') RETURNING id`);
    const [st] = await db.query(`SELECT id FROM staff WHERE login = 'nurse'`);
    await db.query(`INSERT INTO replies (message_id, worker_id, english_text, translated_text, translation_source, voice_ref) VALUES ($1,$2,'Hi','Hi','none',$3)`, [mm.id, st.id, media.id]);

    expect((await her.delete("/api/me")).status).toBe(403); // the X-Ubah header is still required
    expect((await her.delete("/api/me").set(H)).status).toBe(204);

    for (const table of ["users WHERE id", "messages WHERE user_id", "passes WHERE user_id", "voice_notes WHERE user_id", "consents WHERE user_id", "assignments WHERE girl_id", "girl_sessions WHERE user_id"]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} = $1`), table).toBe(0);
    }
    expect((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE to_hash = $1`, [hashPhone("0712600090")]))[0].n).toBe(0);
    expect((await db.query(`SELECT 1 FROM media WHERE id = $1`, [media.id])).length).toBe(0);
    expect((await her.get("/api/me")).status).toBe(401);
    // The access log keeps only that someone looked, never what.
    const log = await db.query(`SELECT what, target_id FROM access_log WHERE girl_id = $1`, [user.id]);
    expect(log.length).toBeGreaterThan(0);
    expect(JSON.stringify(log)).not.toMatch(/Caadadaydu/);
  });
});

describe("spoken replies in her space", () => {
  it("plays her worker's reply when voice replies are on, and only for her", async () => {
    const so = languageConfig("so")!;
    config.voiceReplies.enabled = true;
    so.ttsVoiceId = "voice-so-test";
    try {
      const { a: her, user } = await webGirl("0712600070", "so");
      await assign(user.id, "nurse");
      await handleIncoming(db, { channel: "web", from: "", userId: user.id, text: "Caadadaydu way soo daahday" });
      const nurse = await staff("nurse");
      const m = (await nurse.get("/api/worker/inbox")).body.messages.find((x: any) => x.girl.id === user.id);
      await nurse.post(`/api/worker/messages/${m.id}/reply`).set(H).send({ english: "Please visit the clinic." });
      const reply = (await her.get("/api/me/messages")).body.messages.at(-1);
      expect(reply.audio).toMatch(/^\/api\/me\/audio\/\d+$/);
      const played = await her.get(reply.audio);
      expect(played.status).toBe(200);
      expect(played.headers["content-type"]).toMatch(/audio\/mpeg/);
      const { a: other } = await webGirl("0712600071", "so");
      expect((await other.get(reply.audio)).status).toBe(404);
    } finally {
      config.voiceReplies.enabled = false;
      so.ttsVoiceId = null;
    }
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

  it("never reads her Somali as English when only the mock translation is there (no key, e.g. the test version)", async () => {
    const { mockTranslation } = await import("../src/providers/translation.js");
    useTranslationProvider(mockTranslation);
    try {
      const { a } = await webGirl("0712600062", "so");
      const res = await a.post("/api/me/messages").set(H).send({ text: "Caadadaydu way soo daahday" });
      const answer = res.body.messages.filter((m: any) => m.from === "ubah").map((m: any) => m.text).join("\n");
      expect(answer).not.toMatch(/prevent pregnancy/i); // found live: "way" read as "ways to prevent pregnancy"
      expect(answer).toMatch(/I'm not sure about that/);
    } finally {
      useTranslationProvider(dictionary);
    }
  });

  it("offers a person instead of guessing when the message couldn't be translated", async () => {
    const { a } = await webGirl("0712600061", "so");
    failNext = true;
    const res = await a.post("/api/me/messages").set(H).send({ text: "Caadadaydu way soo daahday" });
    expect(res.body.messages.at(-1).text).toMatch(/I'm not sure about that/);
  });
});

describe("answers come from the right topic, or from a person", () => {
  it("never answers with another topic's lesson, and offers a person when nothing matches well", async () => {
    const g = girl(db, "0712600100");
    await g.send("hi");
    await g.send("3");
    await g.send("2"); // keeps her messages private: not part of this test
    // Search alone matched both to the infections lesson; with the topic Ubah recognises, each gets
    // its own topic's lesson.
    const period = await g.send("how long does a period last");
    expect(period).not.toMatch(/HIV|infection/i);
    expect(period).toMatch(/period/i);
    const positive = await g.send("test was positive");
    expect(positive).not.toMatch(/HIV|infection/i);
    expect(positive).toMatch(/pregnan/i);
    // A question that matches nothing well goes to a person.
    expect(await g.send("what is the weather like in garissa")).toMatch(/I'm not sure about that/);
    expect(await g.send("my period is two weeks late, what should i do")).not.toMatch(/I'm not sure/);
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
