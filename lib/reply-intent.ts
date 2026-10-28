import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

// Works out what a customer wants when they reply to one of our emails.
// Claude Haiku reads the reply; if it can't be reached, simple keywords decide instead.
// The result only chooses whether to send the Reschedule/Cancel buttons. It never
// changes a booking: the customer still has to tap a button.

export type ReplyIntent = "reschedule" | "cancel" | "other";

export type ReplyClassification = {
  intent: ReplyIntent;
  source: "ai" | "keywords";
};

const MODEL = "claude-haiku-5-5";
const MAX_CHARS = 4000;

const anthropic = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey, timeout: 15_000, maxRetries: 1 }) : null;

const SYSTEM = `You sort customer email replies for a bathroom company. The customer has booked a free home visit to get a quote.
Decide what the customer wants:
- "reschedule": they want to move, change, push back or bring forward the visit date or time, or say the booked time doesn't suit them.
- "cancel": they want to cancel the visit or no longer want it.
- "other": anything else, such as questions, confirming they'll be in, thanks, or general chat. If they mention cancelling only to say they don't want to cancel, that is "other".
Judge only the customer's own words. Answer in the JSON format requested.`;

export function keywordIntent(message: string): ReplyIntent {
  const m = message.toLowerCase();
  if (/\b(not|don'?t|do not|won'?t)\s+(want\s+to\s+|need\s+to\s+)?cancel/.test(m)) return "other";
  if (/\b(reschedul|re-schedul|rearrang|re-arrang|postpone|move (it|the|my|our)|change (the|my|our) (date|time|day|appointment|visit)|another (day|date|time)|different (day|date|time)|can'?t make|cannot make|won'?t be (in|home|available)|not be (in|home|available))/.test(m)) {
    return "reschedule";
  }
  if (/\bcancel/.test(m) || /\bCA\b/.test(message)) return "cancel";
  return "other";
}

export async function classifyReply(message: string): Promise<ReplyClassification> {
  const text = message.trim().slice(0, MAX_CHARS);
  if (!text) return { intent: "other", source: "keywords" };
  if (!anthropic) return { intent: keywordIntent(text), source: "keywords" };

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { intent: { type: "string", enum: ["reschedule", "cancel", "other"] } },
            required: ["intent"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: `Customer reply:\n<reply>\n${text}\n</reply>` }],
    });
    if (response.stop_reason === "refusal") return { intent: keywordIntent(text), source: "keywords" };
    const block = response.content.find((b) => b.type === "text");
    const parsed = block && block.type === "text" ? (JSON.parse(block.text) as { intent?: string }) : null;
    if (parsed?.intent === "reschedule" || parsed?.intent === "cancel" || parsed?.intent === "other") {
      return { intent: parsed.intent, source: "ai" };
    }
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      // eslint-disable-next-line no-console
      console.error("reply_intent_api_error", error.status, error.message);
    } else {
      // eslint-disable-next-line no-console
      console.error("reply_intent_failed", error);
    }
  }
  return { intent: keywordIntent(text), source: "keywords" };
}
