import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { MODELS_DIR } from "./ml/models.js";

// Numbers for the partner dashboard, CSV export and monthly donor report.
// Privacy rule: any count from 1 to 4 is shown as "<5", and a percentage is only shown when it is
// based on at least 5, so no small group (and no single girl) can be singled out.
export const MIN_RESPONSES = 5;

export interface Filters {
  from: Date; // inclusive
  to: Date; // exclusive
  siteId: number | null;
  clinicId: number | null;
  language: string | null;
}

// A count that may be hidden: null means "1 to 4, hidden".
export type Count = number | null;
export const sup = (n: number): Count => (n > 0 && n < MIN_RESPONSES ? null : n);
export const showCount = (c: Count) => (c === null ? "<5" : String(c));
export const share = (part: number, whole: number): number | null => (whole >= MIN_RESPONSES ? part / whole : null);
export const showPct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export interface ClinicRow {
  id: number;
  name: string;
  area: string;
  site: string | null;
  verified: boolean;
  passes: Count;
  visits: Count;
  responses: number;
  respectYes: number | null;
  respectPartly: number | null;
  respectNo: number | null;
}

export interface WeekRow {
  week: string; // Monday, YYYY-MM-DD
  questions: Count;
  passes: Count;
  visits: Count;
  urgent: Count;
}

