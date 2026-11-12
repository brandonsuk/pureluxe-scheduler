import { describe, expect, it } from "vitest";
import { availableSlotsSchema } from "@/lib/validators";

const base = { lat: 55.8, lng: -3.8, duration_mins: 60 };

describe("available-slots request: shown_slots", () => {
  it("is optional", () => {
    const parsed = availableSlotsSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shown_slots).toBeUndefined();
  });

  it("accepts the slots as they came back, keeping only date and start time", () => {
    const parsed = availableSlotsSchema.safeParse({
      ...base,
      shown_slots: [
        { date: "2030-01-07", start_time: "09:00", end_time: "10:00", duration_mins: 60, score: 3.2 },
        { date: "2030-01-08", start_time: "13:30:00" },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.shown_slots).toEqual([
      { date: "2030-01-07", start_time: "09:00" },
      { date: "2030-01-08", start_time: "13:30:00" },
    ]);
  });

  it("rejects bad dates or times, and more than 10", () => {
    const bad = [
      [{ date: "07/01/2030", start_time: "09:00" }],
      [{ date: "2030-01-07", start_time: "9am" }],
      [{ date: "2030-01-07" }],
      "2030-01-07 09:00",
      Array.from({ length: 11 }, () => ({ date: "2030-01-07", start_time: "09:00" })),
    ];
    for (const shown_slots of bad) {
      expect(availableSlotsSchema.safeParse({ ...base, shown_slots }).success).toBe(false);
    }
  });
});
