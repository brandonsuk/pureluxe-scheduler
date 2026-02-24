import { addDays, format } from "date-fns";
import { env } from "@/lib/env";
import { getDriveMinutes } from "@/lib/distance";
import { supabaseAdmin } from "@/lib/supabase";
import { addMins, combineDateTime, minutesBetween, todayIsoDate } from "@/lib/time";
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

  for (let cursor = windowStart; cursor < windowEnd; cursor = new Date(cursor.getTime() + 30 * 60 * 1000)) {
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

function pairDriveEstimate(appts: AppointmentWithLoc[], candidate?: SlotInput): Array<[Location, Location]> {
  const withCandidate = [...appts];
  if (candidate) {
    withCandidate.push({
      id: "candidate",
      date: candidate.date,
      start_time: candidate.start_time,
      end_time: addMins(candidate.start_time, candidate.duration_mins),
      lat: candidate.location.lat,
      lng: candidate.location.lng,
    });
  }

  withCandidate.sort((a, b) => a.start_time.localeCompare(b.start_time));

  const points: Location[] = [homeBase, ...withCandidate.map((a) => ({ lat: a.lat, lng: a.lng })), homeBase];
  const pairs: Array<[Location, Location]> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    pairs.push([points[i], points[i + 1]]);
  }
  return pairs;
}

async function estimateTotalDriveMins(appts: AppointmentWithLoc[], candidate?: SlotInput): Promise<number> {
  const pairs = pairDriveEstimate(appts, candidate);
  const mins = await Promise.all(pairs.map(([a, b]) => getDriveMinutes(a, b)));
  return mins.reduce((sum, n) => sum + n, 0);
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

  const availableFromPrev = minutesBetween(prevEnd, start) - env.bufferMins;
  const availableToNext = minutesBetween(end, nextStart) - env.bufferMins;

  if (prevDrive > availableFromPrev || nextDrive > availableToNext) {
    return { valid: false, reason: "drive_window" };
  }

  const apptsWithCandidate = [
    ...existing,
    {
      id: "candidate",
      date: input.date,
      start_time: input.start_time,
      end_time: addMins(input.start_time, input.duration_mins),
      lat: input.location.lat,
      lng: input.location.lng,
    },
  ].sort((a, b) => a.start_time.localeCompare(b.start_time));

  for (let i = 0; i < apptsWithCandidate.length - 1; i += 1) {
    const a = apptsWithCandidate[i];
    const b = apptsWithCandidate[i + 1];
    const gap = minutesBetween(combineDateTime(a.date, a.end_time), combineDateTime(b.date, b.start_time)) - env.bufferMins;
    const drive = await getDriveMinutes({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    if (drive > gap) {
      return { valid: false, reason: "strand" };
    }
  }

  const [beforeScore, afterScore] = await Promise.all([
    estimateTotalDriveMins(existing),
    estimateTotalDriveMins(existing, input),
  ]);

  return { valid: true, score: afterScore - beforeScore };
}

export async function findBestSlots(
  location: Location,
  durationMins: number,
  fromDate?: string,
): Promise<{ featured_slots: CandidateSlot[]; all_slots: Record<string, CandidateSlot[]> }> {
  const days = await fetchWorkingDays(fromDate, 7);
  const allValid: CandidateSlot[] = [];

  for (const day of days) {
    const existing = await fetchDayAppointments(day.date);
    const candidates = generateCandidateSlots(day, durationMins);

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

      if (result.valid && typeof result.score === "number") {
        allValid.push({ ...candidate, score: result.score });
      }
    }
  }

  const scored = allValid.sort((a, b) => a.score - b.score);
  const featuredSlots = scored.slice(0, 5);

  const grouped = allValid
    .sort((a, b) => (a.date === b.date ? a.start_time.localeCompare(b.start_time) : a.date.localeCompare(b.date)))
    .reduce<Record<string, CandidateSlot[]>>((acc, slot) => {
      if (!acc[slot.date]) acc[slot.date] = [];
      acc[slot.date].push(slot);
      return acc;
    }, {});

  return {
    featured_slots: featuredSlots,
    all_slots: grouped,
  };
}
