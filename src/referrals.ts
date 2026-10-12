import type { Db } from "./db.js";
import { config } from "./config.js";
import { newPassCode } from "./privacy.js";
import { enqueue } from "./jobs/queue.js";

export const SERVICES: Record<string, string> = {
  pregnancy_test: "Pregnancy test",
  family_planning: "Family planning",
  period_care: "Period care",
  sti: "Infection or HIV test",
  counselling: "Counselling",
  safety: "Safety support",
  antenatal: "Pregnancy check-up",
};
// Order used by the "What do you need?" menu.
export const SERVICE_MENU = ["pregnancy_test", "family_planning", "period_care", "sti", "counselling", "safety"];

export const TOPIC_SERVICES: Record<string, string[]> = {
  periods: ["period_care"],
  pregnancy: ["pregnancy_test", "counselling"],
  family_planning: ["family_planning"],
  sti: ["sti"],
  safety: ["safety", "counselling"],
  feelings: ["counselling"],
  body: [],
};

export interface ClinicRow {
  id: number;
  name: string;
  area: string;
  services: string[];
  hours: string;
  free: boolean;
  verified: boolean;
}

// Best clinic first: covers the most of the needed services, verified before unverified.
export async function findClinics(db: Db, services: string[]): Promise<ClinicRow[]> {
  const rows = await db.query<ClinicRow>(`SELECT id, name, area, services, hours, free, verified FROM clinics WHERE active ORDER BY id`);
  return rows
    .map((c) => ({ c, overlap: services.filter((s) => c.services.includes(s)).length }))
    .filter((x) => x.overlap > 0 || services.length === 0)
    .sort((a, b) => b.overlap - a.overlap || Number(b.c.verified) - Number(a.c.verified))
    .map((x) => x.c);
}

export interface IssuedPass {
  code: string;
  clinic: ClinicRow;
  expiresAt: Date;
}

export async function issuePass(db: Db, userId: number, services: string[], urgent = false): Promise<IssuedPass | null> {
  const clinics = await findClinics(db, services);
  if (clinics.length === 0) return null;
  const clinic = clinics[0];
  const expiresAt = new Date(Date.now() + config.passValidDays * 864e5);
  let code = newPassCode();
  for (let i = 0; i < 5; i++) {
    const clash = await db.query(`SELECT 1 FROM passes WHERE code = $1`, [code]);
    if (clash.length === 0) break;
    code = newPassCode();
  }
  await db.query(
    `INSERT INTO passes (code, user_id, services, suggested_clinic, urgent, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [code, userId, services, clinic.id, urgent, expiresAt.toISOString()],
  );
  const dueAt = new Date(Date.now() + config.checkinDelayHours * 3600e3);
  const [ci] = await db.query<{ id: number }>(`INSERT INTO checkins (pass_code, user_id, due_at) VALUES ($1,$2,$3) RETURNING id`, [code, userId, dueAt.toISOString()]);
  // The day-3 check-in is a durable job: it survives restarts and runs on any instance.
  await enqueue(db, "checkin.send", { checkinId: ci.id }, { runAt: dueAt, uniqueKey: `checkin:${ci.id}` });
  return { code, clinic, expiresAt };
}

export interface PassCheck {
  valid: boolean;
  reason?: string;
  code?: string;
  services?: string[];
  urgent?: boolean;
  expiresAt?: string;
  alreadyRedeemed?: boolean;
}

// Clinic desk: is this pass valid here? Shows only the services, never who she is.
export async function checkPass(db: Db, rawCode: string, clinicId: number | null): Promise<PassCheck> {
  const code = rawCode.trim().toUpperCase().replace(/^UB-?/, "UB-");
  const [p] = await db.query(`SELECT code, services, urgent, expires_at, redeemed_at FROM passes WHERE code = $1`, [code]);
  if (!p) return { valid: false, reason: "Pass not found" };
  if (new Date(p.expires_at) < new Date()) return { valid: false, reason: "Pass has expired", code };
  if (clinicId) {
    const [c] = await db.query(`SELECT services FROM clinics WHERE id = $1`, [clinicId]);
    if (c && !p.services.some((s: string) => c.services.includes(s))) return { valid: false, reason: "This clinic doesn't offer the services on this pass", code };
  }
  return { valid: true, code, services: p.services, urgent: p.urgent, expiresAt: p.expires_at, alreadyRedeemed: Boolean(p.redeemed_at) };
}

export async function redeemPass(db: Db, code: string, clinicId: number) {
  await db.query(`UPDATE passes SET redeemed_at = COALESCE(redeemed_at, now()), redeemed_clinic = COALESCE(redeemed_clinic, $2) WHERE code = $1`, [code, clinicId]);
}
