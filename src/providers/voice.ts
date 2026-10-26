import { config } from "../config.js";
import { log } from "../log.js";
import { languageConfig } from "../languages/index.js";

// Spoken replies (text-to-speech), behind one interface:
//   elevenlabs  ElevenLabs (ELEVENLABS_API_KEY)
//   mock        no network: development and tests
// OFF unless VOICE_REPLIES=true, and even then only for a language with an approved voice
// (ttsVoiceId in src/languages/). The text reply is always sent too.

export interface SpokenReply {
  audio: Buffer;
  mime: string;
  provider: "elevenlabs" | "mock";
}

export interface VoiceProvider {
  name: "elevenlabs" | "mock";
  speak(text: string, voiceId: string): Promise<SpokenReply | null>;
}

export const mockVoice: VoiceProvider = {
  name: "mock",
  async speak(text) {
    return { audio: Buffer.from(`mock-audio:${text.length}`), mime: "audio/mpeg", provider: "mock" };
  },
};

export const elevenLabsVoice: VoiceProvider = {
  name: "elevenlabs",
  async speak(text, voiceId) {
    try {
      const res = await fetch(`${config.voiceReplies.baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "audio/mpeg", "xi-api-key": config.voiceReplies.apiKey },
        body: JSON.stringify({ text, model_id: config.voiceReplies.model }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
      return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg", provider: "elevenlabs" };
    } catch (err) {
      log.warn({ err: (err as Error).message }, "voice reply failed; the text reply is still sent");
      return null;
    }
  },
};

export const voiceProvider = (): VoiceProvider => (config.voiceReplies.apiKey ? elevenLabsVoice : mockVoice);

// A spoken version of a reply in her language, or null (switched off, no approved voice, or failed).
export async function spokenReply(text: string, lang: string | null): Promise<SpokenReply | null> {
  if (!config.voiceReplies.enabled || !text.trim()) return null;
  const voiceId = languageConfig(lang)?.ttsVoiceId;
  if (!voiceId) return null;
  return voiceProvider().speak(text, voiceId);
}
