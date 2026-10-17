import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { freshDb, staffClient, type StaffClient } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import { refreshCaches } from "../src/caches.js";
import { servingContent } from "../src/content/content.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
let editor: StaffClient;
let reviewer: StaffClient;

// Runs `fn` with a fake OpenAI-compatible server that answers with `reply` and records what it was asked.
async function withFakeAi<T>(reply: unknown, fn: (asked: any[]) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const before = { ...config.llm };
  const asked: any[] = [];
  Object.assign(config.llm, { apiKey: "test-key", baseUrl: "https://ai.example/v1", model: "open-model" });
  globalThis.fetch = (async (url: string, init?: any) => {
    asked.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    return await fn(asked);
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.llm, before);
  }
}

beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { loginPerMin: 10_000 });
  editor = await staffClient(app, db, "editor");
  reviewer = await staffClient(app, db, "reviewer");
});

describe("new topic slots (PCOS, endometriosis, FGM support, GBV)", () => {
  it("exist with a brief for the writer, but nothing reaches girls until it is written and approved", async () => {
    const topics = await db.query(`SELECT id, category, brief FROM content_topics WHERE id IN ('pcos','endometriosis','fgm-support','gbv-help') ORDER BY id`);
    expect(topics.map((t) => [t.id, t.category])).toEqual([
      ["endometriosis", "conditions"],
      ["fgm-support", "fgm"],
      ["gbv-help", "safety"],
      ["pcos", "conditions"],
    ]);
    for (const t of topics) expect(t.brief).toMatch(/^DRAFT brief/);
    const versions = await db.query(`SELECT 1 FROM content_versions WHERE topic_id IN ('pcos','endometriosis','fgm-support','gbv-help')`);
    expect(versions).toEqual([]);
    await refreshCaches(db, { force: true });
    expect(servingContent().some((c) => ["pcos", "endometriosis", "fgm-support", "gbv-help"].includes(c.id))).toBe(false);
    const learn = await request(app).get("/app/api/learn?lang=en");
    expect(JSON.stringify(learn.body)).not.toMatch(/DRAFT brief/);
    // The app lists the new sections as "coming soon" (section names only, never the brief).
    expect(learn.body.upcoming).toEqual(expect.arrayContaining(["conditions", "fgm"]));
    expect(learn.body.upcoming).not.toContain("safety"); // already has lessons
  });

  it("shows the brief to writers and marks empty topics as needing writing", async () => {
    expect((await editor.get("/staff/content")).text).toContain("Needs writing");
    const page = await editor.get("/staff/content/fgm-support");
    expect(page.text).toContain("Brief for the writer");
    expect(page.text).toContain("FGM: care and support");
    expect((await editor.get("/staff/content/pcos/en/edit")).text).toContain("never sent to girls");
    const saved = await editor.post("/staff/content/pcos/settings", { category: "conditions", services: "period_care", brief: "Updated brief" });
    expect(saved.status).toBe(302);
    const [t] = await db.query(`SELECT brief FROM content_topics WHERE id = 'pcos'`);
    expect(t.brief).toBe("Updated brief");
  });
});

describe("Draft with AI (translators)", () => {
  it("explains how to switch it on when no AI key is set, and saves nothing", async () => {
    const n = (await db.query(`SELECT count(*)::int AS n FROM content_versions`))[0].n;
    const res = await editor.post("/staff/content/periods-pain/so/ai-draft");
    expect(res.status).toBe(200);
    expect(res.text).toContain("AI drafts aren&#39;t switched on yet");
    expect((await db.query(`SELECT count(*)::int AS n FROM content_versions`))[0].n).toBe(n);
  });

  it("fills the form with a marked first draft for the translator to check; nothing is saved", async () => {
    const n = (await db.query(`SELECT count(*)::int AS n FROM content_versions`))[0].n;
    const res = await withFakeAi({ title: "[TEST so title]", body: "[TEST so body]", keywords: ["[kw]"] }, async (asked) => {
      const r = await editor.post("/staff/content/periods-pain/so/ai-draft");
      expect(asked).toHaveLength(1);
      expect(asked[0].url).toBe("https://ai.example/v1/chat/completions");
      expect(asked[0].body.model).toBe("open-model");
      expect(asked[0].body.messages[0].content).toMatch(/into Soomaali/);
      expect(asked[0].body.messages[0].content).toMatch(/Do not add, remove or change any medical fact/);
      return r;
    });
    expect(res.text).toContain("AI first draft: not saved yet");
    expect(res.text).toContain("[TEST so body]");
    expect(res.text).toContain("AI first draft: a native speaker must check every word (open-model)");
    expect((await db.query(`SELECT count(*)::int AS n FROM content_versions`))[0].n).toBe(n);
    const [audit] = await db.query(`SELECT action FROM audit_log WHERE action = 'content.ai_draft' ORDER BY id DESC LIMIT 1`);
    expect(audit.action).toBe("content.ai_draft");
  });

  it("drafts app wording too, and warns when a {placeholder} was changed", async () => {
    const ok = await withFakeAi({ text: "[TEST so] {date}" }, () => editor.post("/staff/translations/app_pass_valid/so/ai-draft"));
    expect(ok.text).toContain("AI first draft: not saved yet");
    expect(ok.text).toContain("[TEST so] {date}");
    expect(ok.text).not.toContain("changed a placeholder");
    const broken = await withFakeAi({ text: "[TEST so] {taariikh}" }, () => editor.post("/staff/translations/app_pass_valid/so/ai-draft"));
    expect(broken.text).toContain("The AI changed a placeholder");
    const rows = await db.query(`SELECT 1 FROM string_versions WHERE key = 'app_pass_valid' AND language = 'so'`);
    expect(rows).toEqual([]);
  });

  it("is only for writers, and never for English", async () => {
    expect((await reviewer.post("/staff/content/periods-pain/so/ai-draft")).status).not.toBe(200);
    expect((await editor.post("/staff/content/periods-pain/en/ai-draft")).status).toBe(404);
    expect((await editor.post("/staff/translations/not_a_key/so/ai-draft")).status).toBe(404);
  });
});
