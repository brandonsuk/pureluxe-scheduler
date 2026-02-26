import twilio from "twilio";
import { env } from "@/lib/env";
import { cancelCalendarEvent, cancelCalendarEventByAppointmentId } from "@/lib/google-calendar";
import { sendCancellationNotifications } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDate } from "@/lib/time";

type AppointmentRow = {
  id: string;
  date: string;
  start_time: string;
  client_email: string;
  client_phone: string;
  google_event_id: string | null;
};

function xmlResponse(message: string, status = 200): Response {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function normalizeDigits(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function phoneCandidates(rawFrom: string): string[] {
  const normalized = normalizeDigits(rawFrom);
  const out = new Set<string>([normalized]);

  const digitsOnly = normalized.replace(/^\+/, "");
  if (digitsOnly.startsWith("44")) {
    out.add(`0${digitsOnly.slice(2)}`);
  }
  if (digitsOnly.startsWith("0")) {
    out.add(`+44${digitsOnly.slice(1)}`);
  }

  return [...out].filter(Boolean);
}

function upcomingSortKey(appt: AppointmentRow): string {
  return `${appt.date} ${appt.start_time.slice(0, 5)}`;
}

function parseBody(formBody: string): Record<string, string> {
  const params = new URLSearchParams(formBody);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function commandIsCancel(body: string): boolean {
  return body.trim().toUpperCase() === "CANCEL";
}

function possibleRequestUrls(request: Request): string[] {
  const direct = request.url;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || "https";
  const path = new URL(request.url).pathname;

  const candidates = new Set<string>([direct]);
  if (host) candidates.add(`${proto}://${host}${path}`);
  return [...candidates];
}

function isValidTwilioRequest(request: Request, formBody: string): boolean {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature || !env.twilioAuthToken) return false;

  const params = parseBody(formBody);
  return possibleRequestUrls(request).some((url) => twilio.validateRequest(env.twilioAuthToken, signature, url, params));
}

export async function POST(request: Request) {
  const formBody = await request.text();

  if (!isValidTwilioRequest(request, formBody)) {
    return xmlResponse("Unauthorized request.", 401);
  }

  const payload = parseBody(formBody);
  const from = payload.From || "";
  const body = payload.Body || "";

  if (!commandIsCancel(body)) {
    return xmlResponse("Reply CANCEL to cancel your next upcoming appointment.");
  }

  const numbers = phoneCandidates(from);
  const today = todayIsoDate();

  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,client_email,client_phone,google_event_id")
    .eq("status", "confirmed")
    .gte("date", today)
    .in("client_phone", numbers);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("inbound_sms_lookup_failed", error);
    return xmlResponse("We couldn't process that right now. Please call us to cancel.", 500);
  }

  const appointmentList = ((appointments || []) as AppointmentRow[]).sort((a, b) =>
    upcomingSortKey(a).localeCompare(upcomingSortKey(b)),
  );
  const nextAppt = appointmentList[0];

  if (!nextAppt) {
    return xmlResponse("No upcoming booking found for this number.");
  }

  const { error: cancelError } = await supabaseAdmin
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", nextAppt.id);

  if (cancelError) {
    // eslint-disable-next-line no-console
    console.error("inbound_sms_cancel_failed", cancelError);
    return xmlResponse("We couldn't cancel that booking right now. Please call us.", 500);
  }

  try {
    if (nextAppt.google_event_id) {
      await cancelCalendarEvent(nextAppt.google_event_id);
    } else {
      await cancelCalendarEventByAppointmentId(nextAppt.id);
    }
  } catch (calendarError) {
    // eslint-disable-next-line no-console
    console.error("inbound_sms_calendar_cancel_failed", calendarError);
  }

  await sendCancellationNotifications({
    clientEmail: nextAppt.client_email,
    clientPhone: nextAppt.client_phone,
    date: nextAppt.date,
    startTime: nextAppt.start_time,
  });

  return xmlResponse(`Your appointment on ${nextAppt.date} at ${nextAppt.start_time.slice(0, 5)} has been cancelled.`);
}
