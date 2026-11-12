import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDriveMinutes } from "@/lib/distance";

vi.mock("@/lib/env", () => ({
  env: { tomtomApiKey: "test-key", distanceProvider: "tomtom", googleMapsApiKey: "" },
}));

type Pt = { lat: number; lng: number };
type Call = { origin: Pt; destination: Pt };
type Reply = (call: Call, n: number) => Response;

// Synthetic points; every test uses its own so the module-level caches never overlap between tests.
const pt = (i: number, j = 0): Pt => ({ lat: 56 + i / 100, lng: -4 - j / 100 });
const weekday = (time: string) => ({ date: "2026-11-16", time });

const calls: Call[] = [];
let reply: Reply = () => ok(600);

function ok(seconds: number) {
  return new Response(JSON.stringify({ routes: [{ summary: { travelTimeInSeconds: seconds } }] }), { status: 200 });
}

// Shape of TomTom's routing error body: the code, then a message that names the end it could not match.
function mapMatchFail(end: "Origin" | "Destination" | null) {
  const message = `Engine error while executing route request: MAP_MATCHING_FAILURE${end ? `: ${end} (56.12345, -4.12345)` : ""}`;
  return new Response(JSON.stringify({ detailedError: { code: "MAP_MATCHING_FAILURE", message } }), { status: 400 });
}

function parse(url: string): Call {
  const m = /calculateRoute\/([-\d.]+),([-\d.]+):([-\d.]+),([-\d.]+)\/json/.exec(url);
  if (!m) throw new Error(`unexpected url ${url}`);
  return { origin: { lat: Number(m[1]), lng: Number(m[2]) }, destination: { lat: Number(m[3]), lng: Number(m[4]) } };
}

async function run<T>(p: Promise<T>): Promise<T | Error> {
  const settled = p.then(
    (v) => v,
    (e: Error) => e,
  );
  await vi.runAllTimersAsync();
  return settled;
}

function callsDuring() {
  const start = calls.length;
  return () => calls.slice(start);
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const call = parse(url);
      calls.push(call);
      return reply(call, calls.length);
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TomTom retry cap", () => {
  it("stops after 12 nudges of the named end and then skips that address in any route", async () => {
    const home = pt(1);
    const lead = pt(2);
    reply = () => mapMatchFail("Destination");

    const first = callsDuring();
    expect(await run(getDriveMinutes(home, lead, weekday("10:00")))).toBeInstanceOf(Error);
    const made = first();
    expect(made).toHaveLength(13);
    for (const c of made) expect(c.origin).toEqual(home);
    // Nearest first: a longitude step is shorter than a latitude step this far north.
    expect(made[1].destination).toEqual({ lat: lead.lat, lng: Number((lead.lng + 0.0008).toFixed(6)) });
    expect(made[3].destination).toEqual({ lat: Number((lead.lat + 0.0008).toFixed(6)), lng: lead.lng });
    expect(made[12].destination).toEqual({ lat: Number((lead.lat - 0.005).toFixed(6)), lng: lead.lng });

    const otherBand = callsDuring();
    expect(await run(getDriveMinutes(home, lead, weekday("17:00")))).toBeInstanceOf(Error);
    expect(otherBand()).toHaveLength(0);

    const otherOrigin = callsDuring();
    expect(await run(getDriveMinutes(pt(3), lead, weekday("10:00")))).toBeInstanceOf(Error);
    expect(await run(getDriveMinutes(lead, pt(3), weekday("10:00")))).toBeInstanceOf(Error);
    expect(otherOrigin()).toHaveLength(0);

    const log = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(log).toContain('"scope":"address"');
    expect(log).not.toMatch(/\d+\.\d{3}/); // no coordinates in logs
  });

  it("stops at a rate limit and does not remember the failure", async () => {
    const a = pt(4);
    const b = pt(5);
    reply = (_c, n) => (n === 1 ? mapMatchFail("Destination") : new Response("Too Many Requests", { status: 429 }));

    const first = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBeInstanceOf(Error);
    expect(first()).toHaveLength(2);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain('"status":"429"');

    reply = () => ok(300);
    const again = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBe(5);
    expect(again()).toHaveLength(1);
  });

  it("returns the first nudge that matches and caches it for the band", async () => {
    const a = pt(6);
    const b = pt(7);
    let n = 0;
    reply = () => (++n === 4 ? ok(600) : mapMatchFail("Destination"));

    const first = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBe(10);
    expect(first()).toHaveLength(4);

    const again = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("11:00")))).toBe(10);
    expect(again()).toHaveLength(0);
  });

  it("alternates both ends when TomTom names neither, and only skips that route", async () => {
    const a = pt(8);
    const b = pt(9);
    reply = () => mapMatchFail(null);

    const first = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBeInstanceOf(Error);
    const made = first();
    expect(made).toHaveLength(13);
    expect(made[1]).toMatchObject({ origin: a });
    expect(made[1].destination).not.toEqual(b);
    expect(made[2]).toMatchObject({ destination: b });
    expect(made[2].origin).not.toEqual(a);

    const sameRoute = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("16:00")))).toBeInstanceOf(Error);
    expect(sameRoute()).toHaveLength(0);

    reply = () => ok(900);
    const otherRoute = callsDuring();
    expect(await run(getDriveMinutes(pt(10), b, weekday("10:00")))).toBe(15);
    expect(otherRoute()).toHaveLength(1);

    const log = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(log).toContain('"scope":"route"');
    expect(log).toContain('"hint":"MAP_MATCHING_FAILURE');
    expect(log).not.toMatch(/\d+\.\d{3}/);
  });

  it("only skips the route when the nudges fail at the other end", async () => {
    const a = pt(11);
    const b = pt(12);
    let n = 0;
    reply = () => mapMatchFail(++n === 1 ? "Destination" : "Origin");

    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBeInstanceOf(Error);

    reply = () => ok(1200);
    const otherOrigin = callsDuring();
    expect(await run(getDriveMinutes(pt(13), b, weekday("10:00")))).toBe(20);
    expect(otherOrigin()).toHaveLength(1);
  });

  it("tries the route again after 10 minutes", async () => {
    const a = pt(14);
    const b = pt(15);
    reply = () => mapMatchFail("Destination");
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBeInstanceOf(Error);

    vi.advanceTimersByTime(10 * 60 * 1000 - 1000);
    const stillSkipped = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBeInstanceOf(Error);
    expect(stillSkipped()).toHaveLength(0);

    vi.advanceTimersByTime(60 * 1000);
    reply = () => ok(600);
    const retried = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBe(10);
    expect(retried()).toHaveLength(1);
  });

  it("leaves other TomTom errors as they were: no nudging, no caching", async () => {
    const a = pt(16);
    const b = pt(17);
    reply = () => new Response("Internal error", { status: 500 });

    const first = callsDuring();
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBeInstanceOf(Error);
    expect(first()).toHaveLength(1);

    reply = () => ok(600);
    expect(await run(getDriveMinutes(a, b, weekday("10:00")))).toBe(10);
  });
});