export async function dashboardStats(db: Db, f: Filters) {
  const range = [f.from.toISOString(), f.to.toISOString()];
  // Shared filters. Question and case counts can't be split by clinic (girls ask before choosing one).
  const girlWhere = `($3::text IS NULL OR u.language = $3) AND ($4::int IS NULL OR u.site_id = $4)`;
  const passWhere = `($3::text IS NULL OR u.language = $3) AND ($4::int IS NULL OR cl.site_id = $4) AND ($5::int IS NULL OR p.suggested_clinic = $5 OR p.redeemed_clinic = $5)`;
  const params = [...range, f.language, f.siteId, f.clinicId];

  const [q] = await db.query(
    `SELECT count(*)::int AS questions, count(*) FILTER (WHERE m.kind = 'voice')::int AS voice,
            count(*) FILTER (WHERE cardinality(m.coded_terms) > 0)::int AS coded, count(DISTINCT m.user_id)::int AS girls
       FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.direction = 'in' AND m.danger IS NOT NULL AND m.created_at >= $1 AND m.created_at < $2 AND ${girlWhere} AND $5::int IS NULL`,
    params,
  );
  const [p] = await db.query(
    `SELECT count(*)::int AS passes, count(DISTINCT p.suggested_clinic)::int AS clinics,
            count(ch.id) FILTER (WHERE ch.visited IS NOT NULL)::int AS answered, count(ch.id) FILTER (WHERE ch.visited)::int AS visited,
            count(*) FILTER (WHERE p.redeemed_at IS NOT NULL)::int AS redeemed
       FROM passes p JOIN users u ON u.id = p.user_id LEFT JOIN clinics cl ON cl.id = p.suggested_clinic LEFT JOIN checkins ch ON ch.pass_code = p.code
      WHERE p.issued_at >= $1 AND p.issued_at < $2 AND ${passWhere}`,
    params,
  );
  const [c] = await db.query(
    `SELECT count(*) FILTER (WHERE c.urgent)::int AS urgent, count(*)::int AS total, count(*) FILTER (WHERE c.status = 'open')::int AS open,
            count(*) FILTER (WHERE c.escalated_at IS NOT NULL)::int AS escalated,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM c.first_reply_at - c.created_at) / 60)
              FILTER (WHERE c.urgent AND c.first_reply_at IS NOT NULL) AS median_urgent_reply_min,
            count(*) FILTER (WHERE c.urgent AND c.first_reply_at IS NOT NULL)::int AS urgent_replied
       FROM cases c JOIN users u ON u.id = c.user_id
      WHERE c.created_at >= $1 AND c.created_at < $2 AND ($3::text IS NULL OR u.language = $3) AND ($4::int IS NULL OR c.site_id = $4) AND $5::int IS NULL`,
    params,
  );
  const topics = await db.query<{ topic: string; n: number }>(
    `SELECT m.topic, count(*)::int AS n FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.direction = 'in' AND m.topic IS NOT NULL AND m.created_at >= $1 AND m.created_at < $2 AND ${girlWhere} AND $5::int IS NULL
      GROUP BY m.topic ORDER BY n DESC`,
    params,
  );
  const languages = await db.query<{ language: string | null; n: number }>(
    `SELECT u.language, count(DISTINCT u.id)::int AS n FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.direction = 'in' AND m.created_at >= $1 AND m.created_at < $2 AND ${girlWhere} AND $5::int IS NULL
      GROUP BY u.language ORDER BY n DESC`,
    params,
  );
  const clinicRows = await db.query(
    `SELECT cl.id, cl.name, cl.area, cl.verified, s.name AS site,
            (SELECT count(*)::int FROM passes p JOIN users u ON u.id = p.user_id WHERE p.suggested_clinic = cl.id AND p.issued_at >= $1 AND p.issued_at < $2 AND ($3::text IS NULL OR u.language = $3)) AS passes,
            count(ch.id) FILTER (WHERE ch.visited)::int AS visits,
            count(ch.respect)::int AS responses,
            count(*) FILTER (WHERE ch.respect = 'yes')::int AS yes,
            count(*) FILTER (WHERE ch.respect = 'partly')::int AS partly,
            count(*) FILTER (WHERE ch.respect = 'no')::int AS no
       FROM clinics cl LEFT JOIN sites s ON s.id = cl.site_id
       LEFT JOIN checkins ch ON ch.clinic_id = cl.id AND ch.completed_at >= $1 AND ch.completed_at < $2
            AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = ch.user_id AND u.language = $3))
      WHERE cl.active AND ($4::int IS NULL OR cl.site_id = $4) AND ($5::int IS NULL OR cl.id = $5)
      GROUP BY cl.id, s.name ORDER BY cl.name`,
    params,
  );
  const clinics: ClinicRow[] = clinicRows.map((r) => ({
    id: r.id,
    name: r.name,
    area: r.area,
    site: r.site,
    verified: r.verified,
    passes: sup(r.passes),
    visits: sup(r.visits),
    responses: r.responses,
    respectYes: share(r.yes, r.responses),
    respectPartly: share(r.partly, r.responses),
    respectNo: share(r.no, r.responses),
  }));

  // Weekly trend, Monday-based weeks.
  const weekRows = await db.query(
    `WITH weeks AS (SELECT generate_series(date_trunc('week', $1::timestamptz), date_trunc('week', $2::timestamptz - interval '1 second'), interval '1 week') AS w)
     SELECT to_char(w, 'YYYY-MM-DD') AS week,
       (SELECT count(*)::int FROM messages m JOIN users u ON u.id = m.user_id WHERE m.direction = 'in' AND m.danger IS NOT NULL AND m.created_at >= greatest(w, $1::timestamptz) AND m.created_at < least(w + interval '1 week', $2::timestamptz) AND ${girlWhere} AND $5::int IS NULL) AS questions,
       (SELECT count(*)::int FROM passes p JOIN users u ON u.id = p.user_id LEFT JOIN clinics cl ON cl.id = p.suggested_clinic WHERE p.issued_at >= greatest(w, $1::timestamptz) AND p.issued_at < least(w + interval '1 week', $2::timestamptz) AND ${passWhere}) AS passes,
       (SELECT count(*)::int FROM checkins ch JOIN passes p ON p.code = ch.pass_code JOIN users u ON u.id = p.user_id LEFT JOIN clinics cl ON cl.id = p.suggested_clinic WHERE ch.visited AND ch.completed_at >= greatest(w, $1::timestamptz) AND ch.completed_at < least(w + interval '1 week', $2::timestamptz) AND ${passWhere}) AS visits,
       (SELECT count(*)::int FROM cases c JOIN users u ON u.id = c.user_id WHERE c.urgent AND c.created_at >= greatest(w, $1::timestamptz) AND c.created_at < least(w + interval '1 week', $2::timestamptz) AND ($3::text IS NULL OR u.language = $3) AND ($4::int IS NULL OR c.site_id = $4) AND $5::int IS NULL) AS urgent
     FROM weeks ORDER BY w`,
    params,
  );
  const weeks: WeekRow[] = weekRows.map((w) => ({ week: w.week, questions: sup(w.questions), passes: sup(w.passes), visits: sup(w.visits), urgent: sup(w.urgent) }));

  const [labels] = await db.query(`SELECT count(DISTINCT message_id)::int AS n FROM labels`);
  const [payouts] = await db.query(`SELECT coalesce(sum(amount_kes), 0)::int AS pending FROM dada_payouts WHERE status IN ('pending','approved')`);
  // The live model's report from the registry, else the models/ folder.
  const active = await db.query<{ task: string; report: unknown }>(`SELECT task, report FROM model_versions WHERE status = 'active'`);
  const modelReports = Object.fromEntries(
    ["danger", "topic"].map((task) => {
      const live = active.find((a) => a.task === task);
      if (live) return [task, live.report];
      const path = join(MODELS_DIR, `${task}.report.json`);
      return [task, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null];
    }),
  );

  return {
    filters: f,
    clinicFiltered: f.clinicId != null,
    girls: sup(q.girls),
    questions: sup(q.questions),
    voiceShare: share(q.voice, q.questions),
    codedTermMessages: sup(q.coded),
    passes: sup(p.passes),
    passClinics: p.clinics as number,
    checkinsAnswered: sup(p.answered),
    visitsConfirmed: sup(p.visited),
    visitRate: share(p.visited, p.answered),
    redeemed: sup(p.redeemed),
    urgentCases: sup(c.urgent),
    escalated: sup(c.escalated),
    openCases: c.open as number,
    // A median of fewer than 5 replies is too revealing to show.
    medianUrgentReplyMin: c.urgent_replied >= MIN_RESPONSES && c.median_urgent_reply_min != null ? Number(c.median_urgent_reply_min) : null,
    topics: topics.map((t) => ({ topic: t.topic, n: sup(t.n), share: share(t.n, q.questions) })),
    languages: languages.map((l) => ({ language: l.language ?? "not chosen", n: sup(l.n) })),
    clinics,
    weeks,
    labelledMessages: labels.n as number,
    dadaPayoutsPendingKes: payouts.pending as number,
    modelReports,
  };
}

