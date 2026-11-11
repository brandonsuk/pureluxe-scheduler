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

let lastTomTomRequestAt = 0;
let tomTomQueue: Promise<void> = Promise.resolve();

/** Wall-clock departure in UK local time, e.g. { date: "2026-11-16", time: "08:15" }. */
export type Departure = { date: string; time: string };

type TimeBand = { id: string; startMins: number; repTime: string };

// Representative departure per band, so every lookup in a band gets the same answer.
const TIME_BANDS: TimeBand[] = [
  { id: "early", startMins: 0, repTime: "06:30" },
  { id: "am-peak", startMins: 7 * 60, repTime: "08:15" },
  { id: "midday", startMins: 9 * 60 + 30, repTime: "12:00" },
  { id: "pm-peak", startMins: 15 * 60 + 30, repTime: "17:00" },
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

function cacheKey(origin: Location, destination: Location, bandKey?: string): string {
  return [
    origin.lat.toFixed(5),
    origin.lng.toFixed(5),
    destination.lat.toFixed(5),
    destination.lng.toFixed(5),
    env.distanceProvider,
    bandKey || "live",
  ].join("|");
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

async function getTomTomDriveMinutes(origin: Location, destination: Location, departAt?: string): Promise<number> {
  try {
    return await fetchTomTomRouteMinutes(origin, destination, departAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("MAP_MATCHING_FAILURE")) throw error;

    // Retry with small nearby offsets because geocoded points can be off-road.
    const originCandidates = nudgeCandidates(origin);
    const destinationCandidates = nudgeCandidates(destination);

    for (const o of originCandidates) {
      for (const d of destinationCandidates) {
        try {
          return await fetchTomTomRouteMinutes(o, d, departAt);
        } catch {
          // keep trying
        }
      }
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

function nudgeCandidates(point: Location): Location[] {
  // Wider radius for rural/off-road points (e.g., home base not directly on mapped road).
  const offsets = [0, 0.0008, -0.0008, 0.002, -0.002, 0.005, -0.005];
  const out: Location[] = [];
  for (const dLat of offsets) {
    for (const dLng of offsets) {
      out.push({
        lat: Number((point.lat + dLat).toFixed(6)),
        lng: Number((point.lng + dLng).toFixed(6)),
      });
    }
  }
  return out;
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
