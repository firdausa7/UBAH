import type { LanguageConfig } from "./types.js";

// Somali. First language to be enabled and tested.
export const so: LanguageConfig = {
  code: "so",
  name: "Soomaali",
  englishName: "Somali",
  status: "enabled",
  stt: { code: "so", provider: "openai" },
  translation: { code: "so", provider: "google" },
  ttsVoiceId: null,
  dangerWordsFile: "so.txt",
  uiStringsFile: "data/strings/so.csv",
  reviewedBy: "",
};
