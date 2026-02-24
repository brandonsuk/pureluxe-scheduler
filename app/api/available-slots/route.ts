import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { availableSlotsSchema } from "@/lib/validators";
import { findBestSlots } from "@/lib/scheduler";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = availableSlotsSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", request, 422);

    const slotResults = await findBestSlots(
      { lat: parsed.data.lat, lng: parsed.data.lng },
      parsed.data.duration_mins,
      parsed.data.from_date,
    );

    return jsonOk(slotResults, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
