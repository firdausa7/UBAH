/* Ubah girls' app. Plain JavaScript, no framework, so it loads fast on 3G and old phones.
 * Privacy: no name or phone number. The device holds a random secret (encrypted with her PIN when one
 * is set); the conversation lives on the server, never stored on the phone. Quick exit on every screen. */
"use strict";

const KEY = { token: "ubah.t", lockedToken: "ubah.tenc", lang: "ubah.lang", intro: "ubah.intro" };
const S = { token: null, lang: null, strings: {}, languages: {}, msgs: [], lastId: 0, outbox: [], services: new Set(), recording: null, poll: null };

// ---------- small helpers ----------
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: works for this visit only */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

function tr(key, vars) {
  let s = S.strings[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// Builds DOM nodes; text always goes in as text, never as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

// Simple line icons (24x24, drawn with the text colour). Decorative: the label next to them carries the meaning.
const ICONS = {
  home: "M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5",
  ask: "M4 5h16v11H9l-5 4z",
  care: "M5 4h14v16H5zM12 8v8M8 12h8",
  pass: "M3 7h18v3.5a1.5 1.5 0 0 0 0 3V17H3v-3.5a1.5 1.5 0 0 0 0-3zM15 7v10",
  learn: "M4 5.5C6 4 9 4 12 6c3-2 6-2 8-.5V19c-2-1.5-5-1.5-8 .5-3-2-6-2-8-.5zM12 6v13.5",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  stop: "M7 7h10v10H7z",
  exit: "M10 4H5v16h5M14 8l4 4-4 4M18 12H9",
  check: "M5 12.5l4.5 4.5L19 7",
  arrow: "M9 5l7 7-7 7",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", ICONS[name]);
  svg.append(p);
  return svg;
}

async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(`/app/api${path}`, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401 && S.token) {
    // The session was wiped (or never existed here): start fresh.
    S.token = null;
    store.del(KEY.token);
    store.del(KEY.lockedToken);
    await ensureSession();
    return api(path, opts);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------- PIN lock (the device secret is encrypted with a key derived from the PIN) ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function lockToken(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pinKey(pin, salt), enc.encode(S.token));
  store.set(KEY.lockedToken, JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(data) }));
  store.del(KEY.token);
}
async function unlockToken(pin) {
  const rec = JSON.parse(store.get(KEY.lockedToken));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, await pinKey(pin, unb64(rec.salt)), unb64(rec.data));
  return new TextDecoder().decode(plain);
}
const hasPin = () => Boolean(store.get(KEY.lockedToken));

// ---------- session, strings ----------
async function ensureSession() {
  if (S.token) return;
  const plain = store.get(KEY.token);
  if (plain) {
    S.token = plain;
    return;
  }
  if (hasPin()) return; // locked: wait for the PIN
  const { token } = await api("/session", { method: "POST" });
  S.token = token;
  store.set(KEY.token, token);
}

async function loadStrings(lang) {
  const r = await api(`/strings?lang=${encodeURIComponent(lang || "en")}`);
  S.strings = r.strings;
  S.languages = r.languages;
  S.staging = r.stage === "staging";
  document.documentElement.lang = r.lang;
}

async function setLanguage(code) {
  await api("/me", { method: "PATCH", json: { language: code } });
  S.lang = code;
  store.set(KEY.lang, code);
  await loadStrings(code);
}

// ---------- quick exit ----------
function quickExit() {
  S.token = null;
  S.msgs = [];
  document.getElementById("app").textContent = "";
  // Replace this page in history so Back doesn't return to Ubah.
  location.replace("https://www.google.com/search?q=weather+today");
}

// ---------- layout ----------
const VIEWS = ["home", "ask", "care", "passes", "learn", "account", "intro"];
const route = () => (VIEWS.includes(location.hash.slice(2)) ? location.hash.slice(2) : "home");
const go = (v) => {
  location.hash = `#/${v}`;
};

