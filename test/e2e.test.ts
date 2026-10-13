import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { readFileSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { freshDb, girl, staffClient, type StaffClient } from "./helpers.js";
import { INVENTORY, routeExists } from "./inventory.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { hashPhone } from "../src/privacy.js";
import { mockSmsSent } from "../src/channels/sms.js";
import { mockWhatsAppSent } from "../src/channels/whatsapp.js";
import { sendDueCheckins } from "../src/engine.js";
import { remindUnansweredUrgent, opsStatus } from "../src/ops.js";
import { loadDemo, wipeDemo, hasDemoData } from "../src/demo.js";
import { runLoad } from "../src/tools/loadtest.js";
import { refreshCaches } from "../src/caches.js";
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
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 100_000, webhookPerMin: 100_000, appApi: { sessionsPerHour: 100_000, requestsPerMin: 100_000 } });
});
afterEach(() => {
  config.nurseAlertNumbers = [];
  config.opsKey = "";
});

describe("every button and link, for every role", () => {
  const ROLES = ["admin", "nurse", "dada", "clinic-a", "partner", "reviewer", "editor"];
  // Not pages: a live event stream, binary downloads, and logout (tested elsewhere).
  const SKIP = [/^\/staff\/events/, /^\/staff\/media\//, /\.pdf/, /\.csv/, /^\/staff\/assets\//];

  it("crawls every page each role can reach: every link opens, every form posts to a real route", async () => {
    // Some data so detail pages exist.
    const g = girl(db, "0712400001");
    await g.send("hi");
    await g.send("3");
    await g.send("my uncle beats me");
    await g.send("how do i get family planning");
    await g.send("1");
    const problems: string[] = [];
    let pages = 0;
    for (const role of ROLES) {
      const c = await as(role);
      const start = (await c.get("/staff/")).headers.location as string;
      const queue = [start, "/staff/account", "/staff/password"];
      const seen = new Set<string>();
      while (queue.length && seen.size < 120) {
        const url = queue.shift()!;
        if (seen.has(url) || SKIP.some((re) => re.test(url))) continue;
        seen.add(url);
        const res = await c.get(url);
        pages++;
        if (res.status !== 200) {
          problems.push(`${role}: ${url} -> ${res.status}`);
          continue;
        }
        const html = res.text;
        for (const m of html.matchAll(/<form\b([^>]*)>/gi)) {
          const attrs = m[1];
          const method = (attrs.match(/method="(\w+)"/i)?.[1] ?? "get").toUpperCase();
          const action = (attrs.match(/action="([^"]*)"/i)?.[1] ?? url).replace(/&amp;/g, "&");
          if (!routeExists(method, action)) problems.push(`${role}: form ${method} ${action} on ${url} has no route`);
          if (method === "POST" && !/name="_csrf"/.test(html.slice(m.index!, html.indexOf("</form>", m.index!)))) problems.push(`${role}: form ${action} on ${url} has no CSRF token`);
        }
        for (const m of html.matchAll(/href="([^"#]+)"/g)) {
          const href = m[1].replace(/&amp;/g, "&");
          if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/app/")) continue;
          if (!routeExists("GET", href)) problems.push(`${role}: link ${href} on ${url} has no route`);
          // Follow links into the staff area (query variants of the same page only once per path+query).
          if (href.startsWith("/staff/") && !seen.has(href) && !queue.includes(href) && !href.includes("logout")) queue.push(href);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(pages).toBeGreaterThan(100);
  });

  it("every API call the girls' app makes exists", () => {
    const js = readFileSync(new URL("../src/pwa/public/app.js", import.meta.url), "utf8");
    const calls = [...js.matchAll(/api\(\s*[`"](\/[^`"$?]*)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(8);
    for (const path of new Set(calls)) {
      const exists = ["GET", "POST", "PATCH", "DELETE"].some((m) => routeExists(m, `/app/api${path}`));
      expect(exists, `/app/api${path}`).toBe(true);
    }
    expect(INVENTORY.length).toBeGreaterThan(130);
  });
});

describe("a pilot day, across every channel", () => {
  it("WhatsApp, SMS, USSD and the app; Dada, nurse and clinic desk; check-ins and the dashboard", async () => {
    config.nurseAlertNumbers = ["+254700000777"];
    const wa = "254712400100";
    const wa1 = (id: string, body: unknown) => request(app).post("/webhooks/whatsapp").send({ entry: [{ changes: [{ value: { messages: [{ from: wa, id, ...(body as object) }] } }] }] });

    // 1. A girl on WhatsApp asks a question and gets a pass.
    await wa1("d1", { type: "text", text: { body: "hello" } });
    await wa1("d2", { type: "interactive", interactive: { button_reply: { id: "3" } } });
    await wa1("d3", { type: "text", text: { body: "how can i prevent pregnancy" } });
    await wa1("d4", { type: "interactive", interactive: { button_reply: { id: "1" } } });
    await settle(500);
    const code = [...mockWhatsAppSent].reverse().find((m) => m.to === wa && m.payload.type === "text" && /UB-/.test((m.payload as any).text.body));
    const passCode = (code!.payload as any).text.body.match(/UB-[A-Z0-9]{4}/)[0];

    // 2. A girl on SMS reports violence; a Dada claims it and replies from the inbox.
    await request(app).post("/webhooks/sms").type("form").send({ from: "+254712400101", text: "hi", id: "s1" });
    await settle();
    await request(app).post("/webhooks/sms").type("form").send({ from: "+254712400101", text: "3", id: "s2" });
    await settle();
    await request(app).post("/webhooks/sms").type("form").send({ from: "+254712400101", text: "my husband hits me", id: "s3" });
    await settle();
    const [safety] = await db.query(`SELECT c.id FROM cases c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1`, [hashPhone("+254712400101")]);
    expect(mockSmsSent.some((m) => m.to === "254700000777" && m.message.includes(`case #${safety.id}`))).toBe(true);
    const dada = await as("dada");
    await dada.post(`/staff/cases/${safety.id}/claim`);
    await dada.post(`/staff/cases/${safety.id}/reply`, { body: "I'm here with you. Are you safe right now?" });
    expect(mockSmsSent.filter((m) => m.to === "254712400101").at(-1)!.message).toContain("Are you safe right now?");

    // 3. A girl on a feature phone uses USSD urgent help; nobody answers for 20 minutes; nurses are reminded.
    await request(app).post("/webhooks/ussd").type("form").send({ phoneNumber: "+254712400102", text: "3*5*1" });
    const [urgent] = await db.query(`SELECT c.id FROM cases c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1`, [hashPhone("+254712400102")]);
    await db.query(`UPDATE cases SET created_at = now() - interval '20 minutes' WHERE id = $1`, [urgent.id]);
    expect(await remindUnansweredUrgent(db)).toBeGreaterThanOrEqual(1);
    expect(mockSmsSent.filter((m) => m.to === "254700000777").at(-1)!.message).toMatch(new RegExp(`STILL WAITING: urgent case #${urgent.id}.*20 min`));
    const nurse = await as("nurse");
    await nurse.post(`/staff/cases/${urgent.id}/reply`, { body: "A nurse here. Go to the clinic now; I've told them you're coming." });

    // 4. A girl on the app gets a pass for counselling.
    const s = await request(app).post("/app/api/session");
    const call = (m: "post" | "patch", p: string) => request(app)[m](`/app/api${p}`).set("authorization", `Bearer ${s.body.token}`);
    await call("patch", "/me").send({ language: "en" });
    expect((await call("post", "/passes").send({ services: ["counselling"] })).body.code).toMatch(/^UB-/);

    // 5. The clinic desk records the WhatsApp girl's visit by SMS; three days later she rates it.
    await db.query(`UPDATE staff SET phone = '+254711400200', desk_pin_hash = (SELECT password_hash FROM staff WHERE login = 'clinic-a') WHERE login = 'clinic-a'`);
    await request(app).post("/webhooks/sms").type("form").send({ from: "+254711400200", text: `SEEN ${passCode} 0000`, id: "s9" });
    await settle();
    // (The PIN above is wrong on purpose: the desk is told so and nothing is recorded.)
    expect(mockSmsSent.filter((m) => m.to === "254711400200").at(-1)!.message).toBe("Wrong PIN.");
    const clinic = await as("clinic-a");
    await clinic.post("/staff/clinic/redeem", { code: passCode });
    await sendDueCheckins(db, later(73));
    const checkin: any = [...mockWhatsAppSent].reverse().find((m) => m.to === wa)!.payload;
    expect(checkin.type).toBe("interactive"); // her window is open: buttons
    await wa1("d5", { type: "interactive", interactive: { button_reply: { id: "1" } } });
    await settle();
    await wa1("d6", { type: "interactive", interactive: { button_reply: { id: "1" } } });
    await settle();
    const [ci] = await db.query(`SELECT visited, respect, clinic_id FROM checkins WHERE pass_code = $1`, [passCode]);
    expect(ci).toEqual({ visited: true, respect: "yes", clinic_id: 1 });

    // 6. The partner sees it on the dashboard; the monitor sees nothing waiting.
    const partner = await as("partner");
    const dash = await partner.get("/staff/dashboard?days=7");
    expect(dash.text).toContain("Urgent handoffs");
    config.opsKey = "k".repeat(24);
    const ops = await request(app).get(`/health/ops?key=${config.opsKey}`);
    expect(ops.body.urgentUnanswered15m).toBe(0);
  });
});

describe("monitoring and the urgent-case reminder", () => {
  it("is hidden without the key, and reports what needs attention in JSON or Prometheus format", async () => {
    expect((await request(app).get("/health/ops")).status).toBe(404);
    config.opsKey = "o".repeat(24);
    expect((await request(app).get("/health/ops?key=wrong")).status).toBe(404);
    const g = girl(db, "0712400300");
    await g.send("hi");
    await g.send("3");
    await g.send("i want to kill myself");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    await db.query(`UPDATE cases SET created_at = now() - interval '40 minutes' WHERE id = $1`, [c.id]);
    const bad = await request(app).get("/health/ops").set("x-ops-key", config.opsKey);
    expect(bad.status).toBe(503);
    expect(bad.body.urgentUnanswered15m).toBeGreaterThanOrEqual(1);
    expect(bad.body.oldestUrgentUnansweredMin).toBeGreaterThanOrEqual(40);
    const prom = await request(app).get(`/health/ops?key=${config.opsKey}&format=prometheus`);
    expect(prom.text).toMatch(/^# HELP ubah_ok/);
    expect(prom.text).toMatch(/ubah_urgent_unanswered_15m [1-9]/);
    expect((await opsStatus(db)).ok).toBe(false);
  });

  it("reminds nurses every 15 minutes until someone replies", async () => {
    config.nurseAlertNumbers = ["+254700000888"];
    const g = girl(db, "0712400301");
    await g.send("hi");
    await g.send("3");
    await g.send("I am pregnant and bleeding a lot");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    await db.query(`UPDATE cases SET created_at = now() - interval '16 minutes' WHERE id = $1`, [c.id]);
    const count = () => mockSmsSent.filter((m) => m.to === "254700000888" && m.message.includes(`case #${c.id}`) && m.message.includes("STILL WAITING")).length;
    await remindUnansweredUrgent(db);
    expect(count()).toBe(1);
    await remindUnansweredUrgent(db); // too soon
    expect(count()).toBe(1);
    await db.query(`UPDATE cases SET last_reminder_at = now() - interval '16 minutes' WHERE id = $1`, [c.id]);
    await remindUnansweredUrgent(db);
    expect(count()).toBe(2);
    const nurse = await as("nurse");
    await nurse.post(`/staff/cases/${c.id}/reply`, { body: "On my way" });
    await db.query(`UPDATE cases SET last_reminder_at = now() - interval '16 minutes' WHERE id = $1`, [c.id]);
    await remindUnansweredUrgent(db);
    expect(count()).toBe(2); // answered: no more reminders
    expect((await nurse.get(`/staff/cases/${c.id}`)).text).toContain("No reply yet: nurses reminded");
  });
});

describe("load", () => {
  it("handles a burst of 300 new girls on WhatsApp: every request accepted, every girl answered", async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await runLoad({ url: `http://127.0.0.1:${port}`, rate: 150, durationS: 2, kind: "whatsapp", senderPrefix: "2547991" });
      expect(r.sent).toBe(300);
      expect(r.ok).toBe(300);
      expect(r.p95).toBeLessThan(1000); // the webhook answers at once; work continues after
      // Every girl gets her welcome message.
      let answered = 0;
      for (let i = 0; i < 60 && answered < 300; i++) {
        await settle(500);
        answered = (await db.query<{ n: number }>(`SELECT count(DISTINCT to_hash)::int AS n FROM outbox WHERE channel = 'whatsapp' AND body LIKE 'Welcome to Ubah%' AND to_hash IN (SELECT phone_hash FROM users WHERE created_at > now() - interval '5 minutes')`))[0].n;
      }
      expect(answered).toBeGreaterThanOrEqual(300);
    } finally {
      server.close();
    }
  });

  it("handles a burst on SMS too", async () => {
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      const r = await runLoad({ url: `http://127.0.0.1:${port}`, rate: 100, durationS: 1, kind: "sms", senderPrefix: "2547992" });
      expect(r.ok).toBe(100);
      let handled = 0;
      for (let i = 0; i < 60 && handled < 100; i++) {
        await settle(500);
        handled = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM inbound_messages WHERE provider = 'sms' AND provider_id LIKE 'ATload-%' AND processed_at IS NOT NULL`))[0].n;
      }
      expect(handled).toBe(100);
    } finally {
      server.close();
    }
  });
});

describe("demo mode", () => {
  it("loads labelled, made-up activity, never messages a demo girl, and wipes it completely", async () => {
    const realBefore = (await db.query(`SELECT count(*)::int AS n FROM users WHERE NOT demo`))[0].n;
    const r = await loadDemo(db, { girls: 60, weeks: 6 });
    expect(r.girls).toBe(60);
    expect(r.cases).toBeGreaterThan(0);
    expect(r.passes).toBeGreaterThan(0);
    expect(await hasDemoData(db)).toBe(true);
    const names = (await db.query(`SELECT name FROM clinics WHERE demo`)).map((c) => c.name);
    expect(names.every((n) => n.startsWith("[DEMO]"))).toBe(true);
    await refreshCaches(db, { force: true });
    const admin = await as("admin");
    expect((await admin.get("/staff/inbox?status=handled")).text).toContain("DEMO DATA");
    expect((await admin.get("/staff/dashboard?days=90")).text).toMatch(/Clinic 4/);
    // Replying to a demo case sends nothing.
    const [c] = await db.query(`SELECT c.id FROM cases c JOIN users u ON u.id = c.user_id WHERE u.demo LIMIT 1`);
    const outboxBefore = (await db.query(`SELECT count(*)::int AS n FROM outbox`))[0].n;
    await (await as("nurse")).post(`/staff/cases/${c.id}/reply`, { body: "test" });
    expect((await db.query(`SELECT count(*)::int AS n FROM outbox`))[0].n).toBe(outboxBefore);
    (config as any).production = true;
    await expect(loadDemo(db)).rejects.toThrow(/never loaded in production/);
    (config as any).production = false;
    await wipeDemo(db);
    expect(await hasDemoData(db)).toBe(false);
    expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE demo`))[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE NOT demo`))[0].n).toBeGreaterThanOrEqual(realBefore); // no real girl touched
    expect((await db.query(`SELECT count(*)::int AS n FROM staff WHERE demo`))[0].n).toBe(0);
    await refreshCaches(db, { force: true });
    expect((await admin.get("/staff/inbox")).text).not.toContain("DEMO DATA");
  });
});

describe("pilot documents", () => {
  it("exist and are clearly marked DRAFT for partners to complete", () => {
    for (const f of ["docs/deployment.md", "docs/dpia-template.md", "docs/privacy-notice-girls.md", "docs/safeguarding-procedure.md"]) {
      const path = new URL(`../${f}`, import.meta.url);
      expect(existsSync(path), f).toBe(true);
      if (f !== "docs/deployment.md") expect(readFileSync(path, "utf8"), f).toMatch(/DRAFT/);
    }
  });
});
