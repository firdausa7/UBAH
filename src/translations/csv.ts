import type { Db } from "../db.js";
import { en } from "../i18n.js";
import { placeholdersOf, nextVersionNo } from "../content/workflow.js";
import { parseCsv, toCsv } from "../tools/csv.js";

// The round trip with a native speaker, in a spreadsheet:
//   export  every UI string and answer template not yet checked in that language, with the English
//           and any draft (machine drafts included, marked), into a CSV;
//   import  the corrected CSV back, with the checker's name in checked_by.
// UI strings: an import becomes a version "in review", noting who checked it. A reviewer approves and
// publishes it in the Translation studio as before: nothing reaches girls without that step.
// Answer templates: the translation and the checker's name are saved; from then on it is used.

export const STRING_COLUMNS = ["key", "english", "translation", "status", "checked_by", "note"];
export const TEMPLATE_COLUMNS = ["id", "english", "translation", "checked_by"];

export async function exportStrings(db: Db, lang: string): Promise<string> {
  const rows = await db.query<{ key: string; text: string; status: string }>(
    `SELECT DISTINCT ON (key) key, text, status FROM string_versions WHERE language = $1 AND status <> 'archived'
      ORDER BY key, (status = 'published') DESC, version DESC`,
    [lang],
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = Object.keys(en)
    .filter((k) => byKey.get(k)?.status !== "published")
    .map((k) => {
      const v = byKey.get(k);
      return {
        key: k,
        english: en[k],
        translation: v?.text ?? "",
        status: v ? `${v.status} (not checked)` : "missing",
        checked_by: "",
        note: placeholdersOf(en[k]).length ? `Keep exactly: ${placeholdersOf(en[k]).join(" ")}` : "",
      };
    });
  return toCsv(out, STRING_COLUMNS);
}

export async function exportTemplates(db: Db, lang: string): Promise<string> {
  const rows = await db.query<{ id: number; english_text: string; translated_text: string }>(
    `SELECT id, english_text, translated_text FROM answer_templates WHERE active AND language = $1 AND reviewed_by = '' ORDER BY id`,
    [lang],
  );
  return toCsv(rows.map((r) => ({ id: String(r.id), english: r.english_text, translation: r.translated_text, checked_by: "" })), TEMPLATE_COLUMNS);
}

export interface ImportResult {
  saved: number;
  skipped: number;
  problems: string[];
}

export async function importStrings(db: Db, lang: string, csv: string): Promise<ImportResult> {
  const result: ImportResult = { saved: 0, skipped: 0, problems: [] };
  for (const [i, r] of parseCsv(csv).entries()) {
    const line = i + 2;
    if (!r.key || !r.translation) {
      result.skipped++;
      continue;
    }
    if (!(r.key in en)) {
      result.problems.push(`line ${line}: unknown key ${r.key}`);
      continue;
    }
    if (!r.checked_by) {
      result.problems.push(`line ${line} (${r.key}): checked_by is empty, so it was not imported`);
      continue;
    }
    const want = placeholdersOf(en[r.key]).join(" ");
    if (placeholdersOf(r.translation).join(" ") !== want) {
      result.problems.push(`line ${line} (${r.key}): the translation must keep exactly ${want || "no {placeholders}"}`);
      continue;
    }
    const [same] = await db.query(`SELECT 1 FROM string_versions WHERE key = $1 AND language = $2 AND status IN ('in_review','approved','published') AND text = $3`, [r.key, lang, r.translation]);
    if (same) {
      result.skipped++;
      continue;
    }
    // Replace any open draft, so the reviewer sees one version: the checked one.
    await db.query(`UPDATE string_versions SET status = 'archived' WHERE key = $1 AND language = $2 AND status IN ('draft','in_review')`, [r.key, lang]);
    await db.query(
      `INSERT INTO string_versions (key, language, version, text, status, submitted_at, review_note) VALUES ($1,$2,$3,$4,'in_review', now(), $5)`,
      [r.key, lang, await nextVersionNo(db, "string_versions", r.key, lang), r.translation, `Checked by ${r.checked_by.slice(0, 100)} (CSV import)`],
    );
    result.saved++;
  }
  return result;
}

export async function importTemplates(db: Db, lang: string, csv: string): Promise<ImportResult> {
  const result: ImportResult = { saved: 0, skipped: 0, problems: [] };
  for (const [i, r] of parseCsv(csv).entries()) {
    const line = i + 2;
    const id = Number(r.id);
    if (!Number.isInteger(id) || !r.translation) {
      result.skipped++;
      continue;
    }
    const [t] = await db.query(`SELECT id FROM answer_templates WHERE id = $1 AND language = $2 AND active`, [id, lang]);
    if (!t) {
      result.problems.push(`line ${line}: no active ${lang} template with id ${r.id}`);
      continue;
    }
    // Without a name it is kept as a draft and not used.
    await db.query(
      `UPDATE answer_templates SET translated_text = $2, reviewed_by = $3, reviewed_at = CASE WHEN $3 = '' THEN NULL ELSE now() END WHERE id = $1`,
      [id, r.translation.slice(0, 2000), (r.checked_by ?? "").slice(0, 100)],
    );
    if (!r.checked_by) result.problems.push(`line ${line} (template ${id}): saved, but not used until checked_by is filled in`);
    result.saved++;
  }
  return result;
}
