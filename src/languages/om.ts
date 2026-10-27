import type { LanguageConfig } from "./types.js";

// Afaan Oromoo. Beta until tested with real Oromo speakers.
// OpenAI speech-to-text has no Oromo, so its voice notes come back unclear (she is asked to type)
// until another provider is added (e.g. Meta MMS). Typed Oromo is translated by Google.
export const om: LanguageConfig = {
  code: "om",
  name: "Afaan Oromoo",
  englishName: "Afaan Oromoo",
  status: "beta",
  // MMS has several Oromo varieties: gaz (West Central), hae (Eastern), gax (Borana-Arsi-Guji, spoken
  // in northern Kenya). Check which ones the MMS model card lists, and which your speakers use; set
  // STT_OM_LANGUAGE to change it without touching the code.
  stt: { code: "om", provider: "mock", mmsCode: "gaz" },
  translation: { code: "om", provider: "google" },
  ttsVoiceId: null,
  dangerWordsFile: "om.txt",
  uiStringsFile: "data/strings/om.csv",
  reviewedBy: "",
};
