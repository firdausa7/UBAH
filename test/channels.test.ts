import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, girl, staffClient, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { hashPhone } from "../src/privacy.js";
import { mockWhatsAppSent, menuPayload, downloadWhatsAppMedia } from "../src/channels/whatsapp.js";
import { mockSmsSent, splitSms } from "../src/channels/sms.js";
import { parseMenu } from "../src/channels/menu.js";
import { sendToUser, type UserRow } from "../src/channels/outbound.js";
import { recordInbound, recoverInbound } from "../src/channels/inbound.js";
import { sendDueCheckins } from "../src/engine.js";
import { runDueJobs } from "../src/jobs/queue.js";
import { refreshCaches, invalidateCaches } from "../src/caches.js";
import { t } from "../src/i18n.js";
import { stemSo, tokenize } from "../src/ml/text.js";
import { dangerGate, trainCandidate, promote } from "../src/ml/registry.js";
import { evaluate, editDistance, readManifest, normalizeTranscript } from "../src/ai/sttEval.js";
import { haversineKm } from "../src/location.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Report } from "../src/ml/classifier.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
const clients = new Map<string, StaffClient>();
const as = async (login: string) => {
  if (!clients.has(login)) clients.set(login, await staffClient(app, db, login));
  return clients.get(login)!;
};
const later = (h: number) => new Date(Date.now() + h * 3600e3);
const sentTo = (phone: string) => mockWhatsAppSent.filter((m) => m.to === phone);
const smsTo = (phone: string) => mockSmsSent.filter((m) => m.to === phone);
const settle = () => new Promise((r) => setTimeout(r, 250));
// Webhooks answer at once and the work continues after: wait for its result, not for a fixed time
// (a slower machine, e.g. CI on real Postgres, can take longer than settle()).
async function until(check: () => Promise<boolean>, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await check()) return;
  throw new Error("timed out waiting for the webhook's work");
}

function waText(from: string, id: string, body: string) {
  return { entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: "1", type: "text", text: { body } }] } }] }] };
}
function waButton(from: string, id: string, replyId: string) {
  return { entry: [{ changes: [{ value: { messages: [{ from, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: replyId, title: "x" } } }] } }] }] };
}
const getUser = async (phone: string) => (await db.query<UserRow>(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]))[0];

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});
afterEach(() => {
  config.whatsapp.templateCheckin = "";
  config.whatsapp.templateNotify = "";
  config.whatsapp.templateLanguages = { en: "en" };
  config.allowDraftContent = true;
  invalidateCaches();
});

describe("safety: danger signs reach a human on every step", () => {
  it("even when it is a new girl's very first message", async () => {
    const g = girl(db, "0712300001");
    expect(await g.send("i want to kill myself")).toMatch(/not alone/i);
    const [c] = await db.query(`SELECT c.reason, c.urgent FROM cases c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1`, [hashPhone("0712300001")]);
    expect(c).toEqual({ reason: "danger_selfharm", urgent: true });
  });

  it("on the language step and in the middle of a check-in", async () => {
    const g = girl(db, "0712300002");
    await g.send("hi");
    expect(await g.send("someone raped me")).toMatch(/not your fault/i);
    await g.send("3");
    await g.send("my period is late");
    await g.send("1");
    await sendDueCheckins(db, later(73));
    await g.replies();
    expect(await g.send("I am pregnant and bleeding a lot")).toMatch(/care today/i);
    const reasons = (await db.query(`SELECT c.reason FROM cases c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1 ORDER BY c.id`, [hashPhone("0712300002")])).map((r) => r.reason);
    expect(reasons).toEqual(["danger_safety", "danger_medical"]);
  });

  it("and after she said STOP (she is back, and the case still opens)", async () => {
    const g = girl(db, "0712300003");
    await g.send("hi");
    await g.send("3");
    await g.send("STOP");
    expect(await g.send("my uncle beats me")).toMatch(/not your fault/i);
    expect((await getUser("0712300003")).opted_out).toBe(false);
  });
});

