import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, girl, staffClient, csrfFrom, totpFor, lastSmsCode, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { hashPassword } from "../src/privacy.js";
import { mockSmsSent } from "../src/channels/sms.js";
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

async function addStaff(login: string, role: string, opts: { password?: string; mustChange?: boolean; phone?: string | null; clinicId?: number | null } = {}) {
  await db.query(`INSERT INTO staff (name, role, login, password_hash, must_change_password, phone, clinic_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    `Test ${login}`,
    role,
    login,
    hashPassword(opts.password ?? "test-pass"),
    opts.mustChange ?? false,
    opts.phone ?? null,
    opts.clinicId ?? (role === "clinic" ? 1 : null),
  ]);
}

async function passwordStep(login: string, password = "test-pass") {
  const agent = request.agent(app);
  const csrf = csrfFrom((await agent.get("/staff/login")).text);
  const res = await agent.post("/staff/login").type("form").send({ login, password, _csrf: csrf });
  return { agent, csrf, res };
}

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});

describe("HTTP hardening", () => {
  it("sends security headers and never caches staff pages", async () => {
    const res = await request(app).get("/staff/login");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["content-security-policy"]).not.toContain("unsafe-inline' 'self'; script");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("rejects oversized requests", async () => {
    const big = await request(app).post("/webhooks/sms").type("form").send({ from: "+254711000099", text: "x".repeat(40_000) });
    expect(big.status).toBe(413);
    const bigJson = await request(app).post("/webhooks/whatsapp").send({ pad: "x".repeat(300_000) });
    expect(bigJson.status).toBe(413);
  });

  it("returns a 404 page for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.text).toContain("not found");
  });

  it("rate-limits webhooks and login", async () => {
    const limited = createApp(db, { loginPerMin: 2, webhookPerMin: 2 });
    const hook = () => request(limited).post("/webhooks/sms").type("form").send({});
    expect((await hook()).status).toBe(400);
    expect((await hook()).status).toBe(400);
    const third = await hook();
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeTruthy();

    const agent = request.agent(limited);
    const csrf = csrfFrom((await agent.get("/staff/login")).text);
    const tries = [];
    for (let i = 0; i < 3; i++) tries.push((await agent.post("/staff/login").type("form").send({ login: "nobody", password: "x", _csrf: csrf })).status);
    expect(tries).toEqual([302, 302, 429]);
  });
});

describe("CSRF protection", () => {
  it("blocks the login form without a valid token", async () => {
    const agent = request.agent(app);
    await agent.get("/staff/login");
    expect((await agent.post("/staff/login").type("form").send({ login: "admin", password: "test-pass" })).status).toBe(403);
    expect((await agent.post("/staff/login").type("form").send({ login: "admin", password: "test-pass", _csrf: "forged" })).status).toBe(403);
    // A token from another browser's cookie doesn't work either.
    const other = csrfFrom((await request(app).get("/staff/login")).text);
    expect((await agent.post("/staff/login").type("form").send({ login: "admin", password: "test-pass", _csrf: other })).status).toBe(403);
  });

  it("blocks signed-in actions without a token", async () => {
    const nurse = await as("nurse");
    const res = await nurse.agent.post("/staff/label").type("form").send({ message_id: "1", danger: "none", topic: "body" });
    expect(res.status).toBe(403);
    expect((await nurse.agent.post("/staff/logout").type("form").send({})).status).toBe(403);
  });
});

describe("password login, lockout and sessions", () => {
  it("locks an account after repeated wrong passwords, even for the right password", async () => {
    await addStaff("lockme", "clinic");
    for (let i = 0; i < 5; i++) await passwordStep("lockme", "wrong-password");
    const [s] = await db.query(`SELECT locked_until FROM staff WHERE login = 'lockme'`);
    expect(new Date(s.locked_until).getTime()).toBeGreaterThan(Date.now());
    const { res } = await passwordStep("lockme");
    expect(res.headers.location).toContain("error");
    const audit = await db.query(`SELECT action FROM audit_log WHERE staff_login = 'lockme' ORDER BY id`);
    expect(audit.map((a) => a.action)).toContain("login.locked");
    // After the lock expires she can log in again.
    await db.query(`UPDATE staff SET locked_until = now() - interval '1 minute' WHERE login = 'lockme'`);
    expect((await passwordStep("lockme")).res.headers.location).toBe("/staff/clinic");
  });

  it("ends the session on logout and on deactivation", async () => {
    await addStaff("desk2", "clinic");
    const c = await staffClient(app, db, "desk2");
    expect((await c.get("/staff/clinic")).status).toBe(200);
    await c.post("/staff/logout");
    expect((await c.get("/staff/clinic")).status).toBe(302);

    const d = await staffClient(app, db, "desk2");
    await db.query(`UPDATE staff SET active = FALSE WHERE login = 'desk2'`);
    const after = await d.get("/staff/clinic");
    expect(after.status).toBe(302);
    expect(after.headers.location).toContain("/staff/login");
  });

  it("ignores off-site redirects after login", async () => {
    await addStaff("desk3", "clinic");
    const agent = request.agent(app);
    const csrf = csrfFrom((await agent.get("/staff/login?next=//evil.example")).text);
    const res = await agent.post("/staff/login").type("form").send({ login: "desk3", password: "test-pass", next: "//evil.example", _csrf: csrf });
    expect(res.headers.location).toBe("/staff/clinic");
  });

  it("forces a password change, enforces the rules and signs out other devices", async () => {
    await addStaff("newdesk", "clinic", { mustChange: true });
    const other = await staffClient(app, db, "newdesk");
    const c = await staffClient(app, db, "newdesk");
    expect((await c.get("/staff/clinic")).headers.location).toBe("/staff/password");
    const weak = await c.post("/staff/password", { current: "test-pass", new: "short", confirm: "short" });
    expect(weak.text).toContain("at least 12 characters");
    const wrong = await c.post("/staff/password", { current: "nope", new: "camels drink at the well", confirm: "camels drink at the well" });
    expect(wrong.text).toContain("current password is wrong");
    const ok = await c.post("/staff/password", { current: "test-pass", new: "camels drink at the well", confirm: "camels drink at the well" });
    expect(ok.headers.location).toBe("/staff/clinic");
    expect((await c.get("/staff/clinic")).status).toBe(200);
    expect((await other.get("/staff/clinic")).status).toBe(302); // old device signed out
    expect((await passwordStep("newdesk", "camels drink at the well")).res.headers.location).toBe("/staff/clinic");
  });
});

describe("two-step login", () => {
  it("keeps half-signed-in staff out of every page", async () => {
    const { agent, res } = await passwordStep("partner");
    expect(String(res.headers.location)).toMatch(/\/staff\/2fa/);
    const inbox = await agent.get("/staff/dashboard");
    expect(inbox.status).toBe(302);
    expect(inbox.headers.location).toBe("/staff/2fa");
  });

  it("enrols an authenticator app, stores the secret encrypted and gives recovery codes", async () => {
    await addStaff("nurse2", "nurse");
    const { agent, csrf, res } = await passwordStep("nurse2");
    expect(res.headers.location).toBe("/staff/2fa/setup");
    const setup = await agent.get("/staff/2fa/setup");
    expect(setup.text).toContain("<svg");
    const [row] = await db.query(`SELECT totp_secret_enc FROM staff WHERE login = 'nurse2'`);
    expect(setup.text).not.toContain(row.totp_secret_enc);
    const bad = await agent.post("/staff/2fa/setup").type("form").send({ code: "000000", _csrf: csrf });
    expect(bad.headers.location).toContain("error");
    const ok = await agent.post("/staff/2fa/setup").type("form").send({ code: await totpFor(db, "nurse2"), _csrf: csrf });
    expect(ok.text).toContain("recovery codes");
    const codes = [...ok.text.matchAll(/<li>([A-Z0-9]{4}-[A-Z0-9]{4})<\/li>/g)].map((m) => m[1]);
    expect(codes).toHaveLength(8);
    expect((await agent.get("/staff/inbox")).status).toBe(200);

    // A recovery code works exactly once.
    const again = await passwordStep("nurse2");
    const used = await again.agent.post("/staff/2fa").type("form").send({ recovery: codes[0].toLowerCase(), _csrf: again.csrf });
    expect(used.headers.location).toBe("/staff/inbox");
    const third = await passwordStep("nurse2");
    const reused = await third.agent.post("/staff/2fa").type("form").send({ recovery: codes[0], _csrf: third.csrf });
    expect(reused.headers.location).toContain("error");
  });

  it("refuses a code that was already used", async () => {
    await addStaff("partner2", "partner");
    await staffClient(app, db, "partner2"); // enrols and uses one code
    const [s] = await db.query(`SELECT totp_secret_enc, totp_last_step FROM staff WHERE login = 'partner2'`);
    const { totpAt } = await import("../src/security/totp.js");
    const { decryptSecret } = await import("../src/privacy.js");
    const usedCode = totpAt(decryptSecret(s.totp_secret_enc), Number(s.totp_last_step));
    const { agent, csrf } = await passwordStep("partner2");
    const res = await agent.post("/staff/2fa").type("form").send({ code: usedCode, _csrf: csrf });
    expect(res.headers.location).toContain("error");
  });

  it("locks the account after too many wrong codes", async () => {
    await addStaff("partner3", "partner");
    await staffClient(app, db, "partner3");
    const { agent, csrf } = await passwordStep("partner3");
    let last;
    for (let i = 0; i < 5; i++) last = await agent.post("/staff/2fa").type("form").send({ code: "000000", _csrf: csrf });
    expect(last!.headers.location).toContain("/staff/login?error");
    const [s] = await db.query(`SELECT locked_until FROM staff WHERE login = 'partner3'`);
    expect(s.locked_until).toBeTruthy();
  });

  it("sends Dadas a one-time SMS code that expires and can't be guessed forever", async () => {
    await addStaff("dada2", "dada", { phone: "+254700000222" });
    const { agent, csrf, res } = await passwordStep("dada2");
    expect(res.headers.location).toBe("/staff/2fa");
    const code = lastSmsCode("254700000222");
    expect(code).toMatch(/^\d{6}$/);
    const [otp] = await db.query(`SELECT code_hash FROM staff_otp ORDER BY id DESC LIMIT 1`);
    expect(otp.code_hash).not.toContain(code);
    expect((await agent.post("/staff/2fa").type("form").send({ code: code === "111111" ? "222222" : "111111", _csrf: csrf })).headers.location).toContain("error");
    // Asking again within a minute is refused.
    expect((await agent.post("/staff/2fa/resend").type("form").send({ _csrf: csrf })).headers.location).toContain("wait");
    const ok = await agent.post("/staff/2fa").type("form").send({ code, _csrf: csrf });
    expect(ok.headers.location).toBe("/staff/inbox");

    // An expired code is refused.
    const second = await passwordStep("dada2");
    await db.query(`UPDATE staff_otp SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    const late = await second.agent.post("/staff/2fa").type("form").send({ code: lastSmsCode("254700000222"), _csrf: second.csrf });
    expect(late.headers.location).toContain("error");
    expect(mockSmsSent.some((m) => m.message.includes("Ubah login code"))).toBe(true);
  });

  it("tells a Dada with no phone number to ask an admin", async () => {
    await addStaff("dada3", "dada", { phone: null });
    const { agent, res } = await passwordStep("dada3");
    const page = await agent.get(String(res.headers.location));
    expect(page.text).toContain("no phone number");
    expect((await agent.get("/staff/inbox")).status).toBe(302);
  });
});

