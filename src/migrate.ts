// Numbered SQL migrations: migrations/0001_initial.sql, 0002_....sql, ...
// Command line: src/migrateCli.ts (npm run migrate).
//
// Each migration runs once, inside its own transaction, under an advisory lock so two
// app instances starting together cannot apply the same file twice. A migration that was
// already applied must never be edited: its checksum is recorded and checked on every start.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(here, "../migrations");
const LOCK_ID = 7_284_211; // arbitrary, stable advisory-lock key for Ubah migrations

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const seen = new Set<number>();
  return files.map((f) => {
    const version = Number(f.slice(0, 4));
    if (seen.has(version)) throw new Error(`Two migrations share number ${version}: rename one`);
    seen.add(version);
    const sql = readFileSync(join(dir, f), "utf8");
    return { version, name: f.replace(/\.sql$/, ""), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

export class MigrationError extends Error {}

export async function migrate(db: Db, opts: { dir?: string; log?: (msg: string) => void } = {}): Promise<string[]> {
  const migrations = loadMigrations(opts.dir);
  const applied: string[] = [];
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await db.tx(async (t) => {
    await t.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_ID]);
    const rows = await t.query<{ version: number; name: string; checksum: string }>(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`);
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev) {
        if (prev.checksum !== m.checksum) {
          throw new MigrationError(`Migration ${m.name} was changed after it was applied. Never edit an applied migration: add a new numbered file instead.`);
        }
        continue;
      }
      opts.log?.(`applying ${m.name}`);
      await t.exec(m.sql);
      await t.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)`, [m.version, m.name, m.checksum]);
      applied.push(m.name);
    }
    const known = new Set(migrations.map((m) => m.version));
    const unknown = rows.filter((r) => !known.has(r.version));
    if (unknown.length) {
      throw new MigrationError(`The database has migrations this code doesn't know (${unknown.map((u) => u.name).join(", ")}). Deploy the newer code.`);
    }
  });
  return applied;
}

export async function migrationStatus(db: Db, dir?: string) {
  const rows = await db.query<{ version: number; applied_at: string }>(`SELECT version, applied_at FROM schema_migrations`).catch(() => []);
  const done = new Map(rows.map((r) => [r.version, r.applied_at]));
  return loadMigrations(dir).map((m) => ({ name: m.name, appliedAt: done.get(m.version) ?? null }));
}
