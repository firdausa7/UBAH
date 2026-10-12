import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { MODELS_DIR } from "./ml/models.js";

// Numbers for the partner dashboard. Everything is aggregated; clinic scores are hidden
// until at least MIN_RESPONSES girls have answered, so no single girl can be identified.
export const MIN_RESPONSES = 5;

export interface ClinicScore {
  id: number;
  name: string;
  area: string;
  verified: boolean;
  passes: number;
  visits: number;
  responses: number;
  respectYes: number | null; // share, 0..1, null when too few responses
  respectPartly: number | null;
  respectNo: number | null;
}

export async function dashboardStats(db: Db, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 864e5).toISOString();
  const one = async (sql: string, params: unknown[] = [since]) => (await db.query(sql, params))[0];

  const q = await one(
    `SELECT count(*)::int AS questions, count(*) FILTER (WHERE kind = 'voice')::int AS voice,
            count(*) FILTER (WHERE cardinality(coded_terms) > 0)::int AS coded
       FROM messages WHERE direction = 'in' AND danger IS NOT NULL AND created_at >= $1`,
  );
  const users = await one(`SELECT count(DISTINCT user_id)::int AS n FROM messages WHERE direction = 'in' AND created_at >= $1`);
  const passes = await one(`SELECT count(*)::int AS n, count(DISTINCT suggested_clinic)::int AS clinics FROM passes WHERE issued_at >= $1`);
  const checkins = await one(
    `SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
            count(*) FILTER (WHERE visited IS NOT NULL)::int AS answered,
            count(*) FILTER (WHERE visited)::int AS visited
       FROM checkins c JOIN passes p ON p.code = c.pass_code WHERE p.issued_at >= $1`,
  );
  const cases = await one(
    `SELECT count(*) FILTER (WHERE urgent)::int AS urgent, count(*)::int AS total,
            count(*) FILTER (WHERE status = 'open')::int AS open,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_reply_at - created_at) / 60)
              FILTER (WHERE urgent AND first_reply_at IS NOT NULL) AS median_urgent_reply_min
       FROM cases WHERE created_at >= $1`,
  );
  const topics = await db.query<{ topic: string; n: number }>(
    `SELECT topic, count(*)::int AS n FROM messages WHERE direction = 'in' AND topic IS NOT NULL AND created_at >= $1 GROUP BY topic ORDER BY n DESC`,
    [since],
  );
  const clinicRows = await db.query(
    `SELECT cl.id, cl.name, cl.area, cl.verified,
            (SELECT count(*)::int FROM passes p WHERE p.suggested_clinic = cl.id AND p.issued_at >= $1) AS passes,
            count(ch.id) FILTER (WHERE ch.visited)::int AS visits,
            count(ch.respect)::int AS responses,
            count(*) FILTER (WHERE ch.respect = 'yes')::int AS yes,
            count(*) FILTER (WHERE ch.respect = 'partly')::int AS partly,
            count(*) FILTER (WHERE ch.respect = 'no')::int AS no
       FROM clinics cl
       LEFT JOIN checkins ch ON ch.clinic_id = cl.id AND ch.completed_at >= $1
      WHERE cl.active GROUP BY cl.id ORDER BY cl.id`,
    [since],
  );
  const clinics: ClinicScore[] = clinicRows.map((r) => {
    const enough = r.responses >= MIN_RESPONSES;
    return {
      id: r.id,
      name: r.name,
      area: r.area,
      verified: r.verified,
      passes: r.passes,
      visits: r.visits,
      responses: r.responses,
      respectYes: enough ? r.yes / r.responses : null,
      respectPartly: enough ? r.partly / r.responses : null,
      respectNo: enough ? r.no / r.responses : null,
    };
  });
  const labels = await one(`SELECT count(DISTINCT message_id)::int AS n FROM labels`, []);
  const payouts = await one(`SELECT coalesce(sum(amount_kes), 0)::int AS pending FROM dada_payouts WHERE status = 'pending'`, []);
  const modelReports = Object.fromEntries(
    ["danger", "topic"].map((task) => {
      const p = join(MODELS_DIR, `${task}.report.json`);
      return [task, existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null];
    }),
  );

  return {
    sinceDays,
    girls: users.n as number,
    questions: q.questions as number,
    voiceShare: q.questions ? q.voice / q.questions : null,
    codedTermMessages: q.coded as number,
    passes: passes.n as number,
    passClinics: passes.clinics as number,
    checkinsSent: checkins.sent as number,
    checkinsAnswered: checkins.answered as number,
    visitsConfirmed: checkins.visited as number,
    visitRate: checkins.answered ? checkins.visited / checkins.answered : null,
    urgentCases: cases.urgent as number,
    openCases: cases.open as number,
    medianUrgentReplyMin: cases.median_urgent_reply_min == null ? null : Number(cases.median_urgent_reply_min),
    topics,
    clinics,
    labelledMessages: labels.n as number,
    dadaPayoutsPendingKes: payouts.pending as number,
    modelReports,
  };
}
