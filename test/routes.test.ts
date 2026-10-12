import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { freshDb, girl, staffClient, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { staffRouter } from "../src/web/staff.js";
import { loginRouter } from "../src/web/login.js";
import { simulatorRouter } from "../src/web/simulator.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Db } from "../src/db.js";

// Every route in the app. Adding a route without adding it here (and testing it) fails this suite.
const INVENTORY = [
  "GET /health/live",
  "GET /health",
  "GET /",
  "GET /webhooks/whatsapp",
  "POST /webhooks/whatsapp",
  "POST /webhooks/sms",
  "GET /simulator/",
  "GET /simulator/app.js",
  "GET /simulator/history",
  "POST /simulator/send",
  "POST /simulator/skip",
  "GET /staff/login",
  "POST /staff/login",
  "GET /staff/2fa",
  "POST /staff/2fa",
  "POST /staff/2fa/resend",
  "GET /staff/2fa/setup",
  "POST /staff/2fa/setup",
  "GET /staff/password",
  "POST /staff/password",
  "POST /staff/logout",
  "GET /staff/",
  "GET /staff/inbox",
  "GET /staff/cases/:id",
  "POST /staff/cases/:id/reply",
  "GET /staff/clinic",
  "POST /staff/clinic/check",
  "POST /staff/clinic/redeem",
  "GET /staff/dashboard",
  "POST /staff/admin/run-checkins",
  "GET /staff/label",
  "POST /staff/label",
  "GET /staff/audit",
].sort();

function routesOf(stack: any[], prefix = ""): string[] {
  const out: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
  }
  return out;
}

let db: Db;
let app: ReturnType<typeof createApp>;
const clients = new Map<string, StaffClient>();
const as = async (login: string) => {
  if (!clients.has(login)) clients.set(login, await staffClient(app, db, login));
  return clients.get(login)!;
};

// Every POST form on a page must carry the CSRF token.
function expectFormsProtected(html: string, where: string) {
  const forms = html.match(/<form[^>]*method="post"[\s\S]*?<\/form>/gi) ?? [];
  for (const f of forms) expect(f, `form without CSRF token on ${where}`).toContain('name="_csrf"');
}

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});

