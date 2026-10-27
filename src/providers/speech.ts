import { config } from "../config.js";
import { log } from "../log.js";
import { ALL_LANGUAGES, languageConfig } from "../languages/index.js";

// Speech-to-text for voice notes, behind one interface:
//   openai  any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, or a self-hosted Whisper server)
//   mms     a self-hosted Meta MMS server (tools/mms-server/), for languages Whisper lacks (Afaan Oromoo)
//   mock    no network: development, tests, and languages with no real provider yet
// Each language picks its own provider: src/languages/<lang>.ts, overridden by STT_<LANG>_* settings
// (see .env.example), so each can use whichever measures best on real voice notes (npm run eval:languages).
//
// openai: her chosen language is a soft hint (the "prompt"), never forced: girls mix Somali, Kiswahili
// and English in one note, and forcing one language garbles the rest. The model's own guess is kept.
// mms: the language must be given (MMS can't detect it), so mixed-language notes are harder for it.

export interface Transcript {
  text: string;
  ok: boolean;
  language: string | null; // detected by the model (our code), if it said
  confidence: number | null; // 0..1, if the model gave enough to estimate it
}

export interface SpeechSettings {
  provider: "openai" | "mms" | "mock";
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string; // the code sent to the provider
}

export interface SpeechProvider {
  name: "openai" | "mms" | "mock";
  transcribe(audio: Buffer, mimeType: string, hint: string | null, mock: MockVoice, settings: SpeechSettings): Promise<Transcript>;
}

export interface MockVoice {
  mockText?: string;
  mockLanguage?: string;
  mockConfidence?: number;
}

// A short sentence in her language nudges the model towards it without forcing it.
const HINT_PROMPT: Record<string, string> = {
  so: "Su'aal caafimaad oo Soomaali ah.",
  sw: "Swali la afya kwa Kiswahili.",
  om: "Gaaffii fayyaa Afaan Oromootiin.",
  en: "A health question in English.",
};

// Whisper's verbose_json gives the language as an English name ("somali"); other servers give codes.
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  ALL_LANGUAGES.flatMap((l) => [
    [l.englishName.toLowerCase(), l.code],
    [l.stt.code.toLowerCase(), l.code],
    [l.code, l.code],
  ]),
);
NAME_TO_CODE["swahili"] = "sw";
NAME_TO_CODE["oromo"] = "om";

export function detectedCode(language: unknown): string | null {
  if (typeof language !== "string" || !language.trim()) return null;
  const k = language.trim().toLowerCase();
  return NAME_TO_CODE[k] ?? k;
}

// Mean token probability across segments, lowered when the model thinks there was no speech.
export function confidenceOf(json: any): number | null {
  const segs: any[] = Array.isArray(json?.segments) ? json.segments.filter((s: any) => typeof s?.avg_logprob === "number") : [];
  if (segs.length === 0) return null;
  const weight = (s: any) => Math.max(1, String(s.text ?? "").trim().length);
  const total = segs.reduce((a, s) => a + weight(s), 0);
  const p = segs.reduce((a, s) => a + weight(s) * Math.exp(s.avg_logprob) * (1 - (typeof s.no_speech_prob === "number" ? s.no_speech_prob : 0)), 0) / total;
  return Math.round(Math.min(1, Math.max(0, p)) * 1000) / 1000;
}

async function request(s: SpeechSettings, audio: Buffer, mimeType: string, fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : mimeType.includes("webm") ? "webm" : "m4a";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${ext}`);
  form.append("model", s.model);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${s.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(30000),
  });
}

// Development and tests: the simulator sends the "spoken" words alongside the fake audio.
// Real audio with no words attached comes back empty, so the girl is asked to type.
export const mockSpeech: SpeechProvider = {
  name: "mock",
  async transcribe(_audio, _mimeType, hint, m) {
    const text = (m.mockText ?? "").trim();
    return { text, ok: text.length > 0, language: text ? (m.mockLanguage ?? hint ?? null) : null, confidence: text ? (m.mockConfidence ?? 1) : null };
  },
};

export const openAISpeech: SpeechProvider = {
  name: "openai",
  async transcribe(audio, mimeType, hint, _mock, s) {
    const prompt: Record<string, string> = hint && HINT_PROMPT[hint] ? { prompt: HINT_PROMPT[hint] } : {};
    try {
      let res = await request(s, audio, mimeType, { response_format: "verbose_json", ...prompt });
      // Some servers (and newer OpenAI models) don't offer verbose_json: ask again for plain text.
      if (res.status === 400) res = await request(s, audio, mimeType, prompt);
      if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
      const json: any = await res.json();
      const text = String(json.text ?? "").trim();
      return { text, ok: text.length > 0, language: detectedCode(json.language), confidence: confidenceOf(json) };
    } catch (err) {
      log.warn({ err: (err as Error).message }, "speech-to-text failed");
      return { text: "", ok: false, language: null, confidence: null };
    }
  },
};

// A Meta MMS server (see tools/mms-server/): the same endpoint shape, with the language given.
// It answers {text, confidence?}; MMS doesn't detect the language.
export const mmsSpeech: SpeechProvider = {
  name: "mms",
  async transcribe(audio, mimeType, _hint, _mock, s) {
    try {
      const res = await request(s, audio, mimeType, { language: s.language });
      if (!res.ok) throw new Error(`MMS HTTP ${res.status}`);
      const json: any = await res.json();
      const text = String(json.text ?? "").trim();
      const c = Number(json.confidence);
      return { text, ok: text.length > 0, language: null, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : null };
    } catch (err) {
      log.warn({ err: (err as Error).message }, "speech-to-text (MMS) failed");
      return { text: "", ok: false, language: null, confidence: null };
    }
  },
};

// The settings one language uses: STT_<LANG>_* first, then its config, then the shared STT_* settings.
export function speechSettingsFor(lang: string | null | undefined): SpeechSettings {
  const l = languageConfig(lang);
  const o = (l && config.stt.perLanguage[l.code]) || {};
  const provider = o.provider ?? l?.stt.provider ?? "openai";
  return {
    provider,
    baseUrl: o.baseUrl ?? (provider === "mms" ? "" : config.stt.baseUrl),
    apiKey: o.apiKey ?? (provider === "mms" ? "" : config.stt.apiKey),
    model: o.model ?? (provider === "mms" ? "mms-1b-all" : config.stt.model),
    language: o.language ?? (provider === "mms" ? (l?.stt.mmsCode ?? "") : (l?.stt.code ?? lang ?? "")),
  };
}

// A provider only runs when it is set up: OpenAI needs a key, MMS its server. Otherwise the mock
// (in production that means "audio unclear, please type").
export function speechProviderFor(lang: string | null | undefined): SpeechProvider {
  const s = speechSettingsFor(lang);
  if (s.provider === "openai" && s.apiKey) return openAISpeech;
  if (s.provider === "mms" && s.baseUrl) return mmsSpeech;
  return mockSpeech;
}

export async function transcribe(audio: Buffer, mimeType: string, lang?: string | null, mock: MockVoice | string = {}): Promise<Transcript> {
  const m: MockVoice = typeof mock === "string" ? { mockText: mock } : mock;
  return speechProviderFor(lang).transcribe(audio, mimeType, lang ?? null, m, speechSettingsFor(lang));
}
