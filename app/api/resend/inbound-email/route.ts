import { Resend } from "resend";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { buildResumeLink, phoneCandidates } from "@/lib/abandoned-leads";
import { sendCustomerReply, type CustomerReplyKind } from "@/lib/notifications";
import { classifyReply, extractPhone, extractPostcode, type ReplyIntent } from "@/lib/reply-intent";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDate } from "@/lib/time";

// Customer replies to our emails arrive here (Resend inbound, sent to REPLY_TO_EMAIL).
// 1. Claude Haiku works out what they want (move, cancel, visit details, book, stop, other).
// 2. We look for their upcoming visit by email, or by the postcode + mobile they give us.
// 3. They get an instant reply that fits: the signed Reschedule / Cancel buttons, a request
//    for their postcode and mobile, a booking link, or an opt-out confirmation. Nothing is
//    cancelled or moved from here: the customer still taps a button.
// 4. Every reply is forwarded to ADMIN_ALERT_EMAIL with what was decided.

type AppointmentRow = {
  id: string;
  date: string;
  start_time: string;
  client_name: string;
  address: string;
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

// At most this many automatic replies per visit, and per sender per day, so a
// back-and-forth can't loop.
const MAX_AUTO_REPLIES_PER_VISIT = 3;
const MAX_AUTO_REPLIES_PER_SENDER_PER_DAY = 3;
// We ask for postcode + mobile at most once a week per sender; after that Thomas takes over.
const ASK_DETAILS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const INTENT_LABEL: Record<ReplyIntent, string> = {
  reschedule: "wants to reschedule",
  cancel: "wants to cancel",
  visit_details: "asking about their visit",
  book: "wants to book",
  stop: "asked us to stop",
  other: "general message",
};

const ACTION_LABEL: Record<CustomerReplyKind, string> = {
  manage: "Sent them the Reschedule / Cancel buttons",
  visit_details: "Sent them their visit time with the Reschedule / Cancel buttons",
  already_booked: "Told them they already have a visit, with the Reschedule / Cancel buttons",
  ask_details: "No visit under this email, so we asked for their postcode and mobile",
  no_visit_found: "No upcoming visit for their details, so we sent the booking link",
  book: "Sent them the booking link",
  opted_out: "Stopped the booking reminder texts/emails and confirmed. Please also remove them from any email campaign list",
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


function smartRepliesFor(email: string): boolean {
  if (env.smartReplies === "all") return true;
  return env.smartReplies.split(",").map((s) => s.trim()).filter(Boolean).includes(email);
}

const VISIT_COLUMNS = "id,date,start_time,client_name,address";

async function findVisitByEmail(email: string): Promise<AppointmentRow | null> {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select(VISIT_COLUMNS)
    .eq("status", "confirmed")
    .gte("date", todayIsoDate())
    .ilike("client_email", exactIlike(email))
    .order("date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(1);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("inbound_email_lookup_failed", error);
  }
  return (data?.[0] || null) as AppointmentRow | null;
}

// Both must match: the mobile on the booking and the postcode in its address.
async function findVisitByPostcodeAndPhone(postcode: string, phone: string): Promise<AppointmentRow | null> {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select(VISIT_COLUMNS)
    .eq("status", "confirmed")
    .gte("date", todayIsoDate())
    .in("client_phone", phoneCandidates(phone))
    .order("date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(10);
  if (error) {
    // eslint-disable-next-line no-console
    console.error("inbound_email_details_lookup_failed", error);
  }
  const want = postcode.replace(/\s+/g, "").toUpperCase();
  const rows = (data || []) as AppointmentRow[];
  return rows.find((row) => (row.address || "").replace(/\s+/g, "").toUpperCase().includes(want)) || null;
}

// Their funnel record, if they started one: first name and a link back to where they left off.
async function findLead(email: string): Promise<{ firstName: string; bookUrl: string }> {
  const { data } = await supabaseAdmin
    .from("abandoned_followups")
    .select("lead_session_id,client_name")
    .ilike("client_email", exactIlike(email))
    .order("updated_at", { ascending: false })
    .limit(1);
  const row = (data?.[0] || null) as { lead_session_id?: string; client_name?: string } | null;
  return {
    firstName: (row?.client_name || "").trim().split(/\s+/)[0] || "",
    bookUrl: row?.lead_session_id ? buildResumeLink(row.lead_session_id) : env.funnelBaseUrl,
  };
}

async function optOut(email: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("abandoned_followups")
    .update({ suppressed_reason: "opted_out", updated_at: new Date().toISOString() })
    .ilike("client_email", exactIlike(email));
  if (error) throw error;
}

async function askedForDetailsRecently(email: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("message_rate_limits")
    .select("updated_at")
    .eq("key", `askdetails:${email}`)
    .maybeSingle();
  const at = (data as { updated_at: string } | null)?.updated_at;
  return Boolean(at && Date.now() - Date.parse(at) < ASK_DETAILS_COOLDOWN_MS);
}

async function markAskedForDetails(email: string): Promise<void> {
  await supabaseAdmin
    .from("message_rate_limits")
    .upsert({ key: `askdetails:${email}`, count: 1, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

// Which automatic reply fits, if any. Returns null for "no reply" with the reason.
async function chooseReply(
  intent: ReplyIntent,
  from: string,
  message: string,
): Promise<{ kind: CustomerReplyKind | null; reason: string; visit: AppointmentRow | null; matchedBy: string }> {
  const postcode = extractPostcode(message);
  const phone = extractPhone(message);
  const gaveDetails = Boolean(postcode && phone);

  let visit = await findVisitByEmail(from);
  let matchedBy = visit ? "email" : "";
  if (!visit && gaveDetails) {
    visit = await findVisitByPostcodeAndPhone(postcode, phone);
    if (visit) matchedBy = "postcode and mobile";
  }

  // Someone with a visit booked who says "not interested" most likely wants to cancel it.
  if (intent === "stop" && !visit) return { kind: "opted_out", reason: "", visit, matchedBy };

  if (visit) {
    if (intent === "reschedule" || intent === "cancel" || intent === "stop") return { kind: "manage", reason: "", visit, matchedBy };
    if (intent === "visit_details") return { kind: "visit_details", reason: "", visit, matchedBy };
    if (intent === "book") return { kind: "already_booked", reason: "", visit, matchedBy };
    // A message that's just their postcode + mobile, answering our question.
    if (matchedBy === "postcode and mobile" && (await askedForDetailsRecently(from))) {
      return { kind: "visit_details", reason: "", visit, matchedBy };
    }
    return { kind: null, reason: "general message", visit, matchedBy };
  }

  if (intent === "book") return { kind: "book", reason: "", visit, matchedBy };

  const aboutAVisit = intent === "reschedule" || intent === "cancel" || intent === "visit_details";
  const asked = await askedForDetailsRecently(from);
  if (gaveDetails && (aboutAVisit || asked)) return { kind: "no_visit_found", reason: "", visit, matchedBy };
  if (aboutAVisit && !asked) return { kind: "ask_details", reason: "", visit, matchedBy };
  if (aboutAVisit) return { kind: null, reason: "no visit found and we already asked for their details this week", visit, matchedBy };
  return { kind: null, reason: "general message", visit, matchedBy };
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
  const smart = !automated && smartRepliesFor(from);

  const classified = automated
    ? { intent: "other" as ReplyIntent, source: "keywords" as const }
    : await classifyReply(customerMessage);
  // Until smart replies are on for this sender, only move/cancel requests get an answer.
  const intent: ReplyIntent = smart || classified.intent === "reschedule" || classified.intent === "cancel"
    ? classified.intent
    : "other";
  const { source } = classified;

  let appointment: AppointmentRow | null = null;
  let matchedBy = "";
  let action = automated ? "No automatic reply (automated email)" : "No automatic reply (general message)";

  if (!automated) {
    const choice = smart
      ? await chooseReply(intent, from, customerMessage)
      : await (async () => {
          if (intent !== "reschedule" && intent !== "cancel") {
            return { kind: null, reason: "general message", visit: null, matchedBy: "" };
          }
          const visit = await findVisitByEmail(from);
          return visit
            ? { kind: "manage" as const, reason: "", visit, matchedBy: "email" }
            : { kind: null, reason: "no upcoming visit found for this email address", visit: null, matchedBy: "" };
        })();
    appointment = choice.visit;
    matchedBy = choice.matchedBy;

    const visitKind = choice.kind === "manage" || choice.kind === "visit_details" || choice.kind === "already_booked";
    if (!choice.kind) {
      action = `No automatic reply (${choice.reason})`;
    } else if ((await countAndBump(`autoreply:addr:${from}:${todayIsoDate()}`)) >= MAX_AUTO_REPLIES_PER_SENDER_PER_DAY) {
      action = "No automatic reply (this address has already had 3 today)";
    } else if (visitKind && appointment && (await countAndBump(`autoreply:${appointment.id}`)) >= MAX_AUTO_REPLIES_PER_VISIT) {
      action = "No automatic reply (this visit has already had 3)";
    } else {
      try {
        if (choice.kind === "opted_out") await optOut(from);
        const lead = visitKind ? null : await findLead(from);
        const sent = await sendCustomerReply({
          kind: choice.kind,
          to: from,
          firstName: appointment
            ? (appointment.client_name || "").trim().split(/\s+/)[0] || ""
            : lead?.firstName || "",
          subject,
          inReplyTo: received.message_id,
          appointmentId: appointment?.id,
          when: appointment ? visitWhen(appointment.date, appointment.start_time) : undefined,
          bookUrl: lead?.bookUrl,
        });
        if (sent && choice.kind === "ask_details") await markAskedForDetails(from);
        action = sent
          ? ACTION_LABEL[choice.kind]
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
    const visitLine = appointment
      ? `Visit: ${visitWhen(appointment.date, appointment.start_time)}${matchedBy ? ` (found by ${matchedBy})` : ""}\n`
      : "";
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
