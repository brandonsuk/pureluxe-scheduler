import { addDays, format, subDays } from "date-fns";
import { env } from "@/lib/env";
import { listCalendarEvents } from "@/lib/google-calendar";
import { supabaseAdmin } from "@/lib/supabase";

type SyncResult = {
  window_start: string;
  window_end: string;
  imported: number;
  skipped: number;
};

type TimeParts = {
  date: string;
  time: string;
};

function formatInTimezone(iso: string | null, timeZone: string): TimeParts | null {
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

function toMinuteOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export async function runOpenSlotsSync(daysAhead = 14): Promise<SyncResult> {
  const calendarId = env.googleOpenSlotsCalendarId || env.googleCalendarId;
  if (!calendarId) {
    throw new Error("Missing GOOGLE_OPEN_SLOTS_CALENDAR_ID or GOOGLE_CALENDAR_ID");
  }

  const today = format(new Date(), "yyyy-MM-dd");
  const windowStart = subDays(new Date(today), 1);
  const windowEnd = addDays(new Date(today), Math.max(daysAhead, 1));

  const timeMinIso = windowStart.toISOString();
  const timeMaxIso = windowEnd.toISOString();

  const events = await listCalendarEvents({
    calendarId,
    timeMinIso,
    timeMaxIso,
    query: "open slots",
    maxResults: 2500,
  });

  const rows: Array<{
    date: string;
    start_time: string;
    end_time: string;
    is_available: boolean;
    source: "google_open_slots";
    google_event_id: string;
  }> = [];
  let skipped = 0;

  for (const event of events) {
    if (event.status === "cancelled") continue;
    if (!/open slots?/i.test(event.summary || "")) continue;

    const start = formatInTimezone(event.startDateTime, env.googleCalendarTimezone);
    const end = formatInTimezone(event.endDateTime, env.googleCalendarTimezone);
    if (!start || !end) {
      skipped += 1;
      continue;
    }
    if (start.date !== end.date) {
      skipped += 1;
      continue;
    }
    if (toMinuteOfDay(end.time) <= toMinuteOfDay(start.time)) {
      skipped += 1;
      continue;
    }

    rows.push({
      date: start.date,
      start_time: start.time,
      end_time: end.time,
      is_available: true,
      source: "google_open_slots",
      google_event_id: event.id,
    });
  }

  const startDate = format(windowStart, "yyyy-MM-dd");
  const endDate = format(windowEnd, "yyyy-MM-dd");

  const { error: deleteError } = await supabaseAdmin
    .from("working_hour_windows")
    .delete()
    .eq("source", "google_open_slots")
    .gte("date", startDate)
    .lte("date", endDate);
  if (deleteError) throw new Error(deleteError.message);

  if (rows.length) {
    const { error: upsertError } = await supabaseAdmin
      .from("working_hour_windows")
      .upsert(rows, { onConflict: "date,start_time,end_time,source" });
    if (upsertError) throw new Error(upsertError.message);
  }

  return {
    window_start: startDate,
    window_end: endDate,
    imported: rows.length,
    skipped,
  };
}
