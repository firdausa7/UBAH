import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { encryptPhone, hashPhone, newAnonId } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
});

async function girlIn(language: string, phone: string) {
  const [u] = await db.query(`INSERT INTO users (anon_id, phone_hash, phone_enc, channel, language) VALUES ($1,$2,$3,'web',$4) RETURNING id`, [newAnonId(), hashPhone(phone), encryptPhone(phone), language]);
  return u.id as number;
}

describe("assigning unassigned girls by language", () => {
  it("gives each girl to a worker who speaks her language, evenly, and reports those no worker speaks", async () => {
    await db.query(`DELETE FROM assignments`);
    await db.query(`UPDATE staff SET languages = '{}' WHERE role IN ('nurse','dada')`);
    await db.query(`UPDATE staff SET languages = '{so,en}' WHERE login = 'nurse'`);
    await db.query(`UPDATE staff SET languages = '{so,sw}' WHERE login = 'dada'`);
    await db.query(`DELETE FROM users`);
    const so1 = await girlIn("so", "0712950001");
    const so2 = await girlIn("so", "0712950002");
    const sw1 = await girlIn("sw", "0712950003");
    await girlIn("om", "0712950004");

    const admin = (await staffClient(app, db, "admin")).agent;
    expect((await request(app).post("/api/admin/assign-unassigned").set("x-ubah", "1")).status).toBe(401);
    const r = await admin.post("/api/admin/assign-unassigned").set("x-ubah", "1");
    expect(r.body).toEqual({ assigned: 3, noWorker: { om: 1 } });

    const who = async (girl: number) => (await db.query(`SELECT s.login FROM assignments a JOIN staff s ON s.id = a.health_worker_id WHERE a.girl_id = $1 AND a.ended_at IS NULL`, [girl]))[0]?.login;
    expect(await who(sw1)).toBe("dada"); // only the Dada speaks Kiswahili
    expect(new Set([await who(so1), await who(so2)])).toEqual(new Set(["nurse", "dada"]));
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'girl.assign_by_language'`)).length).toBe(1);

    // Running it again changes nothing for girls who already have a worker.
    expect((await admin.post("/api/admin/assign-unassigned").set("x-ubah", "1")).body).toEqual({ assigned: 0, noWorker: { om: 1 } });
  });
});
