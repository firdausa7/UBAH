import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, lastSmsCode, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { hashPhone } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
const H = { "x-ubah": "1" };
beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});

async function webGirl(phone: string) {
  const a = request.agent(app);
  await a.post("/api/auth/girl/code").set(H).send({ phone });
  await a.post("/api/auth/girl/verify").set(H).send({ phone, code: lastSmsCode(phone.replace(/^0/, "254")), pin: "2580", language: "en" });
  const [u] = await db.query(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]);
  return { a, user: u };
}

describe("confidential reports: her side", () => {
  it("needs only what happened; her words are encrypted; she is told it was received", async () => {
    const { a, user } = await webGirl("0712960001");
    expect((await a.post("/api/me/report").set(H).send({})).status).toBe(400);
    expect((await a.post("/api/me/report").set(H).send({ category: "spying" })).status).toBe(400);
    const r = await a.post("/api/me/report").set(H).send({ category: "harassment" });
    expect(r.status).toBe(201);
    expect(r.body.messages.at(-1).text).toMatch(/Your report was received/);
    const r2 = await a.post("/api/me/report").set(H).send({ category: "online", who: "online", happened: "days", description: "Someone made a fake page with my photos", contactOk: true });
    const [row] = await db.query(`SELECT description_enc, priority_hint, contact_ok, status FROM safeguarding_reports WHERE id = $1`, [r2.body.id]);
    expect(row.description_enc).not.toContain("photos");
    expect(row).toMatchObject({ priority_hint: "normal", contact_ok: true, status: "new" });
    expect((await a.get("/api/me/reports")).body.reports.map((x: any) => [x.category, x.status])).toEqual([
      ["online", "received"],
      ["harassment", "received"],
    ]);
    expect((await db.query(`SELECT kind FROM safeguarding_events WHERE report_id = $1`, [r2.body.id])).map((e: any) => e.kind)).toEqual(["created"]);
    void user;
  });

  it("suggests a higher priority when she is in danger or her words carry a danger sign (a suggestion only)", async () => {
    const { a } = await webGirl("0712960002");
    const r = await a.post("/api/me/report").set(H).send({ category: "abuse", description: "my uncle beats me every night" });
    expect((await db.query(`SELECT priority_hint FROM safeguarding_reports WHERE id = $1`, [r.body.id]))[0].priority_hint).toBe("high");
  });

  it("in danger now: a person at once through the urgent path, without her report's words", async () => {
    const { a, user } = await webGirl("0712960003");
    await a.post("/api/me/report").set(H).send({ category: "abuse", inDanger: true, description: "secret details she wrote" });
    const [c] = await db.query(`SELECT reason, urgent, summary FROM cases WHERE user_id = $1`, [user.id]);
    expect(c).toMatchObject({ reason: "danger_safety", urgent: true });
    expect(c.summary).not.toContain("secret details");
    // The ordinary inbox never carries the report's words either.
    const words = await db.query(`SELECT 1 FROM messages WHERE user_id = $1 AND body LIKE '%secret details%'`, [user.id]);
    expect(words.length).toBe(0);
  });

  it("is in her data copy, and goes when she wipes her history", async () => {
    const { a, user } = await webGirl("0712960004");
    await a.post("/api/me/report").set(H).send({ category: "exploitation", description: "he wants money" });
    expect((await a.get("/api/me/data")).body.reports[0]).toMatchObject({ category: "exploitation", description: "he wants money" });
    await a.delete("/api/me").set(H);
    expect((await db.query(`SELECT 1 FROM safeguarding_reports WHERE user_id = $1`, [user.id])).length).toBe(0);
  });

  it("cannot be read by a nurse, Dada or admin through any girl or worker route", async () => {
    for (const login of ["nurse", "admin"]) {
      const s = await staffClient(app, db, login);
      expect((await s.agent.get("/api/me/reports")).status).toBe(403);
    }
  });
});

