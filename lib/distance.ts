import { env } from "@/lib/env";
import type { Location } from "@/lib/types";

type DistanceValue = {
  value: number;
};

type Element = {
  status: string;
  duration?: DistanceValue;
};

type MatrixResponse = {
  rows: Array<{
    elements: Element[];
  }>;
};

type TomTomRouteResponse = {
  routes?: Array<{
    summary?: {
      travelTimeInSeconds?: number;
    };
  }>;
};

const driveCache = new Map<string, { expiresAt: number; minutes: number }>();
const inflightDriveRequests = new Map<string, Promise<number>>();
const CACHE_TTL_MS = 10 * 60 * 1000;
// Visit-time (departAt) results are typical traffic for a day type + time band, so they keep for hours.
const BANDED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TOMTOM_MIN_INTERVAL_MS = 275;

// Routes and addresses TomTom could not place on a road, even after nudging. Map matching does not
// depend on departure time, so one failure covers every time band. Kept briefly so a bad address
// fails fast instead of repeating the nudge search for every slot.
const unroutableUntil = new Map<string, number>();
const UNROUTABLE_TTL_MS = 10 * 60 * 1000;
// Nearest-first nudges tried after a MAP_MATCHING_FAILURE (was a 49 x 49 grid: up to 2,401 calls).
const MAX_NUDGE_TRIES = 12;
// Nudge distances in degrees, four compass directions each: about 50 m to 560 m at our latitude.
const NUDGE_STEPS_DEG = [0.0008, 0.002, 0.005];

let lastTomTomRequestAt = 0;
let tomTomQueue: Promise<void> = Promise.resolve();

/** Wall-clock departure in UK local time, e.g. { date: "2026-11-16", time: "08:15" }. */
export type Departure = { date: string; time: string };

type TimeBand = { id: string; startMins: number; repTime: string };

// Representative departure per band, so every lookup in a band gets the same answer.
// pm-peak starts at 15:00 so school-run departures (15:00-15:29) are not priced at midday traffic.
const TIME_BANDS: TimeBand[] = [
  { id: "early", startMins: 0, repTime: "06:30" },
  { id: "am-peak", startMins: 7 * 60, repTime: "08:15" },
  { id: "midday", startMins: 9 * 60 + 30, repTime: "12:00" },
  { id: "pm-peak", startMins: 15 * 60, repTime: "17:00" },
  { id: "evening", startMins: 18 * 60 + 30, repTime: "19:00" },
];

function bandFor(time: string): TimeBand {
  const mins = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  let band = TIME_BANDS[0];
  for (const b of TIME_BANDS) if (mins >= b.startMins) band = b;
  return band;
}

