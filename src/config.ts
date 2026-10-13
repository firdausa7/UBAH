// Central configuration, read from environment variables and validated at startup.
// Every external service has a "mock" mode so the prototype runs with no accounts.
// In production, Ubah refuses to start until every safety- and privacy-critical value is set.
import { z } from "zod";

const DEV_HASH = "dev-only-hash-secret-change-me";
const DEV_SESSION = "dev-only-session-secret-change-me";
const DEV_KEY = "0".repeat(64);

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"], { message: "must be true or false" })
    .optional()
    .transform((v) => (v === undefined ? def : ["true", "1", "yes"].includes(v)));
const num = (def: number, min = 0) => z.coerce.number({ message: "must be a number" }).min(min).default(def);
const list = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // With NODE_ENV=production: "production" is the real service; "staging" is a secure online TEST version
  // that may run before SMS/WhatsApp accounts exist (mock channels, draft content) and says so on every page.
  DEPLOY_STAGE: z.enum(["production", "staging"]).default("production"),
  // Render sets this to the service's public https address.
  RENDER_EXTERNAL_URL: z.url().optional(),
  // First admin on a fresh online database, without a terminal: created only if no admin exists,
  // and must change this password (and set up two-step login) at first login.
  BOOTSTRAP_ADMIN_LOGIN: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,39}$/, { message: "lower-case letters, numbers, . _ - (3-40)" }).optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12, { message: "must be at least 12 characters" }).optional(),
  PORT: num(3000, 1),
  BASE_URL: z.url({ message: "must be a full URL, e.g. https://ubah.example.org" }).optional(),
  // Number of proxy hops in front of the app (load balancer = 1). Needed for correct client IPs.
  TRUST_PROXY: num(0),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().default(""),
  PGLITE_DIR: z.string().default("./.data/pglite"),

  HASH_SECRET: z.string().default(DEV_HASH),
  // 32 bytes as 64 hex characters (openssl rand -hex 32) or as base64 (what Render's "generate" produces).
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => /^[0-9a-fA-F]{64}$/.test(v) || Buffer.from(v, "base64").length === 32, { message: "must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64" })
    .transform((v) => (/^[0-9a-fA-F]{64}$/.test(v) ? v : Buffer.from(v, "base64").toString("hex")))
    .default(DEV_KEY),
  SESSION_SECRET: z.string().default(DEV_SESSION),

  LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  STT_BASE_URL: z.string().optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default("whisper-1"),

  WHATSAPP_TOKEN: z.string().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default("ubah-verify"),
  WHATSAPP_APP_SECRET: z.string().default(""),
  WHATSAPP_GRAPH_VERSION: z.string().default("v21.0"),
  // Approved message templates for messages outside the 24-hour window (see README → WhatsApp).
  WHATSAPP_TEMPLATE_CHECKIN: z.string().default(""),
  WHATSAPP_TEMPLATE_NOTIFY: z.string().default(""),
  // Which Ubah languages have an approved template, and its WhatsApp language code: "en:en,sw:sw".
  WHATSAPP_TEMPLATE_LANGUAGES: z.string().default("en:en"),
  WHATSAPP_MAX_VOICE_MB: num(10, 1),
  SMS_PART_CHARS: num(459, 70),

  AT_USERNAME: z.string().default("sandbox"),
  AT_API_KEY: z.string().default(""),
  AT_SENDER_ID: z.string().default(""),
  SMS_WEBHOOK_KEY: z.string().default(""),

  NURSE_ALERT_NUMBERS: list,

  // M-Pesa B2C (Safaricom Daraja) for Dada payments.
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CONSUMER_KEY: z.string().default(""),
  MPESA_CONSUMER_SECRET: z.string().default(""),
  MPESA_SHORTCODE: z.string().default(""),
  MPESA_INITIATOR_NAME: z.string().default(""),
  MPESA_SECURITY_CREDENTIAL: z.string().default(""),
  MPESA_CALLBACK_TOKEN: z.string().default(""),

  ENABLE_SIMULATOR: bool(false).optional(),
  SEED_DEMO: bool(true),
  DEMO_STAFF_PASSWORD: z.string().default("change-me-now"),

  CHECKIN_DELAY_HOURS: num(72),
  PASS_VALID_DAYS: num(7, 1),
  ALLOW_DRAFT_CONTENT: bool(true),
  DADA_PAY_PER_CASE_KES: num(0),

  // Staff security.
  MFA_REQUIRED: bool(true),
  SESSION_HOURS: num(12, 1),
  SESSION_IDLE_MINUTES: num(120, 5),
  LOGIN_MAX_FAILURES: num(5, 1),
  LOGIN_LOCK_MINUTES: num(15, 1),
  // Webhooks come from a few Meta / Africa's Talking servers: keep this high so a girl's message is never throttled.
  RATE_LIMIT_WEBHOOK_PER_MIN: num(6000, 1),
  RATE_LIMIT_LOGIN_PER_MIN: num(10, 1),

  // Background jobs.
  // Shown on the public landing page. Empty = "coming soon" (never a made-up number).
  PUBLIC_SMS_NUMBER: z.string().default(""),
  PUBLIC_WHATSAPP_NUMBER: z.string().default(""),
  PUBLIC_USSD_CODE: z.string().default(""),
  PUBLIC_CONTACT_EMAIL: z.string().default(""),
  // Key for /health/ops (monitoring). Empty: the endpoint is off.
  OPS_KEY: z.string().default(""),
  // Demo mode labels every staff page as DEMO DATA. Never allowed in production.
  DEMO_MODE: bool(false),
  JOBS_ENABLED: bool(true),
  JOB_POLL_MS: num(2000, 100),
  CHECKIN_SWEEP_MINUTES: num(15, 1),
});

