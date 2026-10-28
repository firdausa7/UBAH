import type { Db } from "./db.js";
import { decryptSecret, encryptSecret } from "./privacy.js";
import { findDangerWords, worstDanger } from "./ml/dangerWords.js";
import { analyse } from "./ml/models.js";

// Confidential reports: harassment, abuse, exploitation, online harm.
// - Minimal and optional: only what happened is required; everything else she may skip.
// - Restricted: only protection officers open them (never the ordinary inbox); every look is logged.
// - Her words and staff notes are encrypted; nothing is sent to an outside service.
// - A priority SUGGESTION (her answers and Ubah's own danger lists), never a decision.
// - In danger now: the urgent path starts at once as well (src/urgentHelp.ts), without her report text.

export const CATEGORIES = ["harassment", "abuse", "exploitation", "online", "other"] as const;
export const WHO = ["family", "partner", "school", "stranger", "online", "other", "not_said"] as const;
export const HAPPENED = ["now", "days", "weeks", "longer", "not_said"] as const;
export const STATUSES = ["new", "in_review", "referred", "follow_up", "closed"] as const;
export type Status = (typeof STATUSES)[number];

// Which status may follow which (closed can be reopened for review).
export const NEXT: Record<Status, Status[]> = {
  new: ["in_review", "closed"],
  in_review: ["referred", "follow_up", "closed"],
  referred: ["follow_up", "closed"],
  follow_up: ["in_review", "referred", "closed"],
  closed: ["in_review"],
};

export interface ReportInput {
  category: string;
  inDanger: boolean;
  who?: string | null;
  happened?: string | null;
  description?: string | null;
  contactOk: boolean;
}

const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

export function validReport(b: any): ReportInput | null {
  if (!oneOf(CATEGORIES, b?.category)) return null;
  if (b.who != null && b.who !== "" && !oneOf(WHO, b.who)) return null;
  if (b.happened != null && b.happened !== "" && !oneOf(HAPPENED, b.happened)) return null;
  return {
    category: b.category,
    inDanger: b.inDanger === true,
    who: b.who || null,
    happened: b.happened || null,
    description: String(b.description ?? "").trim().slice(0, 4000) || null,
    contactOk: b.contactOk === true,
  };
}

export function priorityHint(r: ReportInput, lang: string | null): "high" | "normal" {
  if (r.inDanger || r.happened === "now") return "high";
  if (r.description && (worstDanger(findDangerWords(r.description)) || analyse(r.description, lang).danger !== "none")) return "high";
  return "normal";
}

export async function createReport(db: Db, userId: number, lang: string | null, r: ReportInput): Promise<number> {
  const [rep] = await db.query<{ id: number }>(
    `INSERT INTO safeguarding_reports (user_id, category, in_danger, who, happened, description_enc, contact_ok, priority_hint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [userId, r.category, r.inDanger, r.who, r.happened, r.description ? encryptSecret(r.description) : null, r.contactOk, priorityHint(r, lang)],
  );
  await db.query(`INSERT INTO safeguarding_events (report_id, kind, to_status) VALUES ($1,'created','new')`, [rep.id]);
  return rep.id;
}

// What she sees of her reports: what she sent and where it stands, nothing of staff notes.
export async function reportsOf(db: Db, userId: number) {
  const rows = await db.query<any>(`SELECT id, category, status, created_at, updated_at FROM safeguarding_reports WHERE user_id = $1 ORDER BY id DESC`, [userId]);
  return rows.map((r) => ({ id: r.id, category: r.category, status: r.status === "new" ? "received" : r.status === "closed" ? "closed" : "being_looked_at", at: r.created_at }));
}

export const decrypt = (v: string | null) => (v ? decryptSecret(v) : null);
export const encrypt = (v: string | null) => (v ? encryptSecret(v) : null);
