import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { findAvailableDates } from "@/lib/scheduler";
import { availableDatesSchema } from "@/lib/validators";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = availableDatesSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", request, 422, parsed.error.flatten());

    const availableDates = await findAvailableDates(
      { lat: parsed.data.lat, lng: parsed.data.lng },
      parsed.data.duration_mins,
      parsed.data.preferred_window,
      parsed.data.from_date,
      parsed.data.days_ahead || 14,
    );

    return jsonOk({ available_dates: availableDates }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