describe("WhatsApp menus, window and delivery", () => {
  it("turns numbered menus into buttons or a list, using the translated words", () => {
    const answer = parseMenu(t("en", "answer_menu"));
    expect(answer.options.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(menuPayload(answer.body, answer.options, "Choose")).toMatchObject({ type: "interactive", interactive: { type: "button" } });
    const services = parseMenu(t("en", "choose_services"));
    expect(services.options).toHaveLength(6);
    const list: any = menuPayload(services.body, services.options, "Choose");
    expect(list.interactive.type).toBe("list");
    expect(list.interactive.action.sections[0].rows.every((r: any) => r.title.length <= 24)).toBe(true);
    expect(parseMenu("No menu here.").options).toEqual([]);
  });

  it("handles a webhook message once, even if Meta delivers it twice, and button taps send the number", async () => {
    const from = "254712300010";
    for (let i = 0; i < 2; i++) await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.dup1", "hello"));
    await settle();
    expect(sentTo(from)).toHaveLength(1);
    expect((sentTo(from)[0].payload as any).interactive.type).toBe("list"); // language menu
    await request(app).post("/webhooks/whatsapp").send(waButton(from, "wamid.dup2", "3"));
    await settle();
    expect((await getUser(from)).language).toBe("en");
    const [row] = await db.query(`SELECT payload_enc, processed_at FROM inbound_messages WHERE provider_id = 'wamid.dup1'`);
    expect(row.payload_enc).toBeNull(); // emptied once handled
    expect(row.processed_at).toBeTruthy();
  });

  it("records delivery statuses and holds a message whose window closed before it arrived", async () => {
    const from = "254712300010";
    const [o] = await db.query(`SELECT provider_id FROM outbox WHERE to_hash = $1 AND provider_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [hashPhone(from)]);
    const status = (s: string, errors?: unknown[]) => ({ entry: [{ changes: [{ value: { statuses: [{ id: o.provider_id, status: s, ...(errors ? { errors } : {}) }] } }] }] });
    await request(app).post("/webhooks/whatsapp").send(status("delivered"));
    await request(app).post("/webhooks/whatsapp").send(status("read"));
    await settle();
    const [after] = await db.query(`SELECT delivered_at, read_at FROM outbox WHERE provider_id = $1`, [o.provider_id]);
    expect(after.delivered_at).toBeTruthy();
    expect(after.read_at).toBeTruthy();
    await request(app).post("/webhooks/whatsapp").send(status("failed", [{ code: 131047, title: "Re-engagement message" }]));
    await settle();
    expect((await db.query(`SELECT status FROM outbox WHERE provider_id = $1`, [o.provider_id]))[0].status).toBe("held");
    const u = await getUser(from);
    expect((await db.query(`SELECT count(*)::int AS n FROM pending_outbound WHERE user_id = $1`, [u.id]))[0].n).toBe(1);
    expect(smsTo(from).at(-1)!.message).toBe(t("en", "wa_waiting_sms")); // a notice that reveals nothing
  });

  it("delivers held messages first when she writes again", async () => {
    const from = "254712300010";
    const before = sentTo(from).length;
    await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.back", "hello again"));
    await settle();
    expect(sentTo(from).length).toBeGreaterThan(before + 1);
    const u = await getUser(from);
    expect((await db.query(`SELECT count(*)::int AS n FROM pending_outbound WHERE user_id = $1`, [u.id]))[0].n).toBe(0);
  });

  it("outside the 24-hour window: check-ins use the approved template, or SMS when there is none", async () => {
    const from = "254712300011";
    await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.c1", "hi"));
    await request(app).post("/webhooks/whatsapp").send(waButton(from, "wamid.c2", "3"));
    await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.c3", "my period is late"));
    await settle();
    await request(app).post("/webhooks/whatsapp").send(waButton(from, "wamid.c4", "1"));
    // Her pass and its day-3 check-in exist once the "1" (find care) has been handled.
    await until(async () => (await db.query(`SELECT 1 FROM checkins WHERE user_id = (SELECT id FROM users WHERE phone_hash = $1)`, [hashPhone(from)])).length > 0);
    await db.query(`UPDATE users SET wa_last_inbound_at = now() - interval '3 days' WHERE phone_hash = $1`, [hashPhone(from)]);
    // No template configured: the brief's SMS fallback.
    await sendDueCheckins(db, later(73));
    expect(smsTo(from).at(-1)!.message).toContain("Did you visit a clinic");
    // With an approved template for her language: the template, with quick replies that send 1 and 2.
    await db.query(`UPDATE checkins SET sent_at = NULL WHERE user_id = (SELECT id FROM users WHERE phone_hash = $1)`, [hashPhone(from)]);
    await db.query(`UPDATE users SET state = '{"step":"free"}' WHERE phone_hash = $1`, [hashPhone(from)]);
    config.whatsapp.templateCheckin = "ubah_checkin";
    await sendDueCheckins(db, later(73));
    const tpl: any = sentTo(from).at(-1)!.payload;
    expect(tpl.type).toBe("template");
    expect(tpl.template.name).toBe("ubah_checkin");
    expect(tpl.template.components.filter((c: any) => c.type === "button").map((c: any) => c.parameters[0].payload)).toEqual(["1", "2"]);
    // Tapping "Yes" on the template.
    await request(app).post("/webhooks/whatsapp").send({ entry: [{ changes: [{ value: { messages: [{ from, id: "wamid.c5", type: "button", button: { payload: "1", text: "Yes" } }] } }] }] });
    await until(async () => /checkin_(clinic|respect)/.test((await getUser(from)).state.step));
    expect((await getUser(from)).state.step).toMatch(/checkin_(clinic|respect)/);
  });

  it("holds a staff reply when her window is closed and uses the notify template if approved", async () => {
    const from = "254712300011";
    config.whatsapp.templateNotify = "ubah_new_message";
    await db.query(`UPDATE users SET wa_last_inbound_at = now() - interval '2 days' WHERE phone_hash = $1`, [hashPhone(from)]);
    await db.query(`DELETE FROM pending_outbound`);
    const u = await getUser(from);
    await sendToUser(db, u, "Hi, it's a Dada. How are you?", null, null);
    const last: any = sentTo(from).at(-1)!.payload;
    expect(last.template.name).toBe("ubah_new_message");
    expect((await db.query(`SELECT body FROM pending_outbound WHERE user_id = $1`, [u.id]))[0].body).toContain("Dada");
  });

  it("sends the recorded voice answer after the text, uploading it to WhatsApp once", async () => {
    const from = "254712300012";
    await db.query(`INSERT INTO media (mime, bytes, size, sha256) VALUES ('audio/ogg', '\\x4f676753'::bytea, 4, 'x')`);
    const [m] = await db.query(`SELECT id FROM media ORDER BY id DESC LIMIT 1`);
    await db.query(`UPDATE content_versions SET audio_media_id = $1 WHERE topic_id = 'periods-pain' AND language = 'en'`, [m.id]);
    await refreshCaches(db, { force: true });
    await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.v1", "hi"));
    await request(app).post("/webhooks/whatsapp").send(waButton(from, "wamid.v2", "3"));
    await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.v3", "my period pain is very bad"));
    await settle();
    const types = sentTo(from).map((x) => x.payload.type);
    expect(types).toContain("audio");
    expect((await db.query(`SELECT wa_media_id FROM media WHERE id = $1`, [m.id]))[0].wa_media_id).toMatch(/^mock-media/);
  });

  it("only downloads voice notes from Meta's servers", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ url: "https://evil.example/x.ogg", mime_type: "audio/ogg", file_size: 10 }), { status: 200 })) as typeof fetch;
    try {
      await expect(downloadWhatsAppMedia("123")).rejects.toThrow(/Unexpected media URL/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("answers", () => {
  it("cites which approved topic the answer came from", async () => {
    const g = girl(db, "0712300020");
    await g.send("hi");
    await g.send("3");
    expect(await g.send("how do i use a pad")).toContain("(Ubah checked answer: Managing your period)");
    const [m] = await db.query(`SELECT content_version_id FROM messages WHERE direction = 'out' AND body LIKE '%Ubah checked answer%' ORDER BY id DESC LIMIT 1`);
    expect(m.content_version_id).toBeTruthy();
  });

  it("matches a Somali question against a published Somali version, using the Somali tokenizer", async () => {
    expect(stemSo("dhiigga")).toBe("dhiig");
    expect(tokenize("Waa xanuun caloosha", "so")).toEqual(["xanuun", "caloo"]);
    expect(tokenize("ba'an", "so")).toEqual(["ba'an"]);
    await db.query(`INSERT INTO content_versions (topic_id, language, version, title, body, keywords, status) VALUES ('periods-pain','so',1,'[DRAFT so title]','[DRAFT Somali answer about xanuun caadada]','{xanuun,caado}','published')`);
    await refreshCaches(db, { force: true });
    const g = girl(db, "0712300021");
    await g.send("hi");
    await g.send("1");
    const reply = await g.send("xanuunka caadada");
    expect(reply).toContain("[DRAFT Somali answer");
    expect(reply).not.toContain(t("so", "translation_pending"));
  });
});

describe("location: nearest clinic", () => {
  it("uses a shared location once (never stored) and a typed landmark", async () => {
    await db.query(`UPDATE clinics SET lat = 0.05, lng = 40.30, landmarks = '{"[Market X]"}' WHERE id = 1`);
    await db.query(`UPDATE clinics SET lat = 0.20, lng = 40.40 WHERE id = 2`);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.2, 0);
    const from = "254712300030";
    await request(app).post("/webhooks/whatsapp").send(waText(from, "wamid.l1", "hi"));
    await request(app).post("/webhooks/whatsapp").send(waButton(from, "wamid.l2", "3"));
    await request(app).post("/webhooks/whatsapp").send({ entry: [{ changes: [{ value: { messages: [{ from, id: "wamid.l3", type: "location", location: { latitude: 0.21, longitude: 40.41 } }] } }] }] });
    await settle();
    const last: any = sentTo(from).at(-1)!.payload;
    expect(last.text.body).toMatch(/Nearest Ubah partner clinics:\n\[Health post B\]/);
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`)).map((c) => c.column_name);
    expect(cols.some((c) => /lat|lng|coord/.test(c))).toBe(false);
    const g = girl(db, "0712300031");
    await g.send("hi");
    await g.send("3");
    expect(await g.send("NEAR [market x]")).toMatch(/\[Health post A\]/);
    expect((await getUser("0712300031")).area).toBe("[Market X]");
    expect(await g.send("NEAR atlantis")).toMatch(/don't know that place/);
  });

  it("validates clinic coordinates in admin", async () => {
    const admin = await as("admin");
    const base = { name: "[C]", area: "[A]", hours: "[H]", services: ["sti"] };
    expect(String((await admin.post("/staff/admin/clinics", { ...base, lat: "1.0" })).headers.location)).toContain("error=invalid");
    expect(String((await admin.post("/staff/admin/clinics", { ...base, lat: "51.5", lng: "0.1" })).headers.location)).toContain("error=invalid");
    const ok = await admin.post("/staff/admin/clinics", { ...base, lat: "0.1", lng: "40.2", landmarks: "[School Y], [Mosque Z]" });
    const id = Number(String(ok.headers.location).match(/clinics\/(\d+)/)![1]);
    expect((await db.query(`SELECT lat, lng, landmarks FROM clinics WHERE id = $1`, [id]))[0]).toEqual({ lat: 0.1, lng: 40.2, landmarks: ["[School Y]", "[Mosque Z]"] });
  });
});

describe("SMS", () => {
  it("splits long messages at sentence breaks into numbered parts", () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");
    const parts = splitSms(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 120)).toBe(true);
    expect(parts[0]).toMatch(/\(1\/\d\)$/);
    expect(splitSms("short")).toEqual(["short"]);
  });

  it("applies delivery reports and retries when her phone was off", async () => {
    const g = girl(db, "0712300040", "sms");
    await g.send("hi");
    const [o] = await db.query(`SELECT provider_id FROM outbox WHERE to_hash = $1 ORDER BY id DESC LIMIT 1`, [hashPhone("0712300040")]);
    await request(app).post("/webhooks/sms/delivery").type("form").send({ id: o.provider_id, status: "Success" });
    expect((await db.query(`SELECT delivered_at FROM outbox WHERE provider_id = $1`, [o.provider_id]))[0].delivered_at).toBeTruthy();
    await g.send("3");
    const [o2] = await db.query(`SELECT id, provider_id FROM outbox WHERE to_hash = $1 ORDER BY id DESC LIMIT 1`, [hashPhone("0712300040")]);
    await request(app).post("/webhooks/sms/delivery").type("form").send({ id: o2.provider_id, status: "AbsentSubscriber", failureReason: "phone off" });
    expect((await db.query(`SELECT status FROM outbox WHERE id = $1`, [o2.id]))[0].status).toBe("failed");
    expect((await db.query(`SELECT 1 FROM jobs WHERE type = 'outbox.retry' AND payload->>'outboxId' = $1`, [String(o2.id)])).length).toBe(1);
    await runDueJobs(db, { now: later(3) });
    expect((await db.query(`SELECT status FROM outbox WHERE id = $1`, [o2.id]))[0].status).toBe("mock");
    expect((await request(app).post("/webhooks/sms/delivery").type("form").send({})).status).toBe(400);
  });

  it("honours network opt-outs: nothing is sent until she writes again", async () => {
    const g = girl(db, "0712300041", "sms");
    await g.send("hi");
    await request(app).post("/webhooks/sms/optout").type("form").send({ phoneNumber: "+254712300041", senderId: "UBAH" });
    const u = await getUser("0712300041");
    expect(u.opted_out).toBe(true);
    expect(await sendToUser(db, u, "Anything")).toBeNull();
  });

  it("recovers an inbound message the app didn't get to (e.g. it stopped)", async () => {
    const id = await recordInbound(db, { provider: "sms", from: "+254712300042", text: "hello" });
    await db.query(`UPDATE inbound_messages SET received_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
    expect(await recoverInbound(db)).toBe(1);
    expect((await db.query(`SELECT body FROM outbox WHERE to_hash = $1`, [hashPhone("+254712300042")]))[0].body).toContain("Choose a language");
  });
});

describe("USSD for girls", () => {
  const ussd = (phone: string, text: string) => request(app).post("/webhooks/ussd").type("form").send({ sessionId: "s", serviceCode: "*384#", phoneNumber: phone, text });

  it("language, topics (short answer + full SMS), passes, find care and talk to a Dada", async () => {
    const p = "+254712300050";
    expect((await ussd(p, "")).text).toMatch(/^CON Ubah\n1 Soomaali/);
    expect((await ussd(p, "3")).text).toMatch(/^CON Ubah: private health help/);
    const cats = (await ussd(p, "1")).text;
    expect(cats).toMatch(/^CON Choose a topic:\n1 Periods/);
    expect((await ussd(p, "1*1")).text).toMatch(/^CON Choose a topic:/);
    const answer = (await ussd(p, "1*1*1")).text;
    expect(answer).toMatch(/^END .*Full answer sent to you by SMS/s);
    expect(answer.length).toBeLessThanOrEqual(182);
    expect(smsTo("254712300050").at(-1)!.message).toContain("Ubah checked answer");
    expect((await ussd(p, "3")).text).toBe(`END ${t("en", "ussd_no_passes")}`);
    expect((await ussd(p, "2")).text).toMatch(/^CON What do you need\?/);
    expect((await ussd(p, "2*2")).text).toMatch(/^END Your pass: UB-/);
    expect((await ussd(p, "3")).text).toMatch(/^END Your passes:\nUB-/);
    expect((await ussd(p, "4")).text).toBe(`END ${t("en", "ussd_dada")}`);
    expect((await ussd(p, "9")).text).toMatch(/^END Sorry/);
    expect((await ussd(p, "6*2")).text).toMatch(/^END /);
    expect((await getUser("+254712300050")).language).toBe("sw");
  });

  it("urgent help opens an urgent case for a human at once", async () => {
    const p = "+254712300051";
    await ussd(p, "3");
    expect((await ussd(p, "5")).text).toMatch(/^CON Urgent help:/);
    expect((await ussd(p, "5*3")).text).toBe(`END ${t("en", "ussd_urgent_done")}`);
    const [c] = await db.query(`SELECT c.reason, c.urgent, c.level FROM cases c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1`, [hashPhone(p)]);
    expect(c).toEqual({ reason: "danger_selfharm", urgent: true, level: "nurse" });
    expect(smsTo("254712300051").at(-1)!.message).toMatch(/not alone/i);
    await ussd(p, "5*1");
    expect(smsTo("254712300051").at(-1)!.message).toMatch(/UB-[A-Z0-9]{4}/); // urgent pass by SMS
  });
});

describe("model registry", () => {
  const rep = (recall: Record<string, number>): Report => ({
    task: "danger",
    folds: 5,
    examples: 10,
    sources: {},
    accuracy: 0.8,
    confusion: {},
    perLabel: Object.fromEntries(Object.entries(recall).map(([l, r]) => [l, { precision: 0.8, recall: r, support: 5 }])),
  });

  it("never lets a danger-sign model with lower recall for any danger class go live", () => {
    const live = rep({ medical: 0.8, safety: 0.6, selfharm: 0.9, none: 0.5 });
    expect(dangerGate(rep({ medical: 0.8, safety: 0.7, selfharm: 0.9, none: 0.2 }), live).ok).toBe(true); // "none" may drop
    const blocked = dangerGate(rep({ medical: 0.9, safety: 0.5, selfharm: 0.9, none: 0.9 }), live);
    expect(blocked.ok).toBe(false);
    expect(blocked.drops).toEqual([{ label: "safety", from: 0.6, to: 0.5 }]);
    expect(dangerGate(rep({ medical: 0.1 }), null).ok).toBe(true); // nothing live yet
  });

  it("registers the shipped models, trains candidates from labels, and promotes through the page", async () => {
    const live = await db.query(`SELECT task, version FROM model_versions WHERE status = 'active' ORDER BY task`);
    expect(live).toEqual([
      { task: "danger", version: 1 },
      { task: "topic", version: 1 },
    ]);
    const cand = await trainCandidate(db, "topic", null, "test");
    expect(cand!.status).toBe("candidate");
    const nurse = await as("nurse");
    expect((await nurse.get("/staff/models")).text).toContain("Danger-sign</em> classifier");
    expect((await nurse.post(`/staff/models/${cand!.id}/promote`)).status).toBe(403);
    const admin = await as("admin");
    await admin.post(`/staff/models/${cand!.id}/promote`);
    expect((await db.query(`SELECT version FROM model_versions WHERE task = 'topic' AND status = 'active'`))[0].version).toBe(cand!.version);
    // A danger candidate that misses more safety cases is refused, with an audit entry.
    const [d] = await db.query(`SELECT * FROM model_versions WHERE task = 'danger' AND status = 'active'`);
    const worse = { ...d.report, perLabel: { ...d.report.perLabel, safety: { ...d.report.perLabel.safety, recall: d.report.perLabel.safety.recall - 0.1 } } };
    const [bad] = await db.query(`INSERT INTO model_versions (task, version, model, report, examples) VALUES ('danger', 99, $1, $2, 1) RETURNING id`, [JSON.stringify(d.model), JSON.stringify(worse)]);
    expect((await admin.get("/staff/models")).text).toContain("Can't be promoted");
    expect(String((await admin.post(`/staff/models/${bad.id}/promote`)).headers.location)).toContain("error=recall");
    expect((await promote(db, bad.id, 1)).ok).toBe(false);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'model.promote_blocked'`)).length).toBe(1);
    await admin.post(`/staff/models/${bad.id}/reject`, { note: "worse on safety" });
    expect((await db.query(`SELECT status FROM model_versions WHERE id = $1`, [bad.id]))[0].status).toBe("rejected");
    await admin.post("/staff/models/train");
    await runDueJobs(db);
    expect((await db.query(`SELECT count(*)::int AS n FROM model_versions WHERE status = 'candidate'`))[0].n).toBe(2);
  });
});

