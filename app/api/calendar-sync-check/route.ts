import { format } from "date-fns";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase";
import { getCalendarEventSnapshot } from "@/lib/google-calendar";

function formatInTimezone(iso: string | null, timeZone: string): { date: string; time: string } | null {
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    time: `${lookup.hour}:${lookup.minute}`,
  };
}

function normalizeDbTime(value: string): string {
  return value.slice(0, 5);
}

function isAuthorized(request: Request): boolean {
  if (!env.cronSecret) return false;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${env.cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return jsonError("Unauthorized", request, 401);

  const today = format(new Date(), "yyyy-MM-dd");
  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,end_time,google_event_id")
    .eq("status", "confirmed")
    .gte("date", today)
    .limit(250);

  if (error) return jsonError(error.message, request, 500);

  let checked = 0;
  let outOfSync = 0;
  let missing = 0;

  for (const appt of appointments || []) {
    checked += 1;

    if (!appt.google_event_id) {
      missing += 1;
      await supabaseAdmin
        .from("appointments")
        .update({
          calendar_sync_state: "missing",
          calendar_last_status: "missing",
          calendar_last_checked_at: new Date().toISOString(),
        })
        .eq("id", appt.id);
      continue;
    }

    const snapshot = await getCalendarEventSnapshot(appt.google_event_id);
    if (!snapshot.exists) {
      missing += 1;
      await supabaseAdmin
        .from("appointments")
        .update({
          calendar_sync_state: "missing",
          calendar_last_status: "missing",
          calendar_last_checked_at: new Date().toISOString(),
        })
        .eq("id", appt.id);
      continue;
    }

    const start = formatInTimezone(snapshot.startDateTime, env.googleCalendarTimezone);
    const end = formatInTimezone(snapshot.endDateTime, env.googleCalendarTimezone);

    const matchesTime =
      Boolean(start && end) &&
      start!.date === appt.date &&
      start!.time === normalizeDbTime(appt.start_time) &&
      end!.time === normalizeDbTime(appt.end_time);

    const state = snapshot.status === "cancelled" || !matchesTime ? "out_of_sync" : "in_sync";
    if (state === "out_of_sync") outOfSync += 1;

    await supabaseAdmin
      .from("appointments")
      .update({
        calendar_sync_state: state,
        calendar_last_status: snapshot.status,
        calendar_last_start: snapshot.startDateTime,
        calendar_last_end: snapshot.endDateTime,
        calendar_last_checked_at: new Date().toISOString(),
      })
      .eq("id", appt.id);
  }

  return jsonOk({ checked, out_of_sync: outOfSync, missing }, request);
}
