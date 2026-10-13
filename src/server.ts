import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { config, mockMode } from "./config.js";
import { getDb, type Db } from "./db.js";
import { log, safePath } from "./log.js";
import { parseWhatsAppWebhook } from "./channels/whatsapp.js";
import { parseInboundSms } from "./channels/sms.js";
import { staffRouter } from "./web/staff.js";
import { loginRouter } from "./web/login.js";
import { adminRouter } from "./web/admin.js";
import { contentRouter } from "./web/content.js";
import { stringsRouter } from "./web/strings.js";
import { inboxRouter } from "./web/inbox.js";
import { clinicRouter } from "./web/clinic.js";
import { dashboardRouter } from "./web/dashboard.js";
import { paymentsRouter } from "./web/payments.js";
import { modelsRouter } from "./web/models.js";
import { appApiRouter } from "./web/appApi.js";
import { icon } from "./pwa/icons.js";
import { dirname, join } from "node:path";
import { bootstrapModels } from "./ml/registry.js";
import { opsPrometheus, opsStatus, scheduleUrgentReminder } from "./ops.js";
import { handleDeskSms } from "./clinicDesk.js";
import { handleUssd } from "./ussd.js";
import { alertStaff, applySmsDelivery, applyWhatsAppStatus } from "./channels/outbound.js";
import { processInboundNow, queueForSender, receive, recordInbound, recordInboundWithId, scheduleInboundRecovery } from "./channels/inbound.js";
import { hashPhone } from "./privacy.js";
import { applyMpesaResult } from "./payments/mpesa.js";
import { refreshCaches } from "./caches.js";
import { simulatorRouter } from "./web/simulator.js";
import { page, h1 } from "./web/html.js";
import { csrfCookie, verifyCsrf } from "./security/csrf.js";
import { rateLimit } from "./security/rateLimit.js";
import { safeEqual } from "./privacy.js";
import { seedDemo } from "./seed.js";
import { registerAllJobs, scheduleNextSweep } from "./jobs/handlers.js";
import { setWorker, startWorker, type Worker } from "./jobs/queue.js";

export interface AppOptions {
  // Overrides for tests.
  loginPerMin?: number;
  webhookPerMin?: number;
  appApi?: { sessionsPerHour?: number; requestsPerMin?: number };
}

const PWA_DIR = join(dirname(fileURLToPath(import.meta.url)), "pwa", "public");

// Work that continues after a webhook has answered (Meta and Africa's Talking want a fast 200).
// Tracked so a graceful shutdown waits for it instead of dropping a girl's message.
const background = new Set<Promise<unknown>>();
function track(p: Promise<unknown>) {
  background.add(p);
  p.finally(() => background.delete(p));
}
export const drainBackground = () => Promise.allSettled(background);

let shuttingDown = false;
const started = Date.now();

