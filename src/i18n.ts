// Everything Ubah says outside the approved health content.
// English (below) is the source text. Somali, Kiswahili and Afaan Oromoo are written in the
// Translation studio by native speakers, approved by a reviewer and published; only published
// translations are used (see src/caches.ts). Missing keys fall back to English.

export const LANGUAGES: Record<string, string> = { so: "Soomaali", sw: "Kiswahili", en: "English", om: "Afaan Oromoo" };
export const LANGUAGE_MENU: Array<[string, string]> = [["1", "so"], ["2", "sw"], ["3", "en"], ["4", "om"]];

type Strings = Record<string, string>;

export const en: Strings = {
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
  checkin_visited: "Hi, it's Ubah. Did you visit a clinic with your pass {code}?\n1 Yes\n2 Not yet",
  checkin_respect: "Were you treated with respect?\n1 Yes\n2 Partly\n3 No",
  checkin_not_yet: "That's OK. Your pass {code} still works until {expires}. Reply 2 to talk to a Dada if something is stopping you.",
  checkin_thanks: "Thank you. Your answer is anonymous and helps other girls find good care. Reply DADA to talk to a Dada.",
  stopped: "You won't get more messages from Ubah. Send any message to start again.",
  deleted: "Your chats and passes have been deleted.",
  help: "Ubah commands:\nMENU - start again\nDADA - talk to a person\nSTOP - no more messages\nDELETE - delete your chats",
  invalid_choice: "Sorry, I didn't understand. {prompt}",
  ussd_info: "Ubah: to ask a private health question, send HI by SMS or WhatsApp to this number.",
  ussd_language: "Ubah\n1 Soomaali\n2 Kiswahili\n3 English\n4 Afaan Oromoo",
  ussd_main: "Ubah: private health help\n1 Health topics\n2 Find a clinic\n3 My passes\n4 Talk to a Dada\n5 Urgent help now\n6 Language",
  ussd_topics: "Choose a topic:",
  ussd_no_topics: "No topics here yet. Send HI by SMS to ask a question.",
  ussd_full_by_sms: "Full answer sent to you by SMS.",
  ussd_services: "What do you need?\n1 Pregnancy test\n2 Family planning\n3 Period care\n4 Infection or HIV test\n5 Counselling\n6 Safety support",
  ussd_pass: "Your pass: {code}. Go to {clinic}, {area}. Details sent by SMS.",
  ussd_no_clinic: "No partner clinic offers that yet. A Dada will message you by SMS.",
  ussd_passes: "Your passes:",
  ussd_no_passes: "You have no active passes.",
  ussd_urgent_menu: "Urgent help:\n1 Heavy bleeding or pregnancy problem\n2 Someone is hurting me\n3 I want to hurt myself",
  ussd_urgent_done: "A Dada or nurse has been told and will message you by SMS now.",
  ussd_dada: "A Dada will message you by SMS soon.",
  ussd_lang_saved: "Language saved.",
  ussd_invalid: "Sorry, that isn't an option. Please dial again.",
  cat_periods: "Periods",
  cat_pregnancy: "Pregnancy",
  cat_family_planning: "Family planning",
  cat_sti: "Infections and HIV",
  cat_safety: "Safety",
  cat_body: "My body",
  cat_feelings: "Feelings",
  cat_other: "Other",
  svc_pregnancy_test: "Pregnancy test",
  svc_family_planning: "Family planning",
  svc_period_care: "Period care",
  svc_sti: "Infection or HIV test",
  svc_counselling: "Counselling",
  svc_safety: "Safety support",
  svc_antenatal: "Pregnancy check-up",
  app_tagline: "Private answers about your body, your health and where to get care.",
  app_choose_language: "Choose your language",
  app_greeting: "What do you need today?",
  app_home_ask: "Ask a private question",
  app_home_ask_sub: "Type or record a voice note",
  app_home_care: "Find care near me",
  app_home_care_sub: "Partner clinics, with a free pass",
  app_home_learn: "Learn about my body",
  app_home_learn_sub: "Short lessons you can listen to",
  app_privacy: "No name or phone number is needed. Lock Ubah with a PIN under Account.",
  app_quick_exit: "Quick exit",
  app_nav_home: "Home",
  app_nav_ask: "Ask",
  app_nav_care: "Care",
  app_nav_passes: "My passes",
  app_nav_learn: "Learn",
  app_nav_account: "Account",
  app_type_question: "Type your question",
  app_send: "Send",
  app_record: "Record a voice note",
  app_stop_recording: "Stop and send",
  app_offline: "You're offline. Your message will be sent when you're back online.",
  app_care_pick: "What do you need? Pick one or more.",
  app_get_pass: "Get my referral pass",
  app_pick_first: "Pick a service first",
  app_verified: "Verified",
  app_rating: "{yes} of {total} girls said they were treated with respect",
  app_no_rating: "Not enough ratings yet",
  app_no_clinics: "No partner clinic offers this yet.",
  app_passes_empty: "You have no passes yet.",
  app_pass_show: "Show this code at the desk. You won't need to explain again.",
  app_pass_valid: "Valid until {date}",
  app_pass_used: "Recorded as seen",
  app_learn_empty: "Lessons will appear here once they are checked.",
  app_pin_set: "Set a PIN",
  app_pin_remove: "Remove PIN",
  app_pin_enter: "Enter your PIN",
  app_pin_new: "Choose a PIN of 4 to 6 digits",
  app_pin_wrong: "That PIN is not right.",
  app_wipe: "Wipe my history",
  app_wipe_confirm: "This deletes your chats and passes on Ubah. Are you sure?",
  app_wipe_yes: "Yes, delete everything",
  app_cancel: "Cancel",
  app_language: "Language",
  app_saved: "Saved.",
  app_error: "Something went wrong. Please try again.",
  app_voice_unsupported: "Voice notes don't work on this phone. Please type.",
  wa_list_button: "Choose",
  answer_source: "(Ubah checked answer: {title})",
  clinic_rating: "{yes} of {total} girls who went there said they were treated with respect.",
  near_hint: "Far from this clinic? Share your location, or reply NEAR and the name of your area or a place near you.",
  near_intro: "Nearest Ubah partner clinics:",
  near_clinic: "{clinic}, {area} (about {km} km). Open {hours}.",
  near_not_found: "Sorry, I don't know that place. Try the name of a nearby school, market or mosque, or share your location.",
  near_none: "I couldn't find a partner clinic for that yet. A Dada can help you find care. Reply DADA.",
  wa_waiting_sms: "Ubah has a message for you on WhatsApp. Send any message there to read it.",
};

export const TRANSLATION_LANGUAGES = ["so", "sw", "om"] as const;

let translations: Record<string, Strings> = { en };

// Called by the cache refresh with the strings girls may be sent.
export function setTranslations(byLang: Record<string, Strings>) {
  translations = { ...byLang, en };
}

export function t(lang: string | null | undefined, key: string, vars: Record<string, string | number> = {}): string {
  const s = translations[lang ?? "en"]?.[key] ?? en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

// The text with its {placeholders} left in (for the app, which fills them in itself).
export function rawString(lang: string | null | undefined, key: string): string {
  return translations[lang ?? "en"]?.[key] ?? en[key] ?? key;
}

export function hasTranslation(lang: string, key: string): boolean {
  return lang === "en" || Boolean(translations[lang]?.[key]);
}
