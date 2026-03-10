import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { leadProgressSchema } from "@/lib/validators";
import { supabaseAdmin } from "@/lib/supabase";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = leadProgressSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError("Invalid request payload", request, 422, parsed.error.flatten());
    }

    const payload = parsed.data;
    const now = new Date().toISOString();

    const { error } = await supabaseAdmin
      .from("abandoned_followups")
      .upsert(
        {
          lead_session_id: payload.lead_session_id,
          client_name: payload.name,
          client_phone: payload.phone,
          client_email: payload.email,
          postcode: payload.postcode,
          current_step: payload.current_step,
          is_disqualified: payload.disqualified ?? payload.wall_type === "tiling",
          suppressed_reason: null,
          last_activity_at: now,
          updated_at: now,
        },
        { onConflict: "lead_session_id" },
      );

    if (error) return jsonError(error.message, request, 500);
    return jsonOk({ success: true }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