export type Env = z.input<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Ubah configuration is invalid:\n - ${problems.join("\n - ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  // Treat empty strings as "not set" so a blank line in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  const staging = production && e.DEPLOY_STAGE === "staging";
  const publicUrl = e.BASE_URL ?? e.RENDER_EXTERNAL_URL;
  const baseUrl = publicUrl ?? `http://localhost:${e.PORT}`;

  const cfg = {
    env: e.NODE_ENV,
    // "development" locally; online: "staging" (secure TEST version) or "production" (the real service).
    stage: (production ? e.DEPLOY_STAGE : "development") as "development" | "staging" | "production",
    bootstrapAdmin: e.BOOTSTRAP_ADMIN_LOGIN && e.BOOTSTRAP_ADMIN_PASSWORD ? { login: e.BOOTSTRAP_ADMIN_LOGIN, password: e.BOOTSTRAP_ADMIN_PASSWORD } : null,
    production,
    port: e.PORT,
    // Public base URL, used in links sent to staff.
    baseUrl: baseUrl.replace(/\/$/, ""),
    trustProxy: e.TRUST_PROXY,
    logLevel: e.NODE_ENV === "test" && !env.LOG_LEVEL ? ("silent" as const) : e.LOG_LEVEL,

    // Postgres connection string. Leave empty to use embedded Postgres (PGlite) in ./.data
    databaseUrl: e.DATABASE_URL,
    pgliteDir: e.PGLITE_DIR,

    // Privacy keys. MUST be set to long random values in production.
    // HASH_SECRET: used to recognise a returning phone number without storing it in clear.
    // ENCRYPTION_KEY: 32-byte key (hex) used to encrypt phone numbers and 2FA secrets.
    hashSecret: e.HASH_SECRET,
    encryptionKey: e.ENCRYPTION_KEY,
    sessionSecret: e.SESSION_SECRET,

    // AI: any OpenAI-compatible API (OpenAI, or an open-weight model served by vLLM / Ollama).
    llm: { baseUrl: e.LLM_BASE_URL, apiKey: e.LLM_API_KEY, model: e.LLM_MODEL },
    // Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint (Whisper, or a self-hosted MMS server).
    stt: { baseUrl: e.STT_BASE_URL ?? e.LLM_BASE_URL, apiKey: e.STT_API_KEY ?? e.LLM_API_KEY, model: e.STT_MODEL },

    // WhatsApp Cloud API (Meta).
    whatsapp: {
      token: e.WHATSAPP_TOKEN,
      phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      // Meta app secret: when set, every webhook call's signature is checked.
      appSecret: e.WHATSAPP_APP_SECRET,
      graphVersion: e.WHATSAPP_GRAPH_VERSION,
      templateCheckin: e.WHATSAPP_TEMPLATE_CHECKIN,
      templateNotify: e.WHATSAPP_TEMPLATE_NOTIFY,
      templateLanguages: Object.fromEntries(
        e.WHATSAPP_TEMPLATE_LANGUAGES.split(",")
          .map((p) => p.split(":").map((x) => x.trim()))
          .filter((p) => p.length === 2 && p[0] && p[1]),
      ) as Record<string, string>,
      maxVoiceBytes: e.WHATSAPP_MAX_VOICE_MB * 1024 * 1024,
    },
    smsPartChars: e.SMS_PART_CHARS,

    // Africa's Talking SMS.
    africasTalking: { username: e.AT_USERNAME, apiKey: e.AT_API_KEY, senderId: e.AT_SENDER_ID, sandbox: e.AT_USERNAME === "sandbox" },
    // Shared secret for Africa's Talking callbacks: set the callback URL to /webhooks/sms?key=<this>.
    smsWebhookKey: e.SMS_WEBHOOK_KEY,

    mpesa: {
      env: e.MPESA_ENV,
      consumerKey: e.MPESA_CONSUMER_KEY,
      consumerSecret: e.MPESA_CONSUMER_SECRET,
      shortcode: e.MPESA_SHORTCODE,
      initiatorName: e.MPESA_INITIATOR_NAME,
      securityCredential: e.MPESA_SECURITY_CREDENTIAL,
      // Secret part of the callback URL: /webhooks/mpesa/<token>/result
      callbackToken: e.MPESA_CALLBACK_TOKEN || "dev-mpesa-callback",
    },

    // Who gets an SMS for urgent cases (comma-separated phone numbers).
    nurseAlertNumbers: e.NURSE_ALERT_NUMBERS,

    // The browser simulator (chat as a girl without a phone). Off in production unless enabled.
    simulator: e.ENABLE_SIMULATOR ?? (!production || staging),
    seedDemo: e.SEED_DEMO,
    demoStaffPassword: e.DEMO_STAFF_PASSWORD,

    // Behaviour.
    checkinDelayHours: e.CHECKIN_DELAY_HOURS,
    passValidDays: e.PASS_VALID_DAYS,
    // Serve draft (not yet partner-approved) content. Only for local testing — must be false in a pilot.
    allowDraftContent: e.ALLOW_DRAFT_CONTENT,
    // Dada payment per handled case, in KES (logged now, paid via M-Pesa later).
    dadaPayPerCaseKes: e.DADA_PAY_PER_CASE_KES,

    security: {
      mfaRequired: e.MFA_REQUIRED,
      sessionHours: e.SESSION_HOURS,
      sessionIdleMinutes: e.SESSION_IDLE_MINUTES,
      loginMaxFailures: e.LOGIN_MAX_FAILURES,
      loginLockMinutes: e.LOGIN_LOCK_MINUTES,
      rateLimitWebhookPerMin: e.RATE_LIMIT_WEBHOOK_PER_MIN,
      rateLimitLoginPerMin: e.RATE_LIMIT_LOGIN_PER_MIN,
    },

    opsKey: e.OPS_KEY,
    public: { smsNumber: e.PUBLIC_SMS_NUMBER, whatsappNumber: e.PUBLIC_WHATSAPP_NUMBER, ussdCode: e.PUBLIC_USSD_CODE, contactEmail: e.PUBLIC_CONTACT_EMAIL },
    demoMode: e.DEMO_MODE,
    jobs: { enabled: e.JOBS_ENABLED, pollMs: e.JOB_POLL_MS, checkinSweepMinutes: e.CHECKIN_SWEEP_MINUTES },
  };

  // Refuse to run a real pilot with demo secrets, unapproved content or no one to alert.
  if (production) {
    const problems: string[] = [];
    if (cfg.hashSecret === DEV_HASH || cfg.hashSecret.length < 32) problems.push("HASH_SECRET must be set to at least 32 random characters");
    if (cfg.encryptionKey === DEV_KEY) problems.push("ENCRYPTION_KEY must be set (openssl rand -hex 32)");
    if (cfg.sessionSecret === DEV_SESSION || cfg.sessionSecret.length < 32) problems.push("SESSION_SECRET must be set to at least 32 random characters");
    // Staging is never used by real girls, so it may run before the content is approved and channels exist.
    if (cfg.allowDraftContent && !staging) problems.push("ALLOW_DRAFT_CONTENT must be false (only approved content in a pilot)");
    if (!cfg.security.mfaRequired) problems.push("MFA_REQUIRED cannot be false in production");
    if (cfg.demoMode && !staging) problems.push("DEMO_MODE must be false in production (demo data is fake)");
    if (cfg.opsKey && cfg.opsKey.length < 24) problems.push("OPS_KEY must be at least 24 random characters");
    if (cfg.seedDemo) problems.push("SEED_DEMO must be false in production (create the first admin with: npm run create-admin)");
    if (cfg.nurseAlertNumbers.length === 0 && !staging) problems.push("NURSE_ALERT_NUMBERS must list at least one number: danger signs must always reach a human");
    if ((!cfg.africasTalking.apiKey || cfg.africasTalking.sandbox) && !staging) {
      problems.push("AT_API_KEY and a live AT_USERNAME must be set: nurse alerts and Dada login codes are sent by SMS");
    }
    if (!publicUrl || !cfg.baseUrl.startsWith("https://")) problems.push("BASE_URL must be the public https:// address");
    if (!cfg.databaseUrl) problems.push("DATABASE_URL must point to Postgres (embedded PGlite is for development only)");
    if (cfg.whatsapp.token && !cfg.whatsapp.appSecret) problems.push("WHATSAPP_APP_SECRET must be set so webhook signatures are checked");
    if (cfg.whatsapp.token && cfg.whatsapp.verifyToken === "ubah-verify") problems.push("WHATSAPP_VERIFY_TOKEN must be changed from the default");
    if (cfg.africasTalking.apiKey && !cfg.smsWebhookKey) problems.push("SMS_WEBHOOK_KEY must be set so SMS callbacks are authenticated");
    if (cfg.mpesa.consumerKey) {
      const missing = (["consumerSecret", "shortcode", "initiatorName", "securityCredential"] as const).filter((k) => !cfg.mpesa[k]);
      if (missing.length) problems.push(`M-Pesa is switched on but these are missing: ${missing.map((k) => `MPESA_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`).join(", ")}`);
      if (!e.MPESA_CALLBACK_TOKEN || e.MPESA_CALLBACK_TOKEN.length < 24) problems.push("MPESA_CALLBACK_TOKEN must be set to at least 24 random characters");
    }
    if (problems.length) throw new ConfigError(problems);
  }
  return cfg;
}

export type Config = ReturnType<typeof loadConfig>;

function loadOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Logging isn't set up yet (it depends on config), so write straight to stderr.
      process.stderr.write(`${err.message}\n\nSee .env.example for every setting.\n`);
      process.exit(1);
    }
    throw err;
  }
}

export const config: Config = loadOrExit();

export const mockMode = {
  llm: () => !config.llm.apiKey,
  stt: () => !config.stt.apiKey,
  whatsapp: () => !config.whatsapp.token,
  sms: () => !config.africasTalking.apiKey,
  mpesa: () => !config.mpesa.consumerKey,
};
