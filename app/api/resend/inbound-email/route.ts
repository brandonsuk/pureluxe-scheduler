import { Resend } from "resend";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { sendManageVisitReply } from "@/lib/notifications";
import { classifyReply, type ReplyIntent } from "@/lib/reply-intent";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDate } from "@/lib/time";

// Customer replies to our emails arrive here (Resend inbound, sent to REPLY_TO_EMAIL).
// 1. Claude Haiku works out whether they want to move or cancel their visit.
// 2. If so, and we find their upcoming visit, they get an instant reply with the
//    signed Reschedule / Cancel buttons. Nothing is cancelled or moved from here:
//    the customer still taps a button.
// 3. Every reply is forwarded to ADMIN_ALERT_EMAIL with what was decided.

type AppointmentRow = {
  id: string;
  date: string;
  start_time: string;
  client_name: string;
};

type ResendEmailReceivedEvent = {
  type?: string;
  data?: {
    email_id?: string;
  };
};

type ReceivedEmail = {
  from?: string;
  subject?: string;
  text?: string | null;
  html?: string | null;
  message_id?: string;
  headers?: Record<string, string> | Array<{ name: string; value: string }> | null;
};

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

// At most this many automatic replies per visit, so a back-and-forth can't loop.
const MAX_AUTO_REPLIES_PER_VISIT = 3;

const INTENT_LABEL: Record<ReplyIntent, string> = {
  reschedule: "wants to reschedule",
  cancel: "wants to cancel",
  other: "general message",
};

// ILIKE treats % and _ as wildcards; escape them so an address only matches itself.
function exactIlike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function extractEmail(input: string): string {
  const match = input.match(/<([^>]+)>/);
  const email = (match ? match[1] : input).trim().toLowerCase();
  return email;
}

// Remove quoted reply history (the thread quoted below the customer's message) so
// only what the customer actually typed is read.
function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (
      t.startsWith(">") ||
      /^On\b.*\bwrote:?\s*$/i.test(t) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(t) ||
      /^_{5,}$/.test(t) ||
      /^From:\s/i.test(t) ||
      /^Sent from my /i.test(t)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

// HTML replies wrap the quoted thread in a blockquote / gmail_quote container.
// Cut from the first such marker before stripping tags.
function stripQuotedHtml(html: string): string {
  let cut = html;
  for (const marker of [/<blockquote/i, /gmail_quote/i, /<div[^>]*class="[^"]*quote/i]) {
    const idx = cut.search(marker);
    if (idx !== -1) cut = cut.slice(0, idx);
  }
  return cut.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function headerValue(headers: ReceivedEmail["headers"], name: string): string {
  if (!headers) return "";
  const want = name.toLowerCase();
  if (Array.isArray(headers)) {
    return headers.find((h) => h.name?.toLowerCase() === want)?.value || "";
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === want);
  return key ? String(headers[key]) : "";
}

// Out-of-office replies, bounces and our own mail never get an automatic answer.
function isAutomated(email: ReceivedEmail, from: string): boolean {
  if (!from || from.endsWith("@pureluxebathrooms.co.uk")) return true;
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(from)) return true;
  const autoSubmitted = headerValue(email.headers, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (/^(bulk|junk|list|auto_reply)$/.test(headerValue(email.headers, "precedence").toLowerCase())) return true;
  if (headerValue(email.headers, "x-autoreply") || headerValue(email.headers, "x-autorespond")) return true;
  return /^(auto(matic)? ?reply|out of (the )?office|undeliverable|delivery status notification)/i.test(email.subject || "");
}

// "2026-11-04", "10:00:00" -> "Wed 4 Nov at 10:00"
function visitWhen(date: string, startTime: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(",", "");
  return `${day} at ${startTime.slice(0, 5)}`;
}

async function fetchReceivedEmail(id: string): Promise<ReceivedEmail | null> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.resendApiKey}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as ReceivedEmail;
}

// Resend retries a webhook with the same email id; handle each email once.
async function claimOnce(key: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("message_rate_limits")
    .insert({ key, count: 1, updated_at: new Date().toISOString() });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw error;
}

