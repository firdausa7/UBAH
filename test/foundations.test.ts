import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config.js";
import { createDb } from "../src/db.js";
import { migrate, migrationStatus, MIGRATIONS_DIR } from "../src/migrate.js";
import { base32Encode, totpAt, verifyTotp, otpauthUri } from "../src/security/totp.js";
import { passwordProblem, encryptSecret, decryptSecret } from "../src/privacy.js";

const PROD_OK = {
  NODE_ENV: "production",
  BASE_URL: "https://ubah.example.org",
  DATABASE_URL: "postgres://u:p@db:5432/ubah",
  HASH_SECRET: "h".repeat(40),
  SESSION_SECRET: "s".repeat(40),
  ENCRYPTION_KEY: "ab".repeat(32),
  ALLOW_DRAFT_CONTENT: "false",
  SEED_DEMO: "false",
  NURSE_ALERT_NUMBERS: "+254700000009",
  AT_USERNAME: "ubah",
  AT_API_KEY: "key",
  SMS_WEBHOOK_KEY: "k".repeat(20),
  GOOGLE_TRANSLATE_API_KEY: "translate-key",
};

describe("config validation", () => {
  it("runs with no settings in development (mock mode)", () => {
    const c = loadConfig({});
    expect(c.production).toBe(false);
    expect(c.simulator).toBe(true);
    expect(c.security.mfaRequired).toBe(true);
    expect(c.baseUrl).toBe("http://localhost:3000");
  });

  it("explains every bad value at once", () => {
    try {
      loadConfig({ PORT: "abc", ENCRYPTION_KEY: "short", ALLOW_DRAFT_CONTENT: "maybe" });
      throw new Error("should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain("PORT");
      expect(msg).toContain("ENCRYPTION_KEY: must be 32 bytes");
      expect(msg).toContain("ALLOW_DRAFT_CONTENT");
    }
  });

  it("accepts a complete production configuration", () => {
    const c = loadConfig(PROD_OK);
    expect(c.production).toBe(true);
    expect(c.simulator).toBe(false);
    expect(c.allowDraftContent).toBe(false);
  });

  it("refuses production with demo secrets, draft content, no nurse to alert or 2FA off", () => {
    const bad = { ...PROD_OK, HASH_SECRET: "", ALLOW_DRAFT_CONTENT: "true", NURSE_ALERT_NUMBERS: "", MFA_REQUIRED: "false", SEED_DEMO: "true", BASE_URL: "http://x.org" };
    try {
      loadConfig(bad);
      throw new Error("should fail");
    } catch (err) {
      const p = (err as ConfigError).problems.join("\n");
      expect(p).toMatch(/HASH_SECRET/);
      expect(p).toMatch(/ALLOW_DRAFT_CONTENT/);
      expect(p).toMatch(/NURSE_ALERT_NUMBERS.*human/);
      expect(p).toMatch(/MFA_REQUIRED/);
      expect(p).toMatch(/SEED_DEMO/);
      expect(p).toMatch(/https/);
    }
  });

  it("requires webhook secrets once real channels are switched on", () => {
    expect(() => loadConfig({ ...PROD_OK, WHATSAPP_TOKEN: "t" })).toThrow(/WHATSAPP_APP_SECRET/);
    expect(() => loadConfig({ ...PROD_OK, SMS_WEBHOOK_KEY: "" })).toThrow(/SMS_WEBHOOK_KEY/);
  });
});

describe("migrations", () => {
  it("applies every numbered migration once and records it", async () => {
    const db = await createDb({ memory: true });
    const status = await migrationStatus(db);
    expect(status.length).toBeGreaterThanOrEqual(2);
    expect(status.every((s) => s.appliedAt)).toBe(true);
    expect(await migrate(db)).toEqual([]); // second run does nothing
    await db.close();
  });

  it("refuses to run when an applied migration was edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubah-mig-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const db = await createDb({ memory: true, migrate: false });
    await migrate(db, { dir });
    writeFileSync(join(dir, "0001_initial.sql"), "-- edited\nSELECT 1;");
    await expect(migrate(db, { dir })).rejects.toThrow(/changed after it was applied/);
    await db.close();
  });

  it("applies a new migration and rolls back a broken one completely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ubah-mig-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const db = await createDb({ memory: true, migrate: false });
    await migrate(db, { dir });
    writeFileSync(join(dir, "0900_ok.sql"), "CREATE TABLE extra_ok (id int);");
    writeFileSync(join(dir, "0901_broken.sql"), "CREATE TABLE extra_broken (id int); SELECT * FROM no_such_table;");
    await expect(migrate(db, { dir })).rejects.toThrow();
    // All-or-nothing: neither file is recorded or half-applied.
    const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'extra_%'`);
    expect(tables).toEqual([]);
    await db.close();
  });

  it("keeps the audit log append-only", async () => {
    const db = await createDb({ memory: true });
    await db.query(`INSERT INTO audit_log (action) VALUES ('login.success')`);
    await expect(db.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    await db.close();
  });
});

describe("two-step login codes", () => {
  it("matches the RFC 6238 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpAt(secret, 1)).toBe("287082"); // T = 59s
    expect(totpAt(secret, 37037036)).toBe("081804"); // T = 1111111109s
  });

  it("allows one step of clock drift and blocks re-use", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = 59_000 + 30_000 * 100;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpAt(secret, step), null, now)).toBe(step);
    expect(verifyTotp(secret, totpAt(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(secret, step - 3), null, now)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull(); // replay
    expect(verifyTotp(secret, "abc", null, now)).toBeNull();
    expect(otpauthUri(secret, "amina")).toMatch(/^otpauth:\/\/totp\/Ubah%3Aamina\?secret=/);
  });
});

describe("privacy helpers", () => {
  it("encrypts secrets so they can't be read from the database", () => {
    const blob = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(blob).not.toContain("JBSWY3DP");
    expect(decryptSecret(blob)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("enforces the staff password rules", () => {
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("aaaaaaaaaaaaaa")).toMatch(/repeat/);
    expect(passwordProblem("amina-is-my-password", "amina")).toMatch(/login/);
    expect(passwordProblem("change-me-now")).not.toBeNull();
    expect(passwordProblem("camels drink at the well")).toBeNull();
  });
});
