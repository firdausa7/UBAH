import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { freshDb, girl, staffClient, csrfFrom, lastSmsCode, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { mockSmsSent } from "../src/channels/sms.js";
import { runDueJobs } from "../src/jobs/queue.js";
import { refreshCaches, invalidateCaches } from "../src/caches.js";
import { loadServingContent } from "../src/content/content.js";
import { t } from "../src/i18n.js";
import { analyse } from "../src/ml/models.js";
import { findClinics } from "../src/referrals.js";
import { hashPhone } from "../src/privacy.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
const clients = new Map<string, StaffClient>();
const as = async (login: string) => {
  if (!clients.has(login)) clients.set(login, await staffClient(app, db, login));
  return clients.get(login)!;
};
const later = (h: number) => new Date(Date.now() + h * 3600e3);
const loc = (res: { headers: Record<string, any> }) => String(res.headers.location ?? "");

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});
afterEach(() => {
  config.nurseAlertNumbers = [];
  config.dadaPayPerCaseKes = 0;
  config.allowDraftContent = true;
  invalidateCaches();
});

// ======================= Admin: staff =======================
describe("admin: staff accounts", () => {
  it("is for admins only", async () => {
    expect((await (await as("nurse")).get("/staff/admin")).status).toBe(403);
    const admin = await as("admin");
    expect((await admin.get("/staff/admin")).text).toContain("Staff</em> accounts");
    const list = await admin.get("/staff/admin/staff");
    expect(list.text).toContain("Dada Demo");
    expect((await admin.get("/staff/admin/staff?role=dada")).text).not.toContain("Nurse on call");
    expect((await admin.get("/staff/admin/staff/new")).status).toBe(200);
  });

  it("invites a Dada with a one-time link she uses to set her password, then logs in with an SMS code", async () => {
    const admin = await as("admin");
    expect(loc(await admin.post("/staff/admin/staff", { name: "Halima", login: "Bad Login!", role: "dada", phone: "0712345678" }))).toContain("error=invalid");
    expect(loc(await admin.post("/staff/admin/staff", { name: "Halima", login: "halima", role: "dada" }))).toContain("error=invalid"); // Dadas need a phone
    const created = await admin.post("/staff/admin/staff", { name: "Halima Noor", login: "halima", role: "dada", phone: "0712345678", languages: ["so", "sw"], send_sms: "1" });
    expect(created.status).toBe(200);
    const link = created.text.match(/http:\/\/localhost:3000\/staff\/invite\/([A-Za-z0-9_-]+)/)!;
    expect(mockSmsSent.at(-1)!.message).toContain(link[0]);
    expect(loc(await admin.post("/staff/admin/staff", { name: "Again", login: "halima", role: "dada", phone: "0712345678" }))).toContain("error=exists");
    const [row] = await db.query(`SELECT phone, languages, password_hash FROM staff WHERE login = 'halima'`);
    expect(row).toMatchObject({ phone: "+254712345678", languages: ["so", "sw"], password_hash: "!" });

    const agent = request.agent(app);
    const page = await agent.get(`/staff/invite/${link[1]}`);
    expect(page.text).toContain("Hello Halima Noor");
    const csrf = csrfFrom(page.text);
    expect((await agent.post(`/staff/invite/${link[1]}`).type("form").send({ new: "short", confirm: "short", _csrf: csrf })).text).toContain("12 characters");
    const ok = await agent.post(`/staff/invite/${link[1]}`).type("form").send({ new: "the goats came home", confirm: "the goats came home", _csrf: csrf });
    expect(loc(ok)).toBe("/staff/login?done=password");
    expect((await agent.get(`/staff/invite/${link[1]}`)).status).toBe(410); // used
    const halima = await staffClient(app, db, "halima", "the goats came home");
    expect((await halima.get("/staff/inbox")).status).toBe(200);
  });

  it("edits, changes role (ending sessions), deactivates, reactivates, unlocks and resets", async () => {
    const admin = await as("admin");
    await admin.post("/staff/admin/staff", { name: "Desk Two", login: "desk-two", role: "clinic", clinic_id: "1" });
    const [s] = await db.query(`SELECT id FROM staff WHERE login = 'desk-two'`);
    await db.query(`UPDATE staff SET password_hash = (SELECT password_hash FROM staff WHERE login = 'clinic-a') WHERE id = $1`, [s.id]);
    const desk = await staffClient(app, db, "desk-two");
    expect((await admin.get(`/staff/admin/staff/${s.id}`)).text).toContain("Desk Two");
    expect(loc(await admin.post(`/staff/admin/staff/${s.id}`, { name: "Desk 2", role: "clinic", clinic_id: "1", phone: "07000" }))).toContain("error=invalid");
    expect(loc(await admin.post(`/staff/admin/staff/${s.id}`, { name: "Desk 2", role: "partner", phone: "" }))).toContain("done=saved");
    expect((await desk.get("/staff/clinic")).status).toBe(302); // role change ended the session

    await db.query(`UPDATE staff SET locked_until = now() + interval '1 hour' WHERE id = $1`, [s.id]);
    expect((await admin.get(`/staff/admin/staff/${s.id}`)).text).toContain("Unlock");
    await admin.post(`/staff/admin/staff/${s.id}/unlock`);
    expect((await db.query(`SELECT locked_until FROM staff WHERE id = $1`, [s.id]))[0].locked_until).toBeNull();

    await admin.post(`/staff/admin/staff/${s.id}/deactivate`);
    expect((await db.query(`SELECT active FROM staff WHERE id = $1`, [s.id]))[0].active).toBe(false);
    await admin.post(`/staff/admin/staff/${s.id}/reactivate`);
    expect((await db.query(`SELECT active FROM staff WHERE id = $1`, [s.id]))[0].active).toBe(true);

    const reset = await admin.post(`/staff/admin/staff/${s.id}/reset-password`);
    expect(reset.text).toMatch(/\/staff\/invite\/[A-Za-z0-9_-]+/);
    expect((await db.query(`SELECT password_hash FROM staff WHERE id = $1`, [s.id]))[0].password_hash).toBe("!");

    await db.query(`UPDATE staff SET totp_enabled_at = now(), totp_secret_enc = 'x' WHERE id = $1`, [s.id]);
    await admin.post(`/staff/admin/staff/${s.id}/reset-2fa`);
    expect((await db.query(`SELECT totp_enabled_at, totp_secret_enc FROM staff WHERE id = $1`, [s.id]))[0]).toEqual({ totp_enabled_at: null, totp_secret_enc: null });
    const actions = (await db.query(`SELECT action FROM audit_log WHERE target_type = 'staff' AND target_id = $1`, [String(s.id)])).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["staff.create", "staff.update", "staff.unlock", "staff.deactivate", "staff.reactivate", "staff.reset_password", "staff.reset_2fa"]));
  });

  it("won't let an admin lock themselves out or demote themselves", async () => {
    const admin = await as("admin");
    const [me] = await db.query(`SELECT id FROM staff WHERE login = 'admin'`);
    expect(loc(await admin.post(`/staff/admin/staff/${me.id}/deactivate`))).toContain("error=self");
    expect(loc(await admin.post(`/staff/admin/staff/${me.id}`, { name: "Admin", role: "nurse" }))).toContain("error=self");
    expect(loc(await admin.post(`/staff/admin/staff/${me.id}/reset-password`))).toContain("error=self");
    expect((await admin.get("/staff/admin/staff/99999")).status).toBe(404);
  });
});

