import type { Db } from "../db.js";
import { config } from "../config.js";
import { sendCheckin, sendDueCheckins } from "../engine.js";
import { retryOutbox } from "../channels/outbound.js";
import { applyMpesaResult, sendPayout } from "../payments/mpesa.js";
import { enqueue, registerJob, RetryLater } from "./queue.js";
import { log } from "../log.js";

// Every background job Ubah runs.
//   checkin.send    the day-3 check-in for one pass, scheduled when the pass is issued
//   checkins.sweep  safety net: sends any due check-in that was missed, then schedules itself again
//   outbox.retry    re-sends a failed message to a girl, or a failed urgent alert to a nurse
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
    } finally {
      await scheduleNextSweep(db);
    }
  });

  registerJob("outbox.retry", async (db, job) => {
    await retryOutbox(db, job.payload);
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
