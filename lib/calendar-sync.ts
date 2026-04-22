import { format } from "date-fns";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { cancelCalendarEvent, getCalendarEventSnapshot, updateCalendarEventTime } from "@/lib/google-calendar";

const MAX_SYNC_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours — guardrail to skip personal/job events

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

export async function runCalendarSyncCheck(limit = 250): Promise<{ checked: number; out_of_sync: number; missing: number }> {
  const today = format(new Date(), "yyyy-MM-dd");
  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,end_time,google_event_id,thomas_event_id")
    .eq("status", "confirmed")
    .gte("date", today)
    .limit(limit);

  if (error) throw new Error(error.message);

  let checked = 0;
  let outOfSync = 0;
  let missing = 0;

  for (const appt of appointments || []) {
    checked += 1;

    // --- Check Thomas's PureLuxe calendar first (authoritative for time edits) ---
    // Guardrails: event must have a location and be <4 hours so personal/job events are ignored.
    if (appt.thomas_event_id && env.googleOpenSlotsCalendarId) {
      const thomasSnapshot = await getCalendarEventSnapshot(appt.thomas_event_id, env.googleOpenSlotsCalendarId);

      if (thomasSnapshot.exists) {
        const hasLocation = Boolean(thomasSnapshot.location);
        const withinDuration =
          thomasSnapshot.durationMs === null || thomasSnapshot.durationMs === undefined
            ? true
            : thomasSnapshot.durationMs < MAX_SYNC_DURATION_MS;

        if (hasLocation && withinDuration) {
          const thomasCancelled = thomasSnapshot.status === "cancelled";
          const thomasStart = formatInTimezone(thomasSnapshot.startDateTime, env.googleCalendarTimezone);
          const thomasEnd = formatInTimezone(thomasSnapshot.endDateTime, env.googleCalendarTimezone);
          const thomasTimeChanged =
            Boolean(thomasStart && thomasEnd) &&
            (thomasStart!.date !== appt.date ||
              thomasStart!.time !== normalizeDbTime(appt.start_time) ||
              thomasEnd!.time !== normalizeDbTime(appt.end_time));

          if (thomasCancelled) {
            // Thomas deleted the event — cancel in Supabase and on the self-booking calendar
            await supabaseAdmin
              .from("appointments")
              .update({
                status: "cancelled",
                calendar_sync_state: "missing",
                calendar_last_status: "cancelled",
                calendar_last_checked_at: new Date().toISOString(),
              })
              .eq("id", appt.id);
            await cancelCalendarEvent(appt.google_event_id).catch((e) => {
              console.error("thomas_sync_cancel_gcal_failed", e);
            });
            outOfSync += 1;
            continue;
          }

          if (thomasTimeChanged && thomasStart && thomasEnd) {
            // Thomas moved the appointment — update Supabase and mirror to self-booking calendar
            await supabaseAdmin
              .from("appointments")
              .update({
                date: thomasStart.date,
                start_time: thomasStart.time,
                end_time: thomasEnd.time,
                calendar_sync_state: "in_sync",
                calendar_last_status: thomasSnapshot.status,
                calendar_last_start: thomasSnapshot.startDateTime,
                calendar_last_end: thomasSnapshot.endDateTime,
                calendar_last_checked_at: new Date().toISOString(),
              })
              .eq("id", appt.id);
            if (appt.google_event_id) {
              await updateCalendarEventTime(
                env.googleCalendarId,
                appt.google_event_id,
                thomasStart.date,
                thomasStart.time,
                thomasEnd.time,
              ).catch((e) => {
                console.error("thomas_sync_update_gcal_failed", e);
              });
            }
            outOfSync += 1;
            continue;
          }
        }
      }
    }

    // --- Check self-booking calendar (google_event_id) ---
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

    const isCancelled = snapshot.status === "cancelled";
    const state = isCancelled || !matchesTime ? "out_of_sync" : "in_sync";
    if (state === "out_of_sync") outOfSync += 1;

    // If the time moved in the self-booking calendar, update Supabase to match.
    // Also mirror the change to Thomas's calendar so both stay in sync.
    const timeUpdate =
      !isCancelled && !matchesTime && start && end
        ? { date: start.date, start_time: start.time, end_time: end.time }
        : {};

    if (!isCancelled && !matchesTime && start && end && appt.thomas_event_id && env.googleOpenSlotsCalendarId) {
      await updateCalendarEventTime(
        env.googleOpenSlotsCalendarId,
        appt.thomas_event_id,
        start.date,
        start.time,
        end.time,
      ).catch((e) => {
        console.error("gcal_sync_update_thomas_cal_failed", e);
      });
    }

    await supabaseAdmin
      .from("appointments")
      .update({
        ...timeUpdate,
        calendar_sync_state: state,
        calendar_last_status: snapshot.status,
        calendar_last_start: snapshot.startDateTime,
        calendar_last_end: snapshot.endDateTime,
        calendar_last_checked_at: new Date().toISOString(),
      })
      .eq("id", appt.id);
  }

  return { checked, out_of_sync: outOfSync, missing };
}