// ======================= Admin: clinics and sites =======================
describe("admin: clinics", () => {
  it("adds, edits, deactivates and reactivates a clinic with services, hours, verified flag and MFL code", async () => {
    const admin = await as("admin");
    expect((await admin.get("/staff/admin/clinics")).text).toContain("[Health post A]");
    expect((await admin.get("/staff/admin/clinics/new")).status).toBe(200);
    expect(loc(await admin.post("/staff/admin/clinics", { name: "X", area: "Y", hours: "Z", mfl_code: "12", services: ["sti"] }))).toContain("error=invalid");
    expect(loc(await admin.post("/staff/admin/clinics", { name: "X", area: "Y", hours: "Z" }))).toContain("error=invalid"); // no service
    const created = await admin.post("/staff/admin/clinics", { name: "[Test clinic D]", area: "[Block 4]", hours: "[Mon-Fri]", mfl_code: "12345", services: ["sti", "counselling"], free: "1", verified: "1" });
    const id = Number(loc(created).match(/clinics\/(\d+)/)![1]);
    expect((await admin.get(`/staff/admin/clinics/${id}`)).text).toContain("12345");
    await admin.post(`/staff/admin/clinics/${id}`, { name: "[Test clinic D]", area: "[Block 4]", hours: "[Daily]", services: ["sti"], free: "1" });
    expect((await db.query(`SELECT hours, verified, services FROM clinics WHERE id = $1`, [id]))[0]).toEqual({ hours: "[Daily]", verified: false, services: ["sti"] });
    await admin.post(`/staff/admin/clinics/${id}/deactivate`);
    expect((await findClinics(db, ["sti"])).some((c) => c.id === id)).toBe(false);
    await admin.post(`/staff/admin/clinics/${id}/reactivate`);
    expect((await findClinics(db, ["sti"])).some((c) => c.id === id)).toBe(true);
    expect((await admin.get("/staff/admin/clinics/9999")).status).toBe(404);
    expect((await admin.post("/staff/admin/clinics/9999/deactivate")).status).toBe(404);
  });
});

describe("admin: sites and protection pathway", () => {
  it("manages sites, the checklist (add, edit, reorder, remove, restore) and referral contacts (verify, edits clear it)", async () => {
    const admin = await as("admin");
    expect((await admin.get("/staff/admin/sites")).text).toContain("[Demo site]");
    const created = await admin.post("/staff/admin/sites", { name: "[Site B]", county: "[County B]" });
    const siteId = Number(loc(created).match(/sites\/(\d+)/)![1]);
    expect(loc(await admin.post("/staff/admin/sites", { name: "[Site B]" }))).toContain("error=exists");
    await admin.post(`/staff/admin/sites/${siteId}`, { name: "[Site B2]", county: "[County B]", active: "1" });
    await admin.post(`/staff/admin/sites/${siteId}/steps`, { title: "First step", details: "" });
    await admin.post(`/staff/admin/sites/${siteId}/steps`, { title: "Second step", details: "" });
    const steps = await db.query(`SELECT id, title FROM protection_steps WHERE site_id = $1 ORDER BY position`, [siteId]);
    await admin.post(`/staff/admin/sites/${siteId}/steps/${steps[1].id}`, { action: "up" });
    expect((await db.query(`SELECT title FROM protection_steps WHERE site_id = $1 ORDER BY position, id`, [siteId])).map((s) => s.title)).toEqual(["Second step", "First step"]);
    await admin.post(`/staff/admin/sites/${siteId}/steps/${steps[0].id}`, { action: "save", title: "First step (edited)", details: "d" });
    await admin.post(`/staff/admin/sites/${siteId}/steps/${steps[0].id}`, { action: "remove" });
    await admin.post(`/staff/admin/sites/${siteId}/steps/${steps[0].id}`, { action: "restore" });
    expect((await db.query(`SELECT title, active FROM protection_steps WHERE id = $1`, [steps[0].id]))[0]).toEqual({ title: "First step (edited)", active: true });

    await admin.post(`/staff/admin/sites/${siteId}/contacts`, { name: "[Case worker]", organisation: "[Protection partner]", service: "GBV case management", phone: "[phone]" });
    const [c] = await db.query(`SELECT id, verified FROM protection_contacts WHERE site_id = $1`, [siteId]);
    expect(c.verified).toBe(false);
    await admin.post(`/staff/admin/sites/${siteId}/contacts/${c.id}`, { action: "verify" });
    expect((await db.query(`SELECT verified FROM protection_contacts WHERE id = $1`, [c.id]))[0].verified).toBe(true);
    await admin.post(`/staff/admin/sites/${siteId}/contacts/${c.id}`, { action: "save", name: "[Case worker]", organisation: "[Protection partner]", phone: "[new phone]" });
    expect((await db.query(`SELECT verified FROM protection_contacts WHERE id = $1`, [c.id]))[0].verified).toBe(false);
    await admin.post(`/staff/admin/sites/${siteId}/contacts/${c.id}`, { action: "verify" });
    await admin.post(`/staff/admin/sites/${siteId}/contacts/${c.id}`, { action: "unverify" });
    await admin.post(`/staff/admin/sites/${siteId}/contacts/${c.id}`, { action: "remove" });
    await admin.post(`/staff/admin/sites/${siteId}/contacts/${c.id}`, { action: "restore" });
    const view = await admin.get(`/staff/admin/sites/${siteId}`);
    expect(view.text).toContain("Not verified");
    expect(view.text).toContain("First step (edited)");
    expect((await admin.post(`/staff/admin/sites/${siteId}/steps/999999`, { action: "remove" })).status).toBe(404);
  });
});

