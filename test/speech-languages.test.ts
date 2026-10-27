import { describe, it, expect, afterEach, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { config, loadConfig, ConfigError } from "../src/config.js";
import { mmsSpeech, mockSpeech, openAISpeech, speechProviderFor, speechSettingsFor, transcribe } from "../src/providers/speech.js";

const saved = { key: config.stt.apiKey, base: config.stt.baseUrl, per: structuredClone(config.stt.perLanguage) };
afterEach(() => {
  config.stt.apiKey = saved.key;
  config.stt.baseUrl = saved.base;
  config.stt.perLanguage = structuredClone(saved.per);
  vi.unstubAllGlobals();
});

function network(...replies: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = replies.shift() ?? { status: 500 };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }),
  );
  return calls;
}

describe("speech-to-text settings per language", () => {
  it("reads STT_<LANG>_* settings, and refuses unknown providers or codes", () => {
    const c = loadConfig({ STT_OM_PROVIDER: "mms", STT_OM_BASE_URL: "http://mms:8090", STT_OM_LANGUAGE: "gax", STT_SO_MODEL: "gpt-4o-transcribe" });
    expect(c.stt.perLanguage.om).toEqual({ provider: "mms", baseUrl: "http://mms:8090", apiKey: undefined, model: undefined, language: "gax" });
    expect(c.stt.perLanguage.so.model).toBe("gpt-4o-transcribe");
    expect(() => loadConfig({ STT_SW_PROVIDER: "whisper2" })).toThrow(ConfigError);
    expect(() => loadConfig({ STT_OM_LANGUAGE: "Oromo!" })).toThrow(ConfigError);
  });

  it("refuses production with an MMS language but no MMS server", () => {
    const prod = {
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
      GOOGLE_TRANSLATE_API_KEY: "k",
    };
    expect(() => loadConfig({ ...prod, STT_OM_PROVIDER: "mms" })).toThrow(/STT_OM_BASE_URL/);
    expect(() => loadConfig({ ...prod, STT_OM_PROVIDER: "mms", STT_OM_BASE_URL: "http://mms:8090" })).not.toThrow();
  });

  it("uses each language's own provider, and the mock until it is set up", () => {
    expect(speechSettingsFor("so")).toMatchObject({ provider: "openai", language: "so" });
    expect(speechSettingsFor("om")).toMatchObject({ provider: "mock" });
    config.stt.apiKey = "sk-test";
    expect(speechProviderFor("so")).toBe(openAISpeech);
    expect(speechProviderFor("om")).toBe(mockSpeech);
    config.stt.perLanguage.om = { provider: "mms" };
    expect(speechProviderFor("om")).toBe(mockSpeech); // no server yet
    config.stt.perLanguage.om = { provider: "mms", baseUrl: "http://mms:8090" };
    expect(speechProviderFor("om")).toBe(mmsSpeech);
    expect(speechSettingsFor("om")).toMatchObject({ model: "mms-1b-all", language: "gaz", apiKey: "" }); // never the OpenAI key
    // Somali can switch to MMS too, without touching Kiswahili.
    config.stt.perLanguage.so = { provider: "mms", baseUrl: "http://mms:8090" };
    expect(speechSettingsFor("so").language).toBe("som");
    expect(speechProviderFor("sw")).toBe(openAISpeech);
  });

  it("sends an Oromo voice note to the MMS server with its language code and key", async () => {
    config.stt.perLanguage.om = { provider: "mms", baseUrl: "http://mms:8090/", apiKey: "mms-key", language: "gax" };
    const calls = network({ status: 200, body: { text: "Garaan na dhukkuba", confidence: 0.82, language: "gax" } });
    const tr = await transcribe(Buffer.from("OggS"), "audio/ogg", "om");
    expect(tr).toEqual({ text: "Garaan na dhukkuba", ok: true, language: null, confidence: 0.82 });
    expect(calls[0].url).toBe("http://mms:8090/audio/transcriptions");
    const form = calls[0].init.body as FormData;
    expect([form.get("language"), form.get("model")]).toEqual(["gax", "mms-1b-all"]);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer mms-key");
  });

  it("treats an MMS failure as not understood (she is asked to try again or type)", async () => {
    config.stt.perLanguage.om = { provider: "mms", baseUrl: "http://mms:8090" };
    network({ status: 400, body: { detail: { error: "unsupported_language" } } });
    expect(await transcribe(Buffer.from("OggS"), "audio/ogg", "om")).toEqual({ text: "", ok: false, language: null, confidence: null });
  });

  it("uses a per-language OpenAI model and server when set", async () => {
    config.stt.apiKey = "sk-shared";
    config.stt.perLanguage.sw = { model: "gpt-4o-transcribe", baseUrl: "https://stt.example.org/v1", apiKey: "sk-sw" };
    const calls = network({ status: 200, body: { text: "Habari", language: "swahili" } });
    await transcribe(Buffer.from("OggS"), "audio/ogg", "sw");
    expect(calls[0].url).toBe("https://stt.example.org/v1/audio/transcriptions");
    expect((calls[0].init.body as FormData).get("model")).toBe("gpt-4o-transcribe");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-sw");
  });
});

