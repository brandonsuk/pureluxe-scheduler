import { addDays, format } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDriveMinutes } from "@/lib/distance";
import { findBestSlots } from "@/lib/scheduler";

// In-memory stand-in for the Supabase query builder: filters, sorts and limits rows, and records each query.
const db = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Result = { data: Row[] | null; error: { message: string } | null; count: number | null };
  const state = {
    tables: {} as Record<string, Row[]>,
    queries: [] as { table: string; filters: string[] }[],
    // When true, every date-range read of bookings fails (the per-day reads still work).
    failRangeRead: false,
  };

  class Query {
    private readonly table: string;
    private rows: Row[];
    private readonly filters: string[] = [];
    private readonly sorts: { col: string; asc: boolean }[] = [];
    private max = Number.POSITIVE_INFINITY;
    private counted = false;

    constructor(table: string) {
      this.table = table;
      this.rows = [...(state.tables[table] ?? [])];
      state.queries.push({ table, filters: this.filters });
    }

    select(_cols: string, opts?: { count?: string }) {
      this.counted = Boolean(opts?.count);
      return this;
    }

    eq(col: string, value: unknown) {
      this.filters.push(`eq:${col}`);
      this.rows = this.rows.filter((row) => row[col] === value);
      return this;
    }

    gte(col: string, value: string) {
      this.filters.push(`gte:${col}`);
      this.rows = this.rows.filter((row) => String(row[col]) >= value);
      return this;
    }

    lte(col: string, value: string) {
      this.filters.push(`lte:${col}`);
      this.rows = this.rows.filter((row) => String(row[col]) <= value);
      return this;
    }

    order(col: string, opts?: { ascending?: boolean }) {
      this.sorts.push({ col, asc: opts?.ascending !== false });
      return this;
    }

    limit(n: number) {
      this.max = n;
      return this;
    }

    then<T1 = Result, T2 = never>(
      onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
      onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): Promise<T1 | T2> {
      let result: Result;
      if (state.failRangeRead && this.table !== "working_hour_windows" && this.filters.includes("gte:date")) {
        result = { data: null, error: { message: "test range failure" }, count: null };
      } else {
        const sorted = [...this.rows].sort((a, b) => {
          for (const { col, asc } of this.sorts) {
            const x = String(a[col]);
            const y = String(b[col]);
            if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        result = { data: sorted.slice(0, this.max), error: null, count: this.counted ? this.rows.length : null };
      }
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
  }

  return { state, client: { from: (table: string) => new Query(table) } };
});

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: db.client, supabasePublic: db.client }));
vi.mock("@/lib/distance", () => ({
  getDriveMinutes: vi.fn(async () => 10),
  primeSharedDriveTimes: vi.fn(async () => {}),
  saveSharedDriveTimesInBackground: vi.fn(),
  trackDriveKeys: vi.fn((_location: unknown, fn: () => Promise<unknown>) => fn()),
}));

const mocked = vi.mocked(getDriveMinutes);
const location = { lat: 55.8, lng: -3.8 };
const FIRST = "2030-01-07"; // a Monday, far enough ahead that the 12-hour lead time never applies

type Booking = { id: string; date: string; start_time: string; end_time: string; lat: number; lng: number };

function isoDates(n: number): string[] {
  return Array.from({ length: n }, (_, i) => format(addDays(new Date(`${FIRST}T12:00:00`), i), "yyyy-MM-dd"));
}

function openWindows(dates: string[], start = "09:00", end = "18:00") {
  db.state.tables.working_hour_windows = dates.map((date, i) => ({
    id: `w${i}`,
    date,
    start_time: start,
    end_time: end,
    is_available: true,
    source: "google_open_slots",
    google_event_id: null,
  }));
}

// Confirmed visits 09:00-12:00 on the first 5 days, plus a calendar blocker 12:00-14:00 on day 2.
function addBookings(dates: string[]): Booking[] {
  const appointments = dates.slice(0, 5).map((date, i) => ({
    id: `a${i}`,
    date,
    start_time: "09:00",
    end_time: "12:00",
    lat: 55.81,
    lng: -3.81,
  }));
  const blockers = [{ id: "b1", date: dates[1], start_time: "12:00", end_time: "14:00", lat: 55.82, lng: -3.82 }];
  db.state.tables.appointments = appointments.map((row) => ({ ...row, status: "confirmed" }));
  db.state.tables.calendar_blockers = blockers;
  return [...appointments, ...blockers];
}

// Drive minutes by visit date (all legs of a visit carry its date).
function driveByDate(minsFor: (date: string) => number) {
  mocked.mockImplementation(async (_origin, _destination, departure) => minsFor(departure?.date ?? ""));
}

