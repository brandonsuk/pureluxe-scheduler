import { describe, expect, it, vi } from "vitest";
import { validateCandidateSlot } from "@/lib/scheduler";

vi.mock("@/lib/distance", () => ({
  getDriveMinutes: vi.fn(async () => 10),
}));

describe("validateCandidateSlot", () => {
  it("rejects overlapping candidate", async () => {
    const result = await validateCandidateSlot(
      {
        date: "2026-03-10",
        start_time: "10:15",
        duration_mins: 30,
        location: { lat: 55.8, lng: -3.8 },
      },
      [
        {
          id: "a1",
          date: "2026-03-10",
          start_time: "10:00",
          end_time: "10:30",
          lat: 55.81,
          lng: -3.81,
        },
      ],
    );

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("overlap");
  });

  it("accepts feasible non-overlapping candidate", async () => {
    const result = await validateCandidateSlot(
      {
        date: "2026-03-10",
        start_time: "11:00",
        duration_mins: 30,
        location: { lat: 55.8, lng: -3.8 },
      },
      [
        {
          id: "a1",
          date: "2026-03-10",
          start_time: "10:00",
          end_time: "10:30",
          lat: 55.81,
          lng: -3.81,
        },
        {
          id: "a2",
          date: "2026-03-10",
          start_time: "13:00",
          end_time: "13:30",
          lat: 55.82,
          lng: -3.82,
        },
      ],
    );

    expect(result.valid).toBe(true);
    expect(typeof result.score).toBe("number");
  });
});
