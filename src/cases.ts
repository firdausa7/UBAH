import { EventEmitter } from "node:events";
import type { Db } from "./db.js";
import { config } from "./config.js";
import { alertStaff } from "./channels/outbound.js";
import { log } from "./log.js";

// Human handoffs. Who sees what (minimum each role needs):
//   nurse, admin: every case
//   dada: Dada-level cases (safety, "talk to a person") and any case assigned to her
// Medical danger signs and self-harm go to the nurse level at once; a Dada can escalate any case.

export type CaseReason = "danger_medical" | "danger_safety" | "danger_selfharm" | "asked_for_person" | "voice_unclear";
export const levelFor = (reason: string): "nurse" | "dada" => (reason === "danger_medical" || reason === "danger_selfharm" ? "nurse" : "dada");

export const REASON_LABEL: Record<string, string> = {
  danger_medical: "Danger sign: medical",
  danger_safety: "Safety concern",
  danger_selfharm: "Self-harm risk",
  asked_for_person: "Asked for a person",
  voice_unclear: "Audio unclear",
};

export interface Viewer {
  id: number;
  role: string;
}

// SQL fragment limiting cases to what this staff member may see ($n = their id).
export function visibleSql(v: Viewer, param: string): string {
  return v.role === "dada" ? `(c.level = 'dada' OR c.assigned_to = ${param})` : "TRUE";
}
export const canSee = (v: Viewer, c: { level: string; assigned_to: number | null }) => v.role !== "dada" || c.level === "dada" || c.assigned_to === v.id;

// Live updates for the inbox (server-sent events). Other instances are caught by the inbox's poll.
export const caseBus = new EventEmitter();
caseBus.setMaxListeners(500);
export interface CaseSignal {
  id: number;
  urgent: boolean;
  level: string;
  kind: "opened" | "escalated" | "updated";
}

export async function caseEvent(db: Db, caseId: number, staffId: number | null, kind: string, details: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO case_events (case_id, staff_id, kind, details) VALUES ($1,$2,$3,$4)`, [caseId, staffId, kind, JSON.stringify(details)]);
}

export async function escalateToNurse(db: Db, caseId: number, staffId: number, reason: string): Promise<boolean> {
  const rows = await db.query<{ id: number; urgent: boolean; anon_id: string }>(
    `UPDATE cases c SET level = 'nurse', escalated_at = now(), escalated_by = $2,
            assigned_to = CASE WHEN (SELECT role FROM staff WHERE id = c.assigned_to) = 'nurse' THEN c.assigned_to ELSE NULL END
      FROM users u WHERE c.id = $1 AND u.id = c.user_id AND c.level = 'dada' AND c.status = 'open'
      RETURNING c.id, c.urgent, u.anon_id`,
    [caseId, staffId],
  );
  if (!rows.length) return false;
  await caseEvent(db, caseId, staffId, "escalated", { reason: reason.slice(0, 300) });
  const alert = `UBAH: case #${caseId} (girl ${rows[0].anon_id}) was escalated to a nurse by a Dada. Open: ${config.baseUrl}/staff/cases/${caseId}`;
  for (const phone of config.nurseAlertNumbers) await alertStaff(db, phone, alert);
  if (config.nurseAlertNumbers.length === 0) log.warn({ caseId }, "case escalated but NURSE_ALERT_NUMBERS is empty");
  caseBus.emit("case", { id: caseId, urgent: true, level: "nurse", kind: "escalated" } satisfies CaseSignal);
  return true;
}
