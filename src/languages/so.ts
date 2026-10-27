import type { LanguageConfig } from "./types.js";

// Somali. First language to be enabled and tested.
export const so: LanguageConfig = {
  code: "so",
  name: "Soomaali",
  englishName: "Somali",
  status: "enabled",
  stt: { code: "so", provider: "openai", mmsCode: "som", googleCode: "so-SO" },
  translation: { code: "so", provider: "google" },
  ttsVoiceId: null,
  dangerWordsFile: "so.txt",
  uiStringsFile: "data/strings/so.csv",
  reviewedBy: "",
};
