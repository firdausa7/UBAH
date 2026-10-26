import type { LanguageConfig } from "./types.js";

// English: the source language. No translation step.
export const en: LanguageConfig = {
  code: "en",
  name: "English",
  englishName: "English",
  status: "enabled",
  stt: { code: "en", provider: "whisper" },
  translation: null,
  ttsVoiceId: null,
  dangerWordsFile: "en.txt",
  uiStringsFile: "src/i18n.ts",
  reviewedBy: "",
};
