import { features } from "./text.js";

// Multinomial Naive Bayes over word unigrams + bigrams.
// Small, fast, explainable, and trainable on a few hundred labelled messages —
// the right size of model for a prototype trained on nurse-labelled data.

export interface Example {
  text: string;
  label: string;
  source?: string; // seed | labeled
  language?: string;
}

export interface ModelJson {
  kind: "naive-bayes";
  task: string;
  labels: string[];
  vocab: number;
  logPrior: Record<string, number>;
  logLik: Record<string, Record<string, number>>; // label -> feature -> log P(f|label)
  logUnseen: Record<string, number>; // label -> log P(unseen feature|label)
  trainedAt: string;
  trainingSize: number;
  sources: Record<string, number>;
}

export function train(task: string, data: Example[], opts: { uniformPrior?: boolean; alpha?: number } = {}): ModelJson {
  const alpha = opts.alpha ?? 1;
  const labels = [...new Set(data.map((d) => d.label))].sort();
  const counts: Record<string, Map<string, number>> = {};
  const totals: Record<string, number> = {};
  const docs: Record<string, number> = {};
  const vocab = new Set<string>();
  for (const l of labels) {
    counts[l] = new Map();
    totals[l] = 0;
    docs[l] = 0;
  }
  for (const ex of data) {
    docs[ex.label]++;
    for (const f of features(ex.text, ex.language ?? "en")) {
      vocab.add(f);
      counts[ex.label].set(f, (counts[ex.label].get(f) ?? 0) + 1);
      totals[ex.label]++;
    }
  }
  const V = vocab.size;
  const logPrior: Record<string, number> = {};
  const logLik: Record<string, Record<string, number>> = {};
  const logUnseen: Record<string, number> = {};
  for (const l of labels) {
    logPrior[l] = opts.uniformPrior ? Math.log(1 / labels.length) : Math.log(docs[l] / data.length);
    const denom = totals[l] + alpha * V;
    logLik[l] = {};
    for (const [f, c] of counts[l]) logLik[l][f] = Math.log((c + alpha) / denom);
    logUnseen[l] = Math.log(alpha / denom);
  }
  const sources: Record<string, number> = {};
  for (const ex of data) sources[ex.source ?? "unknown"] = (sources[ex.source ?? "unknown"] ?? 0) + 1;
  return { kind: "naive-bayes", task, labels, vocab: V, logPrior, logLik, logUnseen, trainedAt: new Date().toISOString(), trainingSize: data.length, sources };
}

export interface Prediction {
  label: string;
  probs: Record<string, number>;
  known: number; // how many of the message's features the model has seen
}

export function predict(model: ModelJson, text: string, lang = "en"): Prediction {
  const feats = features(text, lang);
  const scores: Record<string, number> = {};
  let known = 0;
  const seen = new Set<string>();
  for (const l of model.labels) for (const f of Object.keys(model.logLik[l])) seen.add(f);
  for (const f of feats) if (seen.has(f)) known++;
  for (const l of model.labels) {
    let s = model.logPrior[l];
    for (const f of feats) {
      if (!seen.has(f)) continue; // ignore words no class has seen
      s += model.logLik[l][f] ?? model.logUnseen[l];
    }
    scores[l] = s;
  }
  const max = Math.max(...Object.values(scores));
  const exp = Object.fromEntries(Object.entries(scores).map(([l, s]) => [l, Math.exp(s - max)]));
  const z = Object.values(exp).reduce((a, b) => a + b, 0);
  const probs = Object.fromEntries(Object.entries(exp).map(([l, e]) => [l, e / z]));
  const label = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
  return { label, probs, known };
}

// Stratified k-fold cross-validation: honest accuracy numbers for the application.
export interface Report {
  task: string;
  folds: number;
  examples: number;
  sources: Record<string, number>;
  accuracy: number;
  perLabel: Record<string, { precision: number; recall: number; support: number }>;
  confusion: Record<string, Record<string, number>>;
}

export function crossValidate(task: string, data: Example[], folds = 5, opts: { uniformPrior?: boolean } = {}): Report {
  const byLabel = new Map<string, Example[]>();
  for (const ex of data) byLabel.set(ex.label, [...(byLabel.get(ex.label) ?? []), ex]);
  const foldOf = new Map<Example, number>();
  for (const xs of byLabel.values()) xs.forEach((ex, i) => foldOf.set(ex, i % folds));
  const labels = [...byLabel.keys()].sort();
  const confusion: Record<string, Record<string, number>> = Object.fromEntries(labels.map((l) => [l, Object.fromEntries(labels.map((m) => [m, 0]))]));
  let correct = 0;
  for (let k = 0; k < folds; k++) {
    const trainSet = data.filter((ex) => foldOf.get(ex) !== k);
    const testSet = data.filter((ex) => foldOf.get(ex) === k);
    const model = train(task, trainSet, opts);
    for (const ex of testSet) {
      const p = predict(model, ex.text, ex.language ?? "en").label;
      confusion[ex.label][p] = (confusion[ex.label][p] ?? 0) + 1;
      if (p === ex.label) correct++;
    }
  }
  const perLabel: Report["perLabel"] = {};
  for (const l of labels) {
    const tp = confusion[l][l];
    const predicted = labels.reduce((a, m) => a + (confusion[m][l] ?? 0), 0);
    const support = labels.reduce((a, m) => a + confusion[l][m], 0);
    perLabel[l] = { precision: predicted ? tp / predicted : 0, recall: support ? tp / support : 0, support };
  }
  const sources: Record<string, number> = {};
  for (const ex of data) sources[ex.source ?? "unknown"] = (sources[ex.source ?? "unknown"] ?? 0) + 1;
  return { task, folds, examples: data.length, sources, accuracy: correct / data.length, perLabel, confusion };
}
