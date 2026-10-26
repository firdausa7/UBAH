import type { LanguageConfig } from "./types.js";

// Kiswahili.
export const sw: LanguageConfig = {
  code: "sw",
  name: "Kiswahili",
  englishName: "Kiswahili",
  status: "enabled",
  stt: { code: "sw", provider: "whisper" },
  translation: { code: "sw", provider: "llm" },
  ttsVoiceId: null,
  dangerWordsFile: "sw.txt",
  uiStringsFile: "data/strings/sw.csv",
  reviewedBy: "",
};
