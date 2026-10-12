import type { Request } from "express";
import type { Db } from "./db.js";
import { log } from "./log.js";

// Append-only record of who did what. Store references (ids), never message text or phone numbers.
export type AuditAction =
  | "login.success"
  | "login.failed"
  | "login.locked"
  | "login.mfa_failed"
  | "login.mfa_enrolled"
  | "login.recovery_code_used"
  | "login.sms_code_sent"
  | "logout"
  | "password.changed"
  | "case.view"
  | "case.reply"
  | "case.handled"
  | "pass.check"
  | "pass.redeem"
  | "label.save"
  | "checkins.run"
  | "audit.view";

export interface AuditEntry {
  staffId?: number | null;
  staffLogin?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (staff_id, staff_login, action, target_type, target_id, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.staffId ?? null, e.staffLogin ?? null, e.action, e.targetType ?? null, e.targetId == null ? null : String(e.targetId), JSON.stringify(e.details ?? {}), e.ip ?? null],
    );
  } catch (err) {
    // Never lose the event silently: it still reaches the structured log.
    log.error({ err, action: e.action }, "audit write failed");
  }
}

// Convenience for request handlers: fills in who and from where.
export function auditReq(db: Db, req: Request, e: Omit<AuditEntry, "staffId" | "staffLogin" | "ip">) {
  const s = (req as any).staff as { id: number; login: string } | undefined;
  return audit(db, { ...e, staffId: s?.id ?? null, staffLogin: s?.login ?? null, ip: req.ip ?? null });
}
