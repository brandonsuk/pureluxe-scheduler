import { describe, expect, it } from "vitest";
import { emailKey, phoneCandidates, phoneKey } from "@/lib/phone";

describe("phoneKey", () => {
  it("gives the same key for every UK format", () => {
    for (const p of ["+44 7310402228", "+447310402228", "447310402228", "07310402228", "07310 402 228", "+44 7310 402228"]) {
      expect(phoneKey(p)).toBe("7310402228");
    }
  });
  it("is empty for a missing or too-short number (e.g. the funnel's '+44 ' default)", () => {
    expect(phoneKey("+44 ")).toBe("");
    expect(phoneKey("")).toBe("");
    expect(phoneKey(undefined)).toBe("");
  });
});

describe("emailKey", () => {
  it("lowercases and trims, and drops non-emails", () => {
    expect(emailKey("  A@B.com ")).toBe("a@b.com");
    expect(emailKey("")).toBe("");
    expect(emailKey("none")).toBe("");
  });
});

describe("phoneCandidates", () => {
  it("includes the spaced formats bookings are stored in", () => {
    expect(phoneCandidates("+447310402228")).toEqual(expect.arrayContaining(["+447310402228", "07310402228", "+44 7310402228", "+44 7310 402228"]));
    expect(phoneCandidates("+44 7310402228")).toContain("+44 7310402228");
  });
});
