import express, { type Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, mockMode } from "./config.js";
import { getDb, type Db } from "./db.js";
import { handleIncoming, sendDueCheckins } from "./engine.js";
import { parseWhatsAppWebhook, downloadWhatsAppMedia } from "./channels/whatsapp.js";
import { parseInboundSms } from "./channels/sms.js";
import { staffRouter } from "./web/staff.js";
import { simulatorRouter } from "./web/simulator.js";
import { seedDemo } from "./seed.js";

export function createApp(db: Db) {
  const app = express();
  app.disable("x-powered-by");
  // Keep the raw body so WhatsApp signatures can be checked.
  app.use(express.json({ verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (_req, res) => res.json({ ok: true, mock: { llm: mockMode.llm(), stt: mockMode.stt(), whatsapp: mockMode.whatsapp(), sms: mockMode.sms() } }));
  app.get("/", (_req, res) => res.redirect("/staff/login"));

  // ---- WhatsApp Cloud API ----
  app.get("/webhooks/whatsapp", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.whatsapp.verifyToken) {
      return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    }
    res.sendStatus(403);
  });
  app.post("/webhooks/whatsapp", async (req: Request, res) => {
    if (config.whatsapp.appSecret) {
      const sig = String(req.headers["x-hub-signature-256"] ?? "");
      const expected = "sha256=" + createHmac("sha256", config.whatsapp.appSecret).update((req as any).rawBody ?? "").digest("hex");
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
    }
    res.sendStatus(200); // Meta expects a fast 200; work continues below.
    for (const m of parseWhatsAppWebhook(req.body)) {
      try {
        if (m.type === "audio" && m.mediaId) {
          const { audio, mimeType } = await downloadWhatsAppMedia(m.mediaId);
          await handleIncoming(db, { channel: "whatsapp", from: m.from, voice: { audio, mimeType } });
        } else if (m.type === "text" || m.type === "interactive") {
          await handleIncoming(db, { channel: "whatsapp", from: m.from, text: m.text ?? "" });
        } else {
          await handleIncoming(db, { channel: "whatsapp", from: m.from, text: "HELP" });
        }
      } catch (err) {
        console.error("[whatsapp] failed to handle message:", (err as Error).message);
      }
    }
  });

  // ---- Africa's Talking SMS ----
  app.post("/webhooks/sms", async (req, res) => {
    if (config.smsWebhookKey && req.query.key !== config.smsWebhookKey) return res.sendStatus(401);
    const m = parseInboundSms(req.body);
    if (!m) return res.sendStatus(400);
    res.sendStatus(200);
    try {
      await handleIncoming(db, { channel: "sms", from: m.from, text: m.text });
    } catch (err) {
      console.error("[sms] failed to handle message:", (err as Error).message);
    }
  });

  if (config.simulator) app.use("/simulator", simulatorRouter(db));
  app.use("/staff", staffRouter(db));
  return app;
}

// Refuse to run a real pilot with demo secrets or unapproved health content.
function checkProductionSafety() {
  if (process.env.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (config.hashSecret.startsWith("dev-only")) problems.push("HASH_SECRET is not set");
  if (/^0+$/.test(config.encryptionKey)) problems.push("ENCRYPTION_KEY is not set");
  if (config.sessionSecret.startsWith("dev-only")) problems.push("SESSION_SECRET is not set");
  if (config.allowDraftContent) problems.push("ALLOW_DRAFT_CONTENT must be false (only approved content in a pilot)");
  if (problems.length) {
    console.error("Ubah will not start in production:\n - " + problems.join("\n - "));
    process.exit(1);
  }
}

async function main() {
  checkProductionSafety();
  const db = await getDb();
  if (process.env.SEED_DEMO !== "false") await seedDemo(db);
  const app = createApp(db);
  app.listen(config.port, () => {
    console.log(`Ubah running on ${config.baseUrl}`);
    console.log(`  Staff:     ${config.baseUrl}/staff/login`);
    if (config.simulator) console.log(`  Simulator: ${config.baseUrl}/simulator`);
    const mocks = Object.entries(mockMode).filter(([, f]) => f()).map(([k]) => k);
    if (mocks.length) console.log(`  Mock mode (no keys set): ${mocks.join(", ")}`);
  });
  // Day-3 check-ins: look every 10 minutes.
  const tick = () => sendDueCheckins(db).catch((e) => console.error("[checkins]", e.message));
  setInterval(tick, 10 * 60e3);
  tick();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