function header(opts = {}) {
  return h(
    "header",
    null,
    h("div", { class: "brand" }, h("span", { class: "dot", "aria-hidden": "true" }), "ubah"),
    h(
      "div",
      { class: "header-actions" },
      opts.locked || opts.bare ? null : h("button", { class: "iconbtn", onclick: () => go("account"), "aria-label": tr("app_nav_account"), "aria-current": opts.view === "account" ? "page" : null }, icon("settings")),
      h("button", { class: "exit", onclick: quickExit }, icon("exit"), tr("app_quick_exit")),
    ),
  );
}

function tabs(current) {
  const items = [
    ["home", "app_nav_home"],
    ["ask", "app_nav_ask"],
    ["care", "app_nav_care"],
    ["passes", "app_nav_passes"],
    ["learn", "app_nav_learn"],
  ];
  return h("nav", { class: "tabs", "aria-label": "Ubah" }, items.map(([v, k]) => h("button", { onclick: () => go(v), "aria-current": current === v ? "page" : null }, icon(v), h("span", null, tr(k)))));
}

function banners(root) {
  if (S.staging) root.append(h("div", { class: "banner", role: "status" }, "TEST VERSION — not for real health questions."));
  if (!navigator.onLine) root.append(h("div", { class: "banner", role: "status" }, tr("app_offline")));
}

function mount(view, ...content) {
  const root = document.getElementById("app");
  root.textContent = "";
  banners(root);
  root.append(header({ view }), h("section", { class: `view view-${view}` }, content), tabs(view));
}

// A full-screen step without the bottom bar (language, intro, PIN).
function mountBare(...content) {
  const root = document.getElementById("app");
  root.textContent = "";
  banners(root);
  root.append(header({ bare: true }), h("section", { class: "view bare" }, content));
}

const title = (text, sub) => h("div", { class: "title" }, h("h1", null, text), sub ? h("p", { class: "muted" }, sub) : null);

// ---------- first visit: language, then how Ubah works ----------
function viewLanguage() {
  mountBare(
    h("div", { class: "flower", "aria-hidden": "true" }),
    h("h1", { class: "center" }, tr("app_choose_language")),
    h(
      "div",
      { class: "stack" },
      Object.entries(S.languages).map(([code, name]) =>
        h(
          "button",
          {
            class: "choice",
            lang: code,
            onclick: async () => {
              await setLanguage(code);
              go(store.get(KEY.intro) ? "home" : "intro");
              render();
            },
          },
          h("b", null, name),
          icon("arrow"),
        ),
      ),
    ),
  );
}

function viewIntro() {
  const point = (ic, t, body) => h("div", { class: "point" }, h("span", { class: "point-icon" }, icon(ic)), h("div", null, h("h2", null, t), h("p", null, body)));
  mountBare(
    h("h1", null, tr("app_intro_title")),
    point("lock", tr("app_intro_private_t"), tr("app_intro_private")),
    point("ask", tr("app_intro_ask_t"), tr("app_intro_ask")),
    point("pass", tr("app_intro_care_t"), tr("app_intro_care")),
    h(
      "button",
      {
        class: "accent wide",
        onclick: () => {
          store.set(KEY.intro, "1");
          go("home");
        },
      },
      tr("app_intro_start"),
    ),
  );
}

// ---------- home ----------
async function viewHome() {
  let pass = null;
  try {
    pass = (await api("/passes")).passes.find((p) => p.valid) || null;
  } catch {
    /* offline: home still works */
  }
  mount(
    "home",
    title(`${tr("app_hello")} ${tr("app_greeting")}`, tr("app_tagline")),
    h("button", { class: "tile hero", onclick: () => go("ask") }, h("span", { class: "tile-icon" }, icon("ask")), h("span", { class: "tile-text" }, h("b", null, tr("app_home_ask")), h("span", null, tr("app_home_ask_sub")))),
    h(
      "div",
      { class: "pair" },
      h("button", { class: "tile", onclick: () => go("care") }, h("span", { class: "tile-icon" }, icon("care")), h("b", null, tr("app_home_care")), h("span", { class: "muted" }, tr("app_home_care_sub"))),
      h("button", { class: "tile", onclick: () => go("learn") }, h("span", { class: "tile-icon" }, icon("learn")), h("b", null, tr("app_home_learn")), h("span", { class: "muted" }, tr("app_home_learn_sub"))),
    ),
    pass
      ? h("button", { class: "mini-pass", onclick: () => go("passes") }, h("span", { class: "muted" }, tr("app_your_pass")), h("span", { class: "code" }, pass.code), h("span", null, tr("app_pass_show")))
      : null,
    h("button", { class: "row", onclick: () => talkToPerson() }, h("span", { class: "row-icon" }, icon("person")), h("span", { class: "row-text" }, h("b", null, tr("app_talk_person")), h("span", { class: "muted" }, tr("app_talk_person_sub"))), icon("arrow")),
    hasPin()
      ? h("p", { class: "note" }, icon("lock"), h("span", null, tr("app_pin_on")))
      : h("button", { class: "note", onclick: () => go("account") }, icon("lock"), h("span", null, tr("app_privacy"))),
  );
}

