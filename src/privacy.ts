import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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

// App users have no phone number: their "number" is "app:<random device secret>", hashed the same way.
export const isAppId = (raw: string) => raw.startsWith("app:");

export function hashPhone(raw: string): string {
  return createHmac("sha256", config.hashSecret).update(isAppId(raw) ? raw : normalizePhone(raw)).digest("hex");
}

function key(): Buffer {
  const k = Buffer.from(config.encryptionKey, "hex");
  if (k.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes in hex (64 characters)");
  return k;
}

// AES-256-GCM: used for phone numbers and staff 2FA secrets.
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// App users: nothing to send to, so only a placeholder is stored (never the device secret).
export const encryptPhone = (raw: string) => encryptSecret(isAppId(raw) ? "app" : normalizePhone(raw));
export const decryptPhone = decryptSecret;

// Session tokens, login codes and recovery codes are stored only as SHA-256 hashes.
export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

// A real hash of a throwaway password, so a login for an unknown account takes as long as a real one.
export const DUMMY_PASSWORD_HASH = hashPassword(randomToken(16));

// Staff password rules: long enough to resist guessing, without forcing symbols that people write down.
export function passwordProblem(password: string, login = ""): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  if (login && password.toLowerCase().includes(login.toLowerCase())) return "Don't include your login in your password.";
  if (/^(.)\1+$/.test(password)) return "Don't repeat one character.";
  if (["change-me-now", "password1234", "123456789012", "ubahubahubah"].includes(password.toLowerCase())) return "That password is too common.";
  return null;
}
