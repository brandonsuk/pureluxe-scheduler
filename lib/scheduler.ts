import { addDays, format } from "date-fns";
import { env } from "@/lib/env";
import { getDriveMinutes, primeSharedDriveTimes, saveSharedDriveTimesInBackground, trackDriveKeys } from "@/lib/distance";
import { supabaseAdmin } from "@/lib/supabase";
import { combineDateTime, minutesBetween, todayIsoDate } from "@/lib/time";
import type { Appointment, CalendarBlocker, CandidateSlot, Location, WorkingHourWindow, WorkingHours } from "@/lib/types";

const MIN_LEAD_TIME_MS = 12 * 60 * 60 * 1000; // 12 hours

function isWithinMinLeadTime(date: string, startTime: string): boolean {
  const slotStart = combineDateTime(date, startTime);
  return slotStart.getTime() - Date.now() < MIN_LEAD_TIME_MS;
}

type TimedBlockWithLoc = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  lat: number;
  lng: number;
};

type SlotInput = {
  date: string;
  start_time: string;
  duration_mins: number;
  location: Location;
  overrideMaxDrive?: boolean;
  dayEndTime?: string; // latest start time for the working day (e.g. "17:00")
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

export async function fetchDayAppointments(date: string): Promise<TimedBlockWithLoc[]> {
  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,end_time,lat,lng")
    .eq("date", date)
    .eq("status", "confirmed")
    .order("start_time", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  const { data: blockers, error: blockersError } = await supabaseAdmin
    .from("calendar_blockers")
    .select("id,date,start_time,end_time,lat,lng")
    .eq("date", date)
    .order("start_time", { ascending: true });

  if (blockersError) {
    throw new Error(blockersError.message);
  }

  const merged = [
    ...(((appointments || []) as Pick<Appointment, "id" | "date" | "start_time" | "end_time" | "lat" | "lng">[]).map(
      (row) => ({
        id: row.id,
        date: row.date,
        start_time: row.start_time,
        end_time: row.end_time,
        lat: row.lat,
        lng: row.lng,
      }),
    )),
    ...(((blockers || []) as Pick<CalendarBlocker, "id" | "date" | "start_time" | "end_time" | "lat" | "lng">[]).map(
      (row) => ({
        id: row.id,
        date: row.date,
        start_time: row.start_time,
        end_time: row.end_time,
        lat: row.lat,
        lng: row.lng,
      }),
    )),
  ];

  return merged.sort((a, b) => a.start_time.localeCompare(b.start_time));
}

type BlockRow = Pick<Appointment, "id" | "date" | "start_time" | "end_time" | "lat" | "lng">;

// Speed: confirmed appointments + calendar blockers for a whole date range in 2 parallel reads, grouped per
// date in the same order fetchDayAppointments returns them. Returns null if a read failed or the API capped
// the rows (or gave no count), so the caller falls back to the per-day reads.
async function fetchRangeAppointments(startDate: string, endDate: string): Promise<Map<string, TimedBlockWithLoc[]> | null> {
  const [appointmentsResult, blockersResult] = await Promise.all([
    supabaseAdmin
      .from("appointments")
      .select("id,date,start_time,end_time,lat,lng", { count: "exact" })
      .gte("date", startDate)
      .lte("date", endDate)
      .eq("status", "confirmed")
      .order("date", { ascending: true })
      .order("start_time", { ascending: true }),
    supabaseAdmin
      .from("calendar_blockers")
      .select("id,date,start_time,end_time,lat,lng", { count: "exact" })
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true })
      .order("start_time", { ascending: true }),
  ]);

  const appointments = (appointmentsResult.data || []) as BlockRow[];
  const blockers = (blockersResult.data || []) as BlockRow[];
  const complete = (count: number | null, rows: number) => count !== null && count <= rows;
  if (
    appointmentsResult.error
    || blockersResult.error
    || !complete(appointmentsResult.count, appointments.length)
    || !complete(blockersResult.count, blockers.length)
  ) {
    // eslint-disable-next-line no-console
    console.warn("[scheduler] range read incomplete, using per-day reads", appointmentsResult.error?.message || blockersResult.error?.message || "row cap");
    return null;
  }

  // Appointments first, then blockers, then a stable sort by start time: the same order as fetchDayAppointments.
  const byDate = new Map<string, TimedBlockWithLoc[]>();
  for (const row of [...appointments, ...blockers]) {
    const block = { id: row.id, date: row.date, start_time: row.start_time, end_time: row.end_time, lat: row.lat, lng: row.lng };
    const list = byDate.get(row.date);
    if (list) list.push(block);
    else byDate.set(row.date, [block]);
  }
  for (const list of byDate.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return byDate;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function straightLineKm(a: Location, b: Location): number {
  const earthRadiusKm = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const hav =
    Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(hav));
}

function centroid(locations: Location[]): Location {
  const total = locations.reduce(
    (acc, loc) => ({ lat: acc.lat + loc.lat, lng: acc.lng + loc.lng }),
    { lat: 0, lng: 0 },
  );
  return {
    lat: total.lat / locations.length,
    lng: total.lng / locations.length,
  };
}

function clusterPenalty(location: Location, existing: TimedBlockWithLoc[]): number {
  if (!existing.length) return 0;

  const points = existing.map((appt) => ({ lat: appt.lat, lng: appt.lng }));
  const center = centroid(points);
  const clusterRadiusKm = Math.max(...points.map((point) => straightLineKm(point, center)), 0);
  const candidateDistanceKm = straightLineKm(location, center);

  // Allow a little spread around the current cluster, but penalize obvious pull-away bookings.
  const freeRadiusKm = Math.max(8, clusterRadiusKm + 5);
  return Math.max(0, candidateDistanceKm - freeRadiusKm) * 6;
}

function sandwichDetourPenalty(location: Location, prev: TimedBlockWithLoc | undefined, next: TimedBlockWithLoc | undefined): number {
  if (!prev || !next) return 0;

  const prevLoc = { lat: prev.lat, lng: prev.lng };
  const nextLoc = { lat: next.lat, lng: next.lng };
  const prevNextKm = straightLineKm(prevLoc, nextLoc);
  const candidateBridgeKm = straightLineKm(prevLoc, location) + straightLineKm(location, nextLoc);
  const detourKm = Math.max(0, candidateBridgeKm - prevNextKm);

  // Heavily punish out-and-back middle bookings when the existing neighbors are already close.
  const multiplier = prevNextKm <= 15 ? 5 : 3;
  return detourKm * multiplier;
}

function generateCandidateSlots(day: WorkingHours, durationMins: number): CandidateSlot[] {
  const slots: CandidateSlot[] = [];
  const windowStart = combineDateTime(day.date, day.start_time);
  const latestStart = combineDateTime(day.date, day.end_time);

  // `end_time` is interpreted as the latest arrival/start time, not finish time.
  for (let cursor = windowStart; cursor <= latestStart; cursor = new Date(cursor.getTime() + 15 * 60 * 1000)) {
    const end = new Date(cursor.getTime() + durationMins * 60 * 1000);
    slots.push({
      date: day.date,
      start_time: format(cursor, "HH:mm"),
      end_time: format(end, "HH:mm"),
      duration_mins: durationMins,
      score: Number.POSITIVE_INFINITY,
    });
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

function addMinutesToTime(time: string, mins: number): string {
  const total = Math.min(Math.max(timeToMinutes(time) + mins, 0), 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export async function validateCandidateSlot(input: SlotInput, existing: TimedBlockWithLoc[]): Promise<ValidationResult> {
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
  // Drive-home deadline = working day end + 90 mins (client must be home by then).
  // Falls back to "17:00" + 90 = "18:30" if dayEndTime is not provided.
  const dayEndMins = input.dayEndTime
    ? timeToMinutes(input.dayEndTime)
    : 17 * 60;
  const driveHomeDeadlineH = Math.floor((dayEndMins + 90) / 60).toString().padStart(2, "0");
  const driveHomeDeadlineM = ((dayEndMins + 90) % 60).toString().padStart(2, "0");
  const driveHomeDeadline = `${driveHomeDeadlineH}:${driveHomeDeadlineM}`;
  const nextStart = next
    ? combineDateTime(next.date, next.start_time)
    : combineDateTime(input.date, driveHomeDeadline);

  let prevDrive: number;
  let nextDrive: number;
  let directPrevToNext: number;
  try {
    // Visit-time routing: each leg uses typical traffic for when it is actually driven.
    // From home, assume leaving ~30 min before the visit; otherwise leave when the previous visit ends.
    const prevDepart = prev ? prev.end_time.slice(0, 5) : addMinutesToTime(input.start_time, -30);
    const endTime = addMinutesToTime(input.start_time, input.duration_mins);
    [prevDrive, nextDrive] = await Promise.all([
      getDriveMinutes(prevLoc, input.location, { date: input.date, time: prevDepart }),
      getDriveMinutes(input.location, nextLoc, { date: input.date, time: endTime }),
    ]);
    const samePrevNext = prevLoc.lat === nextLoc.lat && prevLoc.lng === nextLoc.lng;
    directPrevToNext = samePrevNext
      ? 0
      : await getDriveMinutes(prevLoc, nextLoc, { date: input.date, time: prev ? prevDepart : endTime });
  } catch {
    return { valid: false, reason: "route_unavailable" };
  }

  const availableFromPrev = minutesBetween(prevEnd, start);
  const availableToNext = minutesBetween(end, nextStart);
  const prevLegFits = prev ? prevDrive <= availableFromPrev : true;
  const nextLegFits = nextDrive <= availableToNext;

  // First visit of the day (from home) and last visit (back home) may use the longer edge cap,
  // so far towns get first/last slots only. Job-to-job legs keep the normal cap.
  const prevCap = prev ? env.maxDriveMins : env.maxEdgeDriveMins;
  const nextCap = next ? env.maxDriveMins : env.maxEdgeDriveMins;
  if (!input.overrideMaxDrive && (prevDrive > prevCap || nextDrive > nextCap)) {
    return { valid: false, reason: "max_drive" };
  }

  if (!prevLegFits || !nextLegFits) {
    return { valid: false, reason: "drive_window" };
  }

  const extraDriveScore = prevDrive + nextDrive - directPrevToNext;
  const clusterShapePenalty = clusterPenalty(input.location, existing);
  const detourPenalty = sandwichDetourPenalty(input.location, prev, next);

  // End-of-day stranding penalty: penalise being far from home base late in the working day.
  // Formula: distanceFromHomeKm × (appointmentEndMins - dayStartMins) / (dayEndMins - dayStartMins)
  // A 14:00 Edinburgh job (~50km) scores ~33 extra; a 9:00 Edinburgh job scores ~5.
  // This naturally discourages far-from-home mid/late-day bookings without blocking them entirely.
  const DAY_START_MINS = 9 * 60;
  const endTimeMins = timeToMinutes(input.start_time) + input.duration_mins;
  const strandingDaySpan = Math.max(1, dayEndMins - DAY_START_MINS);
  const strandingProgress = Math.max(0, (endTimeMins - DAY_START_MINS) / strandingDaySpan);
  const strandingPenalty = straightLineKm(input.location, homeBase) * strandingProgress;

  return {
    valid: true,
    score: extraDriveScore + clusterShapePenalty + detourPenalty + strandingPenalty,
  };
}

export async function findBestSlots(
  location: Location,
  durationMins: number,
  fromDate?: string,
  overrideMaxDrive?: boolean,
): Promise<{ featured_slots: CandidateSlot[]; all_slots: Record<string, CandidateSlot[]> }> {
  const startedAt = Date.now();
  const sharedReady = primeSharedDriveTimes(location);
  // Fetch up to 30 calendar days so we can find the first 14 days that actually have open slots.
  const days = await fetchWorkingDays(fromDate, 30);
  const allValid: CandidateSlot[] = [];
  let checkedCandidates = 0;
  const MAX_CANDIDATES_TO_CHECK = 120;
  // Spread: past the 120-check mark, keep looking until valid slots cover this many days (the picks below aim
  // for 4), so a far address isn't offered just 1-2 days. Hard stops are unchanged: 14 days with slots, or
  // the end of the 30-day window.
  const MIN_DAYS_WITH_SLOTS = 4;
  // Safety net: once past the 120-check mark, stop looking for more days when the request has run this long.
  const MORE_DAYS_BUDGET_MS = 10_000;
  const datesWithSlots = new Set<string>();
  const pastOldStop = () => checkedCandidates >= MAX_CANDIDATES_TO_CHECK && allValid.length >= 5;

  // Speed: every date's bookings come from one range read instead of 2 reads per date (as findAvailableDates).
  const dates = [...new Set(days.map((d) => d.date))].sort((a, b) => a.localeCompare(b));
  const blocksByDate = dates.length ? await fetchRangeAppointments(dates[0], dates[dates.length - 1]) : null;

  await sharedReady;
  for (const day of days) {
    // Stop once we've seen 14 distinct days that yielded at least one valid slot.
    if (datesWithSlots.size >= 14) break;

    const existing = blocksByDate ? blocksByDate.get(day.date) ?? [] : await fetchDayAppointments(day.date);
    const candidates = generateCandidateSlots(day, durationMins);
    // Earlier days already cover enough days: keep the old mid-day stop. Otherwise finish this day, so its
    // best slot can be picked rather than just its first valid one.
    const enoughDaysAlready = datesWithSlots.size >= MIN_DAYS_WITH_SLOTS;
    let dayHadValidSlot = false;

    for (const candidate of candidates) {
      if (isWithinMinLeadTime(candidate.date, candidate.start_time)) continue;
      checkedCandidates += 1;
      const result = await trackDriveKeys(location, () =>
        validateCandidateSlot(
          {
            date: candidate.date,
            start_time: candidate.start_time,
            duration_mins: candidate.duration_mins,
            location,
            overrideMaxDrive,
            dayEndTime: day.end_time,
          },
          existing,
        ),
      );

      if (result.valid && typeof result.score === "number") {
        allValid.push({ ...candidate, score: result.score });
        dayHadValidSlot = true;
      }

      if (enoughDaysAlready && pastOldStop()) break;
    }

    if (dayHadValidSlot) datesWithSlots.add(day.date);
    if (pastOldStop() && (datesWithSlots.size >= MIN_DAYS_WITH_SLOTS || Date.now() - startedAt >= MORE_DAYS_BUDGET_MS)) break;
  }

  saveSharedDriveTimesInBackground(location);
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

export type PreferredWindow = "morning" | "afternoon" | "evening";

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
  preferredTime?: string,
  overrideMaxDrive?: boolean,
  skipMinLeadTime?: boolean,
): Promise<CandidateSlot[]> {
  // Speed: the bookings read and the working-hours read run in parallel.
  const [existing, days] = await Promise.all([
    fetchDayAppointments(preferredDate),
    fetchWorkingDays(preferredDate, 1),
    primeSharedDriveTimes(location),
  ]);
  const day = days.find((d) => d.date === preferredDate);
  if (!day) return [];

  const scoredSlots = await scorePreferredSlots(location, durationMins, day, existing, preferredWindow, preferredTime, overrideMaxDrive, skipMinLeadTime);
  saveSharedDriveTimesInBackground(location);
  return scoredSlots;
}

// Valid slots for one working day, scored for the lead's preferred window. Used by findPreferredSlots
// and findAvailableDates.
async function scorePreferredSlots(
  location: Location,
  durationMins: number,
  day: WorkingHours,
  existing: TimedBlockWithLoc[],
  preferredWindow: PreferredWindow,
  preferredTime?: string,
  overrideMaxDrive?: boolean,
  skipMinLeadTime?: boolean,
): Promise<CandidateSlot[]> {
  const candidates = generateCandidateSlots(day, durationMins);
  const scored: CandidateSlot[] = [];
  // Only times inside the requested window that start on :00 or :30 are ever returned (see the filter below).
  const shown = (time: string) =>
    preferencePenaltyMins(time, preferredWindow) === 0 && (time.endsWith(":00") || time.endsWith(":30"));

  for (const candidate of candidates) {
    // Speed: skip times the filter below drops anyway, so they cost no drive lookups.
    if (!shown(candidate.start_time)) continue;
    if (!skipMinLeadTime && isWithinMinLeadTime(candidate.date, candidate.start_time)) continue;
    const result = await trackDriveKeys(location, () =>
      validateCandidateSlot(
        {
          date: candidate.date,
          start_time: candidate.start_time,
          duration_mins: candidate.duration_mins,
          location,
          overrideMaxDrive,
          dayEndTime: day.end_time,
        },
        existing,
      ),
    );
    if (!result.valid || typeof result.score !== "number") continue;

    const penalty = preferencePenaltyMins(candidate.start_time, preferredWindow);
    if (preferredTime) {
      const timeDistanceMins = Math.abs(timeToMinutes(candidate.start_time) - timeToMinutes(preferredTime));
      const exactTimePenalty = timeDistanceMins / 15; // 1 point per 15 minutes away from requested time
      const efficiencyDominantScore = result.score * 0.8 + (penalty / 10 + exactTimePenalty) * 0.2;
      scored.push({ ...candidate, score: efficiencyDominantScore });
      continue;
    }

    scored.push({ ...candidate, score: result.score + penalty / 10 });
  }

  // Only return slots that fall within the requested window.
  // Do NOT fall back to out-of-window slots — that produces confusing results
  // (e.g. showing 11:30am when the user asked for 3–6pm).
  // Also restrict to :00 and :30 start times for clean presentation.
  const inWindow = scored.filter((s) => shown(s.start_time));

  // Return all valid slots in chronological order so the admin can see every option.
  return inWindow.sort((a, b) => a.start_time.localeCompare(b.start_time));
}

export async function findAvailableDates(
  location: Location,
  durationMins: number,
  preferredWindow: PreferredWindow,
  fromDate?: string,
  targetDaysWithSlots = 14,
  overrideMaxDrive?: boolean,
): Promise<string[]> {
  // Fetch up to 30 calendar days so we can return the first targetDaysWithSlots days
  // that actually have open slots, rather than just the first N calendar days.
  const calendarWindow = Math.min(30, Math.max(targetDaysWithSlots * 3, 30));
  const sharedReady = primeSharedDriveTimes(location);
  const days = await fetchWorkingDays(fromDate, calendarWindow);
  const uniqueDates = [...new Set(days.map((d) => d.date))].sort((a, b) => a.localeCompare(b));
  const availableDates: string[] = [];
  if (!uniqueDates.length) return availableDates;

  // Speed: each date uses its first working-hours window from the read above (the same row a per-day read
  // returns), and every date's bookings come from one range read instead of 3 reads per date.
  const firstWindowByDate = new Map<string, WorkingHours>();
  for (const day of days) if (!firstWindowByDate.has(day.date)) firstWindowByDate.set(day.date, day);
  const blocksByDate = await fetchRangeAppointments(uniqueDates[0], uniqueDates[uniqueDates.length - 1]);
  await sharedReady;

  for (const date of uniqueDates) {
    if (availableDates.length >= targetDaysWithSlots) break;
    const day = firstWindowByDate.get(date);
    if (!day) continue;
    const existing = blocksByDate ? blocksByDate.get(date) ?? [] : await fetchDayAppointments(date);
    const slots = await scorePreferredSlots(location, durationMins, day, existing, preferredWindow, undefined, overrideMaxDrive);
    if (slots.length > 0) availableDates.push(date);
  }

  saveSharedDriveTimesInBackground(location);
  return availableDates;
}
