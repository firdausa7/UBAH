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
  land_title_tag: "private health help for girls",
  land_meaning: "Ubah (oo-BAH) means flower in Somali.",
  land_h1_em: "Private",
  land_h1_rest: "health help, and care that's checked.",
  land_lead: "Ubah gives girls and young women in northern Kenya private answers about their bodies and health — by voice note, chat, SMS or a basic phone — sends them to a trusted clinic with a free pass, and checks that they were seen and treated with respect.",
  land_open_app: "Open the Ubah app",
  land_other_ways: "Other ways to reach Ubah",
  land_flower_alt: "A coral flower, Ubah's symbol",
  land_story_eyebrow: "Our story",
  land_story_h_em: "Why",
  land_story_h_rest: "a flower?",
  land_story_1: "A flower grows when it gets what it needs at the right time: water, light, and a safe place to put down roots. Girls are the same. With the right information, care that respects them, and somewhere safe to ask, they grow up healthy and strong.",
  land_story_2: "For many refugee and pastoralist girls, that care is hard to reach. Help is in a language they don't read, questions feel too private to ask out loud, and after a referral no one checks whether they were actually helped — or how they were treated.",
  land_story_3: "Ubah is built to tend that whole journey: an answer in her own language, a referral to a clinic she can trust, and a gentle check-in afterwards. Every check-in helps clinics become places where more girls can grow.",
  land_how_eyebrow: "How it works",
  land_how_h_em: "One",
  land_how_h_rest: "closed loop",
  land_step1_title: "Ask privately",
  land_step1_body: "A girl asks in Somali, Kiswahili, Afaan Oromoo or English — by voice note or text. Answers come only from information checked by health partners.",
  land_step2_title: "Get a pass",
  land_step2_body: "If she needs care, she gets a free referral pass for a verified, youth-friendly partner clinic. She shows the code at the desk — no need to explain again.",
  land_step3_title: "A person when it matters",
  land_step3_body: "Danger signs — heavy bleeding, violence, thoughts of self-harm — go straight to a trained Dada or nurse, never to a machine alone.",
  land_step4_title: "We check back",
  land_step4_body: "Three days later, Ubah asks: did you go, and were you treated with respect? Her anonymous answer becomes each clinic's dignity score.",
  land_reach_eyebrow: "Reach Ubah",
  land_reach_h_em: "Any",
  land_reach_h_rest: "phone works",
  land_reach_live: "Free and private. No name, no account.",
  land_reach_soon: "Ubah is being tested. These ways to reach Ubah open soon.",
  land_coming_soon: "Coming soon",
  land_sms_how: "Send HI to",
  land_whatsapp_how: "Message",
  land_ussd_name: "Any phone (USSD)",
  land_ussd_how: "Dial",
  land_smartphone: "Smartphone",
  land_add_home: "add it to your home screen.",
  land_promise_eyebrow: "Our promise",
  land_promise_h_em: "Your",
  land_promise_h_rest: "privacy comes first",
  land_promise_1: "We never ask your name. Staff see a short code, not who you are.",
  land_promise_2: "Your phone number is scrambled and locked away.",
  land_promise_3: "Clinics see only your pass code and the help you need.",
  land_promise_4: "Send STOP to stop messages, DELETE to erase your chats.",
  land_promise_5: "Lock the app with a PIN. Quick exit leaves at once.",
  land_promise_6: "Clinic scores only show when five or more girls have answered.",
  land_partners_eyebrow: "For partners",
  land_partners_h_em: "Grow",
  land_partners_h_rest: "it with us",
  land_clinics_title: "Clinics",
  land_clinics_body: "Become a verified Ubah partner clinic: receive girls with a clear referral pass, and see — privately — how girls rate the respect they were shown.",
  land_health_title: "Health and protection partners",
  land_health_body: "Review and approve Ubah's health answers, agree safe referral pathways, and receive anonymous reports on what girls need.",
  land_team_title: "Ubah team",
  land_team_body: "Dadas, nurses, clinic desks and partners sign in here.",
  land_staff_login: "Staff login",
  land_footer_built: "Ubah is open source and built by HPI-SOLUTIONS KE LIMITED, Nairobi, Kenya.",
  land_footer_danger: "If you are in danger now, go to the nearest clinic or a person you trust.",
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