// ======================= Content studio =======================
describe("content studio", () => {
  it("lets editors, reviewers and admins in, nobody else", async () => {
    expect((await (await as("nurse")).get("/staff/content")).status).toBe(403);
    expect((await (await as("partner")).get("/staff/content")).status).toBe(403);
    for (const who of ["admin", "editor", "reviewer"]) expect((await (await as(who)).get("/staff/content")).text).toContain("periods-pain");
    expect((await (await as("reviewer")).get("/staff/content/new")).status).toBe(403); // reviewers don't write
  });

  it("draft -> review -> returned -> review -> approved by a named reviewer -> published; only then served in production", async () => {
    const editor = await as("editor");
    const reviewer = await as("reviewer");
    await db.query(`UPDATE staff SET title = 'Clinical officer', organisation = '[Health partner]' WHERE login = 'reviewer'`);
    expect(loc(await editor.post("/staff/content", { id: "versions", category: "body", title: "t", body: "b" }))).toContain("error=invalid");
    const created = await editor.post("/staff/content", { id: "test-hygiene", category: "body", services: ["period_care"], title: "Washing", body: "DRAFT test text: wash with clean water.", keywords: "wash, clean, hygiene" });
    expect(loc(created)).toBe("/staff/content/test-hygiene?done=created");
    expect(loc(await editor.post("/staff/content", { id: "test-hygiene", category: "body", title: "t", body: "b" }))).toContain("error=exists");
    expect((await editor.get("/staff/content/test-hygiene")).text).toContain("Washing");
    expect((await editor.get("/staff/content/test-hygiene/en/edit")).status).toBe(200);

    const saved = await editor.post("/staff/content/test-hygiene/en", { title: "Washing", body: "DRAFT test text: wash with clean water and soap.", keywords: "wash, soap", step: "submit" });
    const vid = Number(loc(saved).match(/versions\/(\d+)/)![1]);
    expect((await db.query(`SELECT status FROM content_versions WHERE id = $1`, [vid]))[0].status).toBe("in_review");
    expect((await editor.post(`/staff/content/versions/${vid}/approve`)).status).toBe(403); // editors can't approve
    expect((await reviewer.get("/staff/content/review")).text).toContain("test-hygiene");
    await reviewer.post(`/staff/content/versions/${vid}/return`, { note: "Please add when to see a nurse." });
    expect((await db.query(`SELECT status, review_note FROM content_versions WHERE id = $1`, [vid]))[0]).toEqual({ status: "draft", review_note: "Please add when to see a nurse." });
    await editor.post("/staff/content/test-hygiene/en", { title: "Washing", body: "DRAFT test text: wash with clean water and soap. See a nurse if it itches.", keywords: "wash, soap" });
    await editor.post(`/staff/content/versions/${vid}/submit`);
    expect(loc(await editor.post(`/staff/content/versions/${vid}/publish`))).toContain("error=state"); // not approved yet
    // A reviewer can never approve their own text.
    await db.query(`UPDATE content_versions SET author_id = (SELECT id FROM staff WHERE login = 'reviewer') WHERE id = $1`, [vid]);
    expect(loc(await reviewer.post(`/staff/content/versions/${vid}/approve`))).toContain("error=own_work");
    await db.query(`UPDATE content_versions SET author_id = (SELECT id FROM staff WHERE login = 'editor') WHERE id = $1`, [vid]);
    await reviewer.post(`/staff/content/versions/${vid}/approve`);
    const [approved] = await db.query(`SELECT status, reviewer_name FROM content_versions WHERE id = $1`, [vid]);
    expect(approved).toEqual({ status: "approved", reviewer_name: "Reviewer Demo, Clinical officer ([Health partner])" });

    // Not yet published: production never serves it.
    expect((await loadServingContent(db, false)).some((c) => c.id === "test-hygiene")).toBe(false);
    await editor.post(`/staff/content/versions/${vid}/publish`);
    expect((await loadServingContent(db, false)).find((c) => c.id === "test-hygiene")?.versionId).toBe(vid);

    // With drafts switched off (as in production), a girl gets the published text, and nothing unpublished.
    config.allowDraftContent = false;
    await refreshCaches(db, { force: true });
    const g = girl(db, "0712000601");
    await g.send("hi");
    await g.send("3");
    expect(await g.send("how should i wash with soap")).toContain("See a nurse if it itches");
    expect(await g.send("my period pain is bad")).toMatch(/not sure/i); // period content is only a draft
  });

  it("keeps one published version per language and full history; a new version doesn't replace it until published", async () => {
    const editor = await as("editor");
    const reviewer = await as("reviewer");
    await editor.post("/staff/content/test-hygiene/en", { title: "Washing v2", body: "DRAFT v2", keywords: "wash", step: "submit" });
    const [v2] = await db.query(`SELECT id FROM content_versions WHERE topic_id = 'test-hygiene' AND language = 'en' ORDER BY version DESC LIMIT 1`);
    expect((await loadServingContent(db, false)).find((c) => c.id === "test-hygiene")?.title).toBe("Washing");
    await reviewer.post(`/staff/content/versions/${v2.id}/approve`);
    await editor.post(`/staff/content/versions/${v2.id}/publish`);
    const all = await db.query(`SELECT version, status FROM content_versions WHERE topic_id = 'test-hygiene' AND language = 'en' ORDER BY version`);
    expect(all).toEqual([
      { version: 1, status: "archived" },
      { version: 2, status: "published" },
    ]);
    // A Somali draft, then discarded.
    await editor.post("/staff/content/test-hygiene/so", { title: "[DRAFT so]", body: "[DRAFT Somali text by a translator]" });
    const [so] = await db.query(`SELECT id FROM content_versions WHERE topic_id = 'test-hygiene' AND language = 'so'`);
    await editor.post(`/staff/content/versions/${so.id}/discard`);
    expect((await db.query(`SELECT status FROM content_versions WHERE id = $1`, [so.id]))[0].status).toBe("archived");
    expect((await editor.get("/staff/content/test-hygiene")).text).toContain("Version history");
    expect((await editor.get("/staff/content/versions/999999")).status).toBe(404);
  });

  it("uploads a recorded voice answer to a draft and serves it to staff", async () => {
    const editor = await as("editor");
    await editor.post("/staff/content/test-hygiene/sw", { title: "[DRAFT sw]", body: "[DRAFT Kiswahili text]" });
    const [v] = await db.query(`SELECT id FROM content_versions WHERE topic_id = 'test-hygiene' AND language = 'sw'`);
    const upload = (buf: Buffer, type: string) =>
      editor.agent.post(`/staff/content/versions/${v.id}/audio?_csrf=${encodeURIComponent(editor.csrf)}`).attach("audio", buf, { filename: "answer.ogg", contentType: type });
    expect(loc(await upload(Buffer.from("not audio"), "text/plain"))).toContain("error=file");
    expect(loc(await upload(Buffer.from("OggS fake audio bytes"), "audio/ogg"))).toContain("done=uploaded");
    const [row] = await db.query(`SELECT audio_media_id FROM content_versions WHERE id = $1`, [v.id]);
    const media = await editor.get(`/staff/media/${row.audio_media_id}`);
    expect(media.headers["content-type"]).toBe("audio/ogg");
    expect((await (await as("nurse")).get(`/staff/media/${row.audio_media_id}`)).status).toBe(403);
    // Uploads need the CSRF token too.
    expect((await editor.agent.post(`/staff/content/versions/${v.id}/audio`).attach("audio", Buffer.from("x"), { filename: "a.ogg", contentType: "audio/ogg" })).status).toBe(403);
    await editor.post(`/staff/content/versions/${v.id}/audio/remove`);
    expect((await db.query(`SELECT audio_media_id FROM content_versions WHERE id = $1`, [v.id]))[0].audio_media_id).toBeNull();
  });

  it("archives a topic through its settings so it is never served", async () => {
    const editor = await as("editor");
    await editor.post("/staff/content/test-hygiene/settings", { category: "body", archived: "1" });
    expect((await loadServingContent(db, false)).some((c) => c.id === "test-hygiene")).toBe(false);
    await editor.post("/staff/content/test-hygiene/settings", { category: "body" });
    expect((await loadServingContent(db, false)).some((c) => c.id === "test-hygiene")).toBe(true);
  });
});

