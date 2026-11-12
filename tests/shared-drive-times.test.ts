import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { tomtomApiKey: "test-key", distanceProvider: "tomtom", googleMapsApiKey: "" },
}));

// A stand-in for Vercel's Runtime Cache, shared by every "server copy" (fresh module import) in a test.
// It never expires entries itself, so the 6 h check on stored drive times is tested on its own.
const cache = vi.hoisted(() => ({
  store: new Map<string, string>(),
  names: [] as string[],
  gets: 0,
  sets: 0,
  getCacheCalls: 0,
  failGet: false,
  hangGet: false,
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: () => {},
  getCache: (options: { namespace?: string; keyHashFunction?: (key: string) => string }) => {
    cache.getCacheCalls += 1;
    const fullKey = (key: string) => `${options.namespace}$${options.keyHashFunction ? options.keyHashFunction(key) : key}`;
    return {
      get: async (key: string) => {
        cache.gets += 1;
        if (cache.hangGet) return new Promise(() => {});
        if (cache.failGet) throw new Error("cache down");
        const raw = cache.store.get(fullKey(key));
        return raw === undefined ? null : JSON.parse(raw);
      },
      set: async (key: string, value: unknown, setOptions?: { ttl?: number; name?: string }) => {
        cache.sets += 1;
        cache.names.push(setOptions?.name ?? "(no name)");
        cache.store.set(fullKey(key), JSON.stringify(value));
      },
    };
  },
}));

type Pt = { lat: number; lng: number };
type Distance = typeof import("@/lib/distance");

// Synthetic points only.
const pt = (i: number, j = 0): Pt => ({ lat: 56 + i / 100, lng: -4 - j / 100 });
const weekday = (time: string) => ({ date: "2026-11-16", time });
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

let fetches = 0;

function ok(seconds: number) {
  return new Response(JSON.stringify({ routes: [{ summary: { travelTimeInSeconds: seconds } }] }), { status: 200 });
}

async function run<T>(p: Promise<T>): Promise<T | Error> {
  const settled = p.then(
    (v) => v,
    (e: Error) => e,
  );
  await vi.runAllTimersAsync();
  return settled;
}

/** A new server copy: fresh module state, same shared cache. */
async function freshCopy(): Promise<Distance> {
  vi.resetModules();
  return import("@/lib/distance");
}

/** One real slot search for this lead: load shared times, look up one visit-time drive, save. */
async function search(copy: Distance, home: Pt, lead: Pt, time = "10:00") {
  await run(copy.primeSharedDriveTimes(lead));
  const minutes = await run(copy.trackDriveKeys(lead, () => copy.getDriveMinutes(home, lead, weekday(time))));
  copy.saveSharedDriveTimesInBackground(lead);
  await run(copy.flushSharedDriveSaves());
  return minutes;
}

