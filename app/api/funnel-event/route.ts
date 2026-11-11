import { NextResponse } from "next/server";
import { applyCorsHeaders, corsOptions } from "@/lib/cors";
import { funnelEventSchema } from "@/lib/validators";
import { supabaseAdmin } from "@/lib/supabase";

// Append-only log of funnel page views and actions, for split-test analysis.
// Standalone on purpose: it only ever inserts into funnel_events, which nothing else
// reads. It always answers 204, so a bad payload or a database error can never show up
// in the funnel.

export const OPTIONS = corsOptions;

const noContent = (request: Request) => applyCorsHeaders(request, new NextResponse(null, { status: 204 }));

export async function POST(request: Request) {
  try {
    const parsed = funnelEventSchema.safeParse(await request.json());
    if (!parsed.success) return noContent(request);

    const p = parsed.data;
    const { error } = await supabaseAdmin.from("funnel_events").insert({
      lead_session_id: p.lead_session_id,
      event: p.event,
      path: p.path ?? null,
      variants: p.variants ?? {},
      device: p.device ?? null,
      viewport_w: p.viewport_w ?? null,
      utm_campaign: p.utm_campaign || null,
      ad_id: p.ad_id || null,
      is_test: p.is_test ?? false,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(`funnel-event: insert failed: ${error.message}`);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`funnel-event: ${error instanceof Error ? error.message : "unexpected error"}`);
  }
  return noContent(request);
}