// ======================= Translations and glossary =======================
describe("translation studio", () => {
  it("translates, checks placeholders, reviews and publishes; girls then get the translation", async () => {
    const editor = await as("editor");
    const reviewer = await as("reviewer");
    expect((await editor.get("/staff/translations?lang=so")).text).toContain("language_set");
    expect((await editor.get("/staff/translations?lang=so&show=missing")).status).toBe(200);
    expect((await editor.get("/staff/translations/no_such_key/so")).status).toBe(404);
    const bad = await editor.post("/staff/translations/pass_issued/so", { text: "[DRAFT] {code} only" });
    expect(bad.text).toContain("Keep every placeholder");
    await editor.post("/staff/translations/language_set/so", { text: "[DRAFT Somali: thank you, ask anything]", step: "submit" });
    const [v] = await db.query(`SELECT id, status FROM string_versions WHERE key = 'language_set' AND language = 'so'`);
    expect(v.status).toBe("in_review");
    expect((await editor.get("/staff/translations?lang=so&show=review")).text).toContain("language_set");
    await reviewer.post(`/staff/translations/versions/${v.id}/approve`);
    await editor.post(`/staff/translations/versions/${v.id}/publish`);
    config.allowDraftContent = false;
    await refreshCaches(db, { force: true });
    expect(t("so", "language_set")).toBe("[DRAFT Somali: thank you, ask anything]");
    const g = girl(db, "0712000602");
    await g.send("hi");
    expect(await g.send("1")).toContain("[DRAFT Somali: thank you");

    await editor.post("/staff/translations/help/sw", { text: "[DRAFT sw help]", step: "submit" });
    const [w] = await db.query(`SELECT id FROM string_versions WHERE key = 'help' AND language = 'sw'`);
    await reviewer.post(`/staff/translations/versions/${w.id}/return`, { note: "Too formal" });
    expect((await db.query(`SELECT status FROM string_versions WHERE id = $1`, [w.id]))[0].status).toBe("draft");
    await editor.post(`/staff/translations/versions/${w.id}/discard`);
    expect((await db.query(`SELECT status FROM string_versions WHERE id = $1`, [w.id]))[0].status).toBe("archived");
    await editor.post(`/staff/translations/versions/${w.id}/submit`);
    expect((await db.query(`SELECT status FROM string_versions WHERE id = $1`, [w.id]))[0].status).toBe("archived"); // can't submit a discarded draft
  });
});