const driveTimeWrites = () => cache.names.filter((n) => n === "drive-times").length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T09:00:00Z"));
  cache.store.clear();
  cache.names.length = 0;
  cache.gets = 0;
  cache.sets = 0;
  cache.getCacheCalls = 0;
  cache.failGet = false;
  cache.hangGet = false;
  fetches = 0;
  vi.stubEnv("RUNTIME_CACHE_ENDPOINT", "https://runtime-cache.test");
  vi.stubEnv("RUNTIME_CACHE_HEADERS", "{}");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetches += 1;
      return ok(600);
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared drive times", () => {
  it("lets a second server copy reuse a drive time without a new TomTom call, storing only hashes", async () => {
    const home = pt(1);
    const lead = pt(2);

    const a = await freshCopy();
    expect(await search(a, home, lead)).toBe(10);
    expect(fetches).toBe(1);
    expect(driveTimeWrites()).toBe(1);

    const b = await freshCopy();
    await run(b.primeSharedDriveTimes(lead));
    expect(await run(b.getDriveMinutes(home, lead, weekday("10:00")))).toBe(10);
    expect(fetches).toBe(1);

    // Privacy: no readable coordinates in any stored key or value, and every write carries a generic name.
    for (const [key, value] of cache.store) {
      expect(key).not.toMatch(/56\.|-4\./);
      expect(value).not.toMatch(/56\.|-4\./);
    }
    expect(new Set(cache.names)).toEqual(new Set(["drive-active", "drive-times"]));
  });

  it("is off without the platform cache (no env, no request context) and never builds a store", async () => {
    vi.unstubAllEnvs();
    const a = await freshCopy();
    expect(a.isSharedDriveStoreAvailable()).toBe(false);
    expect(await search(a, pt(3), pt(4))).toBe(10);
    expect(cache.getCacheCalls).toBe(0);
    expect(cache.sets).toBe(0);
  });

  it("is on when the request context carries the platform cache", async () => {
    vi.unstubAllEnvs();
    (globalThis as unknown as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ cache: {} }) };
    const a = await freshCopy();
    expect(a.isSharedDriveStoreAvailable()).toBe(true);
  });

  it("pauses for 60 s when a read hangs, and the search still answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cache.hangGet = true;
    const a = await freshCopy();
    expect(await search(a, pt(5), pt(6))).toBe(10);
    expect(warn).toHaveBeenCalledWith("[distance] shared drive store paused for 60 s", { reason: "read timed out" });
    expect(a.isSharedDriveStoreAvailable()).toBe(false);

    const getsWhilePaused = cache.gets;
    await run(a.primeSharedDriveTimes(pt(6)));
    expect(cache.gets).toBe(getsWhilePaused);

    cache.hangGet = false;
    vi.advanceTimersByTime(60_001);
    expect(a.isSharedDriveStoreAvailable()).toBe(true);
  });

  it("treats a failing read as no data", async () => {
    cache.failGet = true;
    const a = await freshCopy();
    expect(await search(a, pt(7), pt(8))).toBe(10);
    expect(a.isSharedDriveStoreAvailable()).toBe(false);
  });

  it("ignores stored drive times older than 6 hours", async () => {
    const home = pt(9);
    const lead = pt(10);
    await search(await freshCopy(), home, lead);
    expect(fetches).toBe(1);

    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 60_000);
    const b = await freshCopy();
    await run(b.primeSharedDriveTimes(lead));
    expect(await run(b.getDriveMinutes(home, lead, weekday("10:00")))).toBe(10);
    expect(fetches).toBe(2);
  });

  it("writes the bundle only when something new was looked up", async () => {
    const home = pt(11);
    const lead = pt(12);
    const a = await freshCopy();
    await search(a, home, lead);
    expect(driveTimeWrites()).toBe(1);

    // Same copy, nothing new.
    a.saveSharedDriveTimesInBackground(lead);
    await run(a.flushSharedDriveSaves());
    expect(driveTimeWrites()).toBe(1);

    // Another copy that only reused the shared time.
    await search(await freshCopy(), home, lead);
    expect(fetches).toBe(1);
    expect(driveTimeWrites()).toBe(1);

    // A new lookup for the same lead adds to the bundle.
    vi.setSystemTime(Date.now() + 1_000);
    await search(a, home, lead, "16:00");
    expect(fetches).toBe(2);
    expect(driveTimeWrites()).toBe(2);
  });

  it("never shares live (non-banded) drive times", async () => {
    const lead = pt(14);
    const a = await freshCopy();
    await run(a.primeSharedDriveTimes(lead));
    await run(a.trackDriveKeys(lead, () => a.getDriveMinutes(pt(13), lead)));
    a.saveSharedDriveTimesInBackground(lead);
    await run(a.flushSharedDriveSaves());
    expect(driveTimeWrites()).toBe(0);
  });

  it("a yielding warm-up still answers from memory but starts no new lookup", async () => {
    const home = pt(15);
    const lead = pt(16);
    const a = await freshCopy();
    await run(a.getDriveMinutes(home, lead, weekday("10:00")));
    expect(fetches).toBe(1);

    const ctx = { shouldYield: () => true, newCalls: 0 };
    expect(await run(a.runAsWarmup(ctx, () => a.getDriveMinutes(home, lead, weekday("10:00"))))).toBe(10);
    const miss = await run(a.runAsWarmup(ctx, () => a.getDriveMinutes(home, pt(17), weekday("10:00"))));
    expect(miss).toBeInstanceOf(a.WarmupYieldError);
    expect(fetches).toBe(1);
    expect(ctx.newCalls).toBe(0);
  });

  it("a real search joins a warm-up's lookup already in flight", async () => {
    const home = pt(18);
    const lead = pt(19);
    const a = await freshCopy();
    const ctx = { shouldYield: () => false, newCalls: 0 };
    const warm = a.runAsWarmup(ctx, () => a.getDriveMinutes(home, lead, weekday("10:00")));
    const real = a.getDriveMinutes(home, lead, weekday("10:00"));
    expect(await run(Promise.all([warm, real]))).toEqual([10, 10]);
    expect(fetches).toBe(1);
    expect(ctx.newCalls).toBe(1);
  });

  it("only one server copy claims the warm-up for a lead", async () => {
    const lead = pt(20);
    expect(await run((await freshCopy()).claimSharedWarm(lead))).toBe(true);
    expect(await run((await freshCopy()).claimSharedWarm(lead))).toBe(false);
  });

  it("a real search marks itself active for other copies; a warm-up does not", async () => {
    const lead = pt(21);
    const a = await freshCopy();
    const b = await freshCopy();
    await run(b.runAsWarmup({ shouldYield: () => false, newCalls: 0 }, () => b.primeSharedDriveTimes(lead)));
    expect(await run(b.isRealActivityShared())).toBe(false);
    expect(b.isRealActivityHere()).toBe(false);

    await run(a.primeSharedDriveTimes(lead));
    expect(a.isRealActivityHere()).toBe(true);
    expect(await run(b.isRealActivityShared())).toBe(true);
  });
});
