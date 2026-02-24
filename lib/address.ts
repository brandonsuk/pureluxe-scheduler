import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";

type LoqateItem = {
  Latitude: string;
  Longitude: string;
  Premise?: string;
  Thoroughfare?: string;
  Locality?: string;
  PostalCode?: string;
};

type LoqateGlobalResponseRow = {
  Input?: string;
  Results?: LoqateItem[];
};

export async function geocodeAddress(address: string) {
  const url = "https://api.addressy.com/LocationServices/Geocoding/Global/v1.10/json6.ws";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Key: env.loqateApiKey,
      Input: [address],
      Country: "GB",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to geocode address");
  }

  const data = (await response.json()) as LoqateGlobalResponseRow[];
  const first = data?.[0]?.Results?.[0];

  if (!first?.Latitude || !first?.Longitude) {
    throw new Error("Address not geocoded");
  }

  return {
    lat: Number(first.Latitude),
    lng: Number(first.Longitude),
    label: [first.Premise, first.Thoroughfare, first.Locality, first.PostalCode].filter(Boolean).join(", "),
  };
}

export async function isWithinServiceArea(lat: number, lng: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("service_area")
    .select("geojson")
    .limit(1)
    .single();

  if (error || !data?.geojson) {
    throw new Error("Missing service area polygon");
  }

  return booleanPointInPolygon(point([lng, lat]), data.geojson);
}