describe("speech-to-text evaluation", () => {
  it("refuses recordings without documented consent and measures WER and CER per language", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubah-stt-"));
    writeFileSync(join(dir, "a.ogg"), "fake");
    writeFileSync(join(dir, "b.ogg"), "fake");
    writeFileSync(
      join(dir, "manifest.jsonl"),
      [
        JSON.stringify({ audio: "a.ogg", text: "my period is late", language: "en", consent: true, consent_ref: "F-1" }),
        JSON.stringify({ audio: "b.ogg", text: "caloosha ayaa i xanuunaysa", language: "so", consent: true, consent_ref: "F-2" }),
        JSON.stringify({ audio: "a.ogg", text: "no consent", language: "en", consent: true }),
        JSON.stringify({ audio: "../../etc/passwd", text: "x", language: "en", consent: false }),
      ].join("\n"),
    );
    const { items, refused } = readManifest(join(dir, "manifest.jsonl"));
    expect(refused).toBe(2);
    const fake = async (_a: Buffer, _m: string, lang: string) => ({ ok: true, text: lang === "en" ? "my period is great" : "caloosha ayaa i xanuunaysa" });
    const r = await evaluate(items, dir, fake, "test-model", refused);
    expect(r.languages.en.wer).toBeCloseTo(0.25);
    expect(r.languages.so.wer).toBe(0);
    expect(r.overall.clips).toBe(2);
    expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
    expect(normalizeTranscript("Ba'an, waa!", "so")).toBe("ba'an waa");
  });
});