function datesLookedUp(): Set<string> {
  return new Set(mocked.mock.calls.map((call) => call[2]?.date ?? ""));
}

function lastDayLookedUp(dates: string[]): number {
  return Math.max(...[...datesLookedUp()].map((date) => dates.indexOf(date)));
}

function distinctDays(slots: { date: string }[]): number {
  return new Set(slots.map((slot) => slot.date)).size;
}

beforeEach(() => {
  db.state.tables = { working_hour_windows: [], appointments: [], calendar_blockers: [] };
  db.state.queries = [];
  db.state.failRangeRead = false;
  mocked.mockReset();
  mocked.mockImplementation(async () => 10);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findBestSlots day spread", () => {
  it("keeps looking past the 120-check mark until the picks cover 4 days", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    const outOfRange = new Set(dates.slice(0, 3));
    driveByDate((date) => (outOfRange.has(date) ? 99 : 10));

    const { featured_slots } = await findBestSlots(location, 60, FIRST);

    // The old stop (120 checks) fell on day 4, so this gave 2 picks on 1 day.
    expect(featured_slots).toHaveLength(5);
    expect(new Set(featured_slots.map((slot) => slot.date))).toEqual(new Set(dates.slice(3, 7)));
    expect(lastDayLookedUp(dates)).toBe(6);
  });

  it("stops on the same day as before when the first days already cover 4 days", async () => {
    const dates = isoDates(20);
    openWindows(dates);

    const { featured_slots } = await findBestSlots(location, 60, FIRST);

    expect(featured_slots).toHaveLength(5);
    expect(distinctDays(featured_slots)).toBe(4);
    expect(lastDayLookedUp(dates)).toBe(3);
  });

  it("returns no picks, without hanging, when no day is in range", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    driveByDate(() => 99);

    const { featured_slots } = await findBestSlots(location, 60, FIRST);

    expect(featured_slots).toEqual([]);
    expect(datesLookedUp().size).toBe(20);
  });

  it("still stops after 14 days with slots", async () => {
    const dates = isoDates(20);
    openWindows(dates, "09:00", "09:30"); // 3 start times a day, so the 120-check mark is never reached

    await findBestSlots(location, 60, FIRST);

    expect(lastDayLookedUp(dates)).toBe(13);
  });

  it("stops looking for more days once the request has run 10 s past the 120-check mark", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    const realNow = Date.now();
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow + clock);
    mocked.mockImplementation(async (_origin, _destination, departure) => {
      clock += 100; // each drive lookup takes 100 ms
      return departure?.date === dates[0] ? 10 : 99;
    });

    const { featured_slots } = await findBestSlots(location, 60, FIRST);

    // Only day 1 is in range. Day 4 takes the run past 120 checks and past 10 s, so it stops there.
    expect(lastDayLookedUp(dates)).toBe(3);
    expect(featured_slots.length).toBeGreaterThan(0);
    expect(featured_slots.every((slot) => slot.date === dates[0])).toBe(true);
  });

  it("without the time limit, the same setup keeps looking to the end of the window", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    driveByDate((date) => (date === dates[0] ? 10 : 99));

    await findBestSlots(location, 60, FIRST);

    expect(lastDayLookedUp(dates)).toBe(19);
  });
});

describe("findBestSlots bookings read", () => {
  it("reads every day's bookings in one range read and never picks over them", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    const bookings = addBookings(dates);

    const { featured_slots } = await findBestSlots(location, 60, FIRST);

    expect(featured_slots.length).toBeGreaterThan(0);
    for (const slot of featured_slots) {
      for (const block of bookings.filter((b) => b.date === slot.date)) {
        expect(slot.start_time >= block.end_time || slot.end_time <= block.start_time).toBe(true);
      }
    }
    const appointmentReads = db.state.queries.filter((q) => q.table === "appointments");
    expect(appointmentReads).toHaveLength(1);
    expect(appointmentReads[0].filters).toEqual(expect.arrayContaining(["gte:date", "lte:date", "eq:status"]));
    expect(db.state.queries.filter((q) => q.table === "calendar_blockers")).toHaveLength(1);
    expect(db.state.queries.some((q) => q.filters.includes("eq:date"))).toBe(false);
  });

  it("falls back to per-day reads, with the same picks, when the range read fails", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    addBookings(dates);
    const normal = await findBestSlots(location, 60, FIRST);

    db.state.queries = [];
    db.state.failRangeRead = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = await findBestSlots(location, 60, FIRST);

    expect(fallback.featured_slots).toEqual(normal.featured_slots);
    expect(warn).toHaveBeenCalled();
    expect(db.state.queries.some((q) => q.table === "appointments" && q.filters.includes("eq:date"))).toBe(true);
  });
});