// ---------- ask ----------
async function refreshMessages() {
  const r = await api(`/messages?after=${S.lastId}`);
  addMessages(r.messages);
}
function addMessages(list) {
  for (const m of list) {
    if (m.id > S.lastId) {
      S.msgs.push(m);
      S.lastId = m.id;
    }
  }
}

async function sendText(text) {
  if (route() !== "ask") go("ask");
  if (!navigator.onLine) {
    S.outbox.push(text); // kept in memory only, sent when back online
    S.msgs.push({ id: 0, from: "me", text, pending: true });
    return viewAsk();
  }
  S.msgs.push({ id: 0, from: "me", text, pending: true });
  viewAsk();
  try {
    const r = await api("/messages", { method: "POST", json: { text, after: S.lastId } });
    S.msgs = S.msgs.filter((m) => !m.pending);
    addMessages(r.messages);
  } catch {
    S.msgs = S.msgs.filter((m) => !m.pending);
    S.msgs.push({ id: 0, from: "ubah", text: tr("app_error") });
  }
  if (route() === "ask") viewAsk();
}

// "DADA" is the command every channel understands, in every language.
const talkToPerson = () => sendText("DADA");

async function toggleRecording() {
  if (S.recording) return S.recording.stop();
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    S.msgs.push({ id: 0, from: "ubah", text: tr("app_voice_unsupported") });
    return viewAsk();
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    S.msgs.push({ id: 0, from: "ubah", text: tr("app_voice_unsupported") });
    return viewAsk();
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    S.recording = null;
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    viewAsk();
    try {
      const r = await api(`/voice?after=${S.lastId}`, { method: "POST", body: blob, headers: { "content-type": blob.type.split(";")[0] } });
      addMessages(r.messages);
    } catch {
      S.msgs.push({ id: 0, from: "ubah", text: tr("app_error") });
    }
    viewAsk();
  };
  S.recording = rec;
  rec.start();
  viewAsk();
  setTimeout(() => rec.state === "recording" && rec.stop(), 60000); // at most one minute
}

function viewAsk() {
  const shown = S.msgs.filter((m) => m.text);
  const last = [...S.msgs].reverse().find((m) => m.from === "ubah");
  const empty = h(
    "div",
    { class: "empty" },
    h("h2", null, tr("app_ask_empty_t")),
    h("p", { class: "muted" }, tr("app_ask_empty")),
    h("p", { class: "label" }, tr("app_ask_examples")),
    h("div", { class: "stack" }, ["app_ex_1", "app_ex_2", "app_ex_3", "app_ex_4"].map((k) => h("button", { class: "suggest", onclick: () => sendText(tr(k)) }, tr(k)))),
  );
  const thread = h(
    "div",
    { class: "thread" },
    shown.map((m) =>
      h(
        "div",
        { class: `msg ${m.from === "me" ? "me" : "ubah"}` },
        m.from === "me" ? null : h("span", { class: "who" }, "Ubah"),
        m.kind === "voice" ? "🎙 " : "",
        m.text,
        m.pending ? " …" : "",
      ),
    ),
    last && last.options && last.options.length && last === S.msgs[S.msgs.length - 1]
      ? h("div", { class: "options" }, last.options.map((o) => h("button", { class: "suggest", onclick: () => sendText(o.id) }, o.title)))
      : null,
  );
  const input = h("input", { id: "q", placeholder: tr("app_type_question"), autocomplete: "off", "aria-label": tr("app_type_question"), maxlength: 1600 });
  const form = h(
    "form",
    {
      class: "composer",
      onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) sendText(v);
      },
    },
    input,
    h("button", { type: "submit", class: "accent round", "aria-label": tr("app_send") }, icon("send")),
    h("button", { type: "button", class: `${S.recording ? "accent recording" : "secondary"} round`, "aria-label": S.recording ? tr("app_stop_recording") : tr("app_record"), onclick: toggleRecording }, icon(S.recording ? "stop" : "mic")),
  );
  mount(
    "ask",
    h("div", { class: "ask-head" }, h("h1", null, tr("app_nav_ask")), h("button", { class: "pill", onclick: () => talkToPerson() }, icon("person"), tr("app_talk_person"))),
    shown.length ? thread : empty,
    form,
  );
  window.scrollTo(0, document.body.scrollHeight);
}

