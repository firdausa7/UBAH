import type { Db } from "../db.js";

// One review workflow for health content and for translated strings:
//   draft -> in_review -> approved (by a named health-partner reviewer, never the author) -> published
// A reviewer can send a version back to draft with a note. Publishing archives the previous
// published version, so exactly one version per topic/string and language is live.
// Every transition is a conditional UPDATE: if someone else changed it first, nothing happens.

export type Status = "draft" | "in_review" | "approved" | "published" | "archived";
export type VersionTable = "content_versions" | "string_versions";
const KEY: Record<VersionTable, string> = { content_versions: "topic_id", string_versions: "key" };

export interface Actor {
  id: number;
  name: string;
  title?: string;
  organisation?: string;
}

export type TransitionResult = "ok" | "state" | "own_work" | "placeholders";

async function move(db: Db, table: VersionTable, id: number, from: Status, sets: string, params: unknown[]): Promise<boolean> {
  const rows = await db.query(`UPDATE ${table} SET status = $2, ${sets} WHERE id = $1 AND status = '${from}' RETURNING id`, [id, ...params]);
  return rows.length > 0;
}

export async function submitVersion(db: Db, table: VersionTable, id: number): Promise<TransitionResult> {
  return (await move(db, table, id, "draft", "submitted_at = now(), review_note = ''", ["in_review"])) ? "ok" : "state";
}

export async function approveVersion(db: Db, table: VersionTable, id: number, reviewer: Actor): Promise<TransitionResult> {
  const [v] = await db.query<{ author_id: number | null; status: string }>(`SELECT author_id, status FROM ${table} WHERE id = $1`, [id]);
  if (!v || v.status !== "in_review") return "state";
  if (v.author_id === reviewer.id) return "own_work";
  const signed = [reviewer.name, reviewer.title, reviewer.organisation && `(${reviewer.organisation})`].filter(Boolean).join(", ").replace(", (", " (");
  return (await move(db, table, id, "in_review", "reviewed_by = $3, reviewer_name = $4, reviewed_at = now()", ["approved", reviewer.id, signed])) ? "ok" : "state";
}

export async function returnVersion(db: Db, table: VersionTable, id: number, reviewer: Actor, note: string): Promise<TransitionResult> {
  return (await move(db, table, id, "in_review", "review_note = $3, reviewed_by = $4, reviewed_at = now()", ["draft", note.slice(0, 2000), reviewer.id])) ? "ok" : "state";
}

export async function publishVersion(db: Db, table: VersionTable, id: number, publisher: Actor): Promise<TransitionResult> {
  return db.tx(async (t) => {
    const [v] = await t.query(`SELECT id, ${KEY[table]} AS k, language, status FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!v || v.status !== "approved") return "state";
    await t.query(`UPDATE ${table} SET status = 'archived' WHERE ${KEY[table]} = $1 AND language = $2 AND status = 'published'`, [v.k, v.language]);
    await t.query(`UPDATE ${table} SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`, [id, publisher.id]);
    return "ok";
  });
}

// Withdraw a draft (kept in history as archived; nothing is ever deleted).
export async function discardVersion(db: Db, table: VersionTable, id: number): Promise<TransitionResult> {
  return (await move(db, table, id, "draft", "review_note = review_note", ["archived"])) ? "ok" : "state";
}

// The version being worked on (not yet published) for a topic/string and language, if any.
export async function workingVersion(db: Db, table: VersionTable, key: string, language: string) {
  const [v] = await db.query(
    `SELECT * FROM ${table} WHERE ${KEY[table]} = $1 AND language = $2 AND status IN ('draft','in_review','approved') ORDER BY version DESC LIMIT 1`,
    [key, language],
  );
  return v ?? null;
}

export async function nextVersionNo(db: Db, table: VersionTable, key: string, language: string): Promise<number> {
  const [r] = await db.query<{ n: number }>(`SELECT coalesce(max(version), 0)::int + 1 AS n FROM ${table} WHERE ${KEY[table]} = $1 AND language = $2`, [key, language]);
  return r.n;
}

export const placeholdersOf = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();
