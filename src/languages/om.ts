import type { LanguageConfig } from "./types.js";

// Afaan Oromoo. Beta until tested with real Oromo speakers.
// Whisper has no Oromo, so speech-to-text needs another provider (e.g. Meta MMS); mock until one is chosen.
export const om: LanguageConfig = {
  code: "om",
  name: "Afaan Oromoo",
  englishName: "Afaan Oromoo",
  status: "beta",
  stt: { code: "om", provider: "mock" },
  translation: { code: "om", provider: "llm" },
  ttsVoiceId: null,
  dangerWordsFile: "om.txt",
  uiStringsFile: "data/strings/om.csv",
  reviewedBy: "",
};
