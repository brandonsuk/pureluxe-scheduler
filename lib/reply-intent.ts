import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

// Works out what a customer wants when they reply to one of our emails.
// Claude Haiku reads the reply; if it can't be reached, simple keywords decide instead.
// The result only chooses which automatic reply to send. It never changes a booking:
// the customer still has to tap a button.

export const REPLY_INTENTS = ["reschedule", "cancel", "visit_details", "book", "stop", "other"] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export type ReplyClassification = {
  intent: ReplyIntent;
  source: "ai" | "keywords";
};

const MODEL = "claude-haiku-5-5";
const MAX_CHARS = 4000;

const anthropic = env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey, timeout: 15_000, maxRetries: 1 }) : null;

const SYSTEM = `You sort customer email replies for a bathroom company. Customers get our emails after asking for a quote: reminders to finish booking a free home visit, or confirmations and reminders for a visit they have booked.
Decide what the customer wants:
- "reschedule": they want to move, change, push back or bring forward their visit, or say the booked time doesn't suit them.
- "cancel": they want to cancel their visit or no longer want it.
- "visit_details": they ask when their visit is, whether it's still on, or for its details.
- "book": they want to book a visit, ask how to book, or say yes to booking one.
- "stop": they want no more messages, say they aren't interested, or ask to be removed, without mentioning a booked visit.
- "other": anything else, such as questions about prices or the work, confirming they'll be in, thanks, or general chat. If they mention cancelling only to say they don't want to cancel, that is "other".
Judge only the customer's own words. Answer in the JSON format requested.`;

export function keywordIntent(message: string): ReplyIntent {
  const m = message.toLowerCase();
  if (/\b(not|don'?t|do not|won'?t)\s+(want\s+to\s+|need\s+to\s+)?cancel/.test(m)) return "other";
  if (/\b(reschedul|re-schedul|rearrang|re-arrang|postpone|move (it|the|my|our)|change (the|my|our) (date|time|day|appointment|visit)|another (day|date|time)|different (day|date|time)|can'?t make|cannot make|won'?t be (in|home|available)|not be (in|home|available))/.test(m)) {
    return "reschedule";
  }
  if (/\bcancel/.test(m) || /\bCA\b/.test(message)) return "cancel";
  if (/\b(unsubscribe|stop (emailing|texting|messaging|contacting)|not interested|no longer interested|remove me|take me off)/.test(m)) return "stop";
  if (/\b(what time is|when is (my|the|our)|is (it|my visit|the visit|the appointment) still|still on\b|still coming)/.test(m)) return "visit_details";
  if (/\b((like|want|love) to book|how (do|can) i book|book (a|me|us|in)|arrange a visit)/.test(m)) return "book";
  return "other";
}

// UK postcode in the customer's own words, normalised to "G12 8QQ" style, or "".
export function extractPostcode(message: string): string {
  const match = message.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  return match ? `${match[1]} ${match[2]}` : "";
}

// UK phone number in the customer's own words (digits and a leading +), or "".
export function extractPhone(message: string): string {
  const match = message.match(/(?:\+44\s?\(?0?\)?\s?|\b0)\d(?:[\s-]?\d){8,9}\b/);
  return match ? match[0].replace(/[^\d+]/g, "") : "";
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
            properties: { intent: { type: "string", enum: [...REPLY_INTENTS] } },
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
    if (parsed?.intent && (REPLY_INTENTS as readonly string[]).includes(parsed.intent)) {
      return { intent: parsed.intent as ReplyIntent, source: "ai" };
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