describe("route inventory", () => {
  it("lists every registered route", () => {
    const limiter = (_req: any, _res: any, next: any) => next();
    const registered = [
      ...routesOf((app as any).router.stack),
      ...routesOf((simulatorRouter(db) as any).stack, "/simulator"),
      ...routesOf((loginRouter(db, { loginLimiter: limiter }) as any).stack, "/staff"),
      ...routesOf((staffRouter(db) as any).stack, "/staff"),
    ].sort();
    expect(registered).toEqual(INVENTORY);
  });

  it("every staff page works for its roles and every form is CSRF-protected", async () => {
    const g = girl(db, "0712000801");
    await g.send("hi");
    await g.send("3");
    await g.send("i was raped last night");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    const pages: Array<[string, string]> = [
      ["admin", "/staff/inbox"],
      ["admin", "/staff/inbox?status=handled"],
      ["admin", `/staff/cases/${c.id}`],
      ["admin", "/staff/clinic"],
      ["admin", "/staff/dashboard"],
      ["admin", "/staff/label"],
      ["admin", "/staff/audit"],
      ["admin", "/staff/password"],
      ["nurse", "/staff/inbox"],
      ["dada", "/staff/inbox"],
      ["dada", `/staff/cases/${c.id}`],
      ["clinic-a", "/staff/clinic"],
      ["partner", "/staff/dashboard"],
    ];
    for (const [who, path] of pages) {
      const res = await (await as(who)).get(path);
      expect(res.status, `${who} ${path}`).toBe(200);
      expectFormsProtected(res.text, path);
      expect(res.text, `${who} ${path} has a log-out button`).toContain('action="/staff/logout"');
    }
    for (const path of ["/staff/login"]) expectFormsProtected((await request(app).get(path)).text, path);
  });

  it("blocks each role from pages it shouldn't see", async () => {
    const denied: Array<[string, string]> = [
      ["clinic-a", "/staff/inbox"],
      ["clinic-a", "/staff/dashboard"],
      ["partner", "/staff/inbox"],
      ["partner", "/staff/clinic"],
      ["dada", "/staff/dashboard"],
      ["dada", "/staff/audit"],
      ["nurse", "/staff/clinic"],
      ["nurse", "/staff/audit"],
    ];
    for (const [who, path] of denied) expect((await (await as(who)).get(path)).status, `${who} ${path}`).toBe(403);
    expect((await (await as("dada")).post("/staff/admin/run-checkins")).status).toBe(403);
  });

  it("sends each role to its home page from /staff and / goes to login", async () => {
    expect((await (await as("clinic-a")).get("/staff/")).headers.location).toBe("/staff/clinic");
    expect((await (await as("partner")).get("/staff/")).headers.location).toBe("/staff/dashboard");
    expect((await request(app).get("/")).headers.location).toBe("/staff/login");
    expect((await request(app).get("/staff/cases/abc").set("Cookie", "")).status).toBe(302);
  });

  it("admin can send due check-ins now, and it is audited", async () => {
    const admin = await as("admin");
    const res = await admin.post("/staff/admin/run-checkins");
    expect(res.headers.location).toMatch(/^\/staff\/dashboard\?sent=\d+$/);
    const page = await admin.get(res.headers.location);
    expect(page.text).toContain("check-in(s) sent");
    const [a] = await db.query(`SELECT details FROM audit_log WHERE action = 'checkins.run' ORDER BY id DESC LIMIT 1`);
    expect(a.details).toHaveProperty("sent");
  });

  it("a clinic can't record a pass that isn't valid", async () => {
    const clinic = await as("clinic-a");
    const res = await clinic.post("/staff/clinic/redeem", { code: "UB-ZZZZ" });
    expect(res.text).toContain("Not valid");
  });

  it("a case that doesn't exist is a 404", async () => {
    const nurse = await as("nurse");
    expect((await nurse.get("/staff/cases/999999")).status).toBe(404);
    expect((await nurse.get("/staff/cases/abc")).status).toBe(404);
    expect((await nurse.post("/staff/cases/999999/reply", { body: "x" })).status).toBe(404);
  });
});

describe("webhook authentication", () => {
  it("checks the WhatsApp signature when an app secret is set", async () => {
    const before = config.whatsapp.appSecret;
    config.whatsapp.appSecret = "test-secret";
    try {
      const payload = JSON.stringify({ entry: [] });
      const sig = "sha256=" + createHmac("sha256", "test-secret").update(payload).digest("hex");
      const ok = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sig).send(payload);
      expect(ok.status).toBe(200);
      const bad = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", "sha256=00").send(payload);
      expect(bad.status).toBe(401);
    } finally {
      config.whatsapp.appSecret = before;
    }
  });

  it("checks the SMS callback key when one is set", async () => {
    const before = config.smsWebhookKey;
    config.smsWebhookKey = "k3y";
    try {
      expect((await request(app).post("/webhooks/sms?key=wrong").type("form").send({ from: "+254711000098", text: "hi" })).status).toBe(401);
      expect((await request(app).post("/webhooks/sms?key=k3y").type("form").send({ from: "+254711000098", text: "hi" })).status).toBe(200);
    } finally {
      config.smsWebhookKey = before;
    }
  });
});

describe("simulator", () => {
  it("serves its page and script without inline JavaScript", async () => {
    const page = await request(app).get("/simulator/");
    expect(page.status).toBe(200);
    expect(page.text).not.toMatch(/<script>(?!<\/script>)/);
    expect(page.text).toContain('src="/simulator/app.js"');
    const js = await request(app).get("/simulator/app.js");
    expect(js.headers["content-type"]).toContain("javascript");
    expect((await request(app).post("/simulator/send").send({ phone: 1, text: "x" })).status).toBe(400);
  });
});