// ---------- care: pick what she needs, see clinics, get one pass ----------
async function viewCare() {
  const services = [...S.services];
  const r = await api(`/clinics?services=${encodeURIComponent(services.join(","))}`);
  const toggle = (s) => {
    if (S.services.has(s)) S.services.delete(s);
    else S.services.add(s);
    viewCare();
  };
  const step = (n, text) => h("h2", { class: "step" }, h("span", { class: "num" }, n), text);
  const clinic = (c) =>
    h(
      "div",
      { class: "card clinic" },
      h("div", { class: "clinic-top" }, h("h3", null, c.name), c.verified ? h("span", { class: "tag" }, icon("check"), tr("app_verified")) : null),
      h("div", { class: "muted" }, [c.area, c.site, c.hours].filter(Boolean).join(" · ")),
      h("div", { class: "svc" }, c.services.map((s) => h("span", { class: S.services.has(s) ? "svc-on" : null }, tr(`svc_${s}`)))),
      h("div", { class: "muted small" }, c.rating ? tr("app_rating", { yes: c.rating.respectful, total: c.rating.total }) : tr("app_no_rating")),
    );
  mount(
    "care",
    title(tr("app_nav_care"), tr("app_home_care_sub")),
    step("1", tr("app_care_step1")),
    h("div", { class: "chips", role: "group", "aria-label": tr("app_care_step1") }, r.services.map((s) => h("button", { class: "chip", "aria-pressed": S.services.has(s) ? "true" : "false", onclick: () => toggle(s) }, S.services.has(s) ? icon("check") : null, tr(`svc_${s}`)))),
    step("2", services.length ? tr("app_care_step2") : tr("app_care_all")),
    r.clinics.length ? r.clinics.map(clinic) : h("p", { class: "note" }, tr("app_no_clinics")),
    // Step 3 stays in view above the bottom bar, however long the clinic list is.
    h(
      "div",
      { class: "passbar" },
      step("3", tr("app_care_step3")),
      h("p", { class: "muted small" }, tr("app_care_pass_note")),
      h(
        "button",
        {
          class: "accent wide",
          disabled: !services.length,
          onclick: async () => {
            const p = await api("/passes", { method: "POST", json: { services } });
            await refreshMessages();
            S.services.clear();
            go(p.code ? "passes" : "ask");
          },
        },
        services.length ? tr("app_get_pass") : tr("app_pick_first"),
      ),
    ),
  );
}

async function viewPasses() {
  const r = await api("/passes");
  const status = (p) => (p.valid ? h("span", { class: "tag" }, tr("app_pass_ready")) : p.redeemed ? h("span", { class: "tag grey" }, tr("app_pass_used")) : h("span", { class: "tag grey" }, tr("app_pass_expired")));
  mount(
    "passes",
    title(tr("app_nav_passes"), tr("app_passes_intro")),
    r.passes.length
      ? r.passes.map((p) =>
          h(
            "div",
            { class: p.valid ? "pass" : "card pass-old" },
            status(p),
            h("span", { class: "code" }, p.code),
            p.valid ? h("span", null, tr("app_pass_show")) : null,
            h("span", null, [p.clinic, p.area].filter(Boolean).join(", ")),
            h("span", { class: "muted" }, p.services.map((s) => tr(`svc_${s}`)).join(", ")),
            p.valid ? h("span", { class: "muted" }, tr("app_pass_valid", { date: new Date(p.expiresAt).toLocaleDateString() })) : null,
          ),
        )
      : h("div", { class: "empty" }, h("p", null, tr("app_passes_empty")), h("button", { class: "accent", onclick: () => go("care") }, tr("app_pass_get"))),
  );
}