describe("glossary studio", () => {
  it("adds, edits (clearing verification), verifies, removes and restores coded words, used at once", async () => {
    const editor = await as("editor");
    const reviewer = await as("reviewer");
    expect((await editor.get("/staff/glossary")).text).toContain("monthly visitor");
    await editor.post("/staff/glossary", { term: "Red Sea Time", means: "period", language: "en", topic: "periods", notes: "[test]" });
    expect(loc(await editor.post("/staff/glossary", { term: "red sea time", means: "period", language: "en", topic: "periods" }))).toContain("error=exists");
    await refreshCaches(db, { force: true });
    expect(analyse("it is red sea time and it hurts").codedTerms).toContain("red sea time");
    const [g] = await db.query(`SELECT id FROM glossary_terms WHERE term = 'red sea time'`);
    expect((await editor.post(`/staff/glossary/${g.id}`, { action: "verify" })).status).toBe(403); // editors don't verify
    await reviewer.post(`/staff/glossary/${g.id}`, { action: "verify" });
    expect((await db.query(`SELECT verified FROM glossary_terms WHERE id = $1`, [g.id]))[0].verified).toBe(true);
    await editor.post(`/staff/glossary/${g.id}`, { action: "save", term: "red sea time", means: "menstruation", language: "en", topic: "periods" });
    expect((await db.query(`SELECT verified, means FROM glossary_terms WHERE id = $1`, [g.id]))[0]).toEqual({ verified: false, means: "menstruation" });
    await reviewer.post(`/staff/glossary/${g.id}`, { action: "verify" });
    await reviewer.post(`/staff/glossary/${g.id}`, { action: "unverify" });
    await editor.post(`/staff/glossary/${g.id}`, { action: "remove" });
    await refreshCaches(db, { force: true });
    expect(analyse("it is red sea time").codedTerms).not.toContain("red sea time");
    await editor.post(`/staff/glossary/${g.id}`, { action: "restore" });
    expect((await editor.get("/staff/glossary?lang=en")).text).toContain("red sea time");
  });
});

// ======================= Inbox =======================
describe("inbox", () => {
  it("keeps nurse-level cases away from Dadas and supports claim, assign, notes, history and filters", async () => {
    const g = girl(db, "0712000501");
    await g.send("hi");
    await g.send("3");
    await g.send("i am pregnant and bleeding a lot");
    const [medical] = await db.query(`SELECT id, level FROM cases ORDER BY id DESC LIMIT 1`);
    expect(medical.level).toBe("nurse");
    const dada = await as("dada");
    const nurse = await as("nurse");
    expect((await dada.get(`/staff/cases/${medical.id}`)).status).toBe(403);
    expect((await dada.get("/staff/inbox")).text).not.toContain(`/staff/cases/${medical.id}"`);
    expect((await nurse.get("/staff/inbox?urgent=1")).text).toContain(`/staff/cases/${medical.id}"`);

    await nurse.post(`/staff/cases/${medical.id}/claim`);
    expect((await nurse.get("/staff/inbox?mine=1")).text).toContain(`/staff/cases/${medical.id}"`);
    expect((await nurse.get("/staff/inbox?unassigned=1")).text).not.toContain(`/staff/cases/${medical.id}"`);
    expect(loc(await (await as("admin")).post(`/staff/cases/${medical.id}/claim`))).toContain("error=state"); // already taken
    const [d] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    expect(loc(await nurse.post(`/staff/cases/${medical.id}/assign`, { staff_id: String(d.id) }))).toContain("error=invalid"); // no Dada on nurse cases
    expect((await dada.post(`/staff/cases/${medical.id}/assign`, { staff_id: String(d.id) })).status).toBe(403);
    await nurse.post(`/staff/cases/${medical.id}/notes`, { body: "Called the clinic; they expect her." });
    await nurse.post(`/staff/cases/${medical.id}/unassign`);
    const view = await nurse.get(`/staff/cases/${medical.id}`);
    expect(view.text).toContain("Called the clinic");
    for (const e of ["Case opened", "Claimed", "Internal note added", "Returned to the shared queue"]) expect(view.text).toContain(e);
    expect((await nurse.get(`/staff/inbox?lang=so`)).text).not.toContain(`/staff/cases/${medical.id}"`);
    expect((await nurse.get(`/staff/inbox?lang=en`)).text).toContain(`/staff/cases/${medical.id}"`);
  });

  it("lets a Dada escalate to a nurse with one button: nurses are alerted and the case moves", async () => {
    config.nurseAlertNumbers = ["+254700000888"];
    const g = girl(db, "0712000502");
    await g.send("hi");
    await g.send("3");
    await g.send("DADA");
    const [c] = await db.query(`SELECT id, level FROM cases ORDER BY id DESC LIMIT 1`);
    expect(c.level).toBe("dada");
    const dada = await as("dada");
    await dada.post(`/staff/cases/${c.id}/claim`);
    const res = await dada.post(`/staff/cases/${c.id}/escalate`);
    expect(loc(res)).toBe("/staff/inbox?done=escalated");
    expect((await db.query(`SELECT level, assigned_to, escalated_at FROM cases WHERE id = $1`, [c.id]))[0]).toMatchObject({ level: "nurse", assigned_to: null });
    expect(mockSmsSent.at(-1)!.message).toContain(`case #${c.id}`);
    expect((await dada.get(`/staff/cases/${c.id}`)).status).toBe(403);
    expect(loc(await (await as("nurse")).post(`/staff/cases/${c.id}/escalate`))).toContain("error=state"); // already nurse level
  });

  it("assigns a Dada-level case, handles it (creating her payout), and reopens it", async () => {
    config.dadaPayPerCaseKes = 150;
    const g = girl(db, "0712000503");
    await g.send("hi");
    await g.send("3");
    await g.send("talk to a dada please");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    const nurse = await as("nurse");
    const [d] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    await nurse.post(`/staff/cases/${c.id}/assign`, { staff_id: String(d.id) });
    const dada = await as("dada");
    await dada.post(`/staff/cases/${c.id}/reply`, { body: "Hi, I'm here.", handled: "1" });
    const [p] = await db.query(`SELECT amount_kes, status FROM dada_payouts WHERE case_id = $1`, [c.id]);
    expect(p).toEqual({ amount_kes: 150, status: "pending" });
    await dada.post(`/staff/cases/${c.id}/reopen`);
    await dada.post(`/staff/cases/${c.id}/handled`);
    expect((await db.query(`SELECT count(*)::int AS n FROM dada_payouts WHERE case_id = $1`, [c.id]))[0].n).toBe(1); // paid once per case
  });

  it("shows the site's protection checklist and contacts on a safety case, and records each step", async () => {
    const g = girl(db, "0712000504");
    await g.send("hi");
    await g.send("3");
    await g.send("my uncle beats me");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    const [site] = await db.query(`SELECT id FROM sites WHERE name = '[Demo site]'`);
    await db.query(`INSERT INTO protection_steps (site_id, position, title) VALUES ($1, 1, '[Agreed step one]')`, [site.id]);
    await db.query(`INSERT INTO protection_contacts (site_id, name, organisation) VALUES ($1, '[Contact]', '[Org]')`, [site.id]);
    const dada = await as("dada");
    expect((await dada.get(`/staff/cases/${c.id}`)).text).toContain("Choose the girl&#39;s site");
    expect(loc(await dada.post(`/staff/cases/${c.id}/site`, { site_id: "999" }))).toContain("error=invalid");
    await dada.post(`/staff/cases/${c.id}/site`, { site_id: String(site.id) });
    const page = await dada.get(`/staff/cases/${c.id}`);
    expect(page.text).toContain("[Agreed step one]");
    expect(page.text).toContain("Not verified");
    const [step] = await db.query(`SELECT id FROM protection_steps WHERE site_id = $1 AND title = '[Agreed step one]'`, [site.id]);
    await dada.post(`/staff/cases/${c.id}/steps/${step.id}`);
    expect((await db.query(`SELECT 1 FROM case_protection WHERE case_id = $1`, [c.id])).length).toBe(1);
    await dada.post(`/staff/cases/${c.id}/steps/${step.id}`); // undo
    expect((await db.query(`SELECT 1 FROM case_protection WHERE case_id = $1`, [c.id])).length).toBe(0);
  });

  it("pushes new cases to the inbox live (server-sent events) and serves the live script", async () => {
    const nurse = await as("nurse");
    expect((await nurse.get("/staff/assets/live.js")).text).toContain("EventSource");
    const got = new Promise<string>((resolve) => {
      nurse.agent
        .get("/staff/events")
        .buffer(false)
        .parse((res: any, cb: any) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes("event: case")) {
              resolve(data);
              res.destroy();
              cb(null, data);
            }
          });
        })
        .end(() => {});
    });
    await new Promise((r) => setTimeout(r, 150));
    const g = girl(db, "0712000505");
    await g.send("hi");
    await g.send("3");
    await g.send("i want to end my life");
    expect(await got).toMatch(/"urgent":true/);
  });
});

