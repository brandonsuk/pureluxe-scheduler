import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { bookSchema } from "@/lib/validators";
import { addMins } from "@/lib/time";
import { fetchDayAppointments, validateCandidateSlot } from "@/lib/scheduler";
import { supabaseAdmin } from "@/lib/supabase";
import { sendBookingNotifications } from "@/lib/notifications";
import { createCalendarEvent } from "@/lib/google-calendar";
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
      },
      existing,
    );

    if (!check.valid) return jsonError(`Slot no longer available: ${check.reason}`, request, 409);

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
    try {
      googleEventId = await createCalendarEvent({
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
      });

      if (googleEventId) {
        await supabaseAdmin.from("appointments").update({ google_event_id: googleEventId }).eq("id", data.id);
      }
    } catch (calendarError) {
      // eslint-disable-next-line no-console
      console.error("google_calendar_create_failed", calendarError);
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
      },
      request,
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
