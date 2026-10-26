import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { freshDb, girl, staffClient, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { staffRouter } from "../src/web/staff.js";
import { loginRouter } from "../src/web/login.js";
import { simulatorRouter } from "../src/web/simulator.js";
import { adminRouter } from "../src/web/admin.js";
import { contentRouter } from "../src/web/content.js";
import { stringsRouter } from "../src/web/strings.js";
import { inboxRouter } from "../src/web/inbox.js";
import { clinicRouter } from "../src/web/clinic.js";
import { dashboardRouter } from "../src/web/dashboard.js";
import { paymentsRouter } from "../src/web/payments.js";
import { modelsRouter } from "../src/web/models.js";
import { appApiRouter } from "../src/web/appApi.js";
import { landingRouter } from "../src/web/landing.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Db } from "../src/db.js";

import { INVENTORY } from "./inventory.js";

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
      ...routesOf((appApiRouter(db) as any).stack, "/app/api"),
      ...routesOf((landingRouter(db) as any).stack, ""),
      ...[
        loginRouter(db, { loginLimiter: limiter }),
        adminRouter(db, { tokenLimiter: limiter }),
        inboxRouter(db),
        clinicRouter(db),
        dashboardRouter(db),
        contentRouter(db),
        stringsRouter(db),
        paymentsRouter(db),
        modelsRouter(db),
        staffRouter(db),
      ].flatMap((router: any) => routesOf(router.stack, "/staff")),
    ].sort();
    expect(registered).toEqual(INVENTORY);
  });

  it("serves the React app only for its own areas (once built), never for other unknown URLs", async () => {
    const built = existsSync(new URL("../web/dist/index.html", import.meta.url));
    for (const path of ["/login", "/me", "/me/chat", "/worker", "/worker/inbox/3", "/admin", "/admin/assign"]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(built ? 200 : 404);
      if (built) expect(res.text).toContain('<div id="root">');
    }
    expect((await request(app).get("/meeting")).status).toBe(404);
    expect((await request(app).get("/workers")).status).toBe(404);
  });

  it("every staff page works for its roles and every form is CSRF-protected", async () => {
    const g = girl(db, "0712000801");
    await g.send("hi");
    await g.send("3");
    await g.send("i was raped last night");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    const [site] = await db.query(`SELECT id FROM sites LIMIT 1`);
    const [admin] = await db.query(`SELECT id FROM staff WHERE login = 'admin'`);
    const [version] = await db.query(`SELECT id FROM content_versions ORDER BY id LIMIT 1`);
    const [dada] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    await db.query(`INSERT INTO dada_payouts (staff_id, amount_kes, reason) VALUES ($1, 100, 'page test')`, [dada.id]);
    const [batch] = await db.query(`INSERT INTO payout_batches (created_by, total_kes, payouts) VALUES ($1, 0, 0) RETURNING id`, [admin.id]);
    const pages: Array<[string, string]> = [
      ["admin", "/staff/admin"],
      ["admin", "/staff/admin/staff"],
      ["admin", "/staff/admin/staff/new"],
      ["admin", `/staff/admin/staff/${admin.id}`],
      ["admin", "/staff/admin/clinics"],
      ["admin", "/staff/admin/clinics/new"],
      ["admin", "/staff/admin/clinics/1"],
      ["admin", "/staff/admin/sites"],
      ["admin", `/staff/admin/sites/${site.id}`],
      ["admin", "/staff/payments"],
      ["admin", "/staff/payments?status=paid"],
      ["admin", `/staff/payments/batches/${batch.id}`],
      ["admin", "/staff/payments/reconcile"],
      ["admin", "/staff/account"],
      ["admin", "/staff/content"],
      ["editor", "/staff/content"],
      ["editor", "/staff/content/new"],
      ["editor", "/staff/content/periods-pain"],
      ["editor", "/staff/content/periods-pain/so/edit"],
      ["editor", `/staff/content/versions/${version.id}`],
      ["editor", "/staff/translations"],
      ["editor", "/staff/translations/welcome/so"],
      ["editor", "/staff/glossary"],
      ["reviewer", "/staff/content/review"],
      ["reviewer", `/staff/content/versions/${version.id}`],
      ["reviewer", "/staff/glossary"],
      ["clinic-a", "/staff/account"],
      ["partner", "/staff/dashboard?days=7"],
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
      ["editor", "/staff/inbox"],
      ["editor", "/staff/admin"],
      ["reviewer", "/staff/payments"],
      ["reviewer", "/staff/dashboard"],
      ["partner", "/staff/content"],
      ["partner", "/staff/admin/staff"],
      ["clinic-a", "/staff/content"],
      ["clinic-a", "/staff/payments"],
      ["nurse", "/staff/admin/clinics"],
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
    expect((await (await as("editor")).get("/staff/")).headers.location).toBe("/staff/content");
    expect((await (await as("reviewer")).get("/staff/")).headers.location).toBe("/staff/content");
    expect((await request(app).get("/")).text).toContain("means flower in Somali"); // the public landing page
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
