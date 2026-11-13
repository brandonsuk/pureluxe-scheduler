import { beforeEach, describe, expect, it, vi } from "vitest";

let dayBlocks: { id: string; date: string; start_time: string; end_time: string; lat: number; lng: number }[] = [];
const inserts: Record<string, unknown>[] = [];

vi.mock("@/lib/env", () => ({ env: { adminPassword: "pw", googleOpenSlotsCalendarId: "" } }));
vi.mock("@/lib/cors", () => ({ corsOptions: () => null }));
vi.mock("@/lib/http", () => ({
  jsonOk: (b: unknown) => new Response(JSON.stringify(b), { status: 200 }),
  jsonError: (m: string, _r: Request, s = 400) => new Response(JSON.stringify({ error: m }), { status: s }),
}));
const validate = vi.fn(async () => ({ valid: false, reason: "max_drive" }));
vi.mock("@/lib/scheduler", () => ({ fetchDayAppointments: async () => dayBlocks, validateCandidateSlot: validate }));
vi.mock("@/lib/notifications", () => ({ sendBookingNotifications: vi.fn(async () => undefined) }));
vi.mock("@/lib/google-calendar", () => ({ createCalendarEvent: vi.fn(async () => null), cancelCalendarEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/airtable-sync", () => ({ markAirtableAppointmentBooked: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, gte: () => chain, or: async () => ({ data: [], error: null }),
    insert: (row: Record<string, unknown>) => { inserts.push(row); return { select: () => ({ single: async () => ({ data: { id: "a1", ...row }, error: null }) }) }; },
    update: () => ({ eq: async () => ({ error: null }), in: async () => ({ error: null }) }),
  });
  return { supabaseAdmin: { from: () => chain } };
});

const { POST } = await import("@/app/api/book/route");
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const base = {
  date: day(2), start_time: "10:00", duration_mins: 60, client_name: "Test Lead", client_phone: "07000000000",
  client_email: "t@example.com", address: "1 Test Street, EH1 1AA", lat: 55.95, lng: -3.19, readiness_level: "ready",
};
const call = (extra: Record<string, unknown>) =>
  POST(new Request("http://x/api/book", { method: "POST", body: JSON.stringify({ ...base, ...extra }) }));

describe("POST /api/book force (CRM book anyway)", () => {
  beforeEach(() => { dayBlocks = []; inserts.length = 0; validate.mockClear(); });

  it("without force, normal validation still refuses the slot", async () => {
    expect((await call({})).status).toBe(409);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(0);
  });
  it("force with a wrong or missing password is refused and books nothing", async () => {
    expect((await call({ force: true, admin_password: "no" })).status).toBe(401);
    expect((await call({ force: true })).status).toBe(401);
    expect(inserts).toHaveLength(0);
  });
  it("force with the admin password skips the drive/open-hours checks and books", async () => {
    const r = await call({ force: true, admin_password: "pw" });
    expect(r.status).toBe(200);
    expect(validate).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ date: base.date, start_time: "10:00", end_time: "11:00" });
  });
  it("force never double-books over a visit or calendar block", async () => {
    dayBlocks = [{ id: "b", date: base.date, start_time: "10:30:00", end_time: "11:30:00", lat: 0, lng: 0 }];
    expect((await call({ force: true, admin_password: "pw" })).status).toBe(409);
    dayBlocks = [{ id: "b", date: base.date, start_time: "11:00:00", end_time: "12:00:00", lat: 0, lng: 0 }];
    expect((await call({ force: true, admin_password: "pw" })).status).toBe(200);
  });
  it("force refuses a past date", async () => {
    expect((await call({ force: true, admin_password: "pw", date: day(-1) })).status).toBe(422);
  });
});
