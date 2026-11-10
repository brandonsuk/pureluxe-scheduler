import { env } from "@/lib/env";
import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { cancelSchema } from "@/lib/validators";
import { supabaseAdmin } from "@/lib/supabase";
import { sendCancellationNotifications } from "@/lib/notifications";
import { cancelCalendarEvent, cancelCalendarEventByAppointmentId } from "@/lib/google-calendar";

export const OPTIONS = corsOptions;

const SELECT = "id,client_name,client_email,client_phone,address,date,start_time,status,google_event_id,thomas_event_id";

type Appointment = {
  id: string;
  client_name: string;
  client_email: string;
  client_phone: string;
  address: string;
  date: string;
  start_time: string;
  status: string;
  google_event_id: string | null;
  thomas_event_id: string | null;
};

// "+44 7429 596777", "447429596777" and "07429596777" all become "07429596777".
function nationalPhone(phone: string | null | undefined): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("44")) return `0${digits.slice(2)}`;
  return digits;
}

function ukToday(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: env.googleCalendarTimezone || "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// The soonest confirmed visit from today onwards that matches the lead's phone or email.
async function findUpcomingByContact(phone?: string, email?: string): Promise<Appointment | null> {
  const wantPhone = nationalPhone(phone);
  const wantEmail = String(email || "").trim().toLowerCase();
  if (wantPhone.length < 10 && !wantEmail) return null;

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select(SELECT)
    .eq("status", "confirmed")
    .gte("date", ukToday())
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });
  if (error) throw new Error(error.message);

  return (
    ((data || []) as Appointment[]).find((a) => {
      const phoneMatch = wantPhone.length >= 10 && nationalPhone(a.client_phone) === wantPhone;
      const emailMatch = wantEmail !== "" && String(a.client_email || "").trim().toLowerCase() === wantEmail;
      return phoneMatch || emailMatch;
    }) || null
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", request, 422);

    if (parsed.data.admin_password !== env.adminPassword) {
      return jsonError("Unauthorized", request, 401);
    }

    const notify = parsed.data.notify !== false;
    let appointment: Appointment | null = null;

    if (parsed.data.appointment_id) {
      const appointmentId = parsed.data.appointment_id.trim();
      const { data, error: fetchError } = await supabaseAdmin
        .from("appointments")
        .select(SELECT)
        .eq("id", appointmentId)
        .maybeSingle();
      if (fetchError) {
        return jsonError("Failed to load appointment", request, 500, { db_error: fetchError.message, appointment_id: appointmentId });
      }
      if (!data) return jsonError("Appointment not found", request, 404, { appointment_id: appointmentId });
      appointment = data as Appointment;
    } else {
      appointment = await findUpcomingByContact(parsed.data.phone, parsed.data.email);
      if (!appointment) return jsonOk({ success: true, found: false }, request);
    }

    const { error } = await supabaseAdmin
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointment.id);

    if (error) return jsonError(error.message, request, 500);

    try {
      if (appointment.google_event_id) {
        await cancelCalendarEvent(appointment.google_event_id);
      } else {
        await cancelCalendarEventByAppointmentId(appointment.id);
      }
      if (appointment.thomas_event_id && env.googleOpenSlotsCalendarId) {
        await cancelCalendarEvent(appointment.thomas_event_id, env.googleOpenSlotsCalendarId);
      }
    } catch (calendarError) {
      // eslint-disable-next-line no-console
      console.error("google_calendar_cancel_failed", calendarError);
    }

    if (notify) {
      await sendCancellationNotifications({
        clientName: appointment.client_name,
        address: appointment.address,
        clientEmail: appointment.client_email,
        clientPhone: appointment.client_phone,
        date: appointment.date,
        startTime: appointment.start_time,
      });
    }

    return jsonOk({ success: true, found: true, appointment_id: appointment.id, notified: notify }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
