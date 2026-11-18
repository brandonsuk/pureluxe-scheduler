import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { funnelBaseUrl: "https://offer.example", adminPassword: "pw" },
}));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));

import { leadBookingLink, leadSmsBody } from "@/lib/notifications";

describe("lead one-tap texts", () => {
  const link = leadBookingLink({ clientName: "Jane Smith", clientPhone: "+447700900123", clientEmail: "j@x.co", postcode: "EH12 9XX" });

  it("prefills the booking page", () => {
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe("https://offer.example/book");
    expect(u.searchParams.get("name")).toBe("Jane Smith");
    expect(u.searchParams.get("phone")).toBe("+447700900123");
    expect(u.searchParams.get("email")).toBe("j@x.co");
    expect(u.searchParams.get("address")).toBe("EH12 9XX");
    expect(u.searchParams.get("qualified")).toBe("1");
  });

  it("uses the first name and plain GSM text", () => {
    for (const t of ["missed_call", "as_discussed"] as const) {
      const b = leadSmsBody(t, "Jane Smith", link);
      expect(b.startsWith("Hi Jane, ")).toBe(true);
      expect(b.endsWith(link)).toBe(true);
      expect(/^[\x20-\x7E]+$/.test(b)).toBe(true);
      expect(b).not.toContain("? ");
    }
  });

  it("falls back to Hi with no usable name", () => {
    expect(leadSmsBody("missed_call", "  ", link).startsWith("Hi, ")).toBe(true);
  });
});
