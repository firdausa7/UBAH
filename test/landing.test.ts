import { describe, it, expect, beforeAll, afterEach } from "vitest";
import request from "supertest";
import { freshDb } from "./helpers.js";
import { createApp } from "../src/server.js";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";

let db: Db;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await freshDb();
  app = createApp(db);
});
afterEach(() => {
  config.public = { smsNumber: "", whatsappNumber: "", ussdCode: "", contactEmail: "" };
});

const binary = (res: any, cb: any) => {
  const c: Buffer[] = [];
  res.on("data", (x: Buffer) => c.push(x));
  res.on("end", () => cb(null, Buffer.concat(c)));
};

describe("public landing page", () => {
  it("welcomes girls: what Ubah is, how it works, questions, with Quick exit and no inline script", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("means flower in Somali");
    expect(res.text).toContain("Welcome to Ubah");
    expect(res.text).toContain("Your questions. Your health. Your future.");
    expect(res.text).toContain("Ubah works in five simple steps");
    expect(res.text).toContain("Frequently asked questions");
    expect(res.text).toContain('href="/me"');
    expect(res.text).not.toContain('href="/app/');
    expect(res.text).toContain('href="/login"');
    expect(res.text).toContain("data-quick-exit");
    expect(res.text).not.toMatch(/<script>(?!<\/script>)/);
    expect((await request(app).get("/landing.js")).text).toContain("location.replace");
  });

  it("every in-page link points at a section that exists", async () => {
    const html = (await request(app).get("/")).text;
    const targets = [...html.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(5);
    for (const id of new Set(targets)) expect(html, `#${id}`).toContain(`id="${id}"`);
  });

  it("serves its two images, and nothing else from /assets", async () => {
    const rose = await request(app).get("/assets/rose.png").buffer(true).parse(binary);
    expect(rose.headers["content-type"]).toBe("image/png");
    expect((rose.body as Buffer).subarray(1, 4).toString()).toBe("PNG");
    const girl = await request(app).get("/assets/girl.jpg").buffer(true).parse(binary);
    expect(girl.headers["content-type"]).toBe("image/jpeg");
    expect((await request(app).get("/assets/../config.ts")).status).toBe(404);
    expect((await request(app).get("/assets/constructor")).status).toBe(404);
    expect((await request(app).get("/")).text).toContain("Illustration, not a real girl");
  });

  it("is translatable: published translations show, untranslated sentences stay in English", async () => {
    await db.query(`INSERT INTO string_versions (key, language, version, text, status) VALUES ('land_h1','so',1,'[DRAFT so headline]','published')`);
    const { refreshCaches } = await import("../src/caches.js");
    await refreshCaches(db, { force: true });
    const so = (await request(app).get("/?lang=so")).text;
    expect(so).toContain('<html lang="so">');
    expect(so).toContain("[DRAFT so headline]");
    expect(so).toContain("Frequently asked questions"); // not translated yet
    expect(so).toContain('aria-current="true">Soomaali');
    expect((await request(app).get("/?lang=xx")).text).toContain('<html lang="en">');
  });

  it("never shows a made-up contact: channels without settings say coming soon", async () => {
    const before = (await request(app).get("/")).text;
    expect(before.match(/coming soon/g)?.length).toBe(3);
    expect(before).not.toContain("wa.me");
    expect(before).not.toContain("mailto:");
    config.public = { smsNumber: "22384", whatsappNumber: "+254 700 000 000", ussdCode: "*384*1#", contactEmail: "hello@example.org" };
    const after = (await request(app).get("/")).text;
    expect(after).not.toContain("coming soon");
    expect(after).toContain("*384*1#");
    expect(after).toContain("https://wa.me/254700000000?text=Hi%20Ubah");
    expect(after).toContain("mailto:hello@example.org");
  });
});