export function createApp(db: Db, opts: AppOptions = {}) {
  registerAllJobs();
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);

  // Request id + one structured log line per request (path without query string, never bodies).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = String(req.headers["x-request-id"] ?? "").slice(0, 64) || randomUUID();
    res.setHeader("X-Request-Id", id);
    const t0 = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const entry = { reqId: id, method: req.method, path: safePath(req.originalUrl), status: res.statusCode, ms: Math.round(ms) };
      if (req.path.startsWith("/health")) log.debug(entry, "request");
      else if (res.statusCode >= 500) log.error(entry, "request");
      else log.info(entry, "request");
    });
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          ...(config.production ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "no-referrer" },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Keep the raw body so WhatsApp signatures can be checked. Small limits: messages are short.
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
  app.use(express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 50 }));

  // ---- Health ----
  app.get("/health/live", (_req, res) => res.json({ ok: true }));
  app.get("/health", async (_req, res) => {
    if (shuttingDown) return res.status(503).json({ ok: false, status: "shutting_down" });
    try {
      await Promise.race([db.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error("db timeout")), 3000))]);
      res.json({
        ok: true,
        db: "ok",
        uptimeS: Math.round((Date.now() - started) / 1000),
        ...(config.production ? {} : { mock: { llm: mockMode.llm(), stt: mockMode.stt(), whatsapp: mockMode.whatsapp(), sms: mockMode.sms() } }),
      });
    } catch (err) {
      log.error({ err: (err as Error).message }, "health check failed");
      res.status(503).json({ ok: false, db: "down" });
    }
  });
  // For monitoring and alerting: what needs a human's attention right now. Protected by OPS_KEY.
  app.get("/health/ops", async (req, res) => {
    const key = String(req.query.key ?? req.headers["x-ops-key"] ?? "");
    if (!config.opsKey || !safeEqual(key, config.opsKey)) return res.sendStatus(404);
    const s = await opsStatus(db);
    if (req.query.format === "prometheus") return res.type("text/plain; version=0.0.4").send(opsPrometheus(s));
    res.status(s.ok ? 200 : 503).json(s);
  });
  app.get("/", (_req, res) => res.redirect("/app/"));

  // ---- Webhooks ----
  const webhookLimiter = rateLimit({ name: "webhooks", windowMs: 60_000, max: opts.webhookPerMin ?? config.security.rateLimitWebhookPerMin });
  app.use("/webhooks", webhookLimiter);

  // WhatsApp Cloud API
  app.get("/webhooks/whatsapp", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && safeEqual(String(req.query["hub.verify_token"] ?? ""), config.whatsapp.verifyToken)) {
      return res.status(200).type("text/plain").send(String(req.query["hub.challenge"] ?? "").slice(0, 200));
    }
    res.sendStatus(403);
  });
  app.post("/webhooks/whatsapp", (req: Request, res) => {
    if (config.whatsapp.appSecret) {
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      const expected = "sha256=" + createHmac("sha256", config.whatsapp.appSecret).update((req as any).rawBody ?? "").digest("hex");
      if (!safeEqual(sig, expected)) return res.sendStatus(401);
    }
    res.sendStatus(200); // Meta expects a fast 200; work continues below.
    const { messages, statuses } = parseWhatsAppWebhook(req.body);
    // Join each sender's queue now, before anything asynchronous, so arrival order is kept.
    const handled = messages.map((m) => receive(db, { provider: "whatsapp", message: m }).catch((err) => log.error({ err: (err as Error).message, channel: "whatsapp" }, "failed to handle message")));
    track(Promise.all(handled));
    track(
      (async () => {
        for (const s of statuses) {
          await applyWhatsAppStatus(db, s).catch((err) => log.error({ err: (err as Error).message }, "failed to apply WhatsApp status"));
        }
      })(),
    );
  });

  // Africa's Talking SMS
  const smsKeyOk = (req: Request) => !config.smsWebhookKey || safeEqual(String(req.query.key ?? ""), config.smsWebhookKey);
  app.post("/webhooks/sms", (req, res) => {
    if (!smsKeyOk(req)) return res.sendStatus(401);
    const m = parseInboundSms(req.body);
    if (!m) return res.sendStatus(400);
    res.sendStatus(200);
    track(
      queueForSender(m.from, async () => {
        // Clinic desks check passes by SMS from their registered phone; everyone else is a girl.
        const desk = await handleDeskSms(db, m.from, m.text.slice(0, 200));
        if (desk !== null) return void (await alertStaff(db, m.from, desk));
        const payload = { provider: "sms" as const, from: m.from, text: m.text };
        const id = m.id ? await recordInboundWithId(db, "sms", m.id, payload) : await recordInbound(db, payload);
        if (id) await processInboundNow(db, id);
      }).catch((err) => log.error({ err: (err as Error).message, channel: "sms" }, "failed to handle message")),
    );
  });

  // Delivery reports for SMS Ubah sent.
  app.post("/webhooks/sms/delivery", async (req, res) => {
    if (!smsKeyOk(req)) return res.sendStatus(401);
    const id = String(req.body.id ?? "");
    const status = String(req.body.status ?? "");
    if (!id || !status) return res.sendStatus(400);
    await applySmsDelivery(db, { id, status, failureReason: req.body.failureReason ? String(req.body.failureReason).slice(0, 200) : undefined }).catch((err) =>
      log.error({ err: (err as Error).message }, "failed to apply SMS delivery report"),
    );
    res.sendStatus(200);
  });

  // Someone opted out of Ubah's sender ID at the network level: never message them again (until they write).
  app.post("/webhooks/sms/optout", async (req, res) => {
    if (!smsKeyOk(req)) return res.sendStatus(401);
    const phone = String(req.body.phoneNumber ?? "");
    if (!phone) return res.sendStatus(400);
    await db.query(`UPDATE users SET opted_out = TRUE WHERE phone_hash = $1`, [hashPhone(phone)]);
    await db.query(`DELETE FROM pending_outbound WHERE user_id IN (SELECT id FROM users WHERE phone_hash = $1)`, [hashPhone(phone)]);
    res.sendStatus(200);
  });

  // Africa's Talking USSD: clinic desks (pass checks) and girls (menus). Answers must come back within seconds.
  app.post("/webhooks/ussd", async (req, res) => {
    if (!smsKeyOk(req)) return res.sendStatus(401);
    const phone = String(req.body.phoneNumber ?? "");
    if (!phone) return res.sendStatus(400);
    try {
      res.type("text/plain").send(await handleUssd(db, phone, String(req.body.text ?? "").slice(0, 100)));
    } catch (err) {
      log.error({ err: (err as Error).message, channel: "ussd" }, "failed to handle USSD");
      res.type("text/plain").send("END Sorry, something went wrong. Please try again.");
    }
  });

  // M-Pesa B2C results for Dada payments. The secret token in the path authenticates Safaricom's call.
  app.post("/webhooks/mpesa/:token/:kind", async (req, res) => {
    const kind = req.params.kind;
    if (!safeEqual(String(req.params.token), config.mpesa.callbackToken) || (kind !== "result" && kind !== "timeout")) return res.sendStatus(404);
    try {
      await applyMpesaResult(db, kind, req.body);
    } catch (err) {
      log.error({ err: (err as Error).message }, "failed to record M-Pesa callback");
    }
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  });

  if (config.simulator) app.use("/simulator", simulatorRouter(db));

  // ---- The girls' app (installable, works offline) ----
  app.use("/app/api", appApiRouter(db, opts.appApi));
  app.get("/app/icon-:size.png", (req, res, next) => {
    const size = Number(req.params.size);
    if (size !== 192 && size !== 512) return next();
    res.type("image/png").setHeader("Cache-Control", "public, max-age=604800");
    res.send(icon(size));
  });
  // Express treats /app and /app/ alike: redirect only the bare form.
  app.get("/app", (req, res, next) => (req.originalUrl === "/app" ? res.redirect(301, "/app/") : next()));
  app.use(
    "/app",
    express.static(PWA_DIR, {
      index: "index.html",
      setHeaders(res, path) {
        // The shell is re-checked on every visit (the service worker keeps it for offline use).
        res.setHeader("Cache-Control", "no-cache");
        if (path.endsWith("sw.js")) res.setHeader("Service-Worker-Allowed", "/app/");
        if (path.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
      },
    }),
  );

  // ---- Staff ----
  // Staff pages hold sensitive data, often on shared phones: never cache them.
  app.use("/staff", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/staff", csrfCookie, verifyCsrf);
  const loginLimiter = rateLimit({ name: "login", windowMs: 60_000, max: opts.loginPerMin ?? config.security.rateLimitLoginPerMin });
  app.use("/staff", loginRouter(db, { loginLimiter }));
  app.use("/staff", adminRouter(db, { tokenLimiter: loginLimiter }));
  app.use("/staff", inboxRouter(db));
  app.use("/staff", clinicRouter(db));
  app.use("/staff", dashboardRouter(db));
  app.use("/staff", contentRouter(db));
  app.use("/staff", stringsRouter(db));
  app.use("/staff", paymentsRouter(db));
  app.use("/staff", modelsRouter(db));
  app.use("/staff", staffRouter(db));

  // ---- Not found and errors ----
  app.use((req, res) => {
    res.status(404).send(page("Not found", `${h1("Page", "not found")}<p><a href="/staff">Go to Ubah</a></p>`));
  });
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err?.status ?? err?.statusCode) || 500;
    if (status >= 500) log.error({ err, path: safePath(req.originalUrl) }, "unhandled error");
    if (res.headersSent) return;
    const message = status === 413 ? "That was too large to send." : status < 500 ? "That request wasn't valid." : "Something went wrong. It has been logged.";
    res.status(status).send(page("Error", `${h1("Sorry", "about that")}<p>${message}</p><p><a href="/staff">Go to Ubah</a></p>`));
  });
  return app;
}

