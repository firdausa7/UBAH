import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { freshDb, girl } from "./helpers.js";
import { config } from "../src/config.js";
import { setDb, type Db } from "../src/db.js";
import { enqueue, registerJob, runDueJobs, recoverStale, startWorker, RetryLater } from "../src/jobs/queue.js";
import { registerAllJobs, scheduleNextSweep } from "../src/jobs/handlers.js";
import { transports } from "../src/channels/outbound.js";
import { sendDueCheckins } from "../src/engine.js";
import { createApp, start } from "../src/server.js";
import { hashPhone } from "../src/privacy.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";

let db: Db;
const realSms = transports.sms;
const realWa = transports.whatsapp;
const later = (h: number) => new Date(Date.now() + h * 3600e3);

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  registerAllJobs();
  db = await freshDb();
});
afterEach(() => {
  transports.sms = realSms;
  transports.whatsapp = realWa;
  config.nurseAlertNumbers = [];
});

describe("job queue", () => {
  it("runs due jobs once and leaves future jobs alone", async () => {
    const seen: number[] = [];
    registerJob("test.echo", async (_db, job) => {
      seen.push(job.payload.n);
    });
    await enqueue(db, "test.echo", { n: 1 });
    await enqueue(db, "test.echo", { n: 2 }, { runAt: later(1) });
    await runDueJobs(db);
    expect(seen).toEqual([1]);
    await runDueJobs(db, { now: later(2) });
    expect(seen).toEqual([1, 2]);
    await runDueJobs(db, { now: later(3) });
    expect(seen).toEqual([1, 2]);
  });

  it("ignores a duplicate while the first is still waiting", async () => {
    const a = await enqueue(db, "test.echo", { n: 3 }, { uniqueKey: "only-one", runAt: later(5) });
    const b = await enqueue(db, "test.echo", { n: 4 }, { uniqueKey: "only-one", runAt: later(5) });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
  });

  it("retries with backoff, then gives up after max attempts", async () => {
    let calls = 0;
    registerJob("test.flaky", async () => {
      calls++;
      throw new Error("down");
    });
    const id = await enqueue(db, "test.flaky", {}, { maxAttempts: 3 });
    await runDueJobs(db);
    let [j] = await db.query(`SELECT status, attempts, run_at, last_error FROM jobs WHERE id = $1`, [id]);
    expect(j).toMatchObject({ status: "queued", attempts: 1, last_error: "down" });
    expect(new Date(j.run_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    await runDueJobs(db, { now: later(1) });
    await runDueJobs(db, { now: later(2) });
    [j] = await db.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [id]);
    expect(j).toMatchObject({ status: "dead", attempts: 3 });
    expect(calls).toBe(3);
  });

  it("RetryLater postpones without using up an attempt", async () => {
    registerJob("test.busy", async () => {
      throw new RetryLater(60_000);
    });
    const id = await enqueue(db, "test.busy", {}, { maxAttempts: 1 });
    await runDueJobs(db);
    const [j] = await db.query(`SELECT status, attempts FROM jobs WHERE id = $1`, [id]);
    expect(j).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("recovers jobs left running by a crashed worker", async () => {
    const id = await enqueue(db, "test.echo", { n: 9 });
    await db.query(`UPDATE jobs SET status = 'running', locked_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    expect(await recoverStale(db)).toBeGreaterThanOrEqual(1);
    const [j] = await db.query(`SELECT status FROM jobs WHERE id = $1`, [id]);
    expect(j.status).toBe("queued");
  });

  it("a running worker picks jobs up and stops cleanly", async () => {
    const seen: string[] = [];
    registerJob("test.worker", async (_db, job) => {
      seen.push(job.payload.v);
    });
    const w = startWorker(db, { pollMs: 20 });
    await enqueue(db, "test.worker", { v: "a" });
    w.wake();
    for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await w.stop();
    expect(seen).toEqual(["a"]);
  });
});

describe("background work", () => {
  it("schedules the day-3 check-in as a job and sends it exactly once", async () => {
    const g = girl(db, "0712000701");
    await g.send("hi");
    await g.send("3");
    await g.send("my period is two weeks late");
    const code = (await g.send("1")).match(/UB-[A-Z0-9]{4}/)![0];
    const [ci] = await db.query(`SELECT id, due_at FROM checkins WHERE pass_code = $1`, [code]);
    const [job] = await db.query(`SELECT run_at, status FROM jobs WHERE type = 'checkin.send' AND payload->>'checkinId' = $1`, [String(ci.id)]);
    expect(new Date(job.run_at).getTime()).toBe(new Date(ci.due_at).getTime());

    await runDueJobs(db); // not yet due
    expect(await g.replies()).toEqual([]);
    await runDueJobs(db, { now: later(73) });
    expect((await g.replies()).join()).toContain("Did you visit a clinic");
    // The safety-net sweep must not send it again.
    await db.query(`UPDATE checkins SET due_at = now() - interval '1 hour' WHERE id = $1`, [ci.id]);
    expect(await sendDueCheckins(db, later(80))).toBe(0);
    expect(await g.replies()).toEqual([]);
  });

  it("waits while she is answering another check-in", async () => {
    const g = girl(db, "0712000702");
    await g.send("hi");
    await g.send("3");
    await g.send("how do i get family planning");
    await g.send("1");
    await g.send("3");
    await g.send("i have discharge and itching");
    await g.send("1");
    await g.replies();
    const ids = (await db.query(`SELECT c.id FROM checkins c JOIN users u ON u.id = c.user_id WHERE u.phone_hash = $1 ORDER BY c.id`, [hashPhone(g.phone)])).map((r) => String(r.id));
    expect(ids).toHaveLength(2);
    await runDueJobs(db, { now: later(73) });
    // One check-in goes out; the other job is postponed, not failed.
    const sent = await db.query(`SELECT count(*)::int AS n FROM checkins WHERE id = ANY($1::int[]) AND sent_at IS NOT NULL`, [ids]);
    expect(sent[0].n).toBe(1);
    const postponed = await db.query(`SELECT status, attempts FROM jobs WHERE type = 'checkin.send' AND payload->>'checkinId' = ANY($1) AND status = 'queued'`, [ids]);
    expect(postponed).toEqual([{ status: "queued", attempts: 0 }]);
  });

  it("retries a failed message to a girl until it is delivered", async () => {
    const g = girl(db, "0712000703", "whatsapp");
    transports.whatsapp = async () => {
      throw new Error("WhatsApp HTTP 503");
    };
    await g.send("hi");
    const [o] = await db.query(`SELECT id, status, error FROM outbox ORDER BY id DESC LIMIT 1`);
    expect(o).toMatchObject({ status: "failed", error: "WhatsApp HTTP 503" });
    await runDueJobs(db, { now: later(1) });
    expect((await db.query(`SELECT status, attempts FROM outbox WHERE id = $1`, [o.id]))[0]).toMatchObject({ status: "failed", attempts: 2 });
    transports.whatsapp = async () => "sent";
    await runDueJobs(db, { now: later(2) });
    expect((await db.query(`SELECT status FROM outbox WHERE id = $1`, [o.id]))[0].status).toBe("sent");
  });

  it("never re-sends to a girl who deleted her data", async () => {
    const g = girl(db, "0712000704", "whatsapp");
    await g.send("hi");
    transports.whatsapp = async () => {
      throw new Error("down");
    };
    await g.send("3");
    const [o] = await db.query(`SELECT id FROM outbox WHERE status = 'failed' ORDER BY id DESC LIMIT 1`);
    transports.whatsapp = realWa;
    await g.send("DELETE");
    await runDueJobs(db, { now: later(1) });
    const rows = await db.query(`SELECT status FROM outbox WHERE id = $1`, [o.id]);
    // DELETE removes her outbox rows; if any survived they must be cancelled, never sent.
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("keeps retrying the nurse alert for a danger sign, and the case still reaches the inbox", async () => {
    config.nurseAlertNumbers = ["+254700000999"];
    transports.sms = async () => {
      throw new Error("Africa's Talking HTTP 500");
    };
    const g = girl(db, "0712000705");
    await g.send("hi");
    await g.send("3");
    expect(await g.send("my uncle beats me")).toMatch(/not your fault/i);
    const [c] = await db.query(`SELECT id, urgent, status FROM cases ORDER BY id DESC LIMIT 1`);
    expect(c).toMatchObject({ urgent: true, status: "open" });
    const [alert] = await db.query(`SELECT id, status FROM outbox WHERE kind = 'staff_alert' ORDER BY id DESC LIMIT 1`);
    expect(alert.status).toBe("failed");
    const [job] = await db.query(`SELECT max_attempts, payload FROM jobs WHERE type = 'outbox.retry' AND payload->>'outboxId' = $1`, [String(alert.id)]);
    expect(job.max_attempts).toBe(20);
    expect(JSON.stringify(job.payload)).not.toContain("700000999"); // nurse number encrypted
    transports.sms = async () => ({ status: "sent" as const, providerId: "AT-1" });
    await runDueJobs(db, { now: later(1) });
    expect((await db.query(`SELECT status FROM outbox WHERE id = $1`, [alert.id]))[0].status).toBe("sent");
  });

  it("schedules the check-in sweep on a fixed slot so instances don't duplicate it", async () => {
    await scheduleNextSweep(db, Date.UTC(2030, 0, 1, 10, 7));
    await scheduleNextSweep(db, Date.UTC(2030, 0, 1, 10, 9));
    const rows = await db.query(`SELECT run_at FROM jobs WHERE type = 'checkins.sweep' AND unique_key LIKE 'checkins.sweep:%' AND run_at > '2029-12-31'`);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].run_at).toISOString()).toBe("2030-01-01T10:15:00.000Z");
  });
});

describe("health and shutdown", () => {
  it("reports the database status", async () => {
    const app = createApp(db);
    const ok = await request(app).get("/health");
    expect(ok.body).toMatchObject({ ok: true, db: "ok" });
    expect((await request(app).get("/health/live")).status).toBe(200);
    const broken = { ...db, query: async () => Promise.reject(new Error("connection refused")) } as Db;
    const bad = await request(createApp(broken)).get("/health");
    expect(bad.status).toBe(503);
    expect(bad.body).toEqual({ ok: false, db: "down" });
  });

  it("starts, serves, and shuts down gracefully (server, worker, database)", async () => {
    const own = await freshDb();
    setDb(own);
    const port = config.port;
    config.port = 0;
    const running = await start();
    config.port = port;
    const addr = running.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect((await res.json()).ok).toBe(true);
    expect(running.worker).toBeTruthy();
    await running.shutdown("test");
    expect(running.server.listening).toBe(false);
    await expect(own.query("SELECT 1")).rejects.toThrow();
    setDb(null as unknown as Db);
  });
});
