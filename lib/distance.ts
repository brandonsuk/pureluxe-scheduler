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
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheKey(origin: Location, destination: Location): string {
  return [
    origin.lat.toFixed(5),
    origin.lng.toFixed(5),
    destination.lat.toFixed(5),
    destination.lng.toFixed(5),
    env.distanceProvider,
  ].join("|");
}

export async function getDriveMinutes(origin: Location, destination: Location): Promise<number> {
  const key = cacheKey(origin, destination);
  const hit = driveCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.minutes;

  if (env.distanceProvider !== "tomtom" || !env.tomtomApiKey) {
    throw new Error("TomTom distance provider is required");
  }

  const minutes = await getTomTomDriveMinutes(origin, destination);

  driveCache.set(key, { minutes, expiresAt: Date.now() + CACHE_TTL_MS });
  return minutes;
}

async function getTomTomDriveMinutes(origin: Location, destination: Location): Promise<number> {
  try {
    return await fetchTomTomRouteMinutes(origin, destination);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("MAP_MATCHING_FAILURE")) throw error;

    // Retry with small nearby offsets because geocoded points can be off-road.
    const originCandidates = nudgeCandidates(origin);
    const destinationCandidates = nudgeCandidates(destination);

    for (const o of originCandidates) {
      for (const d of destinationCandidates) {
        try {
          return await fetchTomTomRouteMinutes(o, d);
        } catch {
          // keep trying
        }
      }
    }

    throw error;
  }
}

async function fetchTomTomRouteMinutes(origin: Location, destination: Location): Promise<number> {
  // TomTom routing expects "longitude,latitude"
  const coords = `${origin.lng},${origin.lat}:${destination.lng},${destination.lat}`;
  const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${coords}/json`);
  url.searchParams.set("key", env.tomtomApiKey);
  url.searchParams.set("traffic", "true");
  url.searchParams.set("travelMode", "car");
  url.searchParams.set("routeType", "fastest");

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
