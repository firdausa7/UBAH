// Text helpers shared by retrieval and the classifiers.

const STOP = new Set(
  "a an the and or but if is are was were be been am i im i'm my me you your it its this that to of in on for with at by from do does did have has had not no so can could would should will what how why when where who which there their they them he she her his we our us just very".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// Tiny English stemmer: enough to match "periods"/"period", "bleeding"/"bleed".
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

// Unigrams + bigrams, used as classifier features.
export function features(text: string): string[] {
  const toks = tokenize(text);
  const out = [...toks];
  for (let i = 0; i + 1 < toks.length; i++) out.push(`${toks[i]}_${toks[i + 1]}`);
  return out;
}
