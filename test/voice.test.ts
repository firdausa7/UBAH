import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { freshDb, girl } from "./helpers.js";
import { confidenceOf, detectedCode, transcribe } from "../src/providers/speech.js";
import { config } from "../src/config.js";
import type { Db } from "../src/db.js";

describe("reading the speech model's answer", () => {
  it("turns language names and codes into our codes", () => {
    expect(detectedCode("somali")).toBe("so");
    expect(detectedCode("Swahili")).toBe("sw");
    expect(detectedCode("english")).toBe("en");
    expect(detectedCode("oromo")).toBe("om");
    expect(detectedCode("so")).toBe("so");
    expect(detectedCode("arabic")).toBe("arabic");
    expect(detectedCode("")).toBeNull();
    expect(detectedCode(undefined)).toBeNull();
  });

  it("estimates confidence from the segments, lowered by likely silence", () => {
    expect(confidenceOf({ segments: [{ text: "hello there", avg_logprob: Math.log(0.9), no_speech_prob: 0 }] })).toBe(0.9);
    expect(confidenceOf({ segments: [{ text: "hm", avg_logprob: Math.log(0.9), no_speech_prob: 0.5 }] })).toBe(0.45);
    expect(confidenceOf({ text: "no segments" })).toBeNull();
  });
});

describe("transcribing with a real provider (mocked network)", () => {
  const key = config.stt.apiKey;
  afterEach(() => {
    config.stt.apiKey = key;
    vi.unstubAllGlobals();
  });

  function provider(...replies: Array<{ status: number; body?: unknown }>) {
    const calls: FormData[] = [];
    config.stt.apiKey = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init.body as FormData);
        const r = replies.shift()!;
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
      }),
    );
    return calls;
  }

  it("uses her language as a soft hint, never forcing it, and keeps the model's guess", async () => {
    const calls = provider({ status: 200, body: { text: "Dhiig badan, please help", language: "somali", segments: [{ text: "x", avg_logprob: Math.log(0.8) }] } });
    const tr = await transcribe(Buffer.from("a"), "audio/ogg", "so");
    expect(tr).toEqual({ text: "Dhiig badan, please help", ok: true, language: "so", confidence: 0.8 });
    expect(calls[0].get("language")).toBeNull();
    expect(calls[0].get("prompt")).toMatch(/Soomaali/);
    expect(calls[0].get("response_format")).toBe("verbose_json");
  });

  it("asks again for plain text when the server has no verbose_json", async () => {
    const calls = provider({ status: 400 }, { status: 200, body: { text: "hello" } });
    const tr = await transcribe(Buffer.from("a"), "audio/ogg", "en");
    expect(tr).toEqual({ text: "hello", ok: true, language: null, confidence: null });
    expect(calls[1].get("response_format")).toBeNull();
  });

  it("reports a failure as not understood", async () => {
    provider({ status: 500 });
    expect(await transcribe(Buffer.from("a"), "audio/ogg", "sw")).toMatchObject({ ok: false, text: "" });
  });

  it("never sends Afaan Oromoo to a provider that doesn't support it", async () => {
    const calls = provider({ status: 200, body: { text: "wrong" } });
    expect(await transcribe(Buffer.from("a"), "audio/ogg", "om")).toMatchObject({ ok: false });
    expect(calls).toHaveLength(0);
  });
});

describe("voice notes in the conversation", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  async function somaliGirl(phone: string, shares = true) {
    const g = girl(db, phone);
    await g.send("hi");
    await g.send("1"); // Soomaali
    await g.send(shares ? "1" : "2"); // what her health worker may see
    const [u] = await db.query(`SELECT id FROM users ORDER BY id DESC LIMIT 1`);
    const last = async () => (await db.query(`SELECT * FROM messages WHERE user_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [u.id]))[0];
    const cases = async () => db.query(`SELECT * FROM cases WHERE user_id = $1 ORDER BY id`, [u.id]);
    return { g, last, cases };
  }

  it("keeps both languages when what she spoke differs from what she chose", async () => {
    const { g, last } = await somaliGirl("0712000301");
    await g.voice("hedhi yangu imechelewa", { mockLanguage: "sw", mockConfidence: 0.9 });
    expect(await last()).toMatchObject({ kind: "voice", detected_language: "sw", language_mismatch: true, voice_unclear: false });
    expect((await last()).stt_confidence).toBeCloseTo(0.9);
  });

  it("does not flag a mismatch when they agree", async () => {
    const { g, last } = await somaliGirl("0712000302");
    await g.voice("caadadaydu way soo daahday", { mockLanguage: "so", mockConfidence: 0.9 });
    expect(await last()).toMatchObject({ detected_language: "so", language_mismatch: false });
  });

  it("asks her to try again when the audio is unclear, and tells a worker once", async () => {
    const { g, last, cases } = await somaliGirl("0712000303");
    expect(await g.voice("stop", { mockConfidence: 0.1 })).toMatch(/couldn't hear that voice note/);
    expect(await last()).toMatchObject({ voice_unclear: true });
    // A command heard poorly is never acted on.
    const [u] = await db.query(`SELECT opted_out FROM users ORDER BY id DESC LIMIT 1`);
    expect(u.opted_out).toBe(false);
    await g.voice("something", { mockConfidence: 0.2 });
    const cs = await cases();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ reason: "voice_unclear", urgent: false, level: "dada" });
  });

  it("tells no one when she doesn't share her messages (she is still asked to try again)", async () => {
    const { g, cases } = await somaliGirl("0712000307", false);
    expect(await g.voice("something", { mockConfidence: 0.1 })).toMatch(/couldn't hear that voice note/);
    expect(await cases()).toEqual([]);
  });

  it("tells a worker when the note is empty", async () => {
    const { g, cases, last } = await somaliGirl("0712000304");
    expect(await g.voice("")).toMatch(/couldn't hear that voice note/);
    expect(await last()).toMatchObject({ body: "[voice note: not understood]", voice_unclear: true });
    expect((await cases()).map((c: any) => c.reason)).toEqual(["voice_unclear"]);
  });

  it("still treats a danger sign as urgent, however unclear the audio", async () => {
    const { g, cases } = await somaliGirl("0712000305");
    await g.voice("dhiig badan ayaa iga imanaya", { mockConfidence: 0.2 });
    const cs = await cases();
    expect(cs.map((c: any) => [c.reason, c.urgent])).toEqual([["danger_medical", true]]);
  });

  it("answers a clear voice note as before", async () => {
    const g = girl(db, "0712000306");
    await g.send("hi");
    await g.send("3");
    expect(await g.voice("where can i get condoms to prevent pregnancy", { mockConfidence: 0.95 })).toMatch(/condoms|prevent pregnancy/i);
  });
});
