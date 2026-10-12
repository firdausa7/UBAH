// Creates the first admin account on a fresh (production) database.
//   npm run create-admin -- --login amina --name "Amina Hassan"
// Prints a one-time password; the admin must change it and set up two-step login at first login.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createDb } from "./db.js";
import { hashPassword } from "./privacy.js";
import { audit } from "./audit.js";

const { values } = parseArgs({ options: { login: { type: "string" }, name: { type: "string" } } });
const login = (values.login ?? "").trim();
const name = (values.name ?? "").trim();
if (!/^[a-z0-9._-]{3,40}$/.test(login) || !name) {
  console.error('Usage: npm run create-admin -- --login <login (a-z, 0-9, . _ -)> --name "<full name>"');
  process.exit(1);
}

const db = await createDb();
try {
  const [exists] = await db.query(`SELECT 1 FROM staff WHERE login = $1`, [login]);
  if (exists) throw new Error(`A staff account with login "${login}" already exists.`);
  const password = randomBytes(12).toString("base64url");
  const [s] = await db.query<{ id: number }>(
    `INSERT INTO staff (name, role, login, password_hash, must_change_password) VALUES ($1,'admin',$2,$3,TRUE) RETURNING id`,
    [name, login, hashPassword(password)],
  );
  await audit(db, { action: "password.changed", targetType: "staff", targetId: s.id, details: { via: "create-admin", created: true } });
  console.log(`Created admin "${login}".`);
  console.log(`One-time password: ${password}`);
  console.log("Log in at /staff/login, choose a new password and set up two-step login. This password is not stored anywhere.");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
