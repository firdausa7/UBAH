import { pino } from "pino";
import { config } from "./config.js";

// Structured JSON logs (one line per event) for any log collector.
// Never log message bodies, phone numbers, cookies or secrets.
export const log = pino({
  level: config.logLevel,
  base: { service: "ubah", env: config.env },
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", "req.headers.apikey", "*.password", "*.phone", "*.to", "*.code", "*.secret"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Strip query strings (webhook keys, tokens) and secrets inside paths before a URL is logged:
// one-time set-password links and the M-Pesa callback token.
export const safePath = (url: string) =>
  url
    .split("?")[0]
    .replace(/^(\/staff\/invite\/)[^/]+/, "$1[redacted]")
    .replace(/^(\/webhooks\/mpesa\/)[^/]+/, "$1[redacted]");