describe("audit log", () => {
  it("records who viewed a case and who sent which message", async () => {
    const g = girl(db, "0712000901");
    await g.send("hi");
    await g.send("3");
    await g.send("i want to kill myself");
    const [c] = await db.query(`SELECT id FROM cases ORDER BY id DESC LIMIT 1`);
    const nurse = await as("nurse");
    await nurse.get(`/staff/cases/${c.id}`);
    await nurse.post(`/staff/cases/${c.id}/reply`, { body: "I'm here with you.", handled: "1" });
    const rows = await db.query(`SELECT action, staff_login, details FROM audit_log WHERE target_type = 'case' AND target_id = $1 ORDER BY id`, [String(c.id)]);
    expect(rows.map((r) => r.action)).toEqual(["case.view", "case.reply", "case.handled"]);
    expect(rows.every((r) => r.staff_login === "nurse")).toBe(true);
    const [m] = await db.query(`SELECT sent_by_staff, body FROM messages WHERE id = $1`, [rows[1].details.messageId]);
    expect(m.body).toBe("I'm here with you.");
    expect(m.sent_by_staff).toBeTruthy();
    // The log itself never holds the message text.
    expect(JSON.stringify(rows)).not.toContain("here with you");
  });

  it("shows the log to admins only, with filters", async () => {
    expect((await (await as("nurse")).get("/staff/audit")).status).toBe(403);
    const admin = await as("admin");
    const all = await admin.get("/staff/audit");
    expect(all.status).toBe(200);
    expect(all.text).toContain("case.view");
    const filtered = await admin.get("/staff/audit?action=login.locked");
    expect(filtered.text).toContain("lockme");
    expect(filtered.text).toContain('<span class="tag">login.locked</span>');
    expect(filtered.text).not.toContain('<span class="tag">case.view</span>');
    const [viewed] = await db.query(`SELECT 1 FROM audit_log WHERE action = 'audit.view' AND staff_login = 'admin'`);
    expect(viewed).toBeTruthy();
  });
});
