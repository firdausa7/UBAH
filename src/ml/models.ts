import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { predict, type ModelJson } from "./classifier.js";
import { expandCodedTerms } from "./glossary.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = process.env.MODELS_DIR ?? join(here, "../../models");

const loaded: Record<string, ModelJson | null> = {};
// Active models from the registry (database), set by the cache refresh. They win over models/ files.
let active: Partial<Record<string, ModelJson>> = {};
export function setActiveModels(m: Partial<Record<string, ModelJson>>) {
  active = m;
}
function model(task: "danger" | "topic"): ModelJson | null {
  if (active[task]) return active[task]!;
  if (!(task in loaded)) {
    const p = join(MODELS_DIR, `${task}.json`);
    loaded[task] = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }
  return loaded[task];
}
export function reloadModels() {
  for (const k of Object.keys(loaded)) delete loaded[k];
  active = {};
}

// Safety net: phrases that ALWAYS go to a human, whatever the model says.
// Rules give high recall on the worst cases; the trained model catches the rest.
const DANGER_RULES: Array<{ label: "medical" | "safety" | "selfharm"; re: RegExp }> = [
  { label: "selfharm", re: /\b(kill (my ?self|me)|want(ed)? to die|end (my|it all|my life)|suicid|hurt (my ?self)|cut (my ?self)|don'?t want to live|not want to live|wish i (was|were) dead)\b/i },
  { label: "safety", re: /\b(rap(e|ed)|forc(e|ed|es) me|beat(s|ing)? me|hit(s)? me|abus(e|ed|ing)|assault(ed)?|not safe|threaten(s|ed)? me|touch(es|ed)? me|marry me off|cut me)\b/i },
  { label: "medical", re: /\b(bleeding (a lot|heavily|won'?t stop|will not stop)|soak(s|ing)? a pad every hour|faint(ed)?|baby (is )?not moving|water broke|fits|convulsion|can'?t breathe|unconscious)\b/i },
  { label: "medical", re: /\bpregnant\b.*\b(bleed|bleeding|headache|fever|pain)\b|\b(bleed|bleeding)\b.*\bpregnant\b/i },
];

export interface Analysis {
  text: string; // message with coded terms expanded
  codedTerms: string[];
  topic: string | null;
  topicConfidence: number;
  danger: "none" | "medical" | "safety" | "selfharm";
  dangerSource: "rule" | "model" | "none";
}

export function analyse(raw: string, lang: string | null = "en"): Analysis {
  const l = lang ?? "en";
  const { text, found } = expandCodedTerms(raw);
  let danger: Analysis["danger"] = "none";
  let dangerSource: Analysis["dangerSource"] = "none";
  const rule = DANGER_RULES.find((r) => r.re.test(text));
  if (rule) {
    danger = rule.label;
    dangerSource = "rule";
  } else {
    const dm = model("danger");
    if (dm) {
      const p = predict(dm, text, l);
      // Err on the side of a human: flag when any danger class is reasonably likely.
      const worst = (["selfharm", "safety", "medical"] as const).find((l) => (p.probs[l] ?? 0) >= 0.5 && p.known > 0);
      if (worst) {
        danger = worst;
        dangerSource = "model";
      }
    }
  }
  let topic: string | null = found[0]?.topic ?? null;
  let topicConfidence = topic ? 1 : 0;
  const tm = model("topic");
  if (tm) {
    const p = predict(tm, text, l);
    if (p.known > 0 && (!topic || p.probs[p.label] > 0.6)) {
      topic = p.label;
      topicConfidence = p.probs[p.label];
    }
  }
  return { text, codedTerms: found.map((f) => f.term), topic, topicConfidence, danger, dangerSource };
}
