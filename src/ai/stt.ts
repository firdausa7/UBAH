import { config, mockMode } from "../config.js";
import { log } from "../log.js";

// Speech-to-text for voice notes. Any OpenAI-compatible /audio/transcriptions endpoint:
// OpenAI Whisper, or a self-hosted Whisper / Meta MMS model fine-tuned on Somali voice notes.

const LANG_HINT: Record<string, string> = { so: "so", sw: "sw", en: "en", om: "om" };

export interface Transcript {
  text: string;
  ok: boolean;
}

export async function transcribe(audio: Buffer, mimeType: string, lang?: string | null, mockText?: string): Promise<Transcript> {
  if (mockMode.stt()) {
    // Local testing: the simulator sends the "spoken" words alongside the fake audio.
    return mockText ? { text: mockText, ok: true } : { text: "", ok: false };
  }
  try {
    const form = new FormData();
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : "m4a";
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${ext}`);
    form.append("model", config.stt.model);
    if (lang && LANG_HINT[lang]) form.append("language", LANG_HINT[lang]);
    const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.stt.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
    const json: any = await res.json();
    const text = String(json.text ?? "").trim();
    return { text, ok: text.length > 0 };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "speech-to-text failed");
    return { text: "", ok: false };
  }
}
