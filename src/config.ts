// Central configuration, read from environment variables.
// Every external service has a "mock" mode so the prototype runs with no accounts.

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  // Public base URL, used in links sent to staff.
  baseUrl: env.BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`,

  // Postgres connection string. Leave empty to use embedded Postgres (PGlite) in ./.data
  databaseUrl: env.DATABASE_URL ?? "",
  pgliteDir: env.PGLITE_DIR ?? "./.data/pglite",

  // Privacy keys. MUST be set to long random values in production.
  // HASH_SECRET: used to recognise a returning phone number without storing it in clear.
  // ENCRYPTION_KEY: 32-byte key (hex) used to encrypt the number so Ubah can send the day-3 SMS.
  hashSecret: env.HASH_SECRET ?? "dev-only-hash-secret-change-me",
  encryptionKey: env.ENCRYPTION_KEY ?? "0".repeat(64),
  sessionSecret: env.SESSION_SECRET ?? "dev-only-session-secret-change-me",

  // AI: any OpenAI-compatible API (OpenAI, or an open-weight model served by vLLM / Ollama).
  llm: {
    baseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? "gpt-4o-mini",
  },
  // Speech-to-text: any OpenAI-compatible /audio/transcriptions endpoint (Whisper, or a self-hosted MMS server).
  stt: {
    baseUrl: env.STT_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: env.STT_API_KEY ?? env.LLM_API_KEY ?? "",
    model: env.STT_MODEL ?? "whisper-1",
  },

  // WhatsApp Cloud API (Meta).
  whatsapp: {
    token: env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? "ubah-verify",
    // Meta app secret: when set, every webhook call's signature is checked.
    appSecret: env.WHATSAPP_APP_SECRET ?? "",
    graphVersion: env.WHATSAPP_GRAPH_VERSION ?? "v21.0",
  },

  // Africa's Talking SMS.
  africasTalking: {
    username: env.AT_USERNAME ?? "sandbox",
    apiKey: env.AT_API_KEY ?? "",
    senderId: env.AT_SENDER_ID ?? "",
    sandbox: (env.AT_USERNAME ?? "sandbox") === "sandbox",
  },

  // Who gets alerted for urgent cases (comma-separated phone numbers).
  nurseAlertNumbers: (env.NURSE_ALERT_NUMBERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),

  // The browser simulator (chat as a girl without a phone). Off in production unless enabled.
  simulator: (env.ENABLE_SIMULATOR ?? (env.NODE_ENV === "production" ? "false" : "true")) === "true",
  // Shared secret for Africa's Talking callbacks: set the callback URL to /webhooks/sms?key=<this>.
  smsWebhookKey: env.SMS_WEBHOOK_KEY ?? "",

  // Behaviour.
  checkinDelayHours: Number(env.CHECKIN_DELAY_HOURS ?? 72),
  passValidDays: Number(env.PASS_VALID_DAYS ?? 7),
  // Serve draft (not yet partner-approved) content. Only for local testing — must be false in a pilot.
  allowDraftContent: (env.ALLOW_DRAFT_CONTENT ?? "true") === "true",
  // Dada payment per handled case, in KES (logged now, paid via M-Pesa later).
  dadaPayPerCaseKes: Number(env.DADA_PAY_PER_CASE_KES ?? 0),
};

export const mockMode = {
  llm: () => !config.llm.apiKey,
  stt: () => !config.stt.apiKey,
  whatsapp: () => !config.whatsapp.token,
  sms: () => !config.africasTalking.apiKey,
};
