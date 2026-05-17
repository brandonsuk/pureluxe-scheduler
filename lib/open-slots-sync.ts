import { addDays, format, subDays } from "date-fns";
import { env } from "@/lib/env";
import { listCalendarEvents } from "@/lib/google-calendar";
import { supabaseAdmin } from "@/lib/supabase";

type SyncResult = {
  window_start: string;
  window_end: string;
  scanned: number;
  matched_open_slots: number;
  imported: number;
  skipped: number;
  blockers_synced: number;
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
    maxResults: 2500,
  });

  const startDate = format(windowStart, "yyyy-MM-dd");
  const endDate = format(windowEnd, "yyyy-MM-dd");

  const openSlotRows: Array<{
    date: string;
    start_time: string;
    end_time: string;
    is_available: boolean;
    source: "google_open_slots";
    google_event_id: string;
  }> = [];

  const blockerRows: Array<{
    google_event_id: string;
    summary: string;
    address: string;
    lat: number;
    lng: number;
    date: string;
    start_time: string;
    end_time: string;
  }> = [];

  let skipped = 0;
  let matchedOpenSlots = 0;

  for (const event of events) {
    if (event.status === "cancelled") continue;

    const isOpenSlot = /open slots?/i.test(event.summary || "");

    if (isOpenSlot) {
      matchedOpenSlots += 1;
      const start = formatInTimezone(event.startDateTime, env.googleCalendarTimezone);
      const end = formatInTimezone(event.endDateTime, env.googleCalendarTimezone);
      if (!start || !end || start.date !== end.date || toMinuteOfDay(end.time) <= toMinuteOfDay(start.time)) {
        skipped += 1;
        continue;
      }
      openSlotRows.push({
        date: start.date,
        start_time: start.time,
        end_time: end.time,
        is_available: true,
        source: "google_open_slots",
        google_event_id: event.id,
      });
    } else if (event.startDateTime && event.endDateTime) {
      // Timed non-open-slot event — treat as a blocker so manual appointments
      // prevent the self-booking system from offering overlapping slots.
      const start = formatInTimezone(event.startDateTime, env.googleCalendarTimezone);
      const end = formatInTimezone(event.endDateTime, env.googleCalendarTimezone);
      if (!start || !end) continue;

      // May span multiple days — add a blocker row for each affected date
      let d = start.date;
      while (d <= end.date) {
        const dayStart = d === start.date ? start.time : "00:00";
        const dayEnd = d === end.date ? end.time : "23:59";
        if (dayStart < dayEnd) {
          blockerRows.push({
            google_event_id: event.id,
            summary: event.summary || "",
            address: event.location || "",
            // Use home base coords as fallback — ensures drive-time calcs don't
            // crash on null, and overlap rejection works regardless of lat/lng.
            lat: env.homeBaseLat,
            lng: env.homeBaseLng,
            date: d,
            start_time: dayStart,
            end_time: dayEnd,
          });
        }
        d = format(addDays(new Date(d), 1), "yyyy-MM-dd");
      }
    }
    // All-day non-open-slot events are ignored — they typically represent
    // holidays or reminders, not specific timed commitments.
  }

  // --- Update working_hour_windows ---
  const { error: deleteError } = await supabaseAdmin
    .from("working_hour_windows")
    .delete()
    .eq("source", "google_open_slots")
    .gte("date", startDate)
    .lte("date", endDate);
  if (deleteError) throw new Error(deleteError.message);

  if (openSlotRows.length) {
    const { error: upsertError } = await supabaseAdmin
      .from("working_hour_windows")
      .upsert(openSlotRows, { onConflict: "date,start_time,end_time,source" });
    if (upsertError) throw new Error(upsertError.message);
  }

  // --- Update calendar_blockers ---
  const { error: blockerDeleteError } = await supabaseAdmin
    .from("calendar_blockers")
    .delete()
    .gte("date", startDate)
    .lte("date", endDate);
  if (blockerDeleteError) throw new Error(blockerDeleteError.message);

  if (blockerRows.length) {
    const { error: blockerInsertError } = await supabaseAdmin
      .from("calendar_blockers")
      .insert(blockerRows);
    if (blockerInsertError) throw new Error(blockerInsertError.message);
  }

  return {
    window_start: startDate,
    window_end: endDate,
    scanned: events.length,
    matched_open_slots: matchedOpenSlots,
    imported: openSlotRows.length,
    skipped,
    blockers_synced: blockerRows.length,
  };
}