describe("Google Speech-to-Text (Chirp) with a service account", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { client_email: "ubah-stt@test-project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), project_id: "test-project" };
  const savedGoogle = { ...config.stt.google };
  afterEach(async () => {
    Object.assign(config.stt.google, savedGoogle);
    (await import("../src/providers/googleAuth.js")).forgetGoogleToken();
  });

  function google() {
    config.stt.google.credentialsJson = JSON.stringify(sa);
    config.stt.google.location = "eu";
    config.stt.perLanguage.sw = { provider: "google" };
  }

  it("signs in with the service account, then sends a Kiswahili note to Chirp in sw-KE", async () => {
    google();
    expect(speechProviderFor("sw").name).toBe("google");
    expect(speechSettingsFor("sw")).toMatchObject({ language: "sw-KE", model: "chirp_3", baseUrl: "https://eu-speech.googleapis.com" });
    const calls = network(
      { status: 200, body: { access_token: "ya29.test", expires_in: 3600 } },
      { status: 200, body: { results: [{ alternatives: [{ transcript: "Hedhi yangu", confidence: 0 }], languageCode: "sw-ke" }, { alternatives: [{ transcript: "imechelewa" }] }] } },
      { status: 200, body: { results: [{ alternatives: [{ transcript: "Habari", confidence: 0.9 }] }] } },
    );
    const tr = await transcribe(Buffer.from("OggS voice"), "audio/ogg", "sw");
    expect(tr).toEqual({ text: "Hedhi yangu imechelewa", ok: true, language: "sw", confidence: null }); // Chirp's 0 means "not given"

    // The login: a JWT signed with the service account's key, for the cloud-platform scope.
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const assertion = new URLSearchParams(String(calls[0].init.body)).get("assertion")!;
    const [h, c, sig] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform" });

    // The request: inline audio, the model and language given.
    expect(calls[1].url).toBe("https://eu-speech.googleapis.com/v2/projects/test-project/locations/eu/recognizers/_:recognize");
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer ya29.test");
    const body = JSON.parse(String(calls[1].init.body));
    expect(body.config).toMatchObject({ model: "chirp_3", languageCodes: ["sw-KE"] });
    expect(Buffer.from(body.content, "base64").toString()).toBe("OggS voice");

    // The token is reused until it nearly expires.
    expect((await transcribe(Buffer.from("x"), "audio/ogg", "sw")).confidence).toBe(0.9);
    expect(calls).toHaveLength(3);
  });

  it("is not used until the service account and region are set, and fails safely", async () => {
    config.stt.perLanguage.sw = { provider: "google" };
    expect(speechProviderFor("sw").name).toBe("mock");
    google();
    network({ status: 403 });
    expect(await transcribe(Buffer.from("x"), "audio/ogg", "sw")).toEqual({ text: "", ok: false, language: null, confidence: null });
  });

  it("refuses production with a Google language but no service account", () => {
    expect(() => loadConfig({ NODE_ENV: "production", STT_SW_PROVIDER: "google" })).toThrow(/STT_GOOGLE_LOCATION and STT_GOOGLE_CREDENTIALS/);
  });
});
