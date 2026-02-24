import { env } from "@/lib/env";
import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { todayIsoDate } from "@/lib/time";
import { supabaseAdmin } from "@/lib/supabase";

export const OPTIONS = corsOptions;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const password = searchParams.get("password");
  if (!password || password !== env.adminPassword) {
    return jsonError("Unauthorized", request, 401);
  }

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("*")
    .eq("status", "confirmed")
    .gte("date", todayIsoDate())
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) return jsonError(error.message, request, 500);
  return jsonOk({ appointments: data || [] }, request);
}
