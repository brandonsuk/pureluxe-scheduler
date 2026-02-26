import { addDays, format } from "date-fns";
import { env } from "@/lib/env";
import { getDriveMinutes } from "@/lib/distance";
import { supabaseAdmin } from "@/lib/supabase";
import { combineDateTime, minutesBetween, todayIsoDate } from "@/lib/time";
import type { Appointment, CandidateSlot, Location, WorkingHourWindow, WorkingHours } from "@/lib/types";

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
  const end = format(addDays(new Date(start), Math.max(limit - 1, 0)), "yyyy-MM-dd");

  const { data: windows, error: windowsError } = await supabaseAdmin
    .from("working_hour_windows")
    .select("id,date,start_time,end_time,is_available,source,google_event_id")
    .gte("date", start)
    .lte("date", end)
    .eq("is_available", true)
    .eq("source", "google_open_slots")
    .order("date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(limit * 8);
  if (windowsError) {
    throw new Error(windowsError.message);
  }

  return ((windows || []) as WorkingHourWindow[]).map((windowRow) => ({
    id: windowRow.id,
    date: windowRow.date,
    start_time: windowRow.start_time,
    end_time: windowRow.end_time,
    is_available: windowRow.is_available,
  }));
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

function timeToMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

type TimeBand = "morning" | "midday" | "late_day";

function getTimeBand(time: string): TimeBand {
  const mins = timeToMinutes(time);
  if (mins < 12 * 60) return "morning";
  if (mins < 15 * 60) return "midday";
  return "late_day";
}

function isSpacedFromSelected(slot: CandidateSlot, selected: CandidateSlot[], minGapMins: number): boolean {
  const slotMins = timeToMinutes(slot.start_time);
  return selected.every((s) => {
    if (s.date !== slot.date) return true;
    return Math.abs(slotMins - timeToMinutes(s.start_time)) >= minGapMins;
  });
}

function pickDiverseSlots(
  scored: CandidateSlot[],
  count: number,
  options: {
    minGapMins: number;
    maxPerDay: number;
    preferDistinctDayFirst?: boolean;
    targetDistinctDays?: number;
    targetDistinctBands?: number;
    dayWeight?: number;
    bandWeight?: number;
  },
): CandidateSlot[] {
  const selected: CandidateSlot[] = [];
  const perDay = new Map<string, number>();
  const perBand = new Map<TimeBand, number>();
  const targetDistinctDays = options.targetDistinctDays || 0;
  const targetDistinctBands = options.targetDistinctBands || 0;
  const dayWeight = options.dayWeight ?? 1;
  const bandWeight = options.bandWeight ?? 1;

  function pickBestCandidate(candidates: CandidateSlot[]): CandidateSlot | null {
    if (!candidates.length) return null;
    const seenDays = new Set(selected.map((s) => s.date));
    const seenBands = new Set(selected.map((s) => getTimeBand(s.start_time)));

    let best: CandidateSlot | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const slot of candidates) {
      const dayCount = perDay.get(slot.date) || 0;
      const band = getTimeBand(slot.start_time);
      const bandCount = perBand.get(band) || 0;
      const isNewDay = !seenDays.has(slot.date);
      const isNewBand = !seenBands.has(band);

      // Efficiency stays primary (base score), diversity penalties act as soft tie-breakers.
      let adjusted = slot.score;
      adjusted += dayWeight * dayCount;
      adjusted += bandWeight * bandCount;
      if (!isNewDay) adjusted += dayWeight * 0.5;
      if (!isNewBand) adjusted += bandWeight * 0.5;
      if (seenDays.size < targetDistinctDays && !isNewDay) adjusted += dayWeight * 2;
      if (seenBands.size < targetDistinctBands && !isNewBand) adjusted += bandWeight * 4;

      if (adjusted < bestScore) {
        bestScore = adjusted;
        best = slot;
      }
    }

    return best;
  }

  if (options.preferDistinctDayFirst) {
    const seenDays = new Set<string>();
    for (const slot of scored) {
      if (selected.length >= count) break;
      if ((perDay.get(slot.date) || 0) > 0) continue;
      if (!isSpacedFromSelected(slot, selected, options.minGapMins)) continue;
      selected.push(slot);
      seenDays.add(slot.date);
      perDay.set(slot.date, 1);
      const band = getTimeBand(slot.start_time);
      perBand.set(band, (perBand.get(band) || 0) + 1);
      if (seenDays.size >= targetDistinctDays) break;
    }
  }

  while (selected.length < count) {
    const candidates = scored.filter((slot) => {
      if (selected.some((s) => s.date === slot.date && s.start_time === slot.start_time)) return false;
      if ((perDay.get(slot.date) || 0) >= options.maxPerDay) return false;
      if (!isSpacedFromSelected(slot, selected, options.minGapMins)) return false;
      return true;
    });
    const best = pickBestCandidate(candidates);
    if (!best) break;
    selected.push(best);
    perDay.set(best.date, (perDay.get(best.date) || 0) + 1);
    const band = getTimeBand(best.start_time);
    perBand.set(band, (perBand.get(band) || 0) + 1);
  }

  // Final fill pass with relaxed spacing if needed, while preserving per-day cap.
  if (selected.length < count) {
    while (selected.length < count) {
      const candidates = scored.filter((slot) => {
        if (selected.some((s) => s.date === slot.date && s.start_time === slot.start_time)) return false;
        if ((perDay.get(slot.date) || 0) >= options.maxPerDay) return false;
        return true;
      });
      const best = pickBestCandidate(candidates);
      if (!best) break;
      selected.push(best);
      perDay.set(best.date, (perDay.get(best.date) || 0) + 1);
      const band = getTimeBand(best.start_time);
      perBand.set(band, (perBand.get(band) || 0) + 1);
    }
  }

  return selected;
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

  let prevDrive: number;
  let nextDrive: number;
  let directPrevToNext: number;
  try {
    [prevDrive, nextDrive] = await Promise.all([
      getDriveMinutes(prevLoc, input.location),
      getDriveMinutes(input.location, nextLoc),
    ]);
    const samePrevNext = prevLoc.lat === nextLoc.lat && prevLoc.lng === nextLoc.lng;
    directPrevToNext = samePrevNext ? 0 : await getDriveMinutes(prevLoc, nextLoc);
  } catch {
    return { valid: false, reason: "route_unavailable" };
  }

  const availableFromPrev = minutesBetween(prevEnd, start);
  const availableToNext = minutesBetween(end, nextStart);

  if (prevDrive > availableFromPrev || nextDrive > availableToNext) {
    return { valid: false, reason: "drive_window" };
  }

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
  const featuredSlots = pickDiverseSlots(scored, 5, {
    minGapMins: 60,
    maxPerDay: 2,
    preferDistinctDayFirst: true,
    targetDistinctDays: 4,
    targetDistinctBands: 3,
    dayWeight: 1.2,
    bandWeight: 1.0,
  });

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
    afternoon: [12 * 60, 15 * 60 - 1],
    evening: [15 * 60, 18 * 60 - 1],
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

  return pickDiverseSlots(scored.sort((a, b) => a.score - b.score), 3, {
    minGapMins: 45,
    maxPerDay: 3,
  });
}
