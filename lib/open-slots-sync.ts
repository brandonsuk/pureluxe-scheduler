import { addDays, format, subDays } from "date-fns";
import { geocodeAddress } from "@/lib/address";
import { env } from "@/lib/env";
import { listCalendarEvents } from "@/lib/google-calendar";
import { supabaseAdmin } from "@/lib/supabase";

type SyncResult = {
  window_start: string;
  window_end: string;
  scanned: number;
  matched_open_slots: number;
  matched_blocking_events: number;
  imported: number;
  imported_blockers: number;
  skipped: number;
  skipped_blockers: number;
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

  const { data: existingAppointments, error: existingAppointmentsError } = await supabaseAdmin
    .from("appointments")
    .select("google_event_id")
    .not("google_event_id", "is", null)
    .gte("date", format(windowStart, "yyyy-MM-dd"))
    .lte("date", format(windowEnd, "yyyy-MM-dd"));
  if (existingAppointmentsError) throw new Error(existingAppointmentsError.message);

  const appointmentEventIds = new Set(
    (existingAppointments || [])
      .map((row) => row.google_event_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  const rows: Array<{
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
  let skippedBlockers = 0;
  let matchedOpenSlots = 0;
  let matchedBlockingEvents = 0;
  const geocodeCache = new Map<string, { lat: number; lng: number }>();

  for (const event of events) {
    if (event.status === "cancelled") continue;

    const start = formatInTimezone(event.startDateTime, env.googleCalendarTimezone);
    const end = formatInTimezone(event.endDateTime, env.googleCalendarTimezone);
    if (!start || !end) {
      continue;
    }
    const isOpenSlot = /open slots?/i.test(event.summary || "");
    if (isOpenSlot) {
      matchedOpenSlots += 1;
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
      continue;
    }

    matchedBlockingEvents += 1;
    if (appointmentEventIds.has(event.id) || /appointment id:/i.test(event.description || "")) {
      skippedBlockers += 1;
      continue;
    }
    if (start.date !== end.date) {
      skippedBlockers += 1;
      continue;
    }
    if (toMinuteOfDay(end.time) <= toMinuteOfDay(start.time)) {
      skippedBlockers += 1;
      continue;
    }

    const location = event.location.trim();
    if (!location) {
      skippedBlockers += 1;
      continue;
    }

    let coords = geocodeCache.get(location);
    if (!coords) {
      try {
        const geo = await geocodeAddress(location);
        coords = { lat: geo.lat, lng: geo.lng };
        geocodeCache.set(location, coords);
      } catch {
        skippedBlockers += 1;
        continue;
      }
    }

    blockerRows.push({
      google_event_id: event.id,
      summary: event.summary || "Calendar blocker",
      address: location,
      lat: coords.lat,
      lng: coords.lng,
      date: start.date,
      start_time: start.time,
      end_time: end.time,
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

  const { error: deleteBlockersError } = await supabaseAdmin
    .from("calendar_blockers")
    .delete()
    .gte("date", startDate)
    .lte("date", endDate);
  if (deleteBlockersError) throw new Error(deleteBlockersError.message);

  if (rows.length) {
    const { error: upsertError } = await supabaseAdmin
      .from("working_hour_windows")
      .upsert(rows, { onConflict: "date,start_time,end_time,source" });
    if (upsertError) throw new Error(upsertError.message);
  }

  if (blockerRows.length) {
    const { error: upsertBlockersError } = await supabaseAdmin
      .from("calendar_blockers")
      .upsert(blockerRows, { onConflict: "google_event_id" });
    if (upsertBlockersError) throw new Error(upsertBlockersError.message);
  }

  return {
    window_start: startDate,
    window_end: endDate,
    scanned: events.length,
    matched_open_slots: matchedOpenSlots,
    matched_blocking_events: matchedBlockingEvents,
    imported: rows.length,
    imported_blockers: blockerRows.length,
    skipped,
    skipped_blockers: skippedBlockers,
  };
}
