import { describe, it, expect, afterEach, vi } from "vitest";
import { config, loadConfig, ConfigError } from "../src/config.js";
import { fromEnglish, googleTranslation, toEnglish, translationProvider } from "../src/providers/translation.js";
import { elevenLabsVoice, spokenReply, voiceProvider } from "../src/providers/voice.js";
import { openAISpeech, mockSpeech, speechProviderFor } from "../src/providers/speech.js";
import { languageConfig } from "../src/languages/index.js";

const saved = { translate: { ...config.translate }, voice: { ...config.voiceReplies }, stt: config.stt.apiKey, soVoice: languageConfig("so")!.ttsVoiceId };
afterEach(() => {
  Object.assign(config.translate, saved.translate);
  Object.assign(config.voiceReplies, saved.voice);
  config.stt.apiKey = saved.stt;
  languageConfig("so")!.ttsVoiceId = saved.soVoice;
  vi.unstubAllGlobals();
});

function network(...replies: Array<{ status: number; body?: unknown; raw?: Buffer }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = replies.shift() ?? { status: 500 };
      return new Response(r.raw ? new Uint8Array(r.raw) : JSON.stringify(r.body ?? {}), { status: r.status });
    }),
  );
  return calls;
}

describe("every provider runs without keys (mocks)", () => {
  it("uses the mocks in development and tests", async () => {
    expect(translationProvider().name).toBe("mock");
    expect(voiceProvider().name).toBe("mock");
    expect(speechProviderFor("so")).toBe(mockSpeech);
    expect((await toEnglish("Dhiig badan", "so")).text).toBe("[so→en] Dhiig badan");
  });
});

describe("translation (Google Cloud Translation)", () => {
  it("sends the text with her language as the source, and reads the answer", async () => {
    config.translate.apiKey = "test-key";
    const calls = network({ status: 200, body: { data: { translations: [{ translatedText: "I am bleeding a lot" }] } } });
    const t = await toEnglish("Dhiig badan ayaa iga imanaya", "so");
    expect(t).toEqual({ ok: true, text: "I am bleeding a lot", detected: "so", provider: "google" });
    expect(calls[0].url).toBe("https://translation.googleapis.com/language/translate/v2?key=test-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ q: ["Dhiig badan ayaa iga imanaya"], target: "en", format: "text", source: "so" });
  });

  it("lets Google detect the language when a message mixes languages, and never drops words", async () => {
    config.translate.apiKey = "test-key";
    const calls = network({ status: 200, body: { data: { translations: [{ translatedText: "Help, a lot of blood", detectedSourceLanguage: "so" }] } } });
    const t = await toEnglish("Help, dhiig badan", "sw", true);
    expect(t.detected).toBe("so");
    expect(JSON.parse(String(calls[0].init.body)).source).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body)).q).toEqual(["Help, dhiig badan"]);
  });

  it("keeps the original when the provider fails", async () => {
    config.translate.apiKey = "test-key";
    network({ status: 503 });
    expect(await googleTranslation.translate("Nataka msaada", "en", "sw")).toEqual({ ok: false, text: "Nataka msaada", detected: null, provider: "google" });
  });

  it("skips translation for English, and translates replies into her language", async () => {
    config.translate.apiKey = "test-key";
    const calls = network({ status: 200, body: { data: { translations: [{ translatedText: "Gargaar" }] } } });
    expect(await toEnglish("I need help", "en")).toMatchObject({ provider: "none", text: "I need help" });
    expect(await fromEnglish("Please go to the clinic", "en")).toMatchObject({ provider: "none" });
    expect(await fromEnglish("Help", "om")).toMatchObject({ ok: true, text: "Gargaar" });
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ target: "om", source: "en" });
    expect(calls).toHaveLength(1);
  });
});

describe("voice replies (ElevenLabs), off by default", () => {
  it("does nothing while switched off, or for a language with no approved voice", async () => {
    const calls = network();
    expect(config.voiceReplies.enabled).toBe(false);
    expect(await spokenReply("Hello", "so")).toBeNull();
    config.voiceReplies.enabled = true;
    expect(await spokenReply("Hello", "so")).toBeNull(); // no approved Somali voice yet
    expect(calls).toHaveLength(0);
  });

  it("speaks with the approved voice when switched on", async () => {
    config.voiceReplies.enabled = true;
    config.voiceReplies.apiKey = "xi-key";
    languageConfig("so")!.ttsVoiceId = "voice-so-1";
    const calls = network({ status: 200, raw: Buffer.from("ID3audio") });
    const r = await spokenReply("Fadlan tag rugta caafimaadka", "so");
    expect(r).toMatchObject({ mime: "audio/mpeg", provider: "elevenlabs" });
    expect(r!.audio.toString()).toBe("ID3audio");
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-so-1");
    expect((calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe("xi-key");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: "Fadlan tag rugta caafimaadka", model_id: "eleven_multilingual_v2" });
  });

  it("returns nothing on failure, so the text reply still goes", async () => {
    network({ status: 500 });
    expect(await elevenLabsVoice.speak("Hi", "v")).toBeNull();
  });
});

describe("speech-to-text provider per language", () => {
  it("uses OpenAI for Somali, Kiswahili and English, and the mock for Afaan Oromoo", () => {
    config.stt.apiKey = "sk-test";
    expect(speechProviderFor("so")).toBe(openAISpeech);
    expect(speechProviderFor("sw")).toBe(openAISpeech);
    expect(speechProviderFor("en")).toBe(openAISpeech);
    expect(speechProviderFor("om")).toBe(mockSpeech);
  });
});

describe("production settings", () => {
  const PROD = {
    NODE_ENV: "production",
    BASE_URL: "https://ubah.example.org",
    DATABASE_URL: "postgres://u:p@db:5432/ubah",
    HASH_SECRET: "h".repeat(40),
    SESSION_SECRET: "s".repeat(40),
    ENCRYPTION_KEY: "ab".repeat(32),
    NURSE_ALERT_NUMBERS: "+254700000009",
    AT_USERNAME: "ubah",
    AT_API_KEY: "key",
    SMS_WEBHOOK_KEY: "k".repeat(20),
    ALLOW_DRAFT_CONTENT: "false",
    SEED_DEMO: "false",
  };
  const problems = (env: Record<string, string>) => {
    try {
      loadConfig(env);
      return "";
    } catch (err) {
      return (err as ConfigError).problems.join("\n");
    }
  };

  it("needs a translation key, and an ElevenLabs key if voice replies are on", () => {
    expect(problems(PROD)).toMatch(/GOOGLE_TRANSLATE_API_KEY/);
    expect(problems({ ...PROD, GOOGLE_TRANSLATE_API_KEY: "k" })).toBe("");
    expect(problems({ ...PROD, GOOGLE_TRANSLATE_API_KEY: "k", VOICE_REPLIES: "true" })).toMatch(/ELEVENLABS_API_KEY/);
    expect(loadConfig({ ...PROD, GOOGLE_TRANSLATE_API_KEY: "k" }).voiceReplies.enabled).toBe(false);
  });
});
