import { after } from "next/server";
import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { geocodeAddress, isWithinServiceArea } from "@/lib/address";
import { validateAddressSchema } from "@/lib/validators";
import { warmDriveTimes } from "@/lib/warm-drive-times";

// Room for the background drive-time warm-up after the response (about 15-20 s at most).
export const maxDuration = 60;

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = validateAddressSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", request, 422);

    const geo = await geocodeAddress(parsed.data.address);
    const valid = await isWithinServiceArea(geo.lat, geo.lng);

    // Speed: once the address is in the area, look up this lead's visit-time drive times in the background,
    // so the slot screen a few steps later skips most of its lookups. The response is not delayed.
    if (valid && body?.warm !== false) {
      const location = { lat: geo.lat, lng: geo.lng };
      try {
        after(() => warmDriveTimes(location));
      } catch {
        /* outside a request: skip */
      }
    }

    return jsonOk(
      {
      valid,
      lat: geo.lat,
      lng: geo.lng,
      message: valid ? "Address is within service area" : "Sorry, PureLuxe doesn't currently cover your area",
      },
      request,
    );
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