// ======================= Clinic desk =======================
describe("clinic desk without internet", () => {
  async function passFor(phone: string) {
    const g = girl(db, phone);
    await g.send("hi");
    await g.send("3");
    await g.send("how do i get family planning");
    return (await g.send("1")).match(/UB-[A-Z0-9]{4}/)![0];
  }

  it("sets a desk PIN from the Account page", async () => {
    const clinic = await as("clinic-a");
    expect((await clinic.get("/staff/account")).text).toContain("Desk PIN");
    expect(loc(await clinic.post("/staff/account/desk-pin", { pin: "1111", current: "test-pass" }))).toContain("error=invalid");
    expect(loc(await clinic.post("/staff/account/desk-pin", { pin: "4826", current: "wrong" }))).toContain("error=invalid");
    expect(loc(await clinic.post("/staff/account/desk-pin", { pin: "4826", current: "test-pass" }))).toContain("done=saved");
    expect((await (await as("nurse")).post("/staff/account/desk-pin", { pin: "4826", current: "test-pass" })).status).toBe(403);
    expect((await (await as("nurse")).get("/staff/account")).status).toBe(200);
  });

  it("checks and records a pass by SMS from the registered clinic phone, with a PIN", async () => {
    await db.query(`UPDATE staff SET phone = '+254711222333' WHERE login = 'clinic-a'`);
    const code = await passFor("0712000401");
    const sms = async (text: string) => {
      await request(app).post("/webhooks/sms").type("form").send({ from: "+254711222333", to: "123", text });
      await new Promise((r) => setTimeout(r, 200));
      return mockSmsSent.filter((m) => m.to === "254711222333").at(-1)!.message;
    };
    expect(await sms("hello")).toContain("CHECK UB-XXXX PIN");
    expect(await sms(`CHECK ${code} 4826`)).toMatch(new RegExp(`${code} VALID.*Family planning`));
    expect(await sms(`CHECK ${code} 0000`)).toBe("Wrong PIN.");
    expect(await sms(`SEEN ${code} 4826`)).toContain("Recorded");
    expect((await db.query(`SELECT redeemed_clinic FROM passes WHERE code = $1`, [code]))[0].redeemed_clinic).toBe(1);
    // A girl's own SMS still reaches the engine, not the desk.
    const g = girl(db, "0712000402", "sms");
    expect(await g.send("hi")).toContain("Choose a language");
  });

  it("runs the USSD menu for a clinic desk, and tells anyone else how to reach Ubah", async () => {
    const code = await passFor("0712000403");
    const ussd = (phone: string, text: string) => request(app).post("/webhooks/ussd").type("form").send({ sessionId: "s1", serviceCode: "*384#", phoneNumber: phone, text });
    expect((await ussd("+254711222333", "")).text).toMatch(/^CON Ubah clinic desk/);
    expect((await ussd("+254711222333", "1")).text).toMatch(/^CON Enter the pass code/);
    expect((await ussd("+254711222333", `1*${code.slice(3)}`)).text).toMatch(/^CON Enter your desk PIN/);
    expect((await ussd("+254711222333", `1*${code.slice(3)}*4826`)).text).toMatch(new RegExp(`^END ${code} VALID`));
    expect((await ussd("+254711222333", `2*${code.slice(3)}*4826`)).text).toMatch(/^END Recorded/);
    expect((await ussd("+254711222333", "9")).text).toMatch(/^END/);
    expect((await ussd("+254799000000", "")).text).toMatch(/^END Ubah: to ask a private health question/);
    expect((await request(app).post("/webhooks/ussd").type("form").send({ text: "" })).status).toBe(400);
  });

  it("locks the desk phone after repeated wrong PINs", async () => {
    const code = await passFor("0712000404");
    for (let i = 0; i < 5; i++) await request(app).post("/webhooks/ussd").type("form").send({ phoneNumber: "+254711222333", text: `1*${code.slice(3)}*0000` });
    const res = await request(app).post("/webhooks/ussd").type("form").send({ phoneNumber: "+254711222333", text: `1*${code.slice(3)}*4826` });
    expect(res.text).toContain("Too many wrong PINs");
    await db.query(`UPDATE staff SET locked_until = NULL, failed_logins = 0 WHERE login = 'clinic-a'`);
  });
});

