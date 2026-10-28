import type { Db } from "./db.js";
import { ACTIVE_ASSIGNMENT, WAITING_OVER_A_DAY } from "./auth/access.js";
import { config } from "./config.js";
import { alertStaff } from "./channels/outbound.js";
import { caseEvent } from "./cases.js";
import { enqueue } from "./jobs/queue.js";
import { log } from "./log.js";

// Operations: the numbers a monitor should alert on, and the urgent-case reminder.

export interface OpsStatus {
  ok: boolean;
  urgentUnanswered15m: number; // urgent cases open > 15 minutes with no reply: SAFETY
  oldestUrgentUnansweredMin: number | null;
  staffAlertsFailedNow: number; // nurse alerts still failing
  girlMessagesFailed1h: number;
  jobsDead24h: number;
  jobsQueuedOverdue10m: number; // jobs that should have run 10+ minutes ago (worker stopped?)
  inboundStuck: number; // inbound messages not handled after 5 minutes
  payoutsUnknown: number; // M-Pesa payments sent with no answer for an hour
  // Daily attention (not "needs a person now": these don't make ok false):
  messagesWaiting24h: number; // girls' messages her worker hasn't opened for a day
  girlsUnassignedWaiting24h: number; // girls with no worker and a message waiting a day: assign them
  reportsUntaken24h: number; // confidential reports no protection officer has taken for a day
  reportFollowUpsDue: number; // follow-up dates that have passed on open reports
}

export async function opsStatus(db: Db): Promise<OpsStatus> {
  const [r] = await db.query(
    `SELECT
       (SELECT count(*)::int FROM cases WHERE urgent AND status = 'open' AND first_reply_at IS NULL AND created_at < now() - interval '15 minutes') AS urgent,
       (SELECT extract(epoch FROM now() - min(created_at)) / 60 FROM cases WHERE urgent AND status = 'open' AND first_reply_at IS NULL) AS oldest,
       (SELECT count(*)::int FROM outbox WHERE kind = 'staff_alert' AND status = 'failed') AS alerts,
       (SELECT count(*)::int FROM outbox WHERE kind = 'girl' AND status = 'failed' AND last_attempt_at > now() - interval '1 hour') AS girl,
       (SELECT count(*)::int FROM jobs WHERE status = 'dead' AND finished_at > now() - interval '24 hours') AS dead,
       (SELECT count(*)::int FROM jobs WHERE status = 'queued' AND run_at < now() - interval '10 minutes') AS overdue,
       (SELECT count(*)::int FROM inbound_messages WHERE processed_at IS NULL AND received_at < now() - interval '5 minutes') AS inbound,
       (SELECT count(*)::int FROM dada_payouts WHERE status = 'processing' AND updated_at < now() - interval '1 hour') AS payouts,
       (SELECT count(*)::int FROM messages m WHERE ${WAITING_OVER_A_DAY} AND EXISTS (SELECT 1 FROM assignments a WHERE a.girl_id = m.user_id AND ${ACTIVE_ASSIGNMENT})) AS waiting,
       (SELECT count(DISTINCT m.user_id)::int FROM messages m WHERE ${WAITING_OVER_A_DAY} AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.girl_id = m.user_id AND ${ACTIVE_ASSIGNMENT})) AS unassigned,
       (SELECT count(*)::int FROM safeguarding_reports WHERE status <> 'closed' AND assigned_to IS NULL AND created_at < now() - interval '24 hours') AS reports_untaken,
       (SELECT count(*)::int FROM safeguarding_reports WHERE status <> 'closed' AND follow_up_at IS NOT NULL AND follow_up_at <= now()) AS followups`,
  );
  const s: OpsStatus = {
    ok: false,
    urgentUnanswered15m: r.urgent,
    oldestUrgentUnansweredMin: r.oldest == null ? null : Math.round(Number(r.oldest)),
    staffAlertsFailedNow: r.alerts,
    girlMessagesFailed1h: r.girl,
    jobsDead24h: r.dead,
    jobsQueuedOverdue10m: r.overdue,
    inboundStuck: r.inbound,
    payoutsUnknown: r.payouts,
    messagesWaiting24h: r.waiting,
    girlsUnassignedWaiting24h: r.unassigned,
    reportsUntaken24h: r.reports_untaken,
    reportFollowUpsDue: r.followups,
  };
  s.ok = s.urgentUnanswered15m === 0 && s.staffAlertsFailedNow === 0 && s.jobsQueuedOverdue10m === 0 && s.inboundStuck === 0;
  return s;
}

