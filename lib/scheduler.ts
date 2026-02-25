import { addDays, format } from "date-fns";
import { env } from "@/lib/env";
import { getDriveMinutes } from "@/lib/distance";
import { supabaseAdmin } from "@/lib/supabase";
import { combineDateTime, minutesBetween, todayIsoDate } from "@/lib/time";
import type { Appointment, CandidateSlot, Location, WorkingHours } from "@/lib/types";

type AppointmentWithLoc = Pick<Appointment, "id" | "date" | "start_time" | "end_time" | "lat" | "lng">;

type SlotInput = {
  date: string;
  start_time: string;
  duration_mins: number;
  location: Location;
};

type ValidationResult = {
  valid: boolean;
  score?: number;
  reason?: string;
};

const homeBase: Location = {
  lat: env.homeBaseLat,
  lng: env.homeBaseLng,
};

export async function fetchWorkingDays(fromDate?: string, limit = 14): Promise<WorkingHours[]> {
  const start = fromDate || todayIsoDate();
  const end = format(addDays(new Date(start), 6), "yyyy-MM-dd");

  const { data, error } = await supabaseAdmin
    .from("working_hours")
    .select("id,date,start_time,end_time,is_available")
    .gte("date", start)
    .lte("date", end)
    .eq("is_available", true)
    .order("date", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []) as WorkingHours[];
}

export async function fetchDayAppointments(date: string): Promise<AppointmentWithLoc[]> {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,end_time,lat,lng")
    .eq("date", date)
    .eq("status", "confirmed")
    .order("start_time", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []) as AppointmentWithLoc[];
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function generateCandidateSlots(day: WorkingHours, durationMins: number): CandidateSlot[] {
  const slots: CandidateSlot[] = [];
  const windowStart = combineDateTime(day.date, day.start_time);
  const windowEnd = combineDateTime(day.date, day.end_time);

  for (let cursor = windowStart; cursor < windowEnd; cursor = new Date(cursor.getTime() + 15 * 60 * 1000)) {
    const end = new Date(cursor.getTime() + durationMins * 60 * 1000);
    if (end <= windowEnd) {
      slots.push({
        date: day.date,
        start_time: format(cursor, "HH:mm"),
        end_time: format(end, "HH:mm"),
        duration_mins: durationMins,
        score: Number.POSITIVE_INFINITY,
      });
    }
  }

  return slots;
}

export async function validateCandidateSlot(input: SlotInput, existing: AppointmentWithLoc[]): Promise<ValidationResult> {
  const start = combineDateTime(input.date, input.start_time);
  const end = new Date(start.getTime() + input.duration_mins * 60 * 1000);

  for (const appt of existing) {
    const apptStart = combineDateTime(appt.date, appt.start_time);
    const apptEnd = combineDateTime(appt.date, appt.end_time);
    if (overlaps(start, end, apptStart, apptEnd)) {
      return { valid: false, reason: "overlap" };
    }
  }

  const sorted = [...existing].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const prev = [...sorted]
    .reverse()
    .find((a) => combineDateTime(a.date, a.end_time) <= start);
  const next = sorted.find((a) => combineDateTime(a.date, a.start_time) >= end);

  const prevLoc = prev ? { lat: prev.lat, lng: prev.lng } : homeBase;
  const nextLoc = next ? { lat: next.lat, lng: next.lng } : homeBase;

  const prevEnd = prev ? combineDateTime(prev.date, prev.end_time) : combineDateTime(input.date, "09:00");
  const nextStart = next ? combineDateTime(next.date, next.start_time) : combineDateTime(input.date, "17:00");

  const [prevDrive, nextDrive] = await Promise.all([
    getDriveMinutes(prevLoc, input.location),
    getDriveMinutes(input.location, nextLoc),
  ]);

  const availableFromPrev = minutesBetween(prevEnd, start);
  const availableToNext = minutesBetween(end, nextStart);

  if (prevDrive > availableFromPrev || nextDrive > availableToNext) {
    return { valid: false, reason: "drive_window" };
  }

  const directPrevToNext = await getDriveMinutes(prevLoc, nextLoc);
  return { valid: true, score: prevDrive + nextDrive - directPrevToNext };
}

export async function findBestSlots(
  location: Location,
  durationMins: number,
  fromDate?: string,
): Promise<{ featured_slots: CandidateSlot[]; all_slots: Record<string, CandidateSlot[]> }> {
  const days = await fetchWorkingDays(fromDate, 7);
  const allValid: CandidateSlot[] = [];
  let checkedCandidates = 0;
  const MAX_CANDIDATES_TO_CHECK = 120;

  for (const day of days) {
    const existing = await fetchDayAppointments(day.date);
    const candidates = generateCandidateSlots(day, durationMins);

    for (const candidate of candidates) {
      checkedCandidates += 1;
      const result = await validateCandidateSlot(
        {
          date: candidate.date,
          start_time: candidate.start_time,
          duration_mins: candidate.duration_mins,
          location,
        },
        existing,
      );

      if (result.valid && typeof result.score === "number") {
        allValid.push({ ...candidate, score: result.score });
      }

      if (checkedCandidates >= MAX_CANDIDATES_TO_CHECK && allValid.length >= 5) break;
    }
    if (checkedCandidates >= MAX_CANDIDATES_TO_CHECK && allValid.length >= 5) break;
  }

  const scored = allValid.sort((a, b) => a.score - b.score);
  const featuredSlots = scored.slice(0, 5);

  return {
    featured_slots: featuredSlots,
    all_slots: {},
  };
}

type PreferredWindow = "morning" | "afternoon" | "evening";

function preferencePenaltyMins(time: string, window: PreferredWindow): number {
  const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const ranges = {
    morning: [9 * 60, 12 * 60 - 1],
    afternoon: [12 * 60, 17 * 60 - 1],
    evening: [17 * 60, 21 * 60],
  } as const;
  const [start, end] = ranges[window];
  if (mins >= start && mins <= end) return 0;
  if (mins < start) return start - mins;
  return mins - end;
}

export async function findPreferredSlots(
  location: Location,
  durationMins: number,
  preferredDate: string,
  preferredWindow: PreferredWindow,
): Promise<CandidateSlot[]> {
  const existing = await fetchDayAppointments(preferredDate);
  const day = (await fetchWorkingDays(preferredDate, 1)).find((d) => d.date === preferredDate);
  if (!day) return [];

  const candidates = generateCandidateSlots(day, durationMins);
  const scored: CandidateSlot[] = [];

  for (const candidate of candidates) {
    const result = await validateCandidateSlot(
      {
        date: candidate.date,
        start_time: candidate.start_time,
        duration_mins: candidate.duration_mins,
        location,
      },
      existing,
    );
    if (!result.valid || typeof result.score !== "number") continue;

    const penalty = preferencePenaltyMins(candidate.start_time, preferredWindow);
    scored.push({ ...candidate, score: result.score + penalty / 10 });
  }

  return scored.sort((a, b) => a.score - b.score).slice(0, 3);
}
