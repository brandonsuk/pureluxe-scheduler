import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getCache, waitUntil } from "@vercel/functions";
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

// ---- Shared drive times (Vercel Runtime Cache) ----
// Each server copy keeps its own memory cache above. This shared store lets a fresh copy reuse visit-time
// drive times that another copy (or the step-2 warm-up) already looked up. It is optional: every read and
// write fails open, so if the store is slow, missing or paused, lookups work exactly as before.
// Only hashes are stored: no addresses or coordinates are written in readable form.
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The band layout is part of the name, so a change to TIME_BANDS never reuses times priced on old bands.
const SHARED_NAMESPACE = `pureluxe-drive-v1-${sha256(JSON.stringify(TIME_BANDS)).slice(0, 8)}`;
const SHARED_TTL_S = 6 * 60 * 60;
const SHARED_READ_TIMEOUT_MS = 400;
const SHARED_BREAKER_MS = 60_000;
const MAX_TRACKED_LOCATIONS = 100;
const MAX_KEYS_PER_LOCATION = 4000;
const MAX_ENTRIES_PER_BUNDLE = 2000;
const MAX_SHARED_TIMES = 50_000;
const SHARED_TIMES_PRUNE_TO = 40_000;
// A real slot search marks itself active (here and in the shared store) so any warm-up gets out of its way.
const REAL_ACTIVITY_TTL_MS = 15_000;
const ACTIVE_WRITE_EVERY_MS = 5_000;
const ACTIVE_MARKER_TTL_S = 15;
const WARM_MARKER_TTL_S = 15 * 60;
const SHARED_TIMEOUT = Symbol("shared-timeout");
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

type SharedEntry = { h: string; m: number; at: number }; // h = hashed cache key, m = minutes, at = looked up at
type SharedBundle = { v: 1; loc: string; entries: SharedEntry[] }; // loc = hashed lead location
type LocationState = { keys: Set<string>; sharedAt: number; saveChain: Promise<void> };
type SharedStore = ReturnType<typeof getCache>;

/** Set by the warm-up: it starts no new TomTom lookups once shouldYield() is true, and counts the ones it makes. */
export type WarmupContext = { shouldYield: () => boolean; newCalls: number };

export class WarmupYieldError extends Error {
  constructor() {
    super("Warm-up paused: a lead is waiting on this server");
    this.name = "WarmupYieldError";
  }
}

const driveKeyCollector = new AsyncLocalStorage<Set<string>>();
const warmupContext = new AsyncLocalStorage<WarmupContext>();
const sharedDriveTimes = new Map<string, { minutes: number; expiresAt: number }>();
const sharedByLocation = new Map<string, LocationState>(); // insertion order = least recently used first
const pendingSharedSaves = new Set<Promise<void>>();
let realActivityUntil = 0;
let lastActiveWriteAt = 0;
let sharedCache: SharedStore | undefined;
let sharedBrokenUntil = 0;

/** True when the platform's shared cache is reachable (not the library's per-copy memory fallback). */
function platformCacheAvailable(): boolean {
  try {
    const holder = (globalThis as unknown as Record<symbol, { get?: () => { cache?: unknown } | undefined } | undefined>)[
      VERCEL_REQUEST_CONTEXT
    ];
    if (holder?.get?.()?.cache) return true;
  } catch {
    /* fall through to the env check */
  }
  if (process.env.RUNTIME_CACHE_DISABLE_BUILD_CACHE === "true") return false;
  return Boolean(process.env.RUNTIME_CACHE_ENDPOINT && process.env.RUNTIME_CACHE_HEADERS);
}

function sharedStore(): SharedStore | null {
  if (Date.now() < sharedBrokenUntil) return null;
  // Without the platform cache the library falls back to a memory cache per server copy, which shares nothing
  // and cannot tell a warm-up that a lead is waiting on another copy, so treat that as no store.
  if (!platformCacheAvailable()) return null;
  if (sharedCache === undefined) {
    try {
      sharedCache = getCache({ namespace: SHARED_NAMESPACE, keyHashFunction: (key) => hashKey(key) });
    } catch {
      tripSharedBreaker("store setup failed");
      return null;
    }
  }
  return sharedCache;
}

function tripSharedBreaker(reason: string): void {
  if (Date.now() < sharedBrokenUntil) return;
  sharedBrokenUntil = Date.now() + SHARED_BREAKER_MS;
  // eslint-disable-next-line no-console
  console.warn("[distance] shared drive store paused for 60 s", { reason });
}

