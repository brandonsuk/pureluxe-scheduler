import {
  claimSharedWarm,
  flushSharedDriveSaves,
  isRealActivityHere,
  isRealActivityShared,
  isSharedDriveStoreAvailable,
  runAsWarmup,
  saveSharedDriveTimesInBackground,
  type WarmupContext,
} from "@/lib/distance";
import { findBestSlots } from "@/lib/scheduler";
import type { Location } from "@/lib/types";

// Speed: after a lead's address passes the area check (funnel step 2), look up their visit-time drive times
// in the background and share them, so the slot screen loads without waiting on most TomTom lookups.
// It stops starting new lookups as soon as any real slot search is running.
// Visit mix (last 120 days): 60 min 57%, 30 min 34%, 90 min 10%, so the most likely length goes first.
const WARM_DURATIONS = [60, 30, 90];
const MAX_NEW_CALLS = 60;
const RECENT_MS = 15 * 60 * 1000;
const MAX_STARTS_PER_HOUR = 20;
const POLL_MS = 300;
const SAVE_EVERY_POLLS = 8;
const START_DELAY_MS = 1500;

const recentlyWarmed = new Map<string, number>();
const startTimes: number[] = [];
let running = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function warmDriveTimes(location: Location, options: { startDelayMs?: number } = {}): Promise<void> {
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lng) || running) return;
  const now = Date.now();
  for (const [key, at] of recentlyWarmed) if (now - at >= RECENT_MS) recentlyWarmed.delete(key);
  while (startTimes.length && now - startTimes[0] >= 60 * 60 * 1000) startTimes.shift();
  const key = `${location.lat.toFixed(5)}|${location.lng.toFixed(5)}`; // never logged
  if (recentlyWarmed.has(key) || startTimes.length >= MAX_STARTS_PER_HOUR) return;
  running = true;
  recentlyWarmed.set(key, now);
  startTimes.push(now);

  let stopped = false;
  let poller: ReturnType<typeof setInterval> | undefined;
  const startedAt = Date.now();
  const ctx: WarmupContext = {
    newCalls: 0,
    shouldYield: () => {
      if (!stopped && (isRealActivityHere() || ctx.newCalls >= MAX_NEW_CALLS || !isSharedDriveStoreAvailable())) {
        stopped = true;
      }
      return stopped;
    },
  };
  const skip = (reason: string) => {
    // eslint-disable-next-line no-console
    console.info("[warm] skipped", { reason });
  };

  try {
    await sleep(options.startDelayMs ?? START_DELAY_MS);
    if (!isSharedDriveStoreAvailable()) return skip("store unavailable");
    if (isRealActivityHere() || (await isRealActivityShared())) return skip("lead active");
    if (!(await claimSharedWarm(location))) return skip("already warming");

    let polling = false;
    let ticks = 0;
    poller = setInterval(() => {
      ticks += 1;
      // Partial results reach other server copies sooner.
      if (ticks % SAVE_EVERY_POLLS === 0) saveSharedDriveTimesInBackground(location);
      if (stopped || polling) return;
      polling = true;
      isRealActivityShared()
        .then((active) => {
          if (active) stopped = true;
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, POLL_MS);

    let passes = 0;
    for (const durationMins of WARM_DURATIONS) {
      if (ctx.shouldYield()) break;
      await runAsWarmup(ctx, () => findBestSlots(location, durationMins));
      passes += 1;
    }
    await flushSharedDriveSaves();
    // eslint-disable-next-line no-console
    console.info("[warm] drive times warmed", { passes, ms: Date.now() - startedAt, calls: ctx.newCalls, stopped });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn("[warm] warm-up failed", { message: message.slice(0, 120).replace(/\d/g, "#") });
  } finally {
    if (poller) clearInterval(poller);
    running = false;
  }
}