export type DashboardStats = Awaited<ReturnType<typeof dashboardStats>>;

// ---- CSV export (same filters, same suppression) ----

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Quote, and neutralise spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");

export function statsCsv(st: DashboardStats, labels: { site: string; clinic: string; language: string }): string {
  const f = st.filters;
  const lines = [
    csvLine(["Ubah dashboard export", `${f.from.toISOString().slice(0, 10)} to ${new Date(f.to.getTime() - 1).toISOString().slice(0, 10)}`]),
    csvLine(["Site", labels.site, "Clinic", labels.clinic, "Language", labels.language]),
    csvLine(["Counts of 1 to 4 are shown as <5 to protect privacy."]),
    "",
    csvLine(["Measure", "Value"]),
    csvLine(["Girls who asked", showCount(st.girls)]),
    csvLine(["Questions answered", showCount(st.questions)]),
    csvLine(["Share by voice note", showPct(st.voiceShare)]),
    csvLine(["Referral passes issued", showCount(st.passes)]),
    csvLine(["Passes recorded at a clinic desk", showCount(st.redeemed)]),
    csvLine(["Check-in answers", showCount(st.checkinsAnswered)]),
    csvLine(["Visits confirmed", showCount(st.visitsConfirmed)]),
    csvLine(["Visit rate", showPct(st.visitRate)]),
    csvLine(["Urgent handoffs", showCount(st.urgentCases)]),
    csvLine(["Escalated to a nurse", showCount(st.escalated)]),
    csvLine(["Median first reply to urgent cases (minutes)", st.medianUrgentReplyMin == null ? "—" : Math.round(st.medianUrgentReplyMin)]),
    "",
    csvLine(["Week starting", "Questions", "Passes", "Visits confirmed", "Urgent cases"]),
    ...st.weeks.map((w) => csvLine([w.week, showCount(w.questions), showCount(w.passes), showCount(w.visits), showCount(w.urgent)])),
    "",
    csvLine(["Clinic", "Site", "Verified", "Passes", "Visits confirmed", "Check-in answers", "Respect: yes", "Respect: partly", "Respect: no"]),
    ...st.clinics.map((c) =>
      csvLine([c.name, c.site ?? "", c.verified ? "yes" : "no", showCount(c.passes), showCount(c.visits), showCount(sup(c.responses)), showPct(c.respectYes), showPct(c.respectPartly), showPct(c.respectNo)]),
    ),
    "",
    csvLine(["Topic", "Questions", "Share"]),
    ...st.topics.map((t) => csvLine([t.topic, showCount(t.n), showPct(t.share)])),
  ];
  return lines.join("\r\n") + "\r\n";
}