function dayTypeFor(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 ? "sun" : dow === 6 ? "sat" : "wd";
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ukNowWallClock(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/**
 * Maps a departure to its band and a representative TomTom departAt (UK wall clock, no offset:
 * TomTom reads it as the origin's local time). The departAt is always in the future: if the
 * representative time has passed, the same weekday next week is used.
 */
export function resolveDeparture(departure: Departure, nowMs = Date.now()): { bandKey: string; departAt: string } {
  const band = bandFor(departure.time);
  const bandKey = `${dayTypeFor(departure.date)}:${band.id}`;
  const minFuture = ukNowWallClock(nowMs + 5 * 60 * 1000);
  let date = departure.date;
  while (`${date}T${band.repTime}` <= minFuture) date = addDaysIso(date, 7);
  return { bandKey, departAt: `${date}T${band.repTime}:00` };
}

function pairKey(origin: Location, destination: Location): string {
  return [
    origin.lat.toFixed(5),
    origin.lng.toFixed(5),
    destination.lat.toFixed(5),
    destination.lng.toFixed(5),
    env.distanceProvider,
  ].join("|");
}

function pointKey(point: Location): string {
  return ["pt", point.lat.toFixed(5), point.lng.toFixed(5), env.distanceProvider].join("|");
}

function cacheKey(origin: Location, destination: Location, bandKey?: string): string {
  return `${pairKey(origin, destination)}|${bandKey || "live"}`;
}

function markedUnroutable(key: string, now: number): boolean {
  const until = unroutableUntil.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  unroutableUntil.delete(key);
  return false;
}

function knownUnroutable(origin: Location, destination: Location): boolean {
  const now = Date.now();
  return (
    markedUnroutable(pairKey(origin, destination), now)
    || markedUnroutable(pointKey(origin), now)
    || markedUnroutable(pointKey(destination), now)
  );
}

/**
 * Drive time in minutes. With a departure, uses TomTom's typical traffic for that day type and
 * time band (visit-time routing). Without one, uses traffic right now.
 */
export async function getDriveMinutes(origin: Location, destination: Location, departure?: Departure): Promise<number> {
  const resolved = departure ? resolveDeparture(departure) : undefined;
  const key = cacheKey(origin, destination, resolved?.bandKey);
  const hit = driveCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.minutes;

  // Same error family as a fresh failure, so callers treat it the same way (the slot is just not offered).
  if (knownUnroutable(origin, destination)) {
    throw new Error("MAP_MATCHING_FAILURE (TomTom): unroutable within the last 10 min, skipped");
  }

  const inflight = inflightDriveRequests.get(key);
  if (inflight) return inflight;

  if (env.distanceProvider !== "tomtom" || !env.tomtomApiKey) {
    throw new Error("TomTom distance provider is required");
  }

  const requestPromise = (async () => {
    const minutes = await getTomTomDriveMinutes(origin, destination, resolved?.departAt);
    driveCache.set(key, { minutes, expiresAt: Date.now() + (resolved ? BANDED_CACHE_TTL_MS : CACHE_TTL_MS) });
    return minutes;
  })();

  inflightDriveRequests.set(key, requestPromise);
  try {
    return await requestPromise;
  } finally {
    inflightDriveRequests.delete(key);
  }
}

type RouteEnd = "origin" | "destination";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The end TomTom could not place on a road, when its error names it ("MAP_MATCHING_FAILURE: Destination (...)"). */
function failingEnd(message: string): RouteEnd | null {
  const match = /MAP_MATCHING_FAILURE\W*(origin|destination)/i.exec(message);
  return match ? (match[1].toLowerCase() as RouteEnd) : null;
}

/** Errors that say the route itself is impossible, as opposed to rate limits, outages or network trouble. */
function isUnroutableError(message: string): boolean {
  return message.includes("MAP_MATCHING_FAILURE") || message.includes("NO_ROUTE_FOUND");
}

/** Short, coordinate-free snippet of TomTom's wording after the error code, so its format shows in logs. */
function errorHint(message: string): string {
  const at = message.lastIndexOf("MAP_MATCHING_FAILURE");
  return message.slice(at, at + 60).replace(/\d/g, "#");
}

async function getTomTomDriveMinutes(origin: Location, destination: Location, departAt?: string): Promise<number> {
  try {
    return await fetchTomTomRouteMinutes(origin, destination, departAt);
  } catch (error) {
    const message = errorMessage(error);
    if (!message.includes("MAP_MATCHING_FAILURE")) throw error;

    // Geocoded points can sit just off a mapped road: retry with a few nearest-first offsets, moving only
    // the end TomTom named (both ends in turn when it names neither), then give up.
    const end = failingEnd(message);
    let tries = 0;
    let transient = false;
    let sameEnd = end !== null;
    for (const attempt of nudgeAttempts(origin, destination, end)) {
      tries += 1;
      try {
        const minutes = await fetchTomTomRouteMinutes(attempt.origin, attempt.destination, departAt);
        // eslint-disable-next-line no-console
        console.info("[distance] route matched after nudging", { end: end ?? "unknown", tries });
        return minutes;
      } catch (nudgeError) {
        const nudgeMessage = errorMessage(nudgeError);
        if (!isUnroutableError(nudgeMessage)) {
          // Rate limit, outage or network: stop here and do not remember the route as unroutable.
          transient = true;
          // eslint-disable-next-line no-console
          console.warn("[distance] nudge search stopped by a TomTom error", {
            status: /\(TomTom\): (\d{3})/.exec(nudgeMessage)?.[1] ?? "no status",
            tries,
          });
          break;
        }
        if (failingEnd(nudgeMessage) !== end) sameEnd = false;
      }
    }

    if (!transient) {
      const until = Date.now() + UNROUTABLE_TTL_MS;
      unroutableUntil.set(pairKey(origin, destination), until);
      // Every nudge of the named end failed to match it: that address is off the map, so skip it in any route.
      const addressLevel = sameEnd && end !== null;
      if (addressLevel) unroutableUntil.set(pointKey(end === "origin" ? origin : destination), until);
      // eslint-disable-next-line no-console
      console.warn("[distance] route unroutable after nudging, skipping it for 10 min", {
        end: end ?? "unknown",
        tries,
        scope: addressLevel ? "address" : "route",
        ...(end ? {} : { hint: errorHint(message) }),
      });
    }

    throw error;
  }
}

async function fetchTomTomRouteMinutes(origin: Location, destination: Location, departAt?: string): Promise<number> {
  await waitForTomTomSlot();

  // TomTom routing expects "latitude,longitude"
  const coords = `${origin.lat},${origin.lng}:${destination.lat},${destination.lng}`;
  const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${coords}/json`);
  url.searchParams.set("key", env.tomtomApiKey);
  url.searchParams.set("traffic", "true");
  url.searchParams.set("travelMode", "car");
  url.searchParams.set("routeType", "fastest");
  if (departAt) url.searchParams.set("departAt", departAt);

  const response = await fetch(url.toString());
  if (!response.ok) {
    let details = "";
    try {
      details = await response.text();
    } catch {
      // noop
    }
    throw new Error(`Failed to fetch drive time (TomTom): ${response.status}${details ? ` ${details}` : ""}`);
  }

  const data = (await response.json()) as TomTomRouteResponse;
  const seconds = data.routes?.[0]?.summary?.travelTimeInSeconds;
  if (!seconds) throw new Error("Drive time unavailable for route (TomTom)");
  return Math.ceil(seconds / 60);
}

async function waitForTomTomSlot(): Promise<void> {
  const previous = tomTomQueue;
  let release!: () => void;
  tomTomQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const now = Date.now();
  const waitMs = Math.max(0, lastTomTomRequestAt + TOMTOM_MIN_INTERVAL_MS - now);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  lastTomTomRequestAt = Date.now();
  release();
}

/** Nearby points to try, nearest first. The widest step still reaches rural points set back from the road. */
function nudgeCandidates(point: Location): Location[] {
  // A degree of longitude is shorter than a degree of latitude this far north, so sort by metres.
  const lngScale = Math.cos((point.lat * Math.PI) / 180);
  const offsets: Array<{ dLat: number; dLng: number; metres: number }> = [];
  for (const step of NUDGE_STEPS_DEG) {
    for (const sign of [1, -1]) {
      offsets.push({ dLat: sign * step, dLng: 0, metres: step * 111_320 });
      offsets.push({ dLat: 0, dLng: sign * step, metres: step * 111_320 * lngScale });
    }
  }
  offsets.sort((a, b) => a.metres - b.metres);
  return offsets.map(({ dLat, dLng }) => ({
    lat: Number((point.lat + dLat).toFixed(6)),
    lng: Number((point.lng + dLng).toFixed(6)),
  }));
}

/** The nudged routes to try, capped at MAX_NUDGE_TRIES. Only the failing end moves when TomTom names it. */
function nudgeAttempts(
  origin: Location,
  destination: Location,
  end: RouteEnd | null,
): Array<{ origin: Location; destination: Location }> {
  const attempts: Array<{ origin: Location; destination: Location }> = [];
  const originNudges = end === "destination" ? [] : nudgeCandidates(origin);
  const destinationNudges = end === "origin" ? [] : nudgeCandidates(destination);
  for (let i = 0; i < Math.max(originNudges.length, destinationNudges.length); i += 1) {
    if (destinationNudges[i]) attempts.push({ origin, destination: destinationNudges[i] });
    if (originNudges[i]) attempts.push({ origin: originNudges[i], destination });
  }
  return attempts.slice(0, MAX_NUDGE_TRIES);
}

async function getGoogleDriveMinutes(origin: Location, destination: Location): Promise<number> {
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${origin.lat},${origin.lng}`);
  url.searchParams.set("destinations", `${destination.lat},${destination.lng}`);
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("key", env.googleMapsApiKey);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error("Failed to fetch drive time");
  }

  const data = (await response.json()) as MatrixResponse;
  const element = data.rows?.[0]?.elements?.[0];
  if (!element || element.status !== "OK" || !element.duration) {
    throw new Error("Drive time unavailable for route");
  }

  return Math.ceil(element.duration.value / 60);
}
