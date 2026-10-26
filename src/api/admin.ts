import { Router } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { workerLabel } from "../languages/index.js";
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

  r.delete("/girls/:id/assignment", async (req, res) => {
    const girlId = Number(req.params.id);
    if (!Number.isInteger(girlId)) return res.status(404).json({ error: "girl" });
    const ended = await db.query(`UPDATE assignments SET ended_at = now() WHERE girl_id = $1 AND ended_at IS NULL RETURNING id`, [girlId]);
    if (ended.length) await auditReq(db, req, { action: "girl.unassign", targetType: "girl", targetId: girlId });
    res.json({ girlId, workerId: null });
  });

  return r;
}
