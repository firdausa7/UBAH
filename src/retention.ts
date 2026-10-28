import type { Db } from "./db.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { log } from "./log.js";
import { eraseGirl } from "./erase.js";

// Retention: how long Ubah keeps girls' data, set by the team with their legal adviser (no default).
//   RETENTION_MODE      off (default) | report (log what would go, delete nothing) | delete
//   RETENTION_INACTIVE_DAYS   a girl's whole account, after this many days without any activity
//   RETENTION_MESSAGE_DAYS    her older messages (the account stays), after this many days
// A girl with an open case is never touched: the people helping her keep the history.
// The audit and access logs are not shortened here: they are the record of who did what.

export interface RetentionPlan {
  inactiveGirls: number;
  oldMessages: number;
  inactiveDays: number | null;
  messageDays: number | null;
}

const NO_OPEN_CASE = `NOT EXISTS (SELECT 1 FROM cases c WHERE c.user_id = u.id AND c.status = 'open')`;

async function inactiveGirls(db: Db, days: number) {
  return db.query<{ id: number; phone_hash: string }>(
    `SELECT u.id, u.phone_hash FROM users u WHERE u.last_seen_at < now() - make_interval(days => $1) AND ${NO_OPEN_CASE}`,
    [days],
  );
}

const OLD_MESSAGES = `FROM messages m JOIN users u ON u.id = m.user_id WHERE m.created_at < now() - make_interval(days => $1) AND ${NO_OPEN_CASE}`;

export async function retentionPlan(db: Db): Promise<RetentionPlan> {
  const { inactiveDays, messageDays } = config.retention;
  const inactive = inactiveDays ? (await inactiveGirls(db, inactiveDays)).length : 0;
  const [m] = messageDays ? await db.query<{ n: number }>(`SELECT count(*)::int AS n ${OLD_MESSAGES}`, [messageDays]) : [{ n: 0 }];
  return { inactiveGirls: inactive, oldMessages: m.n, inactiveDays, messageDays };
}

// Run with the housekeeping (every 15 minutes). Does nothing unless RETENTION_MODE is set.
export async function applyRetention(db: Db): Promise<RetentionPlan | null> {
  const mode = config.retention.mode;
  if (mode === "off") return null;
  const plan = await retentionPlan(db);
  if (mode === "report") {
    log.info({ retention: plan }, "retention report: nothing deleted (RETENTION_MODE=report)");
    return plan;
  }
  if (plan.inactiveDays) for (const g of await inactiveGirls(db, plan.inactiveDays)) await eraseGirl(db, g);
  if (plan.messageDays) {
    await db.query(`DELETE FROM messages WHERE id IN (SELECT m.id ${OLD_MESSAGES})`, [plan.messageDays]);
    // Her private wellbeing entries follow the same period.
    await db.query(`DELETE FROM wellbeing_entries WHERE created_at < now() - make_interval(days => $1)`, [plan.messageDays]);
  }
  await audit(db, { action: "retention.applied", details: { ...plan } });
  log.info({ retention: plan }, "retention applied");
  return plan;
}
