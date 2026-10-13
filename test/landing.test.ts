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

describe("public landing page", () => {
  it("tells the Ubah story, the closed loop and the privacy promise, with Quick exit and no inline script", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("means <strong>flower</strong> in Somali");
    expect(res.text).toContain("Why</em> a flower?");
    expect(res.text).toContain("We check back");
    expect(res.text).toContain("Your</em> privacy comes first");
    expect(res.text).toContain('href="/app/"');
    expect(res.text).toContain('href="/staff/login"');
    expect(res.text).toContain("data-quick-exit");
    expect(res.text).not.toMatch(/<script>(?!<\/script>)/);
    expect((await request(app).get("/landing.js")).text).toContain("location.replace");
  });

  it("never shows a made-up contact: channels without settings say coming soon", async () => {
    const before = (await request(app).get("/")).text;
    expect(before.match(/Coming soon/g)?.length).toBe(3);
    config.public = { smsNumber: "22384", whatsappNumber: "+254 700 000 000", ussdCode: "*384*1#", contactEmail: "hello@example.org" };
    const after = (await request(app).get("/")).text;
    expect(after).not.toContain("Coming soon");
    expect(after).toContain("*384*1#");
    expect(after).toContain("mailto:hello@example.org");
  });
});
