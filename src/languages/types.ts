// One config per language. Everything that differs between languages lives here, not in the code paths.

export type LanguageStatus = "enabled" | "beta" | "disabled";

export interface LanguageConfig {
  code: string;
  name: string; // in its own language, as girls see it
  englishName: string; // for workers
  status: LanguageStatus; // disabled: never shown; beta: shown to girls, labelled "Beta" for workers only
  // provider: the default; STT_<LANG>_PROVIDER overrides it. mmsCode: the ISO 639-3 code a Meta MMS server uses.
  stt: { code: string; provider: "openai" | "mms" | "mock"; mmsCode: string };
  translation: { code: string; provider: "google" | "mock" } | null; // null: no translation step (English)
  ttsVoiceId: string | null; // an approved ElevenLabs voice, or null
  dangerWordsFile: string; // relative to data/danger/
  uiStringsFile: string; // English: the source file; other languages: the CSV the strings export/import scripts use
  reviewedBy: string; // who signed off the language as a whole; empty = not reviewed
}
