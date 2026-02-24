import { addDays, format, parseISO } from "date-fns";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { workingHoursSchema } from "@/lib/validators";
import { supabaseAdmin } from "@/lib/supabase";

function dateRange(startDate: string, endDate: string): string[] {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  const out: string[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    out.push(format(current, "yyyy-MM-dd"));
  }
  return out;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = workingHoursSchema.safeParse(body);
    if (!parsed.success) return jsonError("Invalid request payload", 422);
    if (parsed.data.admin_password !== env.adminPassword) return jsonError("Unauthorized", 401);

    const dates = dateRange(parsed.data.start_date, parsed.data.end_date || parsed.data.start_date);

    const rows = dates.map((date) => ({
      date,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
      is_available: parsed.data.is_available,
    }));

    const { error } = await supabaseAdmin.from("working_hours").upsert(rows, { onConflict: "date" });
    if (error) return jsonError(error.message, 500);

    return jsonOk({ success: true, updated: rows.length });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", 500);
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const password = searchParams.get("password");
  const fromDate = searchParams.get("from_date");

  if (!password || password !== env.adminPassword) return jsonError("Unauthorized", 401);

  const from = fromDate || format(new Date(), "yyyy-MM-dd");
  const to = format(addDays(new Date(from), 7), "yyyy-MM-dd");

  const { data, error } = await supabaseAdmin
    .from("working_hours")
    .select("*")
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });

  if (error) return jsonError(error.message, 500);
  return jsonOk({ hours: data || [] });
}
