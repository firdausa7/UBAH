import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";

// One small interface over two Postgres drivers:
// - PGlite (real Postgres compiled to WASM) for local development and tests, no install needed
// - node-postgres (pg) for a real database in the pilot (set DATABASE_URL)
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = () => readFileSync(join(here, "schema.sql"), "utf8");

export async function createDb(opts: { memory?: boolean; url?: string } = {}): Promise<Db> {
  const url = opts.url ?? config.databaseUrl;
  let db: Db;
  if (url && !opts.memory) {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: url });
    db = {
      async query(sql, params = []) {
        const res = await pool.query(sql, params as any[]);
        return res.rows;
      },
      async exec(sql) {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    let pglite;
    if (opts.memory) {
      pglite = new PGlite();
    } else {
      mkdirSync(config.pgliteDir, { recursive: true });
      pglite = new PGlite(config.pgliteDir);
    }
    db = {
      async query(sql, params = []) {
        const res = await pglite.query(sql, params as any[]);
        return res.rows as any[];
      },
      async exec(sql) {
        await pglite.exec(sql);
      },
      close: () => pglite.close(),
    };
  }
  await db.exec(schemaSql());
  return db;
}

let shared: Db | null = null;
export async function getDb(): Promise<Db> {
  if (!shared) shared = await createDb();
  return shared;
}
export function setDb(db: Db) {
  shared = db;
}