async function sharedGet(key: string): Promise<unknown> {
  const store = sharedStore();
  if (!store) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      store.get(key),
      new Promise<typeof SHARED_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(SHARED_TIMEOUT), SHARED_READ_TIMEOUT_MS);
      }),
    ]);
    if (result === SHARED_TIMEOUT) {
      tripSharedBreaker("read timed out");
      return null;
    }
    return result ?? null;
  } catch {
    tripSharedBreaker("read failed");
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sharedSet(key: string, value: unknown, ttl: number, name: string): Promise<void> {
  const store = sharedStore();
  if (!store) return;
  try {
    await store.set(key, value, { ttl, name });
  } catch {
    tripSharedBreaker("write failed");
  }
}

function locKey(location: Location): string {
  return [location.lat.toFixed(5), location.lng.toFixed(5), env.distanceProvider].join("|");
}

function locTag(loc: string): string {
  return sha256(`loc|${loc}`).slice(0, 16);
}

function hashKey(key: string): string {
  return sha256(key).slice(0, 32);
}

function locationState(loc: string): LocationState {
  let state = sharedByLocation.get(loc);
  if (state) sharedByLocation.delete(loc);
  else state = { keys: new Set(), sharedAt: 0, saveChain: Promise.resolve() };
  sharedByLocation.set(loc, state);
  while (sharedByLocation.size > MAX_TRACKED_LOCATIONS) {
    const oldest = sharedByLocation.keys().next().value;
    if (oldest === undefined) break;
    sharedByLocation.delete(oldest);
  }
  return state;
}

function isSharedEntry(entry: unknown, now: number): entry is SharedEntry {
  if (!entry || typeof entry !== "object") return false;
  const { h, m, at } = entry as Record<string, unknown>;
  return (
    typeof h === "string" &&
    /^[0-9a-f]{32}$/.test(h) &&
    typeof m === "number" &&
    Number.isFinite(m) &&
    m >= 0 &&
    m < 1440 &&
    typeof at === "number" &&
    Number.isFinite(at) &&
    at <= now + 60_000 &&
    at + BANDED_CACHE_TTL_MS > now
  );
}

/** The valid, unexpired entries of a stored bundle for this location (none when it is malformed). */
function bundleEntries(value: unknown, loc: string, now: number): SharedEntry[] {
  if (!value || typeof value !== "object") return [];
  const bundle = value as Partial<SharedBundle>;
  if (bundle.v !== 1 || bundle.loc !== locTag(loc) || !Array.isArray(bundle.entries)) return [];
  const entries: SharedEntry[] = [];
  for (const entry of bundle.entries) {
    if (entries.length >= MAX_ENTRIES_PER_BUNDLE) break;
    if (isSharedEntry(entry, now)) entries.push({ h: entry.h, m: entry.m, at: entry.at });
  }
  return entries;
}

function pruneSharedDriveTimes(now: number): void {
  if (sharedDriveTimes.size <= MAX_SHARED_TIMES) return;
  for (const [h, entry] of sharedDriveTimes) if (entry.expiresAt <= now) sharedDriveTimes.delete(h);
  for (const h of sharedDriveTimes.keys()) {
    if (sharedDriveTimes.size <= SHARED_TIMES_PRUNE_TO) break;
    sharedDriveTimes.delete(h);
  }
}

function loadBundle(value: unknown, loc: string, now: number): number {
  let loaded = 0;
  for (const entry of bundleEntries(value, loc, now)) {
    const expiresAt = entry.at + BANDED_CACHE_TTL_MS;
    const existing = sharedDriveTimes.get(entry.h);
    if (existing && existing.expiresAt >= expiresAt) continue;
    sharedDriveTimes.set(entry.h, { minutes: entry.m, expiresAt });
    loaded += 1;
  }
  pruneSharedDriveTimes(now);
  return loaded;
}

/** A shared time for this exact lookup, moved into the memory cache. undefined when there is none. */
function takeSharedDriveTime(key: string): number | undefined {
  const h = hashKey(key);
  const entry = sharedDriveTimes.get(h);
  if (!entry) return undefined;
  sharedDriveTimes.delete(h);
  if (entry.expiresAt <= Date.now()) return undefined;
  driveCache.set(key, { minutes: entry.minutes, expiresAt: entry.expiresAt });
  return entry.minutes;
}

function trackBackground(work: Promise<unknown>): void {
  const tracked: Promise<void> = work
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      pendingSharedSaves.delete(tracked);
    });
  pendingSharedSaves.add(tracked);
  try {
    waitUntil(tracked);
  } catch {
    /* outside Vercel nothing needs keeping alive */
  }
}

function markRealActivity(now: number): void {
  realActivityUntil = now + REAL_ACTIVITY_TTL_MS;
  if (now - lastActiveWriteAt < ACTIVE_WRITE_EVERY_MS) return;
  lastActiveWriteAt = now;
  trackBackground(sharedSet("active", { at: now }, ACTIVE_MARKER_TTL_S, "drive-active"));
}

