import { describe, expect, it } from "vitest";
import { resolveDeparture } from "@/lib/distance";

const now = Date.parse("2026-11-11T15:00:00Z"); // Wed 11 Nov 2026, 15:00 UK

describe("resolveDeparture", () => {
  it("bands weekday times", () => {
    expect(resolveDeparture({ date: "2026-11-16", time: "08:00" }, now)).toEqual({ bandKey: "wd:am-peak", departAt: "2026-11-16T08:15:00" });
    expect(resolveDeparture({ date: "2026-11-16", time: "12:30" }, now).bandKey).toBe("wd:midday");
    expect(resolveDeparture({ date: "2026-11-16", time: "16:45" }, now).bandKey).toBe("wd:pm-peak");
    expect(resolveDeparture({ date: "2026-11-21", time: "10:00" }, now).bandKey).toBe("sat:midday");
  });

  it("starts pm-peak at 15:00 (school run)", () => {
    expect(resolveDeparture({ date: "2026-11-16", time: "14:59" }, now).bandKey).toBe("wd:midday");
    expect(resolveDeparture({ date: "2026-11-16", time: "15:00" }, now)).toEqual({ bandKey: "wd:pm-peak", departAt: "2026-11-16T17:00:00" });
    expect(resolveDeparture({ date: "2026-11-16", time: "15:29" }, now).bandKey).toBe("wd:pm-peak");
    expect(resolveDeparture({ date: "2026-11-21", time: "15:00" }, now).bandKey).toBe("sat:pm-peak");
  });

  it("moves a past departure to the same weekday next week", () => {
    expect(resolveDeparture({ date: "2026-11-11", time: "09:00" }, now).departAt).toBe("2026-11-18T08:15:00");
    expect(resolveDeparture({ date: "2026-11-11", time: "16:00" }, now).departAt).toBe("2026-11-11T17:00:00");
  });
});
