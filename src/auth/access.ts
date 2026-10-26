import type { Request } from "express";
import type { Db } from "../db.js";
import { log } from "../log.js";

// What a health worker may see about a girl:
//   - only girls assigned to them;
//   - her messages and the replies only if she agreed to share them ("messages"),
//     her recorded voice only if she agreed to that too ("voice");
//   - an urgent message always, whatever she chose: a danger sign must reach a human.
// Every look is written to access_log (who, which girl, what, when), never the content itself.

export type ConsentScope = "messages" | "voice";

export async function consents(db: Db, girlId: number): Promise<Record<ConsentScope, boolean>> {
  const rows = await db.query<{ scope: ConsentScope; granted: boolean }>(
    `SELECT DISTINCT ON (scope) scope, granted FROM consents WHERE user_id = $1 ORDER BY scope, id DESC`,
    [girlId],
  );
  const out: Record<ConsentScope, boolean> = { messages: false, voice: false };
  for (const r of rows) out[r.scope] = r.granted;
  return out;
}

export async function setConsents(db: Db, girlId: number, next: Partial<Record<ConsentScope, boolean>>) {
  const now = await consents(db, girlId);
  for (const scope of ["messages", "voice"] as const) {
    if (typeof next[scope] === "boolean" && next[scope] !== now[scope]) {
      await db.query(`INSERT INTO consents (user_id, scope, granted) VALUES ($1,$2,$3)`, [girlId, scope, next[scope]]);
    }
  }
}

export async function assignedWorkerId(db: Db, girlId: number): Promise<number | null> {
  const [a] = await db.query<{ health_worker_id: number }>(`SELECT health_worker_id FROM assignments WHERE girl_id = $1 AND ended_at IS NULL`, [girlId]);
  return a?.health_worker_id ?? null;
}

export async function isAssigned(db: Db, workerId: number, girlId: number): Promise<boolean> {
  return (await assignedWorkerId(db, girlId)) === workerId;
}

export type AccessWhat = "profile" | "messages" | "message" | "voice";

export async function logAccess(db: Db, req: Request, girlId: number, what: AccessWhat, targetId?: string | number) {
  const s = (req as any).staff as { id: number; login: string } | undefined;
  try {
    await db.query(`INSERT INTO access_log (staff_id, staff_login, girl_id, what, target_id, ip) VALUES ($1,$2,$3,$4,$5,$6)`, [
      s?.id ?? null,
      s?.login ?? null,
      girlId,
      what,
      targetId == null ? null : String(targetId),
      req.ip ?? null,
    ]);
  } catch (err) {
    log.error({ err, what }, "access log write failed");
    throw err; // no record, no data: the request fails rather than showing her data unlogged
  }
}
