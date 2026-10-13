import { describe, it, expect, beforeAll } from "vitest";
import { freshDb } from "./helpers.js";
import { safePath } from "../src/log.js";
import { housekeeping } from "../src/jobs/handlers.js";
import type { Db } from "../src/db.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});

describe("fixes from the pre-pilot review", () => {
  it("never writes one-time links or the M-Pesa callback token to the logs", () => {
    expect(safePath("/staff/invite/AbC_123-secret?x=1")).toBe("/staff/invite/[redacted]");
    expect(safePath("/webhooks/mpesa/cb-token-xyz/result")).toBe("/webhooks/mpesa/[redacted]/result");
    expect(safePath("/webhooks/sms?key=secret")).toBe("/webhooks/sms");
    expect(safePath("/staff/cases/12")).toBe("/staff/cases/12");
  });

  it("cleans up ended sessions, used links, old login codes and old finished jobs", async () => {
    const [s] = await db.query(`SELECT id FROM staff LIMIT 1`);
    await db.query(`INSERT INTO staff_sessions (token_hash, staff_id, expires_at, created_at, revoked_at) VALUES ('old', $1, now() - interval '40 days', now() - interval '41 days', now() - interval '40 days'), ('live', $1, now() + interval '1 hour', now(), NULL)`, [s.id]);
    await db.query(`INSERT INTO staff_otp (staff_id, code_hash, expires_at, created_at) VALUES ($1, 'x', now() - interval '2 days', now() - interval '2 days')`, [s.id]);
    await db.query(`INSERT INTO jobs (type, status, finished_at) VALUES ('x', 'done', now() - interval '40 days'), ('y', 'done', now())`);
    await housekeeping(db);
    expect((await db.query(`SELECT token_hash FROM staff_sessions WHERE token_hash IN ('old','live')`)).map((r) => r.token_hash)).toEqual(["live"]);
    expect((await db.query(`SELECT count(*)::int AS n FROM staff_otp WHERE code_hash = 'x'`))[0].n).toBe(0);
    expect((await db.query(`SELECT type FROM jobs WHERE type IN ('x','y')`)).map((r) => r.type)).toEqual(["y"]);
  });
});