// ======================= Dashboard =======================
describe("dashboard, CSV and monthly PDF", () => {
  it("filters by date, site, clinic and language, hides small numbers, and shows weekly trends", async () => {
    const partner = await as("partner");
    const res = await partner.get("/staff/dashboard?days=90");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Week</em> by week");
    expect(res.text).toContain('role="img"');
    expect(res.text).toContain("Show the weekly numbers as a table");
    const [site] = await db.query(`SELECT id FROM sites WHERE name = '[Demo site]'`);
    const filtered = await partner.get(`/staff/dashboard?from=2020-01-01&to=2030-12-31&site=${site.id}&clinic=1&lang=en`);
    expect(filtered.text).toContain("not split by clinic");
    expect((await partner.get("/staff/dashboard?month=2026-01")).status).toBe(200);
    // Somali speakers this period: fewer than 5, so hidden.
    const so = await partner.get("/staff/dashboard?lang=so&days=365");
    expect(so.text).toMatch(/&lt;5|>0</);
    expect((await (await as("dada")).get("/staff/dashboard")).status).toBe(403);
  });

  it("exports CSV with the same filters and suppression, safe for spreadsheets", async () => {
    const partner = await as("partner");
    const csv = await partner.get("/staff/dashboard.csv?days=30");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="ubah-/);
    expect(csv.text).toContain("Questions answered");
    expect(csv.text).toContain("<5");
    const { csvLine } = await import("../src/stats.js");
    expect(csvLine(["=HYPERLINK(1)", 'a"b', "x,y"])).toBe(`'=HYPERLINK(1),"a""b","x,y"`);
  });

  it("produces a monthly PDF report", async () => {
    const partner = await as("partner");
    const month = new Date().toISOString().slice(0, 7);
    const pdf = await partner.agent.get(`/staff/reports/monthly.pdf?month=${month}`).buffer(true).parse((res: any, cb: any) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.body as Buffer).length).toBeGreaterThan(2000);
    const actions = (await db.query(`SELECT action FROM audit_log WHERE action LIKE 'report.%'`)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["report.csv", "report.pdf"]));
  });
});

