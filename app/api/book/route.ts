import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { bookSchema } from "@/lib/validators";
import { addMins } from "@/lib/time";
import { fetchDayAppointments, validateCandidateSlot } from "@/lib/scheduler";
import { supabaseAdmin } from "@/lib/supabase";
import { sendBookingNotifications } from "@/lib/notifications";
import { createCalendarEvent, cancelCalendarEvent } from "@/lib/google-calendar";
import { markAirtableAppointmentBooked } from "@/lib/airtable-sync";

export const OPTIONS = corsOptions;

function normalizeBookPayload(input: Record<string, unknown>) {
  const dateRaw = input.date ?? input.bookingDate;
  const timeRaw = input.start_time ?? input.startTime;
  const readinessRaw = input.readiness_level ?? input.readinessLevel ?? input.readiness ?? input.booking_readiness;
  const fullRenovationRaw = input.full_renovation ?? input.fullRenovation;

  const date = typeof dateRaw === "string" ? dateRaw.slice(0, 10) : dateRaw;
  const start_time = typeof timeRaw === "string" ? timeRaw.slice(0, 5) : timeRaw;

  return {
    date,
    start_time,
    duration_mins: input.duration_mins ?? input.durationMins,
    client_name: input.client_name ?? input.clientName ?? input.name,
    client_phone: input.client_phone ?? input.clientPhone ?? input.phone,
    client_email: input.client_email ?? input.clientEmail ?? input.email,
    address: input.address,
    lat: input.lat,
    lng: input.lng,
    readiness_level: readinessRaw,
    readiness_display: typeof readinessRaw === "string" ? readinessRaw : undefined,
    renovation_type:
      input.renovation_type
      ?? input.renovationType
      ?? (typeof fullRenovationRaw === "string"
        ? fullRenovationRaw
        : undefined)
      ?? (typeof fullRenovationRaw === "boolean"
        ? (fullRenovationRaw ? "full renovation" : "partial renovation")
        : undefined),
    wall_type: input.wall_type ?? input.wallType,
    budget: input.budget,
    override_max_drive:
      typeof input.override_max_drive === "boolean" ? input.override_max_drive : undefined,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const normalized = normalizeBookPayload((body || {}) as Record<string, unknown>);
    const parsed = bookSchema.safeParse(normalized);
    if (!parsed.success) {
      return jsonError("Invalid request payload", request, 422, parsed.error.flatten());
    }

    const payload = parsed.data;
    const existing = await fetchDayAppointments(payload.date);
    const check = await validateCandidateSlot(
      {
        date: payload.date,
        start_time: payload.start_time,
        duration_mins: payload.duration_mins,
        location: { lat: payload.lat, lng: payload.lng },
        overrideMaxDrive: payload.override_max_drive,
      },
      existing,
    );

    if (!check.valid) return jsonError(`Slot no longer available: ${check.reason}`, request, 409);

    // Cancel any existing upcoming confirmed booking for this lead before creating a new one.
    // We only look at future dates so past appointments don't prevent a lead from re-booking.
    const today = new Date().toISOString().slice(0, 10);
    const { data: existingBookings } = await supabaseAdmin
      .from("appointments")
      .select("id, google_event_id, thomas_event_id")
      .eq("status", "confirmed")
      .gte("date", today)
      .or(`client_phone.eq.${payload.client_phone},client_email.eq.${payload.client_email}`);

    if (existingBookings && existingBookings.length > 0) {
      const ids = existingBookings.map((b: { id: string }) => b.id);
      await supabaseAdmin.from("appointments").update({ status: "cancelled" }).in("id", ids);
      for (const booking of existingBookings as { id: string; google_event_id?: string | null; thomas_event_id?: string | null }[]) {
        if (booking.google_event_id) {
          await cancelCalendarEvent(booking.google_event_id).catch((e) => {
            console.error("book_cancel_old_gcal_failed", e);
          });
        }
        if (booking.thomas_event_id && env.googleOpenSlotsCalendarId) {
          await cancelCalendarEvent(booking.thomas_event_id, env.googleOpenSlotsCalendarId).catch((e) => {
            console.error("book_cancel_old_thomas_cal_failed", e);
          });
        }
      }
    }

    const endTime = addMins(payload.start_time, payload.duration_mins);
    const { data, error } = await supabaseAdmin
      .from("appointments")
      .insert({
        date: payload.date,
        start_time: payload.start_time,
        end_time: endTime,
        duration_mins: payload.duration_mins,
        client_name: payload.client_name,
        client_phone: payload.client_phone,
        client_email: payload.client_email,
        address: payload.address,
        lat: payload.lat,
        lng: payload.lng,
        readiness_level: payload.readiness_level,
        status: "confirmed",
      })
      .select("*")
      .single();

    if (error || !data) return jsonError(error?.message || "Failed to create appointment", request, 500);

    // Sync booking back to Airtable CRM (fire-and-forget)
    markAirtableAppointmentBooked(
      payload.client_phone,
      payload.client_email,
      payload.date,
      payload.start_time,
    ).catch((e) => {
      console.error("book_airtable_sync_failed", e);
    });

    let googleEventId: string | null = null;
    let thomasEventId: string | null = null;
    const calendarInput = {
      appointmentId: data.id,
      date: payload.date,
      startTime: payload.start_time,
      endTime,
      clientName: payload.client_name,
      clientPhone: payload.client_phone,
      clientEmail: payload.client_email,
      address: payload.address,
      readinessLevel: payload.readiness_display || payload.readiness_level,
      durationMins: payload.duration_mins,
      renovationType: payload.renovation_type,
      wallType: payload.wall_type,
      budget: payload.budget,
    };

    try {
      googleEventId = await createCalendarEvent(calendarInput);
    } catch (calendarError) {
      // eslint-disable-next-line no-console
      console.error("google_calendar_create_failed", calendarError);
    }

    if (env.googleOpenSlotsCalendarId) {
      try {
        thomasEventId = await createCalendarEvent(calendarInput, env.googleOpenSlotsCalendarId);
      } catch (calendarError) {
        // eslint-disable-next-line no-console
        console.error("thomas_calendar_create_failed", calendarError);
      }
    }

    if (googleEventId || thomasEventId) {
      await supabaseAdmin
        .from("appointments")
        .update({
          ...(googleEventId ? { google_event_id: googleEventId } : {}),
          ...(thomasEventId ? { thomas_event_id: thomasEventId } : {}),
        })
        .eq("id", data.id);
    }

    await sendBookingNotifications({
      clientName: payload.client_name,
      clientEmail: payload.client_email,
      clientPhone: payload.client_phone,
      date: payload.date,
      startTime: payload.start_time,
      durationMins: payload.duration_mins,
      address: payload.address,
      readinessLevel: payload.readiness_level,
    });

    return jsonOk(
      {
        booking: data,
        confirmation: {
          appointment_id: data.id,
          date: data.date,
          time: data.start_time,
        },
        google_calendar_synced: Boolean(googleEventId),
        thomas_calendar_synced: Boolean(thomasEventId),
      },
      request,
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
