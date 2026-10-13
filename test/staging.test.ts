import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { freshDb, csrfFrom } from "./helpers.js";
import { loadConfig, config } from "../src/config.js";
import { createApp, bootstrapAdmin } from "../src/server.js";
import { loadDemo, wipeDemo } from "../src/demo.js";
import type { Db } from "../src/db.js";

const SECRETS = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@db:5432/ubah",
  HASH_SECRET: "h".repeat(44),
  SESSION_SECRET: "s".repeat(44),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), // what Render generates
  SEED_DEMO: "false",
};

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterEach(() => {
  (config as any).stage = "development";
  config.bootstrapAdmin = null;
});

describe("online test version (staging)", () => {
  it("runs before SMS/WhatsApp accounts exist, but still demands real secrets, https and Postgres", () => {
    const c = loadConfig({ ...SECRETS, DEPLOY_STAGE: "staging", RENDER_EXTERNAL_URL: "https://ubah-test.onrender.com", ALLOW_DRAFT_CONTENT: "true" });
    expect(c.stage).toBe("staging");
    expect(c.baseUrl).toBe("https://ubah-test.onrender.com");
    expect(c.encryptionKey).toBe("07".repeat(32)); // base64 key accepted, stored as hex
    expect(c.simulator).toBe(true);
    expect(() => loadConfig({ ...SECRETS, DEPLOY_STAGE: "staging", HASH_SECRET: "" })).toThrow(/HASH_SECRET/);
    expect(() => loadConfig({ ...SECRETS, DEPLOY_STAGE: "staging", RENDER_EXTERNAL_URL: "https://x.onrender.com", MFA_REQUIRED: "false" })).toThrow(/MFA_REQUIRED/);
    expect(() => loadConfig({ ...SECRETS, DEPLOY_STAGE: "staging", RENDER_EXTERNAL_URL: "https://x.onrender.com", SEED_DEMO: "true" })).toThrow(/SEED_DEMO/);
    expect(() => loadConfig({ ...SECRETS, DEPLOY_STAGE: "staging" })).toThrow(/BASE_URL/);
    // The real service still refuses all of that.
    expect(() => loadConfig({ ...SECRETS, RENDER_EXTERNAL_URL: "https://x.onrender.com", ALLOW_DRAFT_CONTENT: "true" })).toThrow(/ALLOW_DRAFT_CONTENT[\s\S]*NURSE_ALERT_NUMBERS[\s\S]*AT_API_KEY/);
    expect(() => loadConfig({ ENCRYPTION_KEY: "not-a-key" })).toThrow(/32 bytes/);
  });

  it("labels every page TEST VERSION", async () => {
    (config as any).stage = "staging";
    const app = createApp(db);
    expect((await request(app).get("/")).text).toContain("TEST VERSION");
    expect((await request(app).get("/staff/login")).text).toContain("TEST VERSION");
    expect((await request(app).get("/app/api/strings")).body.stage).toBe("staging");
  });

  it("creates the first admin from settings once; she must choose her own password", async () => {
    config.bootstrapAdmin = { login: "amina", password: "first-password-123" };
    await db.query(`UPDATE staff SET active = FALSE WHERE role = 'admin'`);
    expect(await bootstrapAdmin(db)).toBe(true);
    expect(await bootstrapAdmin(db)).toBe(false); // an admin exists now
    const app = createApp(db);
    const agent = request.agent(app);
    const csrf = csrfFrom((await agent.get("/staff/login")).text);
    const res = await agent.post("/staff/login").type("form").send({ login: "amina", password: "first-password-123", _csrf: csrf });
    expect(res.headers.location).toBe("/staff/2fa/setup"); // two-step login first, then the forced password change
    const [s] = await db.query(`SELECT must_change_password FROM staff WHERE login = 'amina'`);
    expect(s.must_change_password).toBe(true);
    await db.query(`UPDATE staff SET active = TRUE WHERE role = 'admin'`);
  });

  it("allows demo data on the test version, never on the real service", async () => {
    (config as any).production = true;
    (config as any).stage = "staging";
    try {
      expect((await loadDemo(db, { girls: 5, weeks: 1 })).girls).toBe(5);
      (config as any).stage = "production";
      await expect(loadDemo(db)).rejects.toThrow(/never loaded in production/);
    } finally {
      (config as any).production = false;
      await wipeDemo(db);
    }
  });
});
