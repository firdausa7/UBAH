import { describe, it, expect, beforeAll } from "vitest";
import type { AddressInfo } from "node:net";
import { freshDb } from "./helpers.js";
import { createApp } from "../src/server.js";
import { runLoad } from "../src/tools/loadtest.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Db } from "../src/db.js";

// Bursts of webhooks, timed. Run on their own after the other tests (vitest.load.config.ts), so the
// timings measure Ubah and not the rest of the test suite running alongside.

let db: Db;
let app: ReturnType<typeof createApp>;
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  trainAll(() => {});
  reloadModels();
  db = await freshDb();
  app = createApp(db, { loginPerMin: 100_000, webhookPerMin: 100_000, appApi: { sessionsPerHour: 100_000, requestsPerMin: 100_000 } });
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
