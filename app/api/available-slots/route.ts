import { jsonError, jsonOk } from "@/lib/http";
import { availableSlotsSchema } from "@/lib/validators";
import { findBestSlots } from "@/lib/scheduler";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = availableSlotsSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", 422);

    const slotResults = await findBestSlots(
      { lat: parsed.data.lat, lng: parsed.data.lng },
      parsed.data.duration_mins,
      parsed.data.from_date,
    );

    return jsonOk(slotResults);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", 500);
  }
}
