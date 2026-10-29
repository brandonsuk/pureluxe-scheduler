import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { airtableApiKey: "test-key", airtableBaseId: "appTEST" },
}));

import { markAirtableLeadTilingDisqualified } from "@/lib/airtable-sync";

type Call = { url: string; init?: RequestInit };

function mockAirtable(searchResults: { id: string }[][]) {
  const calls: Call[] = [];
  let search = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PATCH") return new Response("{}", { status: 200 });
    const records = searchResults[search++] ?? [];
    return new Response(JSON.stringify({ records }), { status: 200 });
  }));
  return calls;
}

function formulaOf(call: Call): string {
  return decodeURIComponent(new URL(call.url).searchParams.get("filterByFormula") || "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("markAirtableLeadTilingDisqualified", () => {
  it("finds the lead by session id and ticks Disqualified + wall_type tiling", async () => {
    const calls = mockAirtable([[{ id: "recA" }]]);
    const ok = await markAirtableLeadTilingDisqualified("bd134f89-b244-4e51", "+447700900123", "a@b.com");

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(formulaOf(calls[0])).toBe('{lead_session_id}="bd134f89-b244-4e51"');
    expect(calls[1].url).toContain("/leads/recA");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      fields: { Disqualified: true, wall_type: "tiling" },
    });
  });

  it("falls back to phone or email when the session id isn't found", async () => {
    const calls = mockAirtable([[], [{ id: "recB" }]]);
    const ok = await markAirtableLeadTilingDisqualified("sess-1", "07700 900123", "A@B.com");

    expect(ok).toBe(true);
    const fallback = formulaOf(calls[1]);
    expect(fallback).toContain('{phone}="+447700900123"');
    expect(fallback).toContain('{phone}="07700900123"');
    expect(fallback).toContain('{email}="a@b.com"');
    expect(calls[2].url).toContain("/leads/recB");
  });

  it("returns false and patches nothing when no record exists yet", async () => {
    const calls = mockAirtable([[], []]);
    const ok = await markAirtableLeadTilingDisqualified("sess-1", "07700900123", "a@b.com");

    expect(ok).toBe(false);
    expect(calls.some((c) => c.init?.method === "PATCH")).toBe(false);
  });

  it("keeps quotes out of the search formulas", async () => {
    const calls = mockAirtable([[], []]);
    await markAirtableLeadTilingDisqualified('x",TRUE(),"', '1",TRUE(),"', "a@b.com");

    expect(formulaOf(calls[0])).toBe('{lead_session_id}="xTRUE"');
    expect(formulaOf(calls[1])).not.toContain("TRUE()");
  });

  it("never throws when Airtable is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(markAirtableLeadTilingDisqualified("sess-1", "07700900123", "a@b.com")).resolves.toBe(false);
  });
});
