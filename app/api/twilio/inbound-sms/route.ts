import twilio from "twilio";
import { env } from "@/lib/env";
import { cancelCalendarEvent, cancelCalendarEventByAppointmentId, createCalendarEvent } from "@/lib/google-calendar";
import { sendCancellationNotifications } from "@/lib/notifications";
import { fetchDayAppointments, validateCandidateSlot } from "@/lib/scheduler";
import { supabaseAdmin } from "@/lib/supabase";
import { addMins, todayIsoDate } from "@/lib/time";
import { markAirtableAppointmentCancelled } from "@/lib/airtable-sync";

type AppointmentRow = {
  id: string;
  date: string;
  start_time: string;
  end_time?: string;
  duration_mins?: number;
  client_name?: string;
  client_email: string;
  client_phone: string;
  address?: string;
  lat?: number;
  lng?: number;
  readiness_level?: string;
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

async function buildRescheduleLink(clientPhone: string): Promise<string> {
  const base = env.funnelBaseUrl.replace(/\/$/, "");
  try {
    const { data } = await supabaseAdmin
      .from("abandoned_followups")
      .select("lead_session_id")
      .eq("client_phone", clientPhone)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.lead_session_id) {
      return `${base}/resume?session=${encodeURIComponent(data.lead_session_id)}`;
    }
  } catch {
    // fall through to plain link
  }
  return base;
}

function commandIsCancel(body: string): boolean {
  return /\bCA\b/i.test(body);
}

function commandIsUndo(body: string): boolean {
  return body.trim().toUpperCase() === "UNDO";
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

  if (commandIsUndo(body)) {
    const numbers = phoneCandidates(from);
    const today = todayIsoDate();

    const { data: cancelledAppointments, error: cancelledLookupError } = await supabaseAdmin
      .from("appointments")
      .select("id,date,start_time,duration_mins,client_name,client_email,client_phone,address,lat,lng,readiness_level,google_event_id")
      .eq("status", "cancelled")
      .gte("date", today)
      .in("client_phone", numbers);

    if (cancelledLookupError) {
      // eslint-disable-next-line no-console
      console.error("inbound_sms_undo_lookup_failed", cancelledLookupError);
      return xmlResponse("We couldn't process that right now. Please call us.", 500);
    }

    const candidateList = ((cancelledAppointments || []) as AppointmentRow[]).sort((a, b) =>
      upcomingSortKey(a).localeCompare(upcomingSortKey(b)),
    );
    const toRestore = candidateList[0];

    if (!toRestore) {
      return xmlResponse("No recently cancelled upcoming booking found for this number.");
    }

    if (
      typeof toRestore.duration_mins !== "number"
      || typeof toRestore.lat !== "number"
      || typeof toRestore.lng !== "number"
    ) {
      return xmlResponse("We couldn't restore that booking automatically. Please call us to rebook.");
    }

    const existing = await fetchDayAppointments(toRestore.date);
    const availability = await validateCandidateSlot({
      date: toRestore.date,
      start_time: toRestore.start_time,
      duration_mins: toRestore.duration_mins,
      location: { lat: toRestore.lat, lng: toRestore.lng },
    }, existing);

    if (!availability.valid) {
      return xmlResponse("That slot is no longer available. Please reply to arrange a new time.");
    }

    const endTime = addMins(toRestore.start_time, toRestore.duration_mins);
    let googleEventId: string | null = null;
    try {
      googleEventId = await createCalendarEvent({
        appointmentId: toRestore.id,
        date: toRestore.date,
        startTime: toRestore.start_time.slice(0, 5),
        endTime,
        clientName: toRestore.client_name || "Lead",
        clientPhone: toRestore.client_phone,
        clientEmail: toRestore.client_email,
        address: toRestore.address || "",
        readinessLevel: toRestore.readiness_level || "unsure",
        durationMins: toRestore.duration_mins,
      });
    } catch (calendarError) {
      // eslint-disable-next-line no-console
      console.error("inbound_sms_undo_calendar_create_failed", calendarError);
    }

    const { error: restoreError } = await supabaseAdmin
      .from("appointments")
      .update({
        status: "confirmed",
        google_event_id: googleEventId,
      })
      .eq("id", toRestore.id);

    if (restoreError) {
      // eslint-disable-next-line no-console
      console.error("inbound_sms_undo_restore_failed", restoreError);
      return xmlResponse("We couldn't restore that booking right now. Please call us.", 500);
    }

    return xmlResponse(`Your appointment on ${toRestore.date} at ${toRestore.start_time.slice(0, 5)} is restored.`);
  }

  if (!commandIsCancel(body)) {
    return xmlResponse("Reply CA to cancel or UNDO to restore your next upcoming appointment.");
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

  // Sync cancellation back to Airtable CRM (fire-and-forget)
  markAirtableAppointmentCancelled(nextAppt.client_phone, nextAppt.client_email).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("inbound_sms_airtable_sync_failed", e);
  });

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
  }, { sendSms: false });

  // Look up lead session so we can send a personalised reschedule link
  const rescheduleLink = await buildRescheduleLink(nextAppt.client_phone);

  return xmlResponse(
    `Your appointment on ${nextAppt.date} at ${nextAppt.start_time.slice(0, 5)} has been cancelled. ` +
    `To rebook at a time that suits you: ${rescheduleLink}`,
  );
}