// Prometheus text format, for Grafana / Prometheus / any monitor that reads it.
export function opsPrometheus(s: OpsStatus): string {
  const line = (name: string, help: string, v: number | null) => `# HELP ubah_${name} ${help}\n# TYPE ubah_${name} gauge\nubah_${name} ${v ?? 0}`;
  return (
    [
      line("ok", "1 when nothing needs attention", s.ok ? 1 : 0),
      line("urgent_unanswered_15m", "Urgent cases open more than 15 minutes with no reply", s.urgentUnanswered15m),
      line("oldest_urgent_unanswered_minutes", "Age of the oldest unanswered urgent case", s.oldestUrgentUnansweredMin),
      line("staff_alerts_failed", "Nurse alerts that are still failing", s.staffAlertsFailedNow),
      line("girl_messages_failed_1h", "Messages to girls that failed in the last hour", s.girlMessagesFailed1h),
      line("jobs_dead_24h", "Background jobs that gave up in the last 24 hours", s.jobsDead24h),
      line("jobs_overdue_10m", "Jobs overdue by 10+ minutes (is the worker running?)", s.jobsQueuedOverdue10m),
      line("inbound_stuck", "Inbound messages not handled after 5 minutes", s.inboundStuck),
      line("payouts_unknown", "M-Pesa payments with no answer for an hour", s.payoutsUnknown),
      line("messages_waiting_24h", "Girls' messages her health worker hasn't opened for a day", s.messagesWaiting24h),
      line("girls_unassigned_waiting_24h", "Girls with no health worker and a message waiting a day", s.girlsUnassignedWaiting24h),
      line("reports_untaken_24h", "Confidential reports no protection officer has taken for a day", s.reportsUntaken24h),
      line("report_followups_due", "Follow-up dates passed on open confidential reports", s.reportFollowUpsDue),
    ].join("\n") + "\n"
  );
}

// SAFETY: an urgent case nobody has replied to re-alerts the nurses every 15 minutes until someone does.
export async function remindUnansweredUrgent(db: Db): Promise<number> {
  const rows = await db.query<{ id: number; reason: string; anon_id: string; minutes: number }>(
    `UPDATE cases c SET last_reminder_at = now(), reminders = reminders + 1
       FROM users u
      WHERE u.id = c.user_id AND c.urgent AND c.status = 'open' AND c.first_reply_at IS NULL
        AND c.created_at < now() - interval '15 minutes'
        AND (c.last_reminder_at IS NULL OR c.last_reminder_at < now() - interval '15 minutes')
      RETURNING c.id, c.reason, u.anon_id, round(extract(epoch FROM now() - c.created_at) / 60)::int AS minutes`,
  );
  for (const c of rows) {
    const text = `UBAH STILL WAITING: urgent case #${c.id} (${c.reason.replace("danger_", "")}), girl ${c.anon_id}, no reply for ${c.minutes} min. Open: ${config.baseUrl}/staff/cases/${c.id}`;
    for (const phone of config.nurseAlertNumbers) await alertStaff(db, phone, text);
    await caseEvent(db, c.id, null, "reminder", { minutes: c.minutes });
    log.warn({ caseId: c.id, minutes: c.minutes }, "urgent case still unanswered; nurses reminded");
  }
  return rows.length;
}

const REMIND_MS = 5 * 60_000;
export async function scheduleUrgentReminder(db: Db, from = Date.now()) {
  const slot = Math.floor(from / REMIND_MS) * REMIND_MS + REMIND_MS;
  await enqueue(db, "cases.urgent_reminder", {}, { runAt: new Date(slot), uniqueKey: `cases.urgent_reminder:${slot}`, maxAttempts: 2 });
}
