import { Router } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { languageConfig, workerLabel } from "../languages/index.js";
import { requireRole, workerOf } from "../auth/roles.js";
import { logAccess } from "../auth/access.js";

// /api/admin: list girls and health workers, and assign each girl to one worker.
// Admins see who a girl is assigned to, never her messages.

export function adminApi(db: Db): Router {
  const r = Router();
  r.use(requireRole(db, ["admin"]));

  r.get("/girls", async (req, res) => {
    const rows = await db.query<any>(
      `SELECT u.id, u.anon_id, u.language, u.channel, u.created_at, s.id AS worker_id, s.name AS worker_name
         FROM users u
         LEFT JOIN assignments a ON a.girl_id = u.id AND a.ended_at IS NULL
         LEFT JOIN staff s ON s.id = a.health_worker_id
        ORDER BY u.created_at DESC LIMIT 500`,
    );
    for (const g of rows) await logAccess(db, req, g.id, "profile");
    res.json({
      girls: rows.map((g) => ({
        id: g.id,
        anonId: g.anon_id,
        language: g.language,
        languageLabel: workerLabel(g.language),
        channel: g.channel,
        createdAt: g.created_at,
        worker: g.worker_id ? { id: g.worker_id, name: g.worker_name } : null,
      })),
    });
  });

  r.get("/workers", async (_req, res) => {
    const rows = await db.query<any>(
      `SELECT s.id, s.name, s.role, s.languages,
              (SELECT count(*)::int FROM assignments a WHERE a.health_worker_id = s.id AND a.ended_at IS NULL) AS girls
         FROM staff s WHERE s.active AND s.role IN ('nurse','dada') ORDER BY s.name`,
    );
    res.json({ workers: rows.map((w) => ({ id: w.id, name: w.name, role: w.role, languages: w.languages ?? [], girls: w.girls })) });
  });

  r.put("/girls/:id/assignment", async (req, res) => {
    const girlId = Number(req.params.id);
    const workerId = Number(req.body?.workerId);
    const [girl] = Number.isInteger(girlId) ? await db.query(`SELECT id FROM users WHERE id = $1`, [girlId]) : [];
    const [worker] = Number.isInteger(workerId) ? await db.query(`SELECT id FROM staff WHERE id = $1 AND active AND role IN ('nurse','dada')`, [workerId]) : [];
    if (!girl) return res.status(404).json({ error: "girl" });
    if (!worker) return res.status(400).json({ error: "worker" });
    await db.query(`UPDATE assignments SET ended_at = now() WHERE girl_id = $1 AND ended_at IS NULL`, [girlId]);
    await db.query(`INSERT INTO assignments (health_worker_id, girl_id, assigned_by) VALUES ($1,$2,$3)`, [workerId, girlId, workerOf(req).id]);
    await auditReq(db, req, { action: "girl.assign", targetType: "girl", targetId: girlId, details: { workerId } });
    res.json({ girlId, workerId });
  });

  // Every unassigned girl to a nurse or Dada who speaks her language, the one with the fewest girls
  // first. A girl whose language no worker speaks is left for the admin to assign by hand.
  r.post("/assign-unassigned", async (req, res) => {
    const girls = await db.query<{ id: number; language: string | null }>(
      `SELECT u.id, u.language FROM users u WHERE NOT EXISTS (SELECT 1 FROM assignments a WHERE a.girl_id = u.id AND a.ended_at IS NULL) ORDER BY u.created_at`,
    );
    const workers = await db.query<{ id: number; languages: string[]; girls: number }>(
      `SELECT s.id, s.languages, (SELECT count(*)::int FROM assignments a WHERE a.health_worker_id = s.id AND a.ended_at IS NULL) AS girls
         FROM staff s WHERE s.active AND s.role IN ('nurse','dada') ORDER BY s.id`,
    );
    let assigned = 0;
    const noWorker: Record<string, number> = {};
    for (const g of girls) {
      const lang = g.language ?? "en";
      const w = workers.filter((x) => (x.languages ?? []).includes(lang)).sort((a, b) => a.girls - b.girls || a.id - b.id)[0];
      if (!w) {
        noWorker[lang] = (noWorker[lang] ?? 0) + 1;
        continue;
      }
      await db.query(`INSERT INTO assignments (health_worker_id, girl_id, assigned_by) VALUES ($1,$2,$3)`, [w.id, g.id, workerOf(req).id]);
      w.girls++;
      assigned++;
    }
    await auditReq(db, req, { action: "girl.assign_by_language", targetType: "girl", details: { assigned, noWorker } });
    res.json({ assigned, noWorker });
  });

  r.delete("/girls/:id/assignment", async (req, res) => {
    const girlId = Number(req.params.id);
    if (!Number.isInteger(girlId)) return res.status(404).json({ error: "girl" });
    const ended = await db.query(`UPDATE assignments SET ended_at = now() WHERE girl_id = $1 AND ended_at IS NULL RETURNING id`, [girlId]);
    if (ended.length) await auditReq(db, req, { action: "girl.unassign", targetType: "girl", targetId: girlId });
    res.json({ girlId, workerId: null });
  });

  // Answer templates: the English a worker often writes. A native speaker adds the translation and
  // their name through the CSV export/import; until then a template is not used.
  r.get("/templates", async (_req, res) => {
    const rows = await db.query<any>(`SELECT id, language, english_text, translated_text, reviewed_by FROM answer_templates WHERE active ORDER BY language, english_text`);
    res.json({ templates: rows.map((t) => ({ id: t.id, language: t.language, english: t.english_text, translated: t.translated_text, reviewedBy: t.reviewed_by })) });
  });

  r.post("/templates", async (req, res) => {
    const language = String(req.body?.language ?? "");
    const english = String(req.body?.english ?? "").trim().slice(0, 1600);
    if (!languageConfig(language)?.translation) return res.status(400).json({ error: "language" });
    if (!english) return res.status(400).json({ error: "english" });
    const [t] = await db.query<{ id: number }>(
      `INSERT INTO answer_templates (language, english_text, created_by) VALUES ($1,$2,$3) ON CONFLICT (language, lower(english_text)) WHERE active DO NOTHING RETURNING id`,
      [language, english, workerOf(req).id],
    );
    if (!t) return res.status(409).json({ error: "exists" });
    await auditReq(db, req, { action: "template.create", targetType: "template", targetId: t.id });
    res.status(201).json({ id: t.id });
  });

  return r;
}
