import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, girl, staffClient, csrfFrom, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import { hashPhone } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;

// One signed-in client per account (authenticator codes can't be reused within 30 seconds).
const clients = new Map<string, StaffClient>();
async function login(user: string) {
  if (!clients.has(user)) clients.set(user, await staffClient(app, db, user));
  return clients.get(user)!;
}

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});

describe("channels", () => {
  it("verifies the WhatsApp webhook", async () => {
    const res = await request(app).get("/webhooks/whatsapp").query({ "hub.mode": "subscribe", "hub.verify_token": "ubah-verify", "hub.challenge": "42" });
    expect(res.text).toBe("42");
    expect((await request(app).get("/webhooks/whatsapp").query({ "hub.mode": "subscribe", "hub.verify_token": "wrong" })).status).toBe(403);
  });

  it("handles a WhatsApp text message", async () => {
    const payload = { entry: [{ changes: [{ value: { messages: [{ from: "254711000001", type: "text", text: { body: "hello" } }] } }] }] };
    expect((await request(app).post("/webhooks/whatsapp").send(payload)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const out = await db.query(`SELECT body FROM outbox WHERE to_hash = $1`, [hashPhone("254711000001")]);
    expect(out[0].body).toContain("Choose a language");
  });

  it("handles an Africa's Talking SMS", async () => {
    expect((await request(app).post("/webhooks/sms").type("form").send({ from: "+254711000002", to: "12345", text: "hi" })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const out = await db.query(`SELECT body FROM outbox WHERE to_hash = $1`, [hashPhone("+254711000002")]);
    expect(out[0].body).toContain("Choose a language");
  });
});

describe("staff pages", () => {
  it("blocks pages without login and by role", async () => {
    expect((await request(app).get("/staff/inbox")).status).toBe(302);
    const partner = await login("partner");
    expect((await partner.get("/staff/inbox")).status).toBe(403);
    expect((await partner.get("/staff/dashboard")).status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    const agent = request.agent(app);
    const csrf = csrfFrom((await agent.get("/staff/login")).text);
    const res = await agent.post("/staff/login").type("form").send({ login: "nurse", password: "nope", _csrf: csrf });
    expect(res.headers.location).toContain("error");
  });

  it("lets a Dada answer an urgent case, and the girl receives it", async () => {
    const g = girl(db, "0712000201");
    await g.send("hi");
    await g.send("3");
    await g.send("my boyfriend hit me and i am scared");
    await g.replies();
    const [c] = await db.query(`SELECT id FROM cases WHERE urgent ORDER BY id DESC LIMIT 1`);
    const dada = await login("dada");
    const inbox = await dada.get("/staff/inbox");
    expect(inbox.text).toContain("Safety concern");
    const view = await dada.get(`/staff/cases/${c.id}`);
    expect(view.text).toContain("my boyfriend hit me");
    await dada.post(`/staff/cases/${c.id}/reply`, { body: "I'm here. Are you safe now?", handled: "1" });
    expect((await g.replies()).join()).toContain("Are you safe now?");
    const [after] = await db.query(`SELECT status, first_reply_at FROM cases WHERE id = $1`, [c.id]);
    expect(after.status).toBe("handled");
    expect(after.first_reply_at).toBeTruthy();
  });

  it("lets a clinic check and record a pass without seeing who she is", async () => {
    const g = girl(db, "0712000202");
    await g.send("hi");
    await g.send("3");
    await g.send("how do i get family planning");
    const code = (await g.send("1")).match(/UB-[A-Z0-9]{4}/)![0];
    const clinic = await login("clinic-a");
    const res = await clinic.post("/staff/clinic/check", { code: code.toLowerCase() });
    expect(res.text).toContain("Valid pass");
    expect(res.text).toContain("Family planning");
    expect(res.text).not.toMatch(/0712000202|254712000202/);
    await clinic.post("/staff/clinic/redeem", { code });
    const [p] = await db.query(`SELECT redeemed_clinic FROM passes WHERE code = $1`, [code]);
    expect(p.redeemed_clinic).toBe(1);
    const bad = await clinic.post("/staff/clinic/check", { code: "UB-ZZZZ" });
    expect(bad.text).toContain("Not valid");
  });

  it("shows the dashboard with model reports and hides small clinic samples", async () => {
    const admin = await login("admin");
    const res = await admin.get("/staff/dashboard");
    expect(res.text).toContain("Clinic</em> dignity scores");
    expect(res.text).toContain("Danger-sign classifier");
    expect(res.text).toContain("fewer than 5 answers");
  });

  it("saves labels that become training data", async () => {
    const nurse = await login("nurse");
    const page = await nurse.get("/staff/label");
    const id = page.text.match(/name="message_id" value="(\d+)"/)![1];
    await nurse.post("/staff/label", { message_id: id, danger: "none", topic: "family_planning" });
    const rows = await db.query(`SELECT task, label FROM labels WHERE message_id = $1 ORDER BY task`, [id]);
    expect(rows).toEqual([
      { task: "danger", label: "none" },
      { task: "topic", label: "family_planning" },
    ]);
  });
});

describe("simulator", () => {
  it("chats and skips ahead to the check-in", async () => {
    const send = (text: string) => request(app).post("/simulator/send").send({ phone: "0700000099", text });
    await send("hi");
    await send("3");
    await send("my period is late");
    await send("1");
    await request(app).post("/simulator/skip").send({ phone: "0700000099" });
    const hist = await request(app).get("/simulator/history").query({ phone: "0700000099" });
    expect(hist.body.at(-1).body).toContain("Did you visit a clinic");
  });
});
