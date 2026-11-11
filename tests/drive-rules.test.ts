import { describe, expect, it, vi, beforeEach } from "vitest";
import { getDriveMinutes } from "@/lib/distance";
import { validateCandidateSlot } from "@/lib/scheduler";

vi.mock("@/lib/distance", () => ({
  getDriveMinutes: vi.fn(async () => 10),
}));

const far = { lat: 55.94, lng: -4.32 }; // Milngavie-ish
const near = { lat: 55.78, lng: -4.04 }; // Hamilton-ish
const mocked = vi.mocked(getDriveMinutes);

function driveTimes(fromHome: number, jobToJob: number, toHome: number) {
  mocked.mockImplementation(async (o, d) => {
    if (o.lat === far.lat && d.lat === far.lat) return 0;
    const home = (p: { lat: number }) => p.lat !== far.lat && p.lat !== near.lat;
    if (home(o)) return fromHome;
    if (home(d)) return toHome;
    return jobToJob;
  });
}

beforeEach(() => {
  mocked.mockReset();
});

describe("edge-leg drive cap", () => {
  it("allows a 48 min first and last leg on an empty day", async () => {
    driveTimes(48, 0, 48);
    const r = await validateCandidateSlot({ date: "2026-11-16", start_time: "10:00", duration_mins: 60, location: far }, []);
    expect(r.valid).toBe(true);
  });

  it("rejects a 55 min first leg", async () => {
    driveTimes(55, 0, 30);
    const r = await validateCandidateSlot({ date: "2026-11-16", start_time: "10:00", duration_mins: 60, location: far }, []);
    expect(r).toMatchObject({ valid: false, reason: "max_drive" });
  });

  it("keeps the 40 min cap between jobs", async () => {
    driveTimes(20, 45, 45);
    const r = await validateCandidateSlot(
      { date: "2026-11-16", start_time: "12:00", duration_mins: 60, location: far },
      [{ id: "a", date: "2026-11-16", start_time: "10:00", end_time: "11:00", lat: near.lat, lng: near.lng }],
    );
    expect(r).toMatchObject({ valid: false, reason: "max_drive" });
  });

  it("passes the visit-time departure to each leg", async () => {
    driveTimes(30, 20, 30);
    await validateCandidateSlot(
      { date: "2026-11-16", start_time: "12:00", duration_mins: 60, location: far },
      [{ id: "a", date: "2026-11-16", start_time: "10:00", end_time: "11:00", lat: near.lat, lng: near.lng }],
    );
    const departs = mocked.mock.calls.map((c) => c[2]?.time);
    expect(departs).toContain("11:00"); // from previous visit, leaves when it ends
    expect(departs).toContain("13:00"); // home leg, leaves when this visit ends
  });
});
