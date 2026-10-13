import type { Db } from "../db.js";
import { config } from "../config.js";
import { sendCheckin, sendDueCheckins } from "../engine.js";
import { retryOutbox } from "../channels/outbound.js";
import { applyMpesaResult, sendPayout } from "../payments/mpesa.js";
import { recoverInbound, scheduleInboundRecovery } from "../channels/inbound.js";
import { trainCandidate } from "../ml/registry.js";
import { remindUnansweredUrgent, scheduleUrgentReminder } from "../ops.js";
import { TASKS } from "../ml/train.js";
import { enqueue, registerJob, RetryLater } from "./queue.js";
import { log } from "../log.js";

// Every background job Ubah runs.
//   checkin.send    the day-3 check-in for one pass, scheduled when the pass is issued
//   checkins.sweep  safety net: sends any due check-in that was missed, then schedules itself again
//   outbox.retry    re-sends a failed message to a girl, or a failed urgent alert to a nurse
//   cases.urgent_reminder  re-alerts nurses about urgent cases unanswered for 15+ minutes (every 5 minutes)
//   inbound.recover handles inbound messages a stop or error left unhandled (every 2 minutes)
//   ml.train        trains candidate models from labels (an admin promotes them)
//   mpesa.pay       sends one approved Dada payout to M-Pesa (at most once)
//   mpesa.mock_result  mock mode only: M-Pesa's pretend "success" callback

const sweepPeriodMs = () => config.jobs.checkinSweepMinutes * 60_000;

// Each sweep has a fixed slot time, so instances starting together schedule the same one.
export async function scheduleNextSweep(db: Db, from = Date.now()) {
  const slot = Math.floor(from / sweepPeriodMs()) * sweepPeriodMs() + sweepPeriodMs();
  await enqueue(db, "checkins.sweep", {}, { runAt: new Date(slot), uniqueKey: `checkins.sweep:${slot}`, maxAttempts: 3 });
}

export function registerAllJobs() {
  registerJob("checkin.send", async (db, job) => {
    const result = await sendCheckin(db, Number(job.payload.checkinId));
    // She's answering another check-in right now: ask again in 30 minutes.
    if (result === "busy") throw new RetryLater(30 * 60_000, "girl is mid check-in");
  });

  registerJob("checkins.sweep", async (db) => {
    try {
      const n = await sendDueCheckins(db);
      if (n) log.info({ sent: n }, "check-in sweep sent missed check-ins");
      await housekeeping(db);
    } finally {
      await scheduleNextSweep(db);
    }
  });

  registerJob("outbox.retry", async (db, job) => {
    await retryOutbox(db, job.payload);
  });

  // SAFETY: re-alert nurses about urgent cases nobody has answered for 15 minutes.
  registerJob("cases.urgent_reminder", async (db) => {
    try {
      await remindUnansweredUrgent(db);
    } finally {
      await scheduleUrgentReminder(db);
    }
  });

  registerJob("inbound.recover", async (db) => {
    try {
      const n = await recoverInbound(db);
      if (n) log.warn({ recovered: n }, "handled inbound messages left over from a stop or error");
    } finally {
      await scheduleInboundRecovery(db);
    }
  });

  // Trains a candidate for each model from the seed set and nurse/Dada labels (promotion is manual).
  registerJob("ml.train", async (db, job) => {
    for (const task of TASKS) await trainCandidate(db, task, job.payload.staffId ?? null, "Trained from the Models page");
  });

  registerJob("mpesa.pay", async (db, job) => {
    await sendPayout(db, Number(job.payload.payoutId));
  });

  registerJob("mpesa.mock_result", async (db, job) => {
    await applyMpesaResult(db, "result", {
      Result: { ResultType: 0, ResultCode: 0, ResultDesc: "Mock: the service request is processed successfully.", OriginatorConversationID: job.payload.requestId, ConversationID: `MOCK`, TransactionID: `MOCK${Date.now().toString(36).toUpperCase()}` },
    });
  });
}

// Removes what is no longer needed: ended staff sessions, used or expired one-time links and login codes,
// and finished jobs older than 30 days (their outcome is in the audit log and the records they changed).
export async function housekeeping(db: Db): Promise<void> {
  await db.query(`DELETE FROM staff_sessions WHERE (revoked_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM staff_tokens WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '30 days'`);
  await db.query(`DELETE FROM staff_otp WHERE created_at < now() - interval '1 day'`);
  await db.query(`DELETE FROM jobs WHERE status = 'done' AND finished_at < now() - interval '30 days'`);
}