// ======================= Dada payments =======================
describe("Dada payments (M-Pesa B2C)", () => {
  it("approves payouts in a batch, pays them (mock M-Pesa) and records the receipts", async () => {
    const admin = await as("admin");
    const [d] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    expect(loc(await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "0", reason: "x" }))).toContain("error=invalid");
    await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "500", reason: "Training day" });
    const pending = await db.query(`SELECT id FROM dada_payouts WHERE status = 'pending'`);
    expect(pending.length).toBeGreaterThanOrEqual(2); // the handled case + training day
    expect((await admin.get("/staff/payments")).text).toContain("Training day");
    expect(loc(await admin.post("/staff/payments/approve", {}))).toContain("error=invalid");
    const approved = await admin.post("/staff/payments/approve", { ids: pending.map((p) => String(p.id)) });
    const batchId = Number(loc(approved).match(/batches\/(\d+)/)![1]);
    expect((await admin.get(`/staff/payments/batches/${batchId}`)).text).toContain("through M-Pesa");
    await admin.post(`/staff/payments/batches/${batchId}/pay`);
    expect((await db.query(`SELECT DISTINCT status FROM dada_payouts WHERE batch_id = $1`, [batchId])).map((r) => r.status)).toEqual(["processing"]);
    await runDueJobs(db); // send to M-Pesa
    await runDueJobs(db, { now: later(1) }); // M-Pesa's (mock) result arrives
    const rows = await db.query(`SELECT status, receipt FROM dada_payouts WHERE batch_id = $1`, [batchId]);
    expect(rows.every((r) => r.status === "paid" && String(r.receipt).startsWith("MOCK"))).toBe(true);
    expect((await (await as("nurse")).get("/staff/payments")).status).toBe(403);
  });

  it("fails safely without a phone number, and reconciles: retry, mark paid by receipt, cancel", async () => {
    const admin = await as("admin");
    await admin.post("/staff/admin/staff", { name: "No Phone Dada", login: "nophone", role: "dada", phone: "0700111222" });
    const [d] = await db.query(`SELECT id FROM staff WHERE login = 'nophone'`);
    await db.query(`UPDATE staff SET phone = NULL WHERE id = $1`, [d.id]);
    await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "200", reason: "Test" });
    const [p] = await db.query(`SELECT id FROM dada_payouts WHERE staff_id = $1`, [d.id]);
    const batchId = Number(loc(await admin.post("/staff/payments/approve", { ids: String(p.id) })).match(/batches\/(\d+)/)![1]);
    expect((await admin.get(`/staff/payments/batches/${batchId}`)).text).toContain("no valid M-Pesa number");
    await admin.post(`/staff/payments/batches/${batchId}/pay`);
    await runDueJobs(db);
    expect((await db.query(`SELECT status, result_desc FROM dada_payouts WHERE id = $1`, [p.id]))[0]).toMatchObject({ status: "failed", result_desc: expect.stringContaining("phone") });
    expect((await admin.get("/staff/payments/reconcile")).text).toContain("No Phone Dada");
    await admin.post(`/staff/payments/${p.id}/retry`);
    expect((await db.query(`SELECT status FROM dada_payouts WHERE id = $1`, [p.id]))[0].status).toBe("approved");
    await db.query(`UPDATE dada_payouts SET status = 'failed' WHERE id = $1`, [p.id]);
    expect(loc(await admin.post(`/staff/payments/${p.id}/mark-paid`, { receipt: "bad" }))).toContain("error=state");
    await admin.post(`/staff/payments/${p.id}/mark-paid`, { receipt: "qjk3abc123" });
    expect((await db.query(`SELECT status, receipt FROM dada_payouts WHERE id = $1`, [p.id]))[0]).toEqual({ status: "paid", receipt: "QJK3ABC123" });
    await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "50", reason: "To cancel" });
    const [q] = await db.query(`SELECT id FROM dada_payouts WHERE reason = 'To cancel'`);
    await admin.post(`/staff/payments/${q.id}/cancel`);
    expect((await db.query(`SELECT status FROM dada_payouts WHERE id = $1`, [q.id]))[0].status).toBe("cancelled");
  });

  it("talks to the real Daraja API shape: token, B2C request, then result and timeout callbacks", async () => {
    const admin = await as("admin");
    const [d] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "300", reason: "Real API test" });
    await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "301", reason: "Network error test" });
    const ps = await db.query(`SELECT id FROM dada_payouts WHERE reason IN ('Real API test','Network error test') ORDER BY id`);
    const batchId = Number(loc(await admin.post("/staff/payments/approve", { ids: ps.map((p) => String(p.id)) })).match(/batches\/(\d+)/)![1]);
    const before = { ...config.mpesa };
    const realFetch = globalThis.fetch;
    const sent: any[] = [];
    Object.assign(config.mpesa, { consumerKey: "k", consumerSecret: "s", shortcode: "600000", initiatorName: "ubahapi", securityCredential: "cred", callbackToken: "cb-token-abcdefghijklmnopqrstuvwxyz" });
    globalThis.fetch = (async (url: string, init?: any) => {
      if (String(url).includes("/oauth/v1/generate")) return new Response(JSON.stringify({ access_token: "tok", expires_in: "3599" }), { status: 200 });
      const body = JSON.parse(init.body);
      sent.push(body);
      if (body.Amount === 301) throw new Error("socket hang up");
      return new Response(JSON.stringify({ ConversationID: "AG_1", OriginatorConversationID: body.OriginatorConversationID, ResponseCode: "0", ResponseDescription: "Accept the service request successfully." }), { status: 200 });
    }) as typeof fetch;
    try {
      await admin.post(`/staff/payments/batches/${batchId}/pay`);
      await runDueJobs(db);
    } finally {
      globalThis.fetch = realFetch;
    }
    const ok = sent.find((b) => b.Amount === 300);
    expect(ok).toMatchObject({ CommandID: "BusinessPayment", PartyA: "600000", PartyB: "254700000001", InitiatorName: "ubahapi" });
    expect(ok.ResultURL).toBe("http://localhost:3000/webhooks/mpesa/cb-token-abcdefghijklmnopqrstuvwxyz/result");
    const [unknown] = await db.query(`SELECT status, result_desc FROM dada_payouts WHERE id = $1`, [ps[1].id]);
    expect(unknown).toMatchObject({ status: "failed", result_desc: expect.stringContaining("Check the M-Pesa portal") });

    const result = { Result: { ResultType: 0, ResultCode: 0, ResultDesc: "The service request is processed successfully.", OriginatorConversationID: ok.OriginatorConversationID, ConversationID: "AG_1", TransactionID: "QJK3XYZ789" } };
    expect((await request(app).post("/webhooks/mpesa/wrong-token/result").send(result)).status).toBe(404);
    const cb = await request(app).post(`/webhooks/mpesa/${config.mpesa.callbackToken}/result`).send(result);
    expect(cb.body).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    expect((await db.query(`SELECT status, receipt FROM dada_payouts WHERE id = $1`, [ps[0].id]))[0]).toEqual({ status: "paid", receipt: "QJK3XYZ789" });
    // A late timeout for the same request changes nothing.
    await request(app).post(`/webhooks/mpesa/${config.mpesa.callbackToken}/timeout`).send(result);
    expect((await db.query(`SELECT status FROM dada_payouts WHERE id = $1`, [ps[0].id]))[0].status).toBe("paid");
    expect((await db.query(`SELECT count(*)::int AS n FROM mpesa_callbacks`))[0].n).toBeGreaterThanOrEqual(2);
    Object.assign(config.mpesa, before);
  });

  it("never pretends to pay in production without M-Pesa keys", async () => {
    const admin = await as("admin");
    const [d] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    await admin.post("/staff/payments/manual", { staff_id: String(d.id), amount: "10", reason: "Prod guard" });
    const [p] = await db.query(`SELECT id FROM dada_payouts WHERE reason = 'Prod guard'`);
    const batchId = Number(loc(await admin.post("/staff/payments/approve", { ids: String(p.id) })).match(/batches\/(\d+)/)![1]);
    (config as any).production = true;
    try {
      expect((await admin.get(`/staff/payments/batches/${batchId}`)).text).not.toContain("through M-Pesa</button>");
      expect(loc(await admin.post(`/staff/payments/batches/${batchId}/pay`))).toContain("error=state");
    } finally {
      (config as any).production = false;
    }
    expect((await db.query(`SELECT status FROM dada_payouts WHERE id = $1`, [p.id]))[0].status).toBe("approved");
  });
});

describe("privacy", () => {
  it("never shows a girl's phone number on any staff page", async () => {
    const nurse = await as("nurse");
    const [c] = await db.query(`SELECT c.id FROM cases c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1`, [hashPhone("0712000504")]);
    const page = await nurse.get(`/staff/cases/${c.id}`);
    expect(page.text).not.toMatch(/0712000504|254712000504/);
    expect(lastSmsCode("nobody")).toBe("");
  });
});