async function saveSharedDriveTimes(loc: string, state: LocationState): Promise<void> {
  const syncAt = Date.now();
  const fresh: SharedEntry[] = [];
  let hasNew = false;
  for (const key of state.keys) {
    if (key.endsWith("|live")) continue;
    const hit = driveCache.get(key);
    if (!hit || hit.expiresAt <= syncAt) continue;
    const at = hit.expiresAt - BANDED_CACHE_TTL_MS;
    if (at > state.sharedAt) hasNew = true;
    fresh.push({ h: hashKey(key), m: hit.minutes, at });
  }
  if (!hasNew || !sharedStore()) return;
  const stored = await sharedGet(`bundle|${loc}`);
  if (!sharedStore()) return; // the read timed out: leave the stored bundle alone, a later search retries
  const merged = new Map<string, SharedEntry>();
  for (const entry of bundleEntries(stored, loc, syncAt)) merged.set(entry.h, entry);
  let added = 0;
  let changed = 0;
  for (const entry of fresh) {
    const existing = merged.get(entry.h);
    if (existing && existing.at >= entry.at) continue;
    if (!existing) added += 1;
    changed += 1;
    merged.set(entry.h, entry);
  }
  if (changed > 0) {
    const entries = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES_PER_BUNDLE);
    const bundle: SharedBundle = { v: 1, loc: locTag(loc), entries };
    await sharedSet(`bundle|${loc}`, bundle, SHARED_TTL_S, "drive-times");
    // eslint-disable-next-line no-console
    console.info("[distance] shared drive times saved", { added, total: entries.length });
  }
  state.sharedAt = Math.max(state.sharedAt, syncAt);
}

/** Runs fn and records the drive-time lookups it makes for this lead, so they can be shared. */
export function trackDriveKeys<T>(location: Location, fn: () => Promise<T>): Promise<T> {
  let keys: Set<string> | undefined;
  try {
    keys = locationState(locKey(location)).keys;
  } catch {
    keys = undefined;
  }
  return keys ? driveKeyCollector.run(keys, fn) : fn();
}

/** Loads drive times other server copies saved for this lead. Never throws; waits at most ~0.4 s. */
export async function primeSharedDriveTimes(location: Location): Promise<void> {
  try {
    const startedAt = Date.now();
    if (!warmupContext.getStore()) markRealActivity(startedAt);
    if (!sharedStore()) return;
    const loc = locKey(location);
    locationState(loc);
    const value = await sharedGet(`bundle|${loc}`);
    const loaded = value ? loadBundle(value, loc, Date.now()) : 0;
    // eslint-disable-next-line no-console
    console.info("[distance] shared drive times loaded", { loaded, found: value !== null, ms: Date.now() - startedAt });
  } catch {
    /* optional speed-up only */
  }
}

/** Saves this lead's new visit-time drive times for other server copies, in the background. Never throws. */
export function saveSharedDriveTimesInBackground(location: Location): void {
  try {
    const loc = locKey(location);
    const state = locationState(loc);
    const run: Promise<void> = state.saveChain.then(() => saveSharedDriveTimes(loc, state)).catch(() => undefined);
    state.saveChain = run;
    trackBackground(run);
  } catch {
    /* optional speed-up only */
  }
}

/** Waits for the background saves started on this server copy. */
export async function flushSharedDriveSaves(): Promise<void> {
  await Promise.allSettled([...pendingSharedSaves]);
}

export function runAsWarmup<T>(ctx: WarmupContext, fn: () => Promise<T>): Promise<T> {
  return warmupContext.run(ctx, fn);
}

export function isRealActivityHere(): boolean {
  return realActivityUntil > Date.now();
}

export async function isRealActivityShared(): Promise<boolean> {
  return (await sharedGet("active")) !== null;
}

export function isSharedDriveStoreAvailable(): boolean {
  return sharedStore() !== null;
}

/** False when another server copy already warmed (or is warming) this lead in the last 15 min. */
export async function claimSharedWarm(location: Location): Promise<boolean> {
  try {
    const key = `warm|${locKey(location)}`;
    if ((await sharedGet(key)) !== null) return false;
    await sharedSet(key, { at: Date.now() }, WARM_MARKER_TTL_S, "drive-warm");
    return true;
  } catch {
    return true;
  }
}

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
  const collected = driveKeyCollector.getStore();
  if (collected && collected.size < MAX_KEYS_PER_LOCATION) collected.add(key);
  const hit = driveCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.minutes;
  if (resolved && sharedDriveTimes.size > 0) {
    const shared = takeSharedDriveTime(key);
    if (shared !== undefined) return shared;
  }

  // Same error family as a fresh failure, so callers treat it the same way (the slot is just not offered).
  if (knownUnroutable(origin, destination)) {
    throw new Error("MAP_MATCHING_FAILURE (TomTom): unroutable within the last 10 min, skipped");
  }

  const inflight = inflightDriveRequests.get(key);
  if (inflight) return inflight;

  // A warm-up never starts a new lookup once a lead is waiting (joining one already in flight is fine).
  const warmup = warmupContext.getStore();
  if (warmup?.shouldYield()) throw new WarmupYieldError();
  if (!warmup) markRealActivity(Date.now());

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

  const warmup = warmupContext.getStore();
  if (warmup) warmup.newCalls += 1;
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
