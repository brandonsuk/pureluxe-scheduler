import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Ctx = { newCalls: number; shouldYield: () => boolean };

const state = vi.hoisted(() => ({
  available: true,
  activeHere: false,
  activeShared: false,
  claim: true,
  durations: [] as number[],
  ctx: undefined as Ctx | undefined,
  onPass: undefined as ((durationMins: number) => Promise<void> | void) | undefined,
  fail: false,
  flushes: 0,
  saves: 0,
}));

vi.mock("@/lib/distance", () => ({
  claimSharedWarm: async () => state.claim,
  flushSharedDriveSaves: async () => {
    state.flushes += 1;
  },
  isRealActivityHere: () => state.activeHere,
  isRealActivityShared: async () => state.activeShared,
  isSharedDriveStoreAvailable: () => state.available,
  runAsWarmup: (ctx: Ctx, fn: () => Promise<unknown>) => {
    state.ctx = ctx;
    return fn();
  },
  saveSharedDriveTimesInBackground: () => {
    state.saves += 1;
  },
}));

vi.mock("@/lib/scheduler", () => ({
  findBestSlots: async (_location: unknown, durationMins: number) => {
    state.durations.push(durationMins);
    if (state.fail) throw new Error("boom 123");
    await state.onPass?.(durationMins);
    return { featured_slots: [], all_slots: {} };
  },
}));

type Warm = typeof import("@/lib/warm-drive-times");

// Synthetic points only.
const at = (i: number) => ({ lat: 56 + i / 1000, lng: -4 });

async function fresh(): Promise<Warm> {
  vi.resetModules();
  return import("@/lib/warm-drive-times");
}

async function warm(mod: Warm, location = at(0)) {
  const done = mod.warmDriveTimes(location, { startDelayMs: 0 });
  await vi.runAllTimersAsync();
  await done;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T09:00:00Z"));
  Object.assign(state, {
    available: true,
    activeHere: false,
    activeShared: false,
    claim: true,
    durations: [],
    ctx: undefined,
    onPass: undefined,
    fail: false,
    flushes: 0,
    saves: 0,
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("warmDriveTimes", () => {
  it("warms the likeliest visit length first, then 30 and 90 min", async () => {
    await warm(await fresh());
    expect(state.durations).toEqual([60, 30, 90]);
    expect(state.flushes).toBe(1);
    expect(console.info).toHaveBeenCalledWith(
      "[warm] drive times warmed",
      expect.objectContaining({ passes: 3, calls: 0, stopped: false }),
    );
  });

  it("ignores a bad location without logging", async () => {
    await warm(await fresh(), { lat: Number.NaN, lng: -4 });
    expect(state.durations).toEqual([]);
    expect(console.info).not.toHaveBeenCalled();
  });

  it("skips when the shared store is unavailable", async () => {
    state.available = false;
    await warm(await fresh());
    expect(state.durations).toEqual([]);
    expect(console.info).toHaveBeenCalledWith("[warm] skipped", { reason: "store unavailable" });
  });

  it("skips while a lead is searching on this copy or another", async () => {
    state.activeHere = true;
    await warm(await fresh());
    state.activeHere = false;
    state.activeShared = true;
    await warm(await fresh());
    expect(state.durations).toEqual([]);
    expect(vi.mocked(console.info).mock.calls).toEqual([
      ["[warm] skipped", { reason: "lead active" }],
      ["[warm] skipped", { reason: "lead active" }],
    ]);
  });

  it("skips when another copy already warmed this lead", async () => {
    state.claim = false;
    await warm(await fresh());
    expect(state.durations).toEqual([]);
    expect(console.info).toHaveBeenCalledWith("[warm] skipped", { reason: "already warming" });
  });

  it("warms the same address at most once per 15 minutes", async () => {
    const mod = await fresh();
    await warm(mod);
    await warm(mod);
    expect(state.durations).toEqual([60, 30, 90]);
    vi.setSystemTime(Date.now() + 15 * 60 * 1000);
    await warm(mod);
    expect(state.durations).toHaveLength(6);
  });

  it("starts at most 20 warm-ups an hour", async () => {
    const mod = await fresh();
    for (let i = 0; i < 20; i += 1) await warm(mod, at(i));
    expect(state.durations).toHaveLength(60);
    await warm(mod, at(20));
    expect(state.durations).toHaveLength(60);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await warm(mod, at(21));
    expect(state.durations).toHaveLength(63);
  });

  it("ignores a second call while one is running", async () => {
    const mod = await fresh();
    const first = mod.warmDriveTimes(at(0), { startDelayMs: 0 });
    const second = mod.warmDriveTimes(at(1), { startDelayMs: 0 });
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(state.durations).toEqual([60, 30, 90]);
    await warm(mod, at(2));
    expect(state.durations).toHaveLength(6);
  });

  it("stops after the current pass once a lead starts searching on another copy", async () => {
    state.onPass = async (durationMins) => {
      if (durationMins !== 60) return;
      state.activeShared = true;
      await sleep(400); // the 300 ms poll sees the lead during this pass
    };
    await warm(await fresh());
    expect(state.durations).toEqual([60]);
    expect(console.info).toHaveBeenCalledWith(
      "[warm] drive times warmed",
      expect.objectContaining({ passes: 1, stopped: true }),
    );
  });

  it("shares partial results every 8 polls during a long pass", async () => {
    state.onPass = async (durationMins) => {
      if (durationMins === 60) await sleep(2500);
    };
    await warm(await fresh());
    expect(state.durations).toEqual([60, 30, 90]);
    expect(state.saves).toBe(1);
  });

  it("stops at the TomTom call cap", async () => {
    state.onPass = (durationMins) => {
      if (durationMins === 60 && state.ctx) state.ctx.newCalls = 60;
    };
    await warm(await fresh());
    expect(state.durations).toEqual([60]);
    expect(console.info).toHaveBeenCalledWith(
      "[warm] drive times warmed",
      expect.objectContaining({ passes: 1, calls: 60, stopped: true }),
    );
  });

  it("logs a failure without digits and still allows the next warm-up", async () => {
    const mod = await fresh();
    state.fail = true;
    await warm(mod);
    expect(console.warn).toHaveBeenCalledWith("[warm] warm-up failed", { message: "boom ###" });
    state.fail = false;
    await warm(mod, at(1));
    expect(state.durations).toEqual([60, 60, 30, 90]);
  });
});
