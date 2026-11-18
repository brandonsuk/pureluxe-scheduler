import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { airtableApiKey: "test-key", airtableBaseId: "appTEST" },
}));

import {
  markAirtableAbandonedSmsSent,
  markAirtableAppointmentBooked,
  markAirtableAppointmentCancelled,
  markAirtableLeadTilingDisqualified,
  rankLeadRecords,
} from "@/lib/airtable-sync";

type Call = { url: string; init?: RequestInit };

type Rec = { id: string; createdTime?: string; fields?: Record<string, unknown> };

function mockAirtable(searchResults: Rec[][], byId: Record<string, Rec> = {}) {
  const calls: Call[] = [];
  let search = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PATCH") return new Response("{}", { status: 200 });
    const single = new URL(url).pathname.match(/\/leads\/(rec\w+)$/);
    if (single) {
      const rec = byId[single[1]];
      return rec ? new Response(JSON.stringify(rec), { status: 200 }) : new Response("{}", { status: 404 });
    }
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
    // Airtable phones come in any format ("+44 7700 900123", "07700900123"), so match the last 10 digits.
    expect(fallback).toContain('RIGHT(REGEX_REPLACE({phone}&"","[^0-9]",""),10)="7700900123"');
    expect(fallback).toContain('LOWER(TRIM({email}&""))="a@b.com"');
    expect(calls[2].url).toContain("/leads/recB");
  });

  it("disqualifies every row of the session (Make's spare rows too)", async () => {
    const calls = mockAirtable([[{ id: "recA" }, { id: "recSpare" }]]);
    expect(await markAirtableLeadTilingDisqualified("sess-1", "07700900123", "a@b.com")).toBe(true);
    const patched = calls.filter((c) => c.init?.method === "PATCH").map((c) => c.url.split("/").pop());
    expect(patched).toEqual(["recA", "recSpare"]);
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

// Adam, 5 Oct 2026: one form submission made 3 rows within 6 seconds (Make race).
// Only the first one kept being updated (last_step_at); he came back on 14 Nov.
const live: Rec = { id: "recLiveRow0000001", createdTime: "2026-10-05T11:14:17.000Z", fields: { "Created Time": "2026-10-05T11:14:10.561Z", first_seen_at: "2026-11-14T12:27:45.913Z", last_step_at: "2026-11-14T12:27:47.312Z", step_number: 4, phone: "+44 7310402228", email: "a@b.com" } };
const spare1: Rec = { id: "recSpareRow000001", createdTime: "2026-10-05T11:14:17.000Z", fields: { "Created Time": "2026-10-05T11:14:16.102Z", first_seen_at: "2026-10-05T11:14:16.368Z", step_number: 101, phone: "+44 7310402228", email: "a@b.com" } };
const spare2: Rec = { id: "recSpareRow000002", createdTime: "2026-10-05T11:14:17.000Z", fields: { "Created Time": "2026-10-05T11:14:14.228Z", step_number: 2, phone: "+44 7310402228", email: "a@b.com" } };

describe("rankLeadRecords", () => {
  it("puts the row Make kept updating first, not the newest spare row", () => {
    expect(rankLeadRecords([spare1, spare2, live] as never).map((r) => r.id)[0]).toBe("recLiveRow0000001");
  });

  it("still prefers the live row when the spares were created seconds after its last step", () => {
    const fresh: Rec = { id: "recFreshLive0001", fields: { "Created Time": "2026-11-18T10:00:00.000Z", last_step_at: "2026-11-18T10:00:02.000Z" } };
    const lateSpare: Rec = { id: "recLateSpare0001", fields: { "Created Time": "2026-11-18T10:00:05.000Z" } };
    expect(rankLeadRecords([lateSpare, fresh] as never)[0].id).toBe("recFreshLive0001");
  });

  it("a genuinely newer enquiry (days later) wins", () => {
    const newer: Rec = { id: "recNewerEnq00001", fields: { "Created Time": "2026-11-20T09:00:00.000Z" } };
    expect(rankLeadRecords([live, newer] as never)[0].id).toBe("recNewerEnq00001");
  });
});

describe("markAirtableAppointmentBooked", () => {
  it("books the live row, not the newest spare row", async () => {
    const calls = mockAirtable([[spare1, spare2, live]]);
    expect(await markAirtableAppointmentBooked("+447310402228", "a@b.com", "2026-11-17", "10:00")).toBe(true);
    const patches = calls.filter((c) => c.init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain("/leads/recLiveRow0000001");
  });

  it("uses the CRM's record id when its phone or email matches", async () => {
    const calls = mockAirtable([], { recSpareRow000001: spare1 });
    expect(await markAirtableAppointmentBooked("07310 402228", "", "2026-11-17", "9:00", { recordId: "recSpareRow000001" })).toBe(true);
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(patch.url).toContain("/leads/recSpareRow000001");
    expect(JSON.parse(String(patch.init?.body)).fields.booked_time).toBe("09:00");
    expect(calls.some((c) => c.url.includes("filterByFormula"))).toBe(false);
  });

  it("ignores a record id that belongs to someone else and falls back to search", async () => {
    const other: Rec = { id: "recSomeoneElse001", fields: { phone: "07999999999", email: "x@y.com" } };
    const calls = mockAirtable([[live]], { recSomeoneElse001: other });
    await markAirtableAppointmentBooked("+447310402228", "a@b.com", "2026-11-17", "10:00", { recordId: "recSomeoneElse001" });
    expect(calls.find((c) => c.init?.method === "PATCH")!.url).toContain("/leads/recLiveRow0000001");
  });

  it("a moved visit updates the row that holds the old date", async () => {
    const calls = mockAirtable([[spare1]]);
    await markAirtableAppointmentBooked("+447310402228", "a@b.com", "2026-11-18", "10:00", { previousDate: "2026-11-17" });
    expect(formulaOf(calls[0])).toContain('DATETIME_FORMAT({booked_date},"YYYY-MM-DD")="2026-11-17"');
    expect(calls.find((c) => c.init?.method === "PATCH")!.url).toContain("/leads/recSpareRow000001");
  });

  it("leaves the email out of the search when there is none", async () => {
    const calls = mockAirtable([[live]]);
    await markAirtableAppointmentBooked("+447310402228", "", "2026-11-17", "10:00");
    expect(formulaOf(calls[0])).not.toContain("{email}");
  });
});

describe("markAirtableAppointmentCancelled", () => {
  it("with a date, clears every row showing that visit", async () => {
    const calls = mockAirtable([[live, spare1]]);
    expect(await markAirtableAppointmentCancelled("+447310402228", "a@b.com", "2026-11-17")).toBe(true);
    expect(formulaOf(calls[0])).toContain('DATETIME_FORMAT({booked_date},"YYYY-MM-DD")="2026-11-17"');
    expect(calls.filter((c) => c.init?.method === "PATCH")).toHaveLength(2);
  });

  it("without a date, clears only the best booked row", async () => {
    const calls = mockAirtable([[spare1, live]]);
    await markAirtableAppointmentCancelled("+447310402228", "a@b.com");
    const patches = calls.filter((c) => c.init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain("/leads/recLiveRow0000001");
  });
});

describe("markAirtableAbandonedSmsSent", () => {
  it("looks up the session first", async () => {
    const calls = mockAirtable([[live]]);
    await markAirtableAbandonedSmsSent("+447310402228", "a@b.com", "b77f8d98-a9ba");
    expect(formulaOf(calls[0])).toBe('{lead_session_id}="b77f8d98-a9ba"');
    expect(calls[1].url).toContain("/leads/recLiveRow0000001");
  });
});
