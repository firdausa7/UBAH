import { Router } from "express";
import type { Db } from "../db.js";
import { girlLanguages, languageConfig } from "../languages/index.js";
import { girlOf, requireRole } from "../auth/roles.js";
import { consents, setConsents } from "../auth/access.js";

// /api/me: the girl's own space. She sees only her own data.

export function meApi(db: Db): Router {
  const r = Router();
  r.use(requireRole(db, ["girl"]));

  r.get("/", async (req, res) => {
    const g = girlOf(req);
    res.json({
      anonId: g.anon_id,
      language: g.language,
      // Her four options; a disabled language is never offered, and girls never see "Beta".
      languages: girlLanguages().map((l) => ({ code: l.code, name: l.name })),
      consents: await consents(db, g.id),
    });
  });

  r.patch("/", async (req, res) => {
    const g = girlOf(req);
    const lang = String(req.body?.language ?? "");
    const l = languageConfig(lang);
    if (!l || l.status === "disabled") return res.status(400).json({ error: "language" });
    await db.query(`UPDATE users SET language = $2 WHERE id = $1`, [g.id, l.code]);
    res.json({ language: l.code });
  });

  // What she shares with her health worker. She can change her mind at any time.
  r.put("/consents", async (req, res) => {
    const g = girlOf(req);
    const b = req.body ?? {};
    for (const k of ["messages", "voice"]) if (k in b && typeof b[k] !== "boolean") return res.status(400).json({ error: k });
    await setConsents(db, g.id, { messages: b.messages, voice: b.voice });
    res.json({ consents: await consents(db, g.id) });
  });

  return r;
}