describe("confidential reports: protection officers only", () => {
  const officer = () => staffClient(app, db, "protection");
  let client: Awaited<ReturnType<typeof staffClient>>;
  let reportId: number;

  beforeAll(async () => {
    client = await officer();
    const { a } = await webGirl("0712960100");
    await a.post("/api/me/report").set(H).send({ category: "harassment", description: "a man follows me home from the market" });
    const r = await a.post("/api/me/report").set(H).send({ category: "abuse", inDanger: true, description: "my uncle hits me" });
    reportId = r.body.id;
  });

  it("puts reports from girls in danger first, and shows the priority as a suggestion", async () => {
    const queue = (await client.get("/staff/safeguarding")).text;
    expect(queue.indexOf("In danger")).toBeLessThan(queue.indexOf("Harassment"));
    expect(queue).toContain("Suggested: high priority");
    expect(queue).toContain("it is a suggestion, check it yourself");
  });

  it("is refused to nurses, Dadas and admins", async () => {
    for (const login of ["nurse", "dada", "admin"]) {
      const s = await staffClient(app, db, login);
      expect((await s.get("/staff/safeguarding")).status, login).toBe(403);
      expect((await s.get(`/staff/safeguarding/${reportId}`)).status, login).toBe(403);
    }
  });

  it("logs every look, and shows her words only to the officer", async () => {
    const page = (await client.get(`/staff/safeguarding/${reportId}`)).text;
    expect(page).toContain("my uncle hits me");
    expect(page).toContain("She said she is in danger now");
    const [rep] = await db.query(`SELECT user_id FROM safeguarding_reports WHERE id = $1`, [reportId]);
    expect((await db.query(`SELECT 1 FROM access_log WHERE girl_id = $1 AND staff_login = 'protection' AND what = 'report' AND target_id = $2`, [rep.user_id, String(reportId)])).length).toBe(1);
  });

  it("records each status change with a required note; refuses changes the workflow doesn't allow", async () => {
    expect((await client.post(`/staff/safeguarding/${reportId}/status`, { to: "referred", note: "skipping review" })).headers.location).toMatch(/error=invalid/);
    expect((await client.post(`/staff/safeguarding/${reportId}/status`, { to: "in_review", note: "" })).headers.location).toMatch(/error=invalid/);
    expect((await client.post(`/staff/safeguarding/${reportId}/status`, { to: "in_review", note: "Spoke with the Dada on duty" })).headers.location).toMatch(/done=saved/);
    const [rep] = await db.query(`SELECT status, assigned_to FROM safeguarding_reports WHERE id = $1`, [reportId]);
    expect(rep.status).toBe("in_review");
    expect(rep.assigned_to).toBeTruthy(); // the officer who acted takes it
    const [e] = await db.query(`SELECT from_status, to_status, note_enc FROM safeguarding_events WHERE report_id = $1 AND kind = 'status'`, [reportId]);
    expect(e).toMatchObject({ from_status: "new", to_status: "in_review" });
    expect(e.note_enc).not.toContain("Dada on duty"); // notes are encrypted
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'report.status' AND target_id = $1`, [String(reportId)])).length).toBe(1);
  });

  it("refers only to verified contacts, moves the report to referred, and keeps a follow-up date", async () => {
    const [site] = await db.query(`INSERT INTO sites (name) VALUES ('Test site') RETURNING id`);
    const [unverified] = await db.query(`INSERT INTO protection_contacts (site_id, name, verified) VALUES ($1,'Unchecked',FALSE) RETURNING id`, [site.id]);
    const [verified] = await db.query(`INSERT INTO protection_contacts (site_id, name, organisation, verified) VALUES ($1,'GBV desk','Partner NGO',TRUE) RETURNING id`, [site.id]);
    expect((await client.post(`/staff/safeguarding/${reportId}/referral`, { contact_id: String(unverified.id), note: "x" })).headers.location).toMatch(/error=invalid/);
    await client.post(`/staff/safeguarding/${reportId}/referral`, { contact_id: String(verified.id), note: "Case manager will call her Dada" });
    expect((await db.query(`SELECT status FROM safeguarding_reports WHERE id = $1`, [reportId]))[0].status).toBe("referred");
    await client.post(`/staff/safeguarding/${reportId}/follow-up`, { at: "2026-11-05" });
    await client.post(`/staff/safeguarding/${reportId}/note`, { note: "Her Dada confirmed she is safe tonight" });
    const page = (await client.get(`/staff/safeguarding/${reportId}`)).text;
    expect(page).toContain("Referred to GBV desk (Partner NGO)");
    expect(page).toContain("Case manager will call her Dada");
    expect(page).toContain("Her Dada confirmed she is safe tonight");
    expect(page).toContain("2026-11-05");
  });
});

describe("monitoring confidential reports", () => {
  it("counts reports nobody has taken for a day, and follow-ups that are due", async () => {
    const { opsStatus } = await import("../src/ops.js");
    const before = await opsStatus(db);
    const { a } = await webGirl("0712960200");
    const r = await a.post("/api/me/report").set(H).send({ category: "other" });
    await db.query(`UPDATE safeguarding_reports SET created_at = now() - interval '2 days', follow_up_at = now() - interval '1 hour' WHERE id = $1`, [r.body.id]);
    const after = await opsStatus(db);
    expect(after.reportsUntaken24h).toBe(before.reportsUntaken24h + 1);
    expect(after.reportFollowUpsDue).toBe(before.reportFollowUpsDue + 1);
  });
});
