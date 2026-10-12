import { config, mockMode } from "../config.js";
import { log } from "../log.js";
import type { ContentItem } from "../content/content.js";

// Grounded answering: the model may ONLY rephrase approved content to fit the girl's question.
// Works with any OpenAI-compatible endpoint (OpenAI, or an open-weight model on vLLM / Ollama).
// With no API key (or on any error) Ubah sends the approved text itself — never an ungrounded answer.

const SYSTEM = `You are Ubah, a kind, private health helper for adolescent girls and young women in Kenya.
Rules:
- Answer ONLY using the APPROVED CONTENT below. Do not add any medical fact that is not in it.
- If the content does not answer the question, reply exactly: NOT_COVERED
- Use simple words a 14-year-old understands. At most 3 short sentences. No lists, no markdown.
- Never diagnose. Never name medicines or doses that are not in the content.
- Write in the SAME language as the approved content. Never translate it into another language.
- Be warm and non-judgemental.`;

export interface GroundedAnswer {
  text: string;
  usedModel: boolean;
  covered: boolean;
}

export async function groundedAnswer(question: string, items: ContentItem[]): Promise<GroundedAnswer> {
  const fallback = { text: items[0].body, usedModel: false, covered: true };
  if (mockMode.llm()) return fallback;
  const content = items.map((c) => `[${c.id}] ${c.title}\n${c.body}`).join("\n\n");
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.2,
        max_tokens: 180,
        messages: [
          { role: "system", content: `${SYSTEM}\n\nAPPROVED CONTENT:\n${content}` },
          { role: "user", content: question },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json: any = await res.json();
    const text: string = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return fallback;
    if (text.includes("NOT_COVERED")) return { text: "", usedModel: true, covered: false };
    return { text, usedModel: true, covered: true };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "llm failed, falling back to approved text");
    return fallback;
  }
}
