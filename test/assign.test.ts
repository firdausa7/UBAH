import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { encryptPhone, hashPhone, newAnonId } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
// One sign-in for the whole file: an authenticator code can't be reused within 30 seconds.
let adminClient: Awaited<ReturnType<typeof staffClient>> | null = null;
const signedInAdmin = async () => (adminClient ??= await staffClient(app, db, "admin"));
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

    const admin = (await signedInAdmin()).agent;
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

  it("gives a departing worker's girls back to the admin, and reassigns them", async () => {
    const admin = (await signedInAdmin()).agent;
    const [dada] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    const before = await db.query(`SELECT girl_id FROM assignments WHERE health_worker_id = $1 AND ended_at IS NULL`, [dada.id]);
    expect(before.length).toBeGreaterThan(0);
    // An older assignment left open to an inactive account (before this fix) is treated as none, too.
    await db.query(`UPDATE staff SET active = FALSE WHERE id = $1`, [dada.id]);
    const listed = (await admin.get("/api/admin/girls")).body.girls;
    for (const g of before) expect(listed.find((x: any) => x.id === g.girl_id).worker).toBeNull();
    const r = await admin.post("/api/admin/assign-unassigned").set("x-ubah", "1");
    expect(r.body.assigned).toBeGreaterThan(0); // the Somali ones go to the nurse
    await db.query(`UPDATE staff SET active = TRUE WHERE id = $1`, [dada.id]);
  });

  it("the Deactivate button in Staff tools unassigns that worker's girls", async () => {
    const admin = await signedInAdmin();
    const [dada] = await db.query(`SELECT id FROM staff WHERE login = 'dada'`);
    const g = await girlIn("sw", "0712950009");
    await db.query(`INSERT INTO assignments (health_worker_id, girl_id) VALUES ($1,$2)`, [dada.id, g]);
    expect((await admin.post(`/staff/admin/staff/${dada.id}/deactivate`)).status).toBe(302);
    expect((await db.query(`SELECT 1 FROM assignments WHERE girl_id = $1 AND ended_at IS NULL`, [g])).length).toBe(0);
    const [a] = await db.query(`SELECT details FROM audit_log WHERE action = 'staff.deactivate' ORDER BY id DESC LIMIT 1`);
    expect(a.details.girlsUnassigned).toBeGreaterThan(0);
    await db.query(`UPDATE staff SET active = TRUE, deactivated_at = NULL WHERE id = $1`, [dada.id]);
  });

  it("ends a worker's assignments when they are deactivated or stop being a nurse or Dada", async () => {
    const { endAssignmentsOf } = await import("../src/auth/access.js");
    const [nurse] = await db.query(`SELECT id FROM staff WHERE login = 'nurse'`);
    const open = (await db.query(`SELECT count(*)::int AS n FROM assignments WHERE health_worker_id = $1 AND ended_at IS NULL`, [nurse.id]))[0].n;
    expect(open).toBeGreaterThan(0);
    expect(await endAssignmentsOf(db, nurse.id)).toBe(open);
    expect((await db.query(`SELECT count(*)::int AS n FROM assignments WHERE health_worker_id = $1 AND ended_at IS NULL`, [nurse.id]))[0].n).toBe(0);
  });
});
