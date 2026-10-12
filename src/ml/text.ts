// Text helpers shared by retrieval and the classifiers, aware of the message's language.
//   en: English stopwords + a tiny stemmer ("periods" -> "period", "bleeding" -> "bleed")
//   so: Somali stopwords + light suffix stripping (definite articles / possessives), apostrophes
//       kept inside words (the glottal stop: "ba'an")
//   sw, om: lower-casing and apostrophes kept; no stemming yet
// DRAFT: the Somali lists below are a starting point for native speakers to review and extend.
// They only affect matching; they never decide whether a message is a danger sign on their own.

const EN_STOP = new Set(
  "a an the and or but if is are was were be been am i im i'm my me you your it its this that to of in on for with at by from do does did have has had not no so can could would should will what how why when where who which there their they them he she her his we our us just very".split(
    " ",
  ),
);

// DRAFT: common Somali function words (conjunctions, particles, pronouns).
export const SO_STOP = new Set(
  "waa iyo ka ku u la oo ee aan in si ma waxa waxaan waxay wax ah ayaa baa haa maya ama laakiin markaa haddii sida ilaa kan kani taas kaas aniga adiga isaga iyada anaga idinka iyaga".split(" "),
);
// DRAFT: Somali noun suffixes (definite articles, demonstratives, possessives), longest first.
export const SO_SUFFIXES = ["kayga", "tayda", "kaaga", "taada", "kiisa", "tiisa", "keeda", "teeda", "kaas", "taas", "kii", "tii", "gii", "dii", "hii", "kan", "tan", "ka", "ta", "ga", "da", "ha", "sha"];

export type Lang = "en" | "so" | "sw" | "om" | string;

function words(text: string, keepApostrophes: boolean): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(keepApostrophes ? /[^\p{L}\p{N}\s']/gu : /[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length > 1);
}

// Tiny English stemmer: enough to match "periods"/"period", "bleeding"/"bleed".
function stemEn(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

// Strips one Somali suffix, keeping a stem of at least 3 letters ("dhiigga" -> "dhiig", "caloosha" -> "caloo").
export function stemSo(t: string): string {
  for (const s of SO_SUFFIXES) {
    if (t.length - s.length >= 3 && t.endsWith(s)) {
      let stem = t.slice(0, -s.length);
      // "dhiigga": the article doubles the last consonant.
      if (stem.length >= 4 && stem.at(-1) === stem.at(-2) && s.startsWith(stem.at(-1)!)) stem = stem.slice(0, -1);
      return stem;
    }
  }
  return t;
}

export function tokenize(text: string, lang: Lang = "en"): string[] {
  if (lang === "so") return words(text, true).filter((t) => !SO_STOP.has(t)).map(stemSo);
  if (lang === "sw" || lang === "om") return words(text, true);
  return words(text, false)
    .filter((t) => !EN_STOP.has(t))
    .map(stemEn);
}

// Unigrams + bigrams, used as classifier features.
export function features(text: string, lang: Lang = "en"): string[] {
  const toks = tokenize(text, lang);
  const out = [...toks];
  for (let i = 0; i + 1 < toks.length; i++) out.push(`${toks[i]}_${toks[i + 1]}`);
  return out;
}
