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

export async function getDriveMinutes(origin: Location, destination: Location): Promise<number> {
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