async function countAndBump(key: string): Promise<number> {
  const { data } = await supabaseAdmin.from("message_rate_limits").select("count").eq("key", key).maybeSingle();
  const current = (data as { count: number } | null)?.count ?? 0;
  await supabaseAdmin
    .from("message_rate_limits")
    .upsert({ key, count: current + 1, updated_at: new Date().toISOString() }, { onConflict: "key" });
  return current;
}

export async function POST(request: Request) {
  if (!resend || !env.resendWebhookSecret) {
    return jsonError("Resend inbound not configured", request, 500);
  }

  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.resendWebhookSecret) {
    return jsonError("Unauthorized", request, 401);
  }

  const event = (await request.json()) as ResendEmailReceivedEvent;

  if (event.type !== "email.received" || !event.data?.email_id) {
    return jsonOk({ success: true, ignored: true }, request);
  }

  const received = await fetchReceivedEmail(event.data.email_id);
  if (!received) {
    // Let Resend retry: nothing has been done for this email yet.
    return jsonError("Could not fetch received email", request, 502);
  }

  if (!(await claimOnce(`inbound:${event.data.email_id}`))) {
    return jsonOk({ success: true, ignored: true, reason: "already_handled" }, request);
  }

  const from = extractEmail(received.from || "");
  if (from.endsWith("@pureluxebathrooms.co.uk")) {
    // Our own mail (e.g. a loop through contact@): never answer or forward it.
    return jsonOk({ success: true, ignored: true, reason: "own_domain" }, request);
  }
  const subject = received.subject || "(no subject)";
  const text = (received.text || "").trim();
  const html = (received.html || "").replace(/<[^>]*>/g, " ").trim();
  const customerMessage = text ? stripQuotedReply(text) : stripQuotedHtml(received.html || "");
  const automated = isAutomated(received, from);

  const { intent, source } = automated
    ? { intent: "other" as ReplyIntent, source: "keywords" as const }
    : await classifyReply(customerMessage);

  let appointment: AppointmentRow | null = null;
  let action = automated ? "No automatic reply (automated email)" : "No automatic reply (general message)";

  if (!automated && intent !== "other") {
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .select("id,date,start_time,client_name")
      .eq("status", "confirmed")
      .gte("date", todayIsoDate())
      .ilike("client_email", exactIlike(from))
      .order("date", { ascending: true })
      .order("start_time", { ascending: true })
      .limit(1);
    if (error) {
      // eslint-disable-next-line no-console
      console.error("inbound_email_lookup_failed", error);
    }
    appointment = (data?.[0] || null) as AppointmentRow | null;

    if (!appointment) {
      action = "No automatic reply (no upcoming visit found for this email address)";
    } else if ((await countAndBump(`autoreply:${appointment.id}`)) >= MAX_AUTO_REPLIES_PER_VISIT) {
      action = "No automatic reply (this visit has already had 3)";
    } else {
      try {
        const sent = await sendManageVisitReply({
          to: from,
          firstName: (appointment.client_name || "").trim().split(/\s+/)[0] || "",
          appointmentId: appointment.id,
          when: visitWhen(appointment.date, appointment.start_time),
          subject,
          inReplyTo: received.message_id,
        });
        action = sent
          ? "Sent them the Reschedule / Cancel buttons"
          : "No automatic reply (email limit for this address reached)";
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("inbound_email_autoreply_failed", e);
        action = "Automatic reply FAILED, please reply by hand";
      }
    }
  }

  // Forward every reply to the team, with what was decided.
  try {
    const visitLine = appointment ? `Visit: ${visitWhen(appointment.date, appointment.start_time)}\n` : "";
    await resend.emails.send({
      from: "PureLuxe <contact@pureluxebathrooms.co.uk>",
      to: env.adminAlertEmail,
      replyTo: from || undefined,
      subject: `Lead email (${INTENT_LABEL[intent]}): ${subject}`,
      text: `From: ${from}\n${visitLine}Read as: ${INTENT_LABEL[intent]}${source === "keywords" && !automated ? " (keyword check)" : ""}\nWhat we did: ${action}\n\n${text || html || "(empty message)"}`,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("inbound_email_forward_failed", e);
  }

  return jsonOk({ success: true, intent, source, action, appointment_id: appointment?.id || null }, request);
}
