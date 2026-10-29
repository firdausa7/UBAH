import { describe, it, expect, beforeAll } from "vitest";
import { freshDb, girl, staffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { refreshCaches } from "../src/caches.js";
import { lessonsFor } from "../src/girlCare.js";
import { search } from "../src/content/content.js";
import { hashPhone } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await refreshCaches(db, { force: true });
});

async function englishGirl(phone: string, ageBand: string | null) {
  const g = girl(db, phone, "sms");
  await g.send("hi");
  await g.send("3");
  await g.send("2");
  await db.query(`UPDATE users SET age_band = $2 WHERE phone_hash = $1`, [hashPhone(phone), ageBand]);
  return g;
}

describe("the health information assistant", () => {
  it("says every answer is information, not medical advice", async () => {
    const g = await englishGirl("0712990001", null);
    const answer = await g.send("my period is two weeks late, what should i do");
    expect(answer).toContain("This is health information, not medical advice for you.");
    expect(answer).toContain("(Ubah checked answer:");
  });

  it("gives an adults-only topic only to a girl who said she is 18 or older", async () => {
    const q = "how do i use a pad";
    const top = search(q, { lang: "en" })[0].item;
    const topicId = top.id;
    await db.query(`UPDATE content_topics SET audience = 'adults' WHERE id = $1`, [topicId]);
    await refreshCaches(db, { force: true });
    try {
      for (const [phone, band, gets] of [
        ["0712990002", "18_plus", true],
        ["0712990003", "15_17", false],
        ["0712990004", "under_15", false],
        ["0712990005", "not_said", false],
        ["0712990006", null, false],
      ] as const) {
        const reply = await (await englishGirl(phone, band)).send(q);
        // The restricted topic itself (another, open topic may still answer).
        expect(reply.includes(`Ubah checked answer: ${top.title}`), `${band}`).toBe(gets);
      }
      // Lessons follow the same rule.
      expect((await lessonsFor(db, "en", "18_plus")).lessons.some((l) => l.id === topicId)).toBe(true);
      expect((await lessonsFor(db, "en", "15_17")).lessons.some((l) => l.id === topicId)).toBe(false);
    } finally {
      await db.query(`UPDATE content_topics SET audience = 'all' WHERE id = $1`, [topicId]);
      await refreshCaches(db, { force: true });
    }
  });

  it("has empty, unpublished slots for antenatal care, postnatal care and normal periods: nothing is served until a health partner writes it", async () => {
    const slots = await db.query(`SELECT id, category, brief FROM content_topics WHERE id IN ('antenatal-care','postnatal-care','periods-normal') ORDER BY id`);
    expect(slots.map((s: any) => s.id)).toEqual(["antenatal-care", "periods-normal", "postnatal-care"]);
    for (const s of slots) expect(s.brief).toMatch(/^DRAFT brief/);
    expect(slots.find((s: any) => s.id === "periods-normal").category).toBe("periods");
    expect((await db.query(`SELECT 1 FROM content_versions WHERE topic_id IN ('antenatal-care','postnatal-care','periods-normal')`)).length).toBe(0);
  });

  it("lets the content team set a topic's audience in the studio", async () => {
    const app = createApp(db, { loginPerMin: 10_000 });
    const editor = await staffClient(app, db, "editor");
    const page = (await editor.get("/staff/content/periods-pain")).text;
    expect(page).toContain("Who may receive this answer");
    await editor.post("/staff/content/periods-pain/settings", { category: "periods", audience: "adults", brief: "" });
    expect((await db.query(`SELECT audience FROM content_topics WHERE id = 'periods-pain'`))[0].audience).toBe("adults");
    await editor.post("/staff/content/periods-pain/settings", { category: "periods", audience: "all", brief: "" });
    expect((await db.query(`SELECT audience FROM content_topics WHERE id = 'periods-pain'`))[0].audience).toBe("all");
  });
});
