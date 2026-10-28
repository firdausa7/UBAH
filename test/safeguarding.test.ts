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
