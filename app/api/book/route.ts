import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { bookSchema } from "@/lib/validators";
import { addMins } from "@/lib/time";
import { fetchDayAppointments, validateCandidateSlot } from "@/lib/scheduler";
import { supabaseAdmin } from "@/lib/supabase";
import { sendBookingNotifications } from "@/lib/notifications";

export const OPTIONS = corsOptions;

function normalizeBookPayload(input: Record<string, unknown>) {
  const dateRaw = input.date ?? input.bookingDate;
  const timeRaw = input.start_time ?? input.startTime;

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
    readiness_level: input.readiness_level ?? input.readinessLevel ?? input.readiness,
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
      },
      request,
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
