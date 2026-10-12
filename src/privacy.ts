import { createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

// Phone numbers are never stored in clear.
// - hashPhone: a keyed hash, so Ubah recognises a returning girl without keeping her number readable.
// - encryptPhone: AES-256-GCM, so Ubah can still send her the day-3 check-in.

export function normalizePhone(raw: string): string {
  let p = raw.replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0") && p.length === 10) p = "254" + p.slice(1); // Kenyan local format
  return p;
}

export function hashPhone(raw: string): string {
  return createHmac("sha256", config.hashSecret).update(normalizePhone(raw)).digest("hex");
}

function key(): Buffer {
  const k = Buffer.from(config.encryptionKey, "hex");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes in hex (64 characters)");
  return k;
}

export function encryptPhone(raw: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(normalizePhone(raw), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decryptPhone(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// Short anonymous ID staff see instead of a name or number, e.g. "A19F".
export function newAnonId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
}

// Pass codes avoid look-alike characters so they're easy to read out at a clinic desk.
export function newPassCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return "UB-" + Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join("");
}

// Staff passwords: scrypt with a random salt.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}
