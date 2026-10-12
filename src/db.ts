import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { migrate } from "./migrate.js";

// One small interface over two Postgres drivers:
// - PGlite (real Postgres compiled to WASM) for local development and tests, no install needed
// - node-postgres (pg) for a real database in the pilot (set DATABASE_URL)
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  // Runs fn on one connection inside BEGIN/COMMIT; rolls back if fn throws.
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  memory?: boolean;
  url?: string;
  // Postgres schema to use (tests isolate each run in its own schema).
  schema?: string;
  migrate?: boolean;
}

export async function createDb(opts: CreateDbOptions = {}): Promise<Db> {
  const url = opts.url ?? config.databaseUrl;
  const db = url && !opts.memory ? await pgDb(url, opts.schema) : await pgliteDb(opts.memory ?? false);
  if (opts.migrate !== false) await migrate(db);
  return db;
}

async function pgDb(url: string, schema?: string): Promise<Db> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({
    connectionString: url,
    max: 10,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  if (schema) {
    const c = await pool.connect();
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, "")}"`);
    } finally {
      c.release();
    }
  }
  const wrap = (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }): Omit<Db, "tx" | "close"> => ({
    async query(sql, params = []) {
      return (await q.query(sql, params as any[])).rows;
    },
    async exec(sql) {
      await q.query(sql);
    },
  });
  const db: Db = {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      const inner: Db = {
        ...wrap(client),
        tx: (f) => f(inner), // nested: reuse the open transaction
        close: async () => {},
      };
      try {
        await client.query("BEGIN");
        const out = await fn(inner);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

async function pgliteDb(memory: boolean): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  let pglite;
  if (memory) {
    pglite = new PGlite();
  } else {
    mkdirSync(config.pgliteDir, { recursive: true });
    pglite = new PGlite(config.pgliteDir);
  }
  type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: unknown[] }>; exec: (sql: string) => Promise<unknown> };
  const wrap = (q: Q): Omit<Db, "tx" | "close"> => ({
    async query(sql, params = []) {
      return (await q.query(sql, params as any[])).rows as any[];
    },
    async exec(sql) {
      await q.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pglite),
    tx(fn) {
      return pglite.transaction(async (t) => {
        const inner: Db = { ...wrap(t as unknown as Q), tx: (f) => f(inner), close: async () => {} };
        return fn(inner);
      });
    },
    close: () => pglite.close(),
  };
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
