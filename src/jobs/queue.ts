import { hostname } from "node:os";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { log } from "../log.js";

// A small Postgres-backed job queue. Jobs survive restarts, run on any app instance
// (FOR UPDATE SKIP LOCKED), retry with exponential backoff, and are recovered if a worker dies.

export interface Job<P = any> {
  id: number;
  type: string;
  payload: P;
  attempts: number;
  max_attempts: number;
  run_at: string;
}

export type JobHandler = (db: Db, job: Job) => Promise<void>;

// Throw this to try again later without counting it as a failure (e.g. "she is mid-conversation").
export class RetryLater extends Error {
  constructor(public delayMs: number, reason = "retry later") {
    super(reason);
  }
}

const handlers = new Map<string, JobHandler>();
export function registerJob(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  // At most one queued/running job per key; a second enqueue is ignored.
  uniqueKey?: string;
}

export async function enqueue(db: Db, type: string, payload: unknown = {}, opts: EnqueueOptions = {}): Promise<number | null> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO jobs (type, payload, run_at, max_attempts, unique_key) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (unique_key) WHERE unique_key IS NOT NULL AND status IN ('queued','running') DO NOTHING
     RETURNING id`,
    [type, JSON.stringify(payload), (opts.runAt ?? new Date()).toISOString(), opts.maxAttempts ?? 8, opts.uniqueKey ?? null],
  );
  return rows[0]?.id ?? null;
}

// 30s, 1m, 2m, 4m ... capped at 1h, with jitter so retries don't stampede.
export function backoffMs(attempt: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

const STALE_MINUTES = 10;
const workerId = `${hostname()}:${process.pid}`;

async function claim(db: Db, now: Date): Promise<Job | null> {
  const [job] = await db.query<Job>(
    `UPDATE jobs SET status = 'running', locked_by = $2, locked_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= $1 ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, type, payload, attempts, max_attempts, run_at`,
    [now.toISOString(), workerId],
  );
  return job ?? null;
}

// Jobs left "running" by a crashed worker go back to the queue.
export async function recoverStale(db: Db): Promise<number> {
  const rows = await db.query(
    `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, last_error = 'recovered after worker stopped'
      WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1) RETURNING id`,
    [STALE_MINUTES],
  );
  return rows.length;
}

// `now` is the queue's clock for this run: retries are scheduled relative to it, so a run can never
// re-claim the job it just postponed.
export async function runJob(db: Db, job: Job, now = new Date()): Promise<"done" | "retry" | "dead"> {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`no handler registered for job type ${job.type}`);
    await handler(db, job);
    await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL, locked_by = NULL WHERE id = $1`, [job.id]);
    return "done";
  } catch (err) {
    const message = (err as Error).message.slice(0, 1000);
    if (err instanceof RetryLater) {
      // Not a failure: give the attempt back.
      await db.query(
        `UPDATE jobs SET status = 'queued', attempts = attempts - 1, run_at = $2, locked_by = NULL, locked_at = NULL, last_error = $3 WHERE id = $1`,
        [job.id, new Date(now.getTime() + err.delayMs).toISOString(), message],
      );
      return "retry";
    }
    if (job.attempts >= job.max_attempts) {
      await db.query(`UPDATE jobs SET status = 'dead', finished_at = now(), last_error = $2, locked_by = NULL WHERE id = $1`, [job.id, message]);
      log.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, "job failed permanently");
      return "dead";
    }
    await db.query(`UPDATE jobs SET status = 'queued', run_at = $2, last_error = $3, locked_by = NULL, locked_at = NULL WHERE id = $1`, [
      job.id,
      new Date(now.getTime() + backoffMs(job.attempts)).toISOString(),
      message,
    ]);
    log.warn({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, "job failed, will retry");
    return "retry";
  }
}

// Runs every job that is due now (used by tests, CLI commands and each worker tick).
export async function runDueJobs(db: Db, opts: { now?: Date; limit?: number } = {}): Promise<number> {
  let n = 0;
  const limit = opts.limit ?? 100;
  const now = opts.now ?? new Date();
  while (n < limit) {
    const job = await claim(db, now);
    if (!job) break;
    await runJob(db, job, now);
    n++;
  }
  return n;
}

// Long-running worker. Polls the queue; wake() runs it at once (e.g. right after an urgent enqueue).
export interface Worker {
  wake(): void;
  stop(): Promise<void>;
}

export function startWorker(db: Db, opts: { pollMs?: number } = {}): Worker {
  const pollMs = opts.pollMs ?? config.jobs.pollMs;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false; // a wake() arrived while a tick was running
  let lastRecover = 0;

  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      if (Date.now() - lastRecover > 60_000) {
        lastRecover = Date.now();
        const n = await recoverStale(db);
        if (n) log.warn({ jobs: n }, "recovered stale jobs");
      }
      await runDueJobs(db, { limit: 50 });
    } catch (err) {
      log.error({ err }, "job worker tick failed");
    }
    if (!stopped) timer = setTimeout(schedule, pollMs);
  };
  const schedule = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = tick().finally(() => {
      running = null;
      if (again && !stopped) {
        again = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        schedule();
      }
    });
  };
  schedule();
  log.info({ workerId, pollMs }, "job worker started");
  return {
    wake() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running; // let the current job finish
      log.info({ workerId }, "job worker stopped");
    },
  };
}

let current: Worker | null = null;
export const setWorker = (w: Worker | null) => (current = w);
// Ask the running worker (if any) to look at the queue now.
export const wakeWorker = () => current?.wake();
