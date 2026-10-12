import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import { crossValidate, train, type Example, type ModelJson, type Report } from "./classifier.js";
import { MODELS_DIR } from "./models.js";
import { readSeed, TASKS, type Task } from "./train.js";

// Model registry: every trained model is kept with its evaluation. A new model starts as a
// "candidate"; an admin promotes it to "active". SAFETY: a danger-sign model is never promoted if
// its recall for any danger class (medical, safety, self-harm) is lower than the active model's.

export const DANGER_CLASSES = ["medical", "safety", "selfharm"] as const;

export interface VersionRow {
  id: number;
  task: Task;
  version: number;
  status: "candidate" | "active" | "retired" | "rejected";
  model: ModelJson;
  report: Report;
  examples: number;
  sources: Record<string, number>;
  trained_at: string;
  promoted_at: string | null;
  notes: string;
}

// Training data: the seed set plus every message nurses and Dadas labelled (majority label per message).
export async function labelledExamples(db: Db, task: Task): Promise<Example[]> {
  const rows = await db.query<{ body: string; label: string; language: string | null }>(
    `SELECT body, label, language FROM (
       SELECT m.body, l.label, u.language, count(*) AS votes,
              row_number() OVER (PARTITION BY m.id ORDER BY count(*) DESC, l.label) AS rk
         FROM labels l JOIN messages m ON m.id = l.message_id JOIN users u ON u.id = m.user_id
        WHERE l.task = $1 GROUP BY m.id, m.body, l.label, u.language) x
      WHERE rk = 1`,
    [task],
  );
  return rows.map((r) => ({ text: r.body, label: r.label, source: "labeled", language: r.language ?? "en" }));
}

export async function trainCandidate(db: Db, task: Task, staffId: number | null, notes = ""): Promise<VersionRow | null> {
  const data = [...readSeed(task), ...(await labelledExamples(db, task))];
  if (data.length < 10) return null;
  const opts = { uniformPrior: task === "danger" };
  const report = crossValidate(task, data, 5, opts);
  const model = train(task, data, opts);
  const [row] = await db.query<VersionRow>(
    `INSERT INTO model_versions (task, version, status, model, report, examples, sources, trained_by, notes)
     VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM model_versions WHERE task = $1), 'candidate', $2, $3, $4, $5, $6, $7) RETURNING *`,
    [task, JSON.stringify(model), JSON.stringify(report), data.length, JSON.stringify(report.sources), staffId, notes],
  );
  return row;
}

export interface Gate {
  ok: boolean;
  drops: Array<{ label: string; from: number; to: number }>;
}

// Danger recall must not drop for any danger class.
export function dangerGate(candidate: Report, active: Report | null): Gate {
  if (!active) return { ok: true, drops: [] };
  const drops = DANGER_CLASSES.filter((l) => active.perLabel[l])
    .map((l) => ({ label: l, from: active.perLabel[l].recall, to: candidate.perLabel[l]?.recall ?? 0 }))
    .filter((d) => d.to + 1e-9 < d.from);
  return { ok: drops.length === 0, drops };
}

export async function activeVersion(db: Db, task: Task): Promise<VersionRow | null> {
  const [row] = await db.query<VersionRow>(`SELECT * FROM model_versions WHERE task = $1 AND status = 'active'`, [task]);
  return row ?? null;
}

export async function promote(db: Db, id: number, staffId: number): Promise<{ ok: true } | { ok: false; reason: string; gate?: Gate }> {
  return db.tx(async (t) => {
    const [cand] = await t.query<VersionRow>(`SELECT * FROM model_versions WHERE id = $1 FOR UPDATE`, [id]);
    if (!cand || cand.status !== "candidate") return { ok: false as const, reason: "state" };
    const [active] = await t.query<VersionRow>(`SELECT * FROM model_versions WHERE task = $1 AND status = 'active' FOR UPDATE`, [cand.task]);
    if (cand.task === "danger") {
      const gate = dangerGate(cand.report, active?.report ?? null);
      if (!gate.ok) return { ok: false as const, reason: "danger_recall", gate };
    }
    if (active) await t.query(`UPDATE model_versions SET status = 'retired' WHERE id = $1`, [active.id]);
    await t.query(`UPDATE model_versions SET status = 'active', promoted_by = $2, promoted_at = now() WHERE id = $1`, [id, staffId]);
    return { ok: true as const };
  });
}

export async function reject(db: Db, id: number, note: string): Promise<boolean> {
  const rows = await db.query(`UPDATE model_versions SET status = 'rejected', notes = trim(notes || ' ' || $2) WHERE id = $1 AND status = 'candidate' RETURNING id`, [id, note.slice(0, 500)]);
  return rows.length > 0;
}

// First run: register the models shipped in models/ as the active version 1 of each task.
export async function bootstrapModels(db: Db): Promise<number> {
  let added = 0;
  for (const task of TASKS) {
    const [exists] = await db.query(`SELECT 1 FROM model_versions WHERE task = $1 LIMIT 1`, [task]);
    const modelPath = join(MODELS_DIR, `${task}.json`);
    const reportPath = join(MODELS_DIR, `${task}.report.json`);
    if (exists || !existsSync(modelPath) || !existsSync(reportPath)) continue;
    const model = JSON.parse(readFileSync(modelPath, "utf8")) as ModelJson;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
    await db.query(
      `INSERT INTO model_versions (task, version, status, model, report, examples, sources, promoted_at, notes) VALUES ($1, 1, 'active', $2, $3, $4, $5, now(), 'Shipped with the code (models/ folder)') ON CONFLICT DO NOTHING`,
      [task, JSON.stringify(model), JSON.stringify(report), report.examples, JSON.stringify(report.sources)],
    );
    added++;
  }
  return added;
}

export async function loadActiveModels(db: Db): Promise<Partial<Record<Task, ModelJson>>> {
  const rows = await db.query<{ task: Task; model: ModelJson }>(`SELECT task, model FROM model_versions WHERE status = 'active'`);
  return Object.fromEntries(rows.map((r) => [r.task, r.model]));
}
