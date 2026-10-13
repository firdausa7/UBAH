import type { Db } from "./db.js";
import { MIN_RESPONSES } from "./stats.js";

// What girls see about a clinic: how many of the girls who went there (and answered the day-3
// check-in in the last 12 months) said they were treated with respect. Shown only when at least
// MIN_RESPONSES girls answered, so no single girl's answer can be singled out.
export interface ClinicRating {
  respectful: number;
  total: number;
}

export async function clinicRatings(db: Db): Promise<Map<number, ClinicRating>> {
  const rows = await db.query<{ clinic_id: number; total: number; yes: number }>(
    `SELECT clinic_id, count(*)::int AS total, count(*) FILTER (WHERE respect = 'yes')::int AS yes
       FROM checkins WHERE respect IS NOT NULL AND clinic_id IS NOT NULL AND completed_at > now() - interval '12 months'
      GROUP BY clinic_id HAVING count(*) >= $1`,
    [MIN_RESPONSES],
  );
  return new Map(rows.map((r) => [r.clinic_id, { respectful: r.yes, total: r.total }]));
}