describe("findBestSlots 5 more", () => {
  const keyOf = (slot: { date: string; start_time: string }) => `${slot.date} ${slot.start_time.slice(0, 5)}`;
  const minsOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const onScreen = (slots: { date: string; start_time: string }[]) =>
    slots.map(({ date, start_time }) => ({ date, start_time }));

  it("never repeats a time on screen, keeps 2 a day and an hour apart across all 10", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    addBookings(dates);
    const first = await findBestSlots(location, 60, FIRST);

    const more = await findBestSlots(location, 60, FIRST, undefined, onScreen(first.featured_slots));

    expect(first.featured_slots).toHaveLength(5);
    expect(more.featured_slots).toHaveLength(5);
    const shownKeys = new Set(first.featured_slots.map(keyOf));
    expect(more.featured_slots.some((slot) => shownKeys.has(keyOf(slot)))).toBe(false);
    const all = [...first.featured_slots, ...more.featured_slots];
    const perDay = new Map<string, string[]>();
    for (const slot of all) perDay.set(slot.date, [...(perDay.get(slot.date) ?? []), slot.start_time]);
    for (const times of perDay.values()) {
      expect(times.length).toBeLessThanOrEqual(2);
      if (times.length === 2) expect(Math.abs(minsOf(times[0]) - minsOf(times[1]))).toBeGreaterThanOrEqual(60);
    }
  });

  it("looks past the days on screen until 4 new days have slots, and picks those days", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    const first = await findBestSlots(location, 60, FIRST);
    expect(new Set(first.featured_slots.map((slot) => slot.date))).toEqual(new Set(dates.slice(0, 4)));

    mocked.mockClear();
    const more = await findBestSlots(location, 60, FIRST, undefined, onScreen(first.featured_slots));

    // The first 5 stopped after day 4 (index 3). The next 5 need days 5-8 too.
    expect(lastDayLookedUp(dates)).toBe(7);
    const newDays = new Set(more.featured_slots.map((slot) => slot.date).filter((date) => !dates.slice(0, 4).includes(date)));
    expect(newDays).toEqual(new Set(dates.slice(4, 8)));
    expect(more.featured_slots.filter((slot) => newDays.has(slot.date)).length).toBeGreaterThanOrEqual(4);
  });

  it("keeps an hour away from a time on screen on the same day, even when short of slots", async () => {
    const dates = isoDates(1);
    openWindows(dates, "11:00", "13:30"); // 60-min visits can start 11:00 to 12:30

    const more = await findBestSlots(location, 60, FIRST, undefined, [{ date: dates[0], start_time: "12:00" }]);

    // 12:00 is on screen, so 11:15 to 12:30 are too close; 2 a day means only one more.
    expect(onScreen(more.featured_slots)).toEqual([{ date: dates[0], start_time: "11:00" }]);
  });

  it("returns nothing when the days on screen are full and no other day has room", async () => {
    const dates = isoDates(2);
    openWindows(dates);
    const first = await findBestSlots(location, 60, FIRST);
    expect(first.featured_slots).toHaveLength(4);

    const more = await findBestSlots(location, 60, FIRST, undefined, onScreen(first.featured_slots));

    expect(more.featured_slots).toEqual([]);
  });

  it("gives exactly the normal picks when nothing is on screen", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    addBookings(dates);
    const normal = await findBestSlots(location, 60, FIRST);

    expect((await findBestSlots(location, 60, FIRST, undefined, [])).featured_slots).toEqual(normal.featured_slots);
    expect((await findBestSlots(location, 60, FIRST, undefined, undefined)).featured_slots).toEqual(normal.featured_slots);
  });

  it("accepts on-screen times with or without seconds", async () => {
    const dates = isoDates(20);
    openWindows(dates);
    const first = await findBestSlots(location, 60, FIRST);
    const withSeconds = first.featured_slots.map(({ date, start_time }) => ({ date, start_time: `${start_time.slice(0, 5)}:00` }));

    const a = await findBestSlots(location, 60, FIRST, undefined, onScreen(first.featured_slots));
    const b = await findBestSlots(location, 60, FIRST, undefined, withSeconds);

    expect(b.featured_slots).toEqual(a.featured_slots);
    const shownKeys = new Set(first.featured_slots.map(keyOf));
    expect(b.featured_slots.some((slot) => shownKeys.has(keyOf(slot)))).toBe(false);
  });
});
