import { describe, it, expect, beforeAll } from "vitest";
import { freshDb, girl } from "./helpers.js";
import { sendDueCheckins } from "../src/engine.js";
import { trainAll } from "../src/ml/train.js";
import { reloadModels } from "../src/ml/models.js";
import type { Db } from "../src/db.js";

beforeAll(() => {
  trainAll(() => {});
  reloadModels();
});

describe("the closed loop: question -> answer -> pass -> check-in -> dignity score", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });

  it("welcomes a new girl and asks for her language", async () => {
    const g = girl(db, "0712000101");
    expect(await g.send("hi")).toContain("Choose a language");
    expect(await g.send("3")).toContain("Ask me anything");
  });

  it("runs the whole loop and records a dignity score", async () => {
    const g = girl(db, "0712000102");
    await g.send("hello");
    await g.send("3");

    const answer = await g.send("my period is two weeks late, what should i do");
    expect(answer).toMatch(/pregnancy test/i);
    expect(answer).toContain("1 Find a clinic");

    const pass = await g.send("1");
    const code = pass.match(/UB-[A-Z0-9]{4}/)?.[0];
    expect(code).toBeTruthy();
    expect(pass).toContain("any Ubah partner clinic");

    // Three days later the check-in goes out.
    const sent = await sendDueCheckins(db, new Date(Date.now() + 73 * 3600e3));
    expect(sent).toBeGreaterThan(0);
    expect(await g.replies()).toEqual([expect.stringContaining("Did you visit a clinic")]);

    expect(await g.send("1")).toContain("Which clinic");
    expect(await g.send("1")).toContain("treated with respect");
    expect(await g.send("2")).toContain("Thank you");

    const [row] = await db.query(`SELECT visited, respect, clinic_id FROM checkins WHERE pass_code = $1`, [code]);
    expect(row).toMatchObject({ visited: true, respect: "partly", clinic_id: 1 });
  });

  it("understands coded words", async () => {
    const g = girl(db, "0712000103");
    await g.send("hey");
    await g.send("3");
    const reply = await g.send("my monthly visitor gives me bad cramps");
    expect(reply).toMatch(/period pain|painkiller|warm cloth/i);
    const [m] = await db.query(`SELECT coded_terms FROM messages WHERE body LIKE 'my monthly visitor%'`);
    expect(m.coded_terms).toContain("monthly visitor");
  });

  it("accepts voice notes", async () => {
    const g = girl(db, "0712000104");
    await g.send("hi");
    await g.send("3");
    const reply = await g.voice("where can i get condoms to prevent pregnancy");
    expect(reply).toMatch(/condoms|prevent pregnancy/i);
    const [m] = await db.query(`SELECT kind FROM messages WHERE body LIKE 'where can i get condoms%'`);
    expect(m.kind).toBe("voice");
  });

  it("sends danger signs to a human with an urgent pass", async () => {
    const g = girl(db, "0712000105");
    await g.send("hi");
    await g.send("3");
    const reply = await g.send("I am pregnant and bleeding a lot");
    expect(reply).toMatch(/needs care today/i);
    expect(reply).toMatch(/UB-[A-Z0-9]{4}/);
    const [c] = await db.query(`SELECT reason, urgent FROM cases ORDER BY id DESC LIMIT 1`);
    expect(c).toMatchObject({ reason: "danger_medical", urgent: true });
  });

  it("treats safety and self-harm as urgent and never answers them with the bot", async () => {
    const g = girl(db, "0712000106");
    await g.send("hi");
    await g.send("3");
    expect(await g.send("my uncle beats me at night")).toMatch(/not your fault/i);
    expect(await g.send("i don't want to live anymore")).toMatch(/not alone/i);
    const cases = await db.query(`SELECT reason FROM cases WHERE urgent ORDER BY id DESC LIMIT 2`);
    expect(cases.map((c) => c.reason).sort()).toEqual(["danger_safety", "danger_selfharm"]);
  });

  it("says it doesn't know rather than guessing", async () => {
    const g = girl(db, "0712000107");
    await g.send("hi");
    await g.send("3");
    expect(await g.send("what is the capital of france")).toMatch(/not sure/i);
  });

  it("marks answers not yet translated", async () => {
    const g = girl(db, "0712000108");
    await g.send("hi");
    await g.send("1"); // Somali
    expect(await g.send("my period pain is very bad")).toContain("not yet available in your language");
  });

  it("STOP and DELETE give her control", async () => {
    const g = girl(db, "0712000109");
    await g.send("hi");
    await g.send("3");
    await g.send("how do i use a pad");
    await g.send("DELETE");
    const users = await db.query(`SELECT 1 FROM users u JOIN messages m ON m.user_id = u.id WHERE m.body = 'how do i use a pad'`);
    expect(users).toHaveLength(0);
  });

  it("never stores a phone number in clear", async () => {
    const rows = await db.query(`SELECT phone_hash, phone_enc FROM users`);
    for (const r of rows) {
      expect(r.phone_hash).not.toMatch(/0712|254712/);
      expect(r.phone_enc).not.toMatch(/0712|254712/);
    }
  });
});
