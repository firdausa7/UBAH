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

// Strip query strings (webhook keys, tokens) before a URL is logged.
export const safePath = (url: string) => url.split("?")[0];
