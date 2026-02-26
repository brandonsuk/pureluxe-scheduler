import { Resend } from "resend";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
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

type ResendEmailReceivedEvent = {
  type?: string;
  data?: {
    email_id?: string;
  };
};

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;

function extractEmail(input: string): string {
  const match = input.match(/<([^>]+)>/);
  const email = (match ? match[1] : input).trim().toLowerCase();
  return email;
}

function commandIsCancel(content: string): boolean {
  return /\bCA\b/i.test(content);
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

  const received = await resend.emails.get(event.data.email_id);
  if (!received?.data) {
    return jsonOk({ success: true, ignored: true, reason: "email_not_found" }, request);
  }

  const from = extractEmail(received.data.from || "");
  const text = (received.data.text || "").trim();
  const html = (received.data.html || "").replace(/<[^>]*>/g, " ").trim();
  const combined = `${text}\n${html}`.trim();

  if (!from || !commandIsCancel(combined)) {
    return jsonOk({ success: true, ignored: true, reason: "no_ca_command" }, request);
  }

  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,client_email,client_phone,google_event_id")
    .eq("status", "confirmed")
    .gte("date", todayIsoDate())
    .ilike("client_email", from)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(1);

  if (error) return jsonError("Appointment lookup failed", request, 500, { db_error: error.message });

  const appointment = (appointments?.[0] || null) as AppointmentRow | null;
  if (!appointment) return jsonOk({ success: true, ignored: true, reason: "no_upcoming_match" }, request);

  const { error: cancelError } = await supabaseAdmin
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointment.id);
  if (cancelError) return jsonError("Cancel failed", request, 500, { db_error: cancelError.message });

  try {
    if (appointment.google_event_id) {
      await cancelCalendarEvent(appointment.google_event_id);
    } else {
      await cancelCalendarEventByAppointmentId(appointment.id);
    }
  } catch (calendarError) {
    // eslint-disable-next-line no-console
    console.error("email_cancel_calendar_failed", calendarError);
  }

  await sendCancellationNotifications(
    {
      clientEmail: appointment.client_email,
      clientPhone: appointment.client_phone,
      date: appointment.date,
      startTime: appointment.start_time,
    },
    { sendSms: false },
  );

  return jsonOk({ success: true, cancelled: true, appointment_id: appointment.id }, request);
}