async function viewLearn() {
  let r;
  try {
    r = await api(`/learn?lang=${encodeURIComponent(S.lang || "en")}`);
  } catch {
    r = { lessons: [] };
  }
  const groups = new Map();
  for (const l of r.lessons) groups.set(l.category, [...(groups.get(l.category) || []), l]);
  mount(
    "learn",
    title(tr("app_nav_learn"), tr("app_learn_intro")),
    r.lessons.length
      ? [...groups].map(([cat, lessons]) =>
          h(
            "div",
            { class: "group" },
            h("h2", { class: "label" }, tr(`cat_${cat}`)),
            lessons.map((l) =>
              h(
                "details",
                { class: "lesson" },
                h("summary", null, h("span", null, l.title), l.translated ? null : h("span", { class: "tag grey", lang: "en" }, S.languages.en || "English"), icon("arrow")),
                // Not yet translated and approved in her language: she still gets the English, clearly marked.
                l.translated ? null : h("p", { class: "pending" }, tr("translation_pending")),
                h("p", { class: "body", lang: l.translated ? null : "en" }, l.body),
                l.audio ? h("audio", { controls: true, preload: "none", src: l.audio }) : null,
              ),
            ),
          ),
        )
      : h("p", { class: "note" }, tr("app_learn_empty")),
    (r.upcoming || []).map((cat) =>
      h(
        "div",
        { class: "group" },
        h("h2", { class: "label" }, tr(`cat_${cat}`)),
        h("div", { class: "card soon" }, h("span", { class: "tag grey" }, tr("app_learn_soon_t")), h("p", { class: "muted" }, tr("app_learn_soon")), h("button", { class: "secondary", onclick: () => talkToPerson() }, icon("person"), tr("app_talk_person"))),
      ),
    ),
  );
}

// ---------- PIN ----------
function pinPad(heading, onDone, error) {
  let entry = "";
  const dots = h("div", { class: "dots", "aria-label": `0/6` });
  const paint = () => {
    dots.textContent = "";
    for (let i = 0; i < Math.max(4, entry.length); i++) dots.append(h("span", { class: i < entry.length ? "on" : "" }));
  };
  const press = (d) => {
    if (entry.length < 6) entry += d;
    paint();
  };
  paint();
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => h("button", { onclick: () => press(d) }, d));
  return h(
    "div",
    { class: "pin" },
    h("span", { class: "point-icon" }, icon("lock")),
    h("h1", { class: "center" }, heading),
    dots,
    error ? h("p", { class: "tag warn", role: "alert" }, error) : null,
    h(
      "div",
      { class: "keypad" },
      keys,
      h("button", { onclick: () => ((entry = entry.slice(0, -1)), paint()), "aria-label": "Delete" }, "⌫"),
      h("button", { onclick: () => press("0") }, "0"),
      h("button", { class: "accent", onclick: () => entry.length >= 4 && onDone(entry), "aria-label": "OK" }, icon("check")),
    ),
  );
}

function viewLock(error) {
  const root = document.getElementById("app");
  root.textContent = "";
  root.append(
    header({ locked: true }),
    h(
      "section",
      { class: "view bare" },
      pinPad(
        tr("app_pin_enter"),
        async (pin) => {
          try {
            S.token = await unlockToken(pin);
            start();
          } catch {
            viewLock(tr("app_pin_wrong"));
          }
        },
        error,
      ),
    ),
  );
}

