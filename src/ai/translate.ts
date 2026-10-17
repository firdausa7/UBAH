import { config, mockMode } from "../config.js";
import { log } from "../log.js";
import { LANGUAGES } from "../i18n.js";

// AI FIRST DRAFTS for translators. The model only proposes wording: nothing is saved until a native
// speaker has checked and saved it, and nothing reaches girls until a reviewer approves it.
// Works with any OpenAI-compatible endpoint (OpenAI, Groq, or an open-weight model on vLLM / Ollama).

export const AI_DRAFT_NOTE = "AI first draft: a native speaker must check every word";

const SYSTEM = (to: string) => `You translate short health messages for adolescent girls in Kenya from English into ${to}.
Rules:
- Translate faithfully. Do not add, remove or change any medical fact, number, name or phone number.
- Use simple, everyday words a 14-year-old understands, as spoken in northern Kenya.
- Keep every {placeholder} exactly as written, including the curly brackets.
- Reply with JSON only, in the shape you are given.`;

export type DraftResult<T> = { ok: true; value: T; model: string } | { ok: false; reason: "not_configured" | "failed" };

async function ask<T>(lang: string, shape: string, payload: unknown): Promise<DraftResult<T>> {
  if (mockMode.llm()) return { ok: false, reason: "not_configured" };
  const to = LANGUAGES[lang];
  if (!to || lang === "en") return { ok: false, reason: "failed" };
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.1,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM(to) },
          { role: "user", content: `Reply in this JSON shape: ${shape}\n\nEnglish:\n${JSON.stringify(payload)}` },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json: any = await res.json();
    const raw = String(json.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return { ok: true, value: JSON.parse(raw) as T, model: config.llm.model };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "ai translation draft failed");
    return { ok: false, reason: "failed" };
  }
}

export async function draftContent(lang: string, en: { title: string; body: string; keywords: string[] }) {
  const r = await ask<{ title?: unknown; body?: unknown; keywords?: unknown }>(lang, `{"title": "...", "body": "...", "keywords": ["...", "..."]}`, en);
  if (!r.ok) return r;
  const title = String(r.value.title ?? "").trim().slice(0, 200);
  const body = String(r.value.body ?? "").trim().slice(0, 4000);
  const keywords = Array.isArray(r.value.keywords) ? r.value.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 40) : [];
  if (!title || !body) return { ok: false as const, reason: "failed" as const };
  return { ok: true as const, value: { title, body, keywords }, model: r.model };
}

export async function draftString(lang: string, text: string) {
  const r = await ask<{ text?: unknown }>(lang, `{"text": "..."}`, { text });
  if (!r.ok) return r;
  const value = String(r.value.text ?? "").trim().slice(0, 2000);
  if (!value) return { ok: false as const, reason: "failed" as const };
  return { ok: true as const, value, model: r.model };
}

export const draftProblem = (reason: "not_configured" | "failed") =>
  reason === "not_configured"
    ? "AI drafts aren't switched on yet. Add LLM_API_KEY (and LLM_BASE_URL, LLM_MODEL) to the server settings, then try again."
    : "The AI couldn't make a draft just now. Try again, or translate it yourself.";
