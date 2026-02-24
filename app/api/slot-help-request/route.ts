import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    // Temporary logger target; this can be replaced by webhook forwarding in Lovable.
    // eslint-disable-next-line no-console
    console.info("slot_help_request", {
      created_at: new Date().toISOString(),
      ...payload,
    });
    return jsonOk({ success: true }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
