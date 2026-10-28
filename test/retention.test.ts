import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { freshDb } from "./helpers.js";
import { config, loadConfig } from "../src/config.js";
import { applyRetention, retentionPlan } from "../src/retention.js";
import { encryptPhone, hashPhone, newAnonId } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
const saved = { ...config.retention };
beforeAll(async () => {
  db = await freshDb();
});
afterEach(() => Object.assign(config.retention, saved));

async function girl(phone: string, lastSeenDaysAgo: number) {
  const [u] = await db.query(
    `INSERT INTO users (anon_id, phone_hash, phone_enc, channel, language, last_seen_at) VALUES ($1,$2,$3,'sms','so', now() - make_interval(days => $4)) RETURNING id`,
    [newAnonId(), hashPhone(phone), encryptPhone(phone), lastSeenDaysAgo],
  );
  await db.query(`INSERT INTO messages (user_id, direction, channel, body, created_at) VALUES ($1,'in','sms','old question', now() - make_interval(days => $2)), ($1,'in','sms','new question', now())`, [u.id, lastSeenDaysAgo]);
  return u.id as number;
}
const exists = async (id: number) => (await db.query(`SELECT 1 FROM users WHERE id = $1`, [id])).length === 1;
const messagesOf = async (id: number) => (await db.query(`SELECT body FROM messages WHERE user_id = $1 ORDER BY id`, [id])).map((m: any) => m.body);

describe("retention", () => {
  it("needs periods to delete, and never less than 30 days", () => {
    expect(() => loadConfig({ RETENTION_MODE: "delete" })).toThrow(/RETENTION_INACTIVE_DAYS/);
    expect(() => loadConfig({ RETENTION_MODE: "delete", RETENTION_INACTIVE_DAYS: "7" })).toThrow();
    expect(loadConfig({}).retention).toEqual({ mode: "off", inactiveDays: null, messageDays: null });
  });

  it("is off by default; 'report' counts and deletes nothing; 'delete' deletes, sparing girls with an open case", async () => {
    await db.query(`DELETE FROM users`);
    const gone = await girl("0712980001", 400);
    const protectedGirl = await girl("0712980002", 400);
    await db.query(`INSERT INTO cases (user_id, reason, urgent, summary) VALUES ($1,'asked_for_person',FALSE,'still being helped')`, [protectedGirl]);
    const active = await girl("0712980003", 200); // active recently? no: 200 days, but under the account limit
    await db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [active]);

    expect(await applyRetention(db)).toBeNull(); // off
    expect(await exists(gone)).toBe(true);

    Object.assign(config.retention, { mode: "report", inactiveDays: 365, messageDays: 180 });
    expect(await applyRetention(db)).toMatchObject({ inactiveGirls: 1, oldMessages: 2 });
    expect(await exists(gone)).toBe(true); // report deletes nothing

    Object.assign(config.retention, { mode: "delete" });
    await applyRetention(db);
    expect(await exists(gone)).toBe(false); // a year without activity: erased entirely
    expect(await exists(protectedGirl)).toBe(true); // open case: untouched
    expect(await messagesOf(protectedGirl)).toEqual(["old question", "new question"]);
    expect(await messagesOf(active)).toEqual(["new question"]); // her account stays; old messages go
    expect((await db.query(`SELECT details FROM audit_log WHERE action = 'retention.applied'`)).length).toBe(1);
    expect(await retentionPlan(db)).toMatchObject({ inactiveGirls: 0, oldMessages: 0 });
  });
});
