import { after } from "next/server";
import { markAirtableLeadTilingDisqualified } from "@/lib/airtable-sync";
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
    const isDisqualified = payload.disqualified ?? payload.wall_type === "tiling";

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
          is_disqualified: isDisqualified,
          suppressed_reason: null,
          last_activity_at: now,
          updated_at: now,
        },
        { onConflict: "lead_session_id" },
      );

    if (error) return jsonError(error.message, request, 500);

    // The funnel's only disqualification is "Tiling is a must-have", which never goes
    // through Make, so mark the Airtable lead here. after() runs once the response has
    // been sent, so this can't slow or break the funnel. If Make hasn't created the
    // record yet, the abandoned-lead cron catches up.
    if (isDisqualified) {
      after(async () => {
        const updated = await markAirtableLeadTilingDisqualified(
          payload.lead_session_id,
          payload.phone,
          payload.email,
        );
        if (!updated) {
          // eslint-disable-next-line no-console
          console.warn(`lead-progress: Airtable tiling update not done for ${payload.lead_session_id} (no record yet or Airtable error); the abandoned-lead cron will retry`);
        }
      });
    }

    return jsonOk({ success: true }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
