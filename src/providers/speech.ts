import { config, mockMode } from "../config.js";
import { log } from "../log.js";
import { ALL_LANGUAGES, languageConfig } from "../languages/index.js";

// Speech-to-text for voice notes, behind one interface:
//   openai  any OpenAI-compatible /audio/transcriptions endpoint (OpenAI, or a self-hosted Whisper server)
//   mock    no network: development, tests, and languages with no real provider yet (Afaan Oromoo)
// The provider and language code per language come from src/languages/; keys from STT_* (see .env.example).
//
// Her chosen language is a soft hint (the "prompt"), never forced: girls mix Somali, Kiswahili and
// English in one note, and forcing one language garbles the rest. The model's own guess is kept.

export interface Transcript {
  text: string;
  ok: boolean;
  language: string | null; // detected by the model (our code), if it said
  confidence: number | null; // 0..1, if the model gave enough to estimate it
}

export interface SpeechProvider {
  name: "openai" | "mock";
  transcribe(audio: Buffer, mimeType: string, hint: string | null, mock: MockVoice): Promise<Transcript>;
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

async function request(audio: Buffer, mimeType: string, hint: string | null, verbose: boolean): Promise<Response> {
  const form = new FormData();
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : "m4a";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${ext}`);
  form.append("model", config.stt.model);
  if (verbose) form.append("response_format", "verbose_json");
  if (hint && HINT_PROMPT[hint]) form.append("prompt", HINT_PROMPT[hint]);
  return fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.stt.apiKey}` },
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
  async transcribe(audio, mimeType, hint) {
    try {
      let res = await request(audio, mimeType, hint, true);
      // Some servers (and newer OpenAI models) don't offer verbose_json: ask again for plain text.
      if (res.status === 400) res = await request(audio, mimeType, hint, false);
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

export function speechProviderFor(lang: string | null | undefined): SpeechProvider {
  if (mockMode.stt()) return mockSpeech;
  return languageConfig(lang)?.stt.provider === "openai" ? openAISpeech : mockSpeech;
}

export async function transcribe(audio: Buffer, mimeType: string, lang?: string | null, mock: MockVoice | string = {}): Promise<Transcript> {
  const m: MockVoice = typeof mock === "string" ? { mockText: mock } : mock;
  return speechProviderFor(lang).transcribe(audio, mimeType, lang ?? null, m);
}
