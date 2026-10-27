import { describe, it, expect, beforeAll } from "vitest";
import { freshDb, girl } from "./helpers.js";
import { consents } from "../src/auth/access.js";
import { hashPhone } from "../src/privacy.js";
import type { Db } from "../src/db.js";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});

const userOf = async (phone: string) => (await db.query(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(phone)]))[0];

async function newGirl(phone: string, channel: "sms" | "whatsapp" = "sms") {
  const g = girl(db, phone, channel);
  await g.send("hi");
  const afterLanguage = await g.send("3"); // English
  return { g, afterLanguage };
}

describe("asking what her health worker may see, on WhatsApp and SMS", () => {
  it("asks once after she chooses her language; 1 shares her messages", async () => {
    const { g, afterLanguage } = await newGirl("0712800001");
    expect(afterLanguage).toContain("Ask me anything");
    expect(afterLanguage).toContain("Can your health worker (a trained Dada or nurse) read them");
    expect(await g.send("1")).toContain("Your health worker can read your messages");
    const u = await userOf("0712800001");
    expect(await consents(db, u.id)).toEqual({ messages: true, voice: false });
    expect(u.state.step).toBe("free");
  });

  it("2 keeps them private, and asking for a person later doesn't override her no", async () => {
    const { g } = await newGirl("0712800002", "whatsapp");
    expect(await g.send("2")).toContain("Your messages stay private");
    await g.send("DADA");
    expect(await consents(db, (await userOf("0712800002")).id)).toEqual({ messages: false, voice: false });
  });

  it("no answer means private: her question is answered, she isn't asked again, and DADA still shares", async () => {
    const { g } = await newGirl("0712800003");
    expect(await g.send("my period is two weeks late, what should i do")).toMatch(/period/i);
    let u = await userOf("0712800003");
    expect(u.share_asked_at).not.toBeNull();
    expect((await db.query(`SELECT 1 FROM consents WHERE user_id = $1`, [u.id])).length).toBe(0);
    // Choosing her language again doesn't ask again.
    await g.send("MENU");
    expect(await g.send("3")).not.toContain("Can your health worker");
    await g.send("DADA");
    u = await userOf("0712800003");
    expect((await consents(db, u.id)).messages).toBe(true);
  });

  it("asks about her voice once, after her first voice note; VOICE, SHARE and PRIVATE change it any time", async () => {
    const { g } = await newGirl("0712800004");
    await g.send("1");
    expect(await g.voice("where can i get condoms to prevent pregnancy")).toContain("Reply VOICE if yes");
    expect(await g.voice("is it normal to have pain during my period")).not.toContain("Reply VOICE");
    const id = (await userOf("0712800004")).id;
    expect(await g.send("VOICE")).toContain("can listen to your voice notes");
    expect(await consents(db, id)).toEqual({ messages: true, voice: true });
    expect(await g.send("private")).toContain("stay private");
    expect(await consents(db, id)).toEqual({ messages: false, voice: false });
    expect(await g.send("SHARE")).toContain("can read your messages");
    expect(await consents(db, id)).toEqual({ messages: true, voice: false });
    // Commands are never translated, checked as questions, or shown to workers as messages.
    const [m] = await db.query(`SELECT english_text FROM messages WHERE user_id = $1 AND body = 'SHARE'`, [id]);
    expect(m.english_text).toBeNull();
  });

  it("an urgent message still reaches a person whatever she chose", async () => {
    const { g } = await newGirl("0712800005");
    await g.send("2");
    await g.send("i want to kill myself");
    const [c] = await db.query(`SELECT reason, urgent FROM cases WHERE user_id = $1`, [(await userOf("0712800005")).id]);
    expect(c).toEqual({ reason: "danger_selfharm", urgent: true });
  });

  it("lists the commands in HELP", async () => {
    const { g } = await newGirl("0712800006");
    const help = await g.send("HELP");
    expect(help).toContain("SHARE - your health worker can read your messages");
    expect(help).toContain("PRIVATE - only when you ask for a person");
  });
});
