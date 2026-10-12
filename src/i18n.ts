// Everything Ubah says outside the approved health content.
// English is complete. Somali, Kiswahili and Afaan Oromoo MUST be translated by native speakers
// and checked with girls before the pilot — missing keys fall back to English.

export const LANGUAGES: Record<string, string> = { so: "Soomaali", sw: "Kiswahili", en: "English", om: "Afaan Oromoo" };
export const LANGUAGE_MENU: Array<[string, string]> = [["1", "so"], ["2", "sw"], ["3", "en"], ["4", "om"]];

type Strings = Record<string, string>;

const en: Strings = {
  welcome:
    "Welcome to Ubah, a private place to ask about your body and health. Your name is not saved.\nChoose a language:\n1 Soomaali\n2 Kiswahili\n3 English\n4 Afaan Oromoo",
  language_set: "Thank you. Ask me anything about your body, periods, pregnancy, family planning or safety. You can type or send a voice note.",
  translation_pending: "(Sorry, this answer is not yet available in your language, so it is in English.)",
  answer_menu: "Reply:\n1 Find a clinic\n2 Talk to a Dada\n3 Ask another question",
  dont_know:
    "I'm not sure about that, and I only answer with checked health information. A Dada (a trained young woman) can help you.\nReply:\n2 Talk to a Dada\n3 Ask another question",
  choose_services:
    "What do you need at the clinic? Reply with numbers, for example 1 3:\n1 Pregnancy test\n2 Family planning\n3 Period care\n4 Infection or HIV test\n5 Counselling\n6 Safety support",
  no_clinic: "I couldn't find a partner clinic with that service yet. A Dada will help you find care.",
  pass_issued:
    "Your referral pass: {code}\nShow it at the desk. You won't need to explain again.\nSuggested clinic: {clinic}, {area}. Open {hours}.{free}\nThe pass works at any Ubah partner clinic for {days} days.",
  pass_free: " Free.",
  checkin_scheduled: "I'll send you a short message in 3 days to ask how it went. Reply STOP anytime.",
  dada_requested: "OK. A Dada will reply to you here soon. You can keep writing in the meantime.",
  urgent_medical:
    "This needs care today. Please go to a clinic now and show this pass: {code}\nSuggested clinic: {clinic}, {area}.\nA nurse has been told and may message you.",
  urgent_safety:
    "Thank you for telling me. It is not your fault. A Dada is being told now and will message you here.\nIf you are in danger now, go to a safe person or the nearest clinic. In Kenya you can call the free helpline 1195.",
  urgent_selfharm:
    "I'm really glad you told me. You are not alone. A Dada is being told now and will message you here very soon.\nIf you might act on these thoughts now, please go to someone you trust or the nearest clinic straight away.",
  voice_failed: "Sorry, I couldn't hear that voice note. Please try again or type your message.",
  checkin_visited: "Hi, it's Ubah. Did you visit a clinic with your pass {code}?\nReply 1 Yes, 2 Not yet",
  checkin_respect: "Were you treated with respect?\nReply 1 Yes, 2 Partly, 3 No",
  checkin_not_yet: "That's OK. Your pass {code} still works until {expires}. Reply 2 to talk to a Dada if something is stopping you.",
  checkin_thanks: "Thank you. Your answer is anonymous and helps other girls find good care. Reply DADA to talk to a Dada.",
  stopped: "You won't get more messages from Ubah. Send any message to start again.",
  deleted: "Your chats and passes have been deleted.",
  help: "Ubah commands:\nMENU - start again\nDADA - talk to a person\nSTOP - no more messages\nDELETE - delete your chats",
  invalid_choice: "Sorry, I didn't understand. {prompt}",
};

const translations: Record<string, Strings> = {
  en,
  so: {}, // TODO: Somali translation by native speakers
  sw: {}, // TODO: Kiswahili translation
  om: {}, // TODO: Afaan Oromoo translation
};

export function t(lang: string | null | undefined, key: string, vars: Record<string, string | number> = {}): string {
  const s = translations[lang ?? "en"]?.[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export function hasTranslation(lang: string, key: string): boolean {
  return lang === "en" || Boolean(translations[lang]?.[key]);
}
