import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { findPreferredSlots } from "@/lib/scheduler";
import { preferredSlotsSchema } from "@/lib/validators";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = preferredSlotsSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", request, 422, parsed.error.flatten());

    const slots = await findPreferredSlots(
      { lat: parsed.data.lat, lng: parsed.data.lng },
      parsed.data.duration_mins,
      parsed.data.preferred_date,
      parsed.data.preferred_window,
    );

    return jsonOk({ slots }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
