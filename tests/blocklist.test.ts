import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory blocked_contacts table behind a tiny Supabase-style query builder.
type Row = Record<string, unknown>;
let blocked: Row[] = [];
let failLookups = false;
const appointmentInserts: Row[] = [];

vi.mock("@/lib/env", () => ({ env: { adminPassword: "pw", googleOpenSlotsCalendarId: "" } }));
vi.mock("@/lib/cors", () => ({ corsOptions: () => null }));
vi.mock("@/lib/http", () => ({
  jsonOk: (b: unknown) => new Response(JSON.stringify(b), { status: 200 }),
  jsonError: (m: string, _r: Request, s = 400) => new Response(JSON.stringify({ error: m }), { status: s }),
}));
vi.mock("@/lib/scheduler", () => ({
  fetchDayAppointments: async () => [],
  validateCandidateSlot: async () => ({ valid: true, reason: "" }),
}));
vi.mock("@/lib/notifications", () => ({ sendBookingNotifications: vi.fn(async () => undefined) }));
vi.mock("@/lib/google-calendar", () => ({ createCalendarEvent: vi.fn(async () => null), cancelCalendarEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/airtable-sync", () => ({ markAirtableAppointmentBooked: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase", () => {
  const blockedQuery = () => {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    const run = () => {
      if (failLookups) return { data: null, error: { message: "relation does not exist" } };
      const rows = blocked.filter((r) => filters.every((f) => f(r)));
      if (patch) rows.forEach((r) => Object.assign(r, patch));
      return { data: rows, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      order: () => q,
      limit: () => q,
      update: (p: Row) => { patch = p; return q; },
      insert: (row: Row) => {
        const full = { id: "b" + (blocked.length + 1), blocked_at: new Date().toISOString(), unblocked_at: null, ...row };
        blocked.push(full);
        return { select: () => ({ single: async () => ({ data: full, error: null }) }) };
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  const apptChain: Record<string, unknown> = {};
  Object.assign(apptChain, {
    select: () => apptChain, eq: () => apptChain, gte: () => apptChain,
    in: async () => ({ data: [], error: null }),
    insert: (row: Row) => { appointmentInserts.push(row); return { select: () => ({ single: async () => ({ data: { id: "a1", ...row }, error: null }) }) }; },
    update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
  });
  return { supabaseAdmin: { from: (t: string) => (t === "blocked_contacts" ? blockedQuery() : apptChain) } };
});

const { POST: book } = await import("@/app/api/book/route");
const { POST: blockRoute } = await import("@/app/api/block/route");
const { findActiveBlock, loadBlockedContacts, isBlockedContact } = await import("@/lib/blocklist");

const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const lead = {
  date: day(2), start_time: "10:00", duration_mins: 60, client_name: "Test Lead", client_phone: "07436 000111",
  client_email: "Test.Lead@Example.com", address: "1 Test Street, G74 1AA", lat: 55.76, lng: -4.17, readiness_level: "ready",
};
const callBook = (extra: Row = {}) =>
  book(new Request("http://x/api/book", { method: "POST", body: JSON.stringify({ ...lead, ...extra }) }));
const callBlock = (body: Row) =>
  blockRoute(new Request("http://x/api/block", { method: "POST", body: JSON.stringify({ admin_password: "pw", ...body }) }));

beforeEach(() => { blocked = []; failLookups = false; appointmentInserts.length = 0; });

describe("/api/block", () => {
  it("needs the admin password", async () => {
    expect((await callBlock({ action: "list", admin_password: "nope" })).status).toBe(401);
    expect((await blockRoute(new Request("http://x", { method: "POST", body: "{}" }))).status).toBe(401);
  });
  it("blocks by phone + email, stored as match keys, and is idempotent", async () => {
    const r = await callBlock({ action: "block", phone: "07436723673", email: "DPK@Example.com ", name: "Test Person", reason: "Cancelled 6 times" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ created: true, block: { phone_key: "7436723673", email_key: "dpk@example.com" } });
    const again = await (await callBlock({ action: "block", phone: "+44 7436 723673", email: "dpk@example.com" })).json();
    expect(again.created).toBe(false);
    expect(blocked).toHaveLength(1);
  });
  it("refuses a block with no usable phone or email", async () => {
    expect((await callBlock({ action: "block", phone: "123", email: "nope" })).status).toBe(422);
    expect(blocked).toHaveLength(0);
  });
  it("lists active blocks and unblocks", async () => {
    await callBlock({ action: "block", phone: "07436723673" });
    expect((await (await callBlock({ action: "list" })).json()).blocks).toHaveLength(1);
    expect((await (await callBlock({ action: "unblock", phone: "447436723673" })).json()).lifted).toBe(1);
    expect((await (await callBlock({ action: "list" })).json()).blocks).toHaveLength(0);
    expect(blocked[0].unblocked_at).toBeTruthy(); // kept as history
  });
  it("reports a missing table as an error instead of pretending it worked", async () => {
    failLookups = true;
    expect((await callBlock({ action: "block", phone: "07436723673" })).status).toBe(500);
  });
});

describe("POST /api/book with the blocklist", () => {
  it("books normally when nobody is blocked", async () => {
    expect((await callBook()).status).toBe(200);
    expect(appointmentInserts).toHaveLength(1);
  });
  it("refuses a blocked phone in any format, and books nothing", async () => {
    await callBlock({ action: "block", phone: "+447436000111" });
    const r = await callBook({ client_email: "someone.else@example.com" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/unable to book/);
    expect(appointmentInserts).toHaveLength(0);
  });
  it("refuses a blocked email even with a new phone number", async () => {
    await callBlock({ action: "block", email: "test.lead@example.com" });
    expect((await callBook({ client_phone: "07999 888777" })).status).toBe(403);
  });
  it("also refuses the CRM book-anyway override (unblock first)", async () => {
    await callBlock({ action: "block", phone: "07436000111" });
    expect((await callBook({ force: true, admin_password: "pw" })).status).toBe(403);
    expect(appointmentInserts).toHaveLength(0);
  });
  it("books again once unblocked", async () => {
    await callBlock({ action: "block", phone: "07436000111" });
    await callBlock({ action: "unblock", phone: "07436000111" });
    expect((await callBook()).status).toBe(200);
  });
  it("fails open: a blocklist error never stops a booking", async () => {
    blocked.push({ id: "x", phone_key: "7436000111", email_key: "", unblocked_at: null });
    failLookups = true;
    expect((await callBook()).status).toBe(200);
  });
});

describe("blocklist helpers", () => {
  it("findActiveBlock ignores unusable input and lifted blocks", async () => {
    expect(await findActiveBlock("", "")).toBeNull();
    blocked.push({ id: "old", phone_key: "7436000111", email_key: "", unblocked_at: "2026-01-01T00:00:00Z" });
    expect(await findActiveBlock("07436000111", "")).toBeNull();
  });
  it("loadBlockedContacts + isBlockedContact match either key", async () => {
    blocked.push({ id: "1", phone_key: "7436000111", email_key: "a@b.com", unblocked_at: null });
    const set = await loadBlockedContacts();
    expect(isBlockedContact(set, "+44 7436 000111", "")).toBe(true);
    expect(isBlockedContact(set, "07000000000", "A@B.com")).toBe(true);
    expect(isBlockedContact(set, "07000000000", "c@d.com")).toBe(false);
  });
  it("loadBlockedContacts is empty on error (fail open)", async () => {
    failLookups = true;
    const set = await loadBlockedContacts();
    expect(set.phones.size + set.emails.size).toBe(0);
  });
});