// ---------- settings ----------
function viewAccount(message) {
  const section = (heading, ...kids) => h("div", { class: "card" }, h("h2", null, heading), kids);
  mount(
    "account",
    title(tr("app_nav_account")),
    message ? h("p", { class: "tag", role: "status" }, icon("check"), message) : null,
    section(
      tr("app_language"),
      h(
        "div",
        { class: "chips" },
        Object.entries(S.languages).map(([code, name]) =>
          h(
            "button",
            {
              class: "chip",
              lang: code,
              "aria-pressed": S.lang === code ? "true" : "false",
              onclick: async () => {
                await setLanguage(code);
                viewAccount(tr("app_saved"));
              },
            },
            name,
          ),
        ),
      ),
    ),
    section(
      tr("app_privacy_t"),
      h("p", { class: "muted" }, hasPin() ? tr("app_pin_on") : tr("app_pin_explain")),
      hasPin()
        ? h(
            "button",
            {
              class: "secondary",
              onclick: () => {
                store.set(KEY.token, S.token);
                store.del(KEY.lockedToken);
                viewAccount(tr("app_saved"));
              },
            },
            tr("app_pin_remove"),
          )
        : h("button", { class: "accent", onclick: () => mountBare(pinPad(tr("app_pin_new"), async (pin) => {
              await lockToken(pin);
              go("account");
              viewAccount(tr("app_saved"));
            })) }, icon("lock"), tr("app_lock_now")),
    ),
    h("button", { class: "row", onclick: () => go("intro") }, h("span", { class: "row-icon" }, icon("learn")), h("span", { class: "row-text" }, h("b", null, tr("app_intro_title"))), icon("arrow")),
    h(
      "div",
      { class: "card danger" },
      h("h2", null, tr("app_wipe")),
      h("p", { class: "muted" }, tr("app_wipe_explain")),
      h(
        "button",
        {
          class: "secondary danger-btn",
          onclick: () =>
            mountBare(
              h("h1", null, tr("app_wipe")),
              h("p", { class: "note" }, tr("app_wipe_confirm")),
              h(
                "button",
                {
                  class: "accent wide",
                  onclick: async () => {
                    await api("/me", { method: "DELETE" });
                    S.token = null;
                    S.msgs = [];
                    S.lastId = 0;
                    S.lang = null;
                    store.del(KEY.token);
                    store.del(KEY.lockedToken);
                    store.del(KEY.intro);
                    await ensureSession();
                    go("home");
                    render();
                  },
                },
                tr("app_wipe_yes"),
              ),
              h("button", { class: "secondary wide", onclick: () => viewAccount() }, tr("app_cancel")),
            ),
        },
        tr("app_wipe"),
      ),
    ),
  );
}

// ---------- router ----------
async function render() {
  clearInterval(S.poll);
  if (!S.lang) return viewLanguage();
  const v = route();
  try {
    if (v === "ask") {
      await refreshMessages();
      viewAsk();
      // New messages from a Dada or nurse arrive while she has the chat open.
      S.poll = setInterval(async () => {
        const before = S.lastId;
        await refreshMessages().catch(() => {});
        if (S.lastId !== before && route() === "ask" && !S.recording) viewAsk();
      }, 10000);
    } else if (v === "intro") viewIntro();
    else if (v === "care") await viewCare();
    else if (v === "passes") await viewPasses();
    else if (v === "learn") await viewLearn();
    else if (v === "account") viewAccount();
    else await viewHome();
  } catch {
    mount(v, h("p", { class: "note" }, navigator.onLine ? tr("app_error") : tr("app_offline")));
  }
}

async function start() {
  try {
    await ensureSession();
    if (!S.token) {
      // Locked: the app's words aren't personal, so load them before asking for the PIN.
      await loadStrings(store.get(KEY.lang) || "en").catch(() => {});
      return viewLock();
    }
    const me = await api("/me");
    S.lang = me.language || null;
    await loadStrings(S.lang || store.get(KEY.lang) || "en");
    render();
  } catch {
    // Offline on first open: show what can work without the network.
    await loadStrings(store.get(KEY.lang) || "en").catch(() => {});
    S.lang = S.lang || store.get(KEY.lang) || "en";
    render();
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("online", async () => {
  const queued = S.outbox.splice(0);
  S.msgs = S.msgs.filter((m) => !m.pending);
  for (const text of queued) await sendText(text);
  render();
});
window.addEventListener("offline", render);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
start();