export interface Running {
  server: Server;
  db: Db;
  worker: Worker | null;
  shutdown(signal?: string): Promise<void>;
}

export async function start(): Promise<Running> {
  const db = await getDb(); // runs pending migrations
  if (config.seedDemo) await seedDemo(db);
  await bootstrapModels(db);
  await refreshCaches(db, { force: true });
  const app = createApp(db);
  const server = app.listen(config.port, () => {
    log.info({ url: config.baseUrl, staff: `${config.baseUrl}/staff/login`, simulator: config.simulator ? `${config.baseUrl}/simulator` : null }, "Ubah running");
    const mocks = Object.entries(mockMode).filter(([, f]) => f()).map(([k]) => k);
    if (mocks.length) log.warn({ mocks }, "mock mode (no keys set)");
  });
  server.keepAliveTimeout = 65_000; // longer than common load-balancer idle timeouts
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  let worker: Worker | null = null;
  if (config.jobs.enabled) {
    await scheduleNextSweep(db);
    await scheduleInboundRecovery(db);
    await scheduleUrgentReminder(db);
    worker = startWorker(db);
    setWorker(worker);
  }

  let closing: Promise<void> | null = null;
  const shutdown = (signal = "shutdown") =>
    (closing ??= (async () => {
      shuttingDown = true;
      log.info({ signal }, "shutting down");
      const force = setTimeout(() => {
        log.error("shutdown took too long, exiting");
        process.exit(1);
      }, 20_000);
      force.unref();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await drainBackground();
      await worker?.stop();
      setWorker(null);
      await db.close();
      clearTimeout(force);
      log.info("shutdown complete");
    })());

  return { server, db, worker, shutdown };
}

async function main() {
  const running = await start();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      running.shutdown(signal).then(
        () => process.exit(0),
        (err) => {
          log.error({ err }, "shutdown failed");
          process.exit(1);
        },
      );
    });
  }
  process.on("unhandledRejection", (err) => log.error({ err }, "unhandled promise rejection"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    log.fatal({ err }, "Ubah failed to start");
    process.exit(1);
  });
}
