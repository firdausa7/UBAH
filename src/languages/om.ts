import type { LanguageConfig } from "./types.js";

// Afaan Oromoo. Beta until tested with real Oromo speakers.
// OpenAI speech-to-text has no Oromo, so its voice notes come back unclear (she is asked to type)
// until another provider is added (e.g. Meta MMS). Typed Oromo is translated by Google.
export const om: LanguageConfig = {
  code: "om",
  name: "Afaan Oromoo",
  englishName: "Afaan Oromoo",
  status: "beta",
  stt: { code: "om", provider: "mock" },
  translation: { code: "om", provider: "google" },
  ttsVoiceId: null,
  dangerWordsFile: "om.txt",
  uiStringsFile: "data/strings/om.csv",
  reviewedBy: "",
};
