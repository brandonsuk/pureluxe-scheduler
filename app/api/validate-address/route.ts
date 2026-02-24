import { jsonError, jsonOk } from "@/lib/http";
import { geocodeAddress, isWithinServiceArea } from "@/lib/address";
import { validateAddressSchema } from "@/lib/validators";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = validateAddressSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", 422);

    const geo = await geocodeAddress(parsed.data.address);
    const valid = await isWithinServiceArea(geo.lat, geo.lng);

    return jsonOk({
      valid,
      lat: geo.lat,
      lng: geo.lng,
      message: valid ? "Address is within service area" : "Sorry, PureLuxe doesn't currently cover your area",
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", 500);
  }
}
