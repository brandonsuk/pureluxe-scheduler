import { env } from "@/lib/env";
import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { cancelSchema } from "@/lib/validators";
import { supabaseAdmin } from "@/lib/supabase";
import { sendCancellationNotifications } from "@/lib/notifications";
import { cancelCalendarEvent } from "@/lib/google-calendar";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", request, 422);

    if (parsed.data.admin_password !== env.adminPassword) {
      return jsonError("Unauthorized", request, 401);
    }

    const { data: appointment, error: fetchError } = await supabaseAdmin
      .from("appointments")
      .select("id,client_email,client_phone,date,start_time,google_event_id")
      .eq("id", parsed.data.appointment_id)
      .single();

    if (fetchError || !appointment) return jsonError("Appointment not found", request, 404);

    const { error } = await supabaseAdmin
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", parsed.data.appointment_id);

    if (error) return jsonError(error.message, request, 500);

    try {
      await cancelCalendarEvent(appointment.google_event_id);
    } catch (calendarError) {
      // eslint-disable-next-line no-console
      console.error("google_calendar_cancel_failed", calendarError);
    }

    await sendCancellationNotifications({
      clientEmail: appointment.client_email,
      clientPhone: appointment.client_phone,
      date: appointment.date,
      startTime: appointment.start_time,
    });

    return jsonOk({ success: true }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
