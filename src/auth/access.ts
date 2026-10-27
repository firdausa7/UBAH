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

// explicit: record her answer even when it matches the default ("no" is a choice too, and asking for
// a person later must not override it).
export async function setConsents(db: Db, girlId: number, next: Partial<Record<ConsentScope, boolean>>, opts: { explicit?: boolean } = {}) {
  const now = await consents(db, girlId);
  for (const scope of ["messages", "voice"] as const) {
    if (typeof next[scope] === "boolean" && (opts.explicit || next[scope] !== now[scope])) {
      await db.query(`INSERT INTO consents (user_id, scope, granted) VALUES ($1,$2,$3)`, [girlId, scope, next[scope]]);
    }
  }
}

// Asking for a person (DADA on WhatsApp/SMS/USSD, or "Talk to a person") is her choice to share her
// messages with her health worker. An earlier "no" she gave in the app is respected.
export async function shareOnRequest(db: Db, girlId: number) {
  const [any] = await db.query(`SELECT 1 FROM consents WHERE user_id = $1 AND scope = 'messages' LIMIT 1`, [girlId]);
  if (!any) await db.query(`INSERT INTO consents (user_id, scope, granted) VALUES ($1,'messages',TRUE)`, [girlId]);
}

// Her worker counts only while their account is active and they are still a nurse or Dada.
export const ACTIVE_ASSIGNMENT = `a.ended_at IS NULL AND EXISTS (SELECT 1 FROM staff hw WHERE hw.id = a.health_worker_id AND hw.active AND hw.role IN ('nurse','dada'))`;

export async function assignedWorkerId(db: Db, girlId: number): Promise<number | null> {
  const [a] = await db.query<{ health_worker_id: number }>(`SELECT a.health_worker_id FROM assignments a WHERE a.girl_id = $1 AND ${ACTIVE_ASSIGNMENT}`, [girlId]);
  return a?.health_worker_id ?? null;
}

// A girl's real message (not a menu number or a command) that a worker could see, still unopened
// after a day. Used by /admin and /health/ops so no girl is forgotten. ("m" is the messages row.)
export const WAITING_OVER_A_DAY = `m.direction = 'in' AND m.status = 'new' AND m.created_at < now() - interval '24 hours'
  AND (m.urgent OR (m.body ~ '[[:alpha:]]{3,}' AND upper(btrim(m.body)) NOT IN ('STOP','DELETE','HELP','MENU','DADA','SHARE','VOICE','PRIVATE')))
  AND (m.urgent OR COALESCE((SELECT k.granted FROM consents k WHERE k.user_id = m.user_id AND k.scope = 'messages' ORDER BY k.id DESC LIMIT 1), FALSE))`;

// A worker deactivated, or no longer a nurse or Dada: their girls go back to "not assigned", so an
// admin sees them and reassigns them (and their messages never wait on someone who has left).
export async function endAssignmentsOf(db: Db, staffId: number): Promise<number> {
  return (await db.query(`UPDATE assignments SET ended_at = now() WHERE health_worker_id = $1 AND ended_at IS NULL RETURNING id`, [staffId])).length;
}

export async function isAssigned(db: Db, workerId: number, girlId: number): Promise<boolean> {
  return (await assignedWorkerId(db, girlId)) === workerId;
}

export type AccessWhat = "profile" | "messages" | "message" | "voice";

// One line per look, not per screen refresh: the same person seeing the same thing about the same girl
// within 10 minutes is the same look (the inbox refreshes every few seconds).
const SAME_LOOK_MINUTES = 10;

export async function logAccess(db: Db, req: Request, girlId: number, what: AccessWhat, targetId?: string | number) {
  const s = (req as any).staff as { id: number; login: string } | undefined;
  try {
    const [seen] = await db.query(
      `SELECT 1 FROM access_log WHERE girl_id = $1 AND staff_id IS NOT DISTINCT FROM $2 AND what = $3 AND target_id IS NOT DISTINCT FROM $4
          AND at > now() - make_interval(mins => $5) LIMIT 1`,
      [girlId, s?.id ?? null, what, targetId == null ? null : String(targetId), SAME_LOOK_MINUTES],
    );
    if (seen) return;
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
