import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = [
  { id: "11111111-1111-4111-8111-111111111111", client_name: "A", client_email: "a@x.com", client_phone: "+44 7429 596777", address: "x", date: "2099-01-02", start_time: "10:00:00", status: "confirmed", google_event_id: "g1", thomas_event_id: "t1" },
  { id: "22222222-2222-4222-8222-222222222222", client_name: "B", client_email: "B@Y.com", client_phone: "07000000001", address: "y", date: "2099-01-01", start_time: "09:00:00", status: "confirmed", google_event_id: "g2", thomas_event_id: null },
];
const updates: string[] = [];

vi.mock("@/lib/env", () => ({ env: { adminPassword: "pw", googleOpenSlotsCalendarId: "open-cal", googleCalendarTimezone: "Europe/London" } }));
vi.mock("@/lib/cors", () => ({ corsOptions: () => null }));
vi.mock("@/lib/http", () => ({
  jsonOk: (b: unknown) => new Response(JSON.stringify(b), { status: 200 }),
  jsonError: (m: string, _r: Request, s = 400) => new Response(JSON.stringify({ error: m }), { status: s }),
}));
const notify = vi.fn(async () => undefined);
vi.mock("@/lib/notifications", () => ({ sendCancellationNotifications: notify }));
const calCancel = vi.fn(async () => undefined);
vi.mock("@/lib/google-calendar", () => ({ cancelCalendarEvent: calCancel, cancelCalendarEventByAppointmentId: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => {
  const builder = () => {
    const q: Record<string, unknown> & { _id?: string } = {};
    const chain = {
      select: () => chain,
      eq: (col: string, val: string) => { if (col === "id") q._id = val; return chain; },
      gte: () => chain,
      order: () => chain,
      maybeSingle: async () => ({ data: rows.find((r) => r.id === q._id) || null, error: null }),
      update: () => ({ eq: async (_c: string, id: string) => { updates.push(id); return { error: null }; } }),
      then: (res: (v: unknown) => void) => res({ data: [...rows].sort((a, b) => a.date.localeCompare(b.date)), error: null }),
    };
    return chain;
  };
  return { supabaseAdmin: { from: () => builder() } };
});

const { POST } = await import("@/app/api/cancel/route");
const call = (body: unknown) => POST(new Request("http://x/api/cancel", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/cancel", () => {
  beforeEach(() => { updates.length = 0; notify.mockClear(); calCancel.mockClear(); });

  it("rejects a wrong password", async () => {
    expect((await call({ phone: "07429596777", admin_password: "no" })).status).toBe(401);
  });
  it("needs an identifier", async () => {
    expect((await call({ admin_password: "pw" })).status).toBe(422);
  });
  it("finds by phone in another format, cancels both calendar events, silent when notify false", async () => {
    const r = await (await call({ phone: "07429596777", notify: false, admin_password: "pw" })).json();
    expect(r).toMatchObject({ found: true, appointment_id: rows[0].id, notified: false });
    expect(updates).toEqual([rows[0].id]);
    expect(calCancel).toHaveBeenCalledWith("g1");
    expect(calCancel).toHaveBeenCalledWith("t1", "open-cal");
    expect(notify).not.toHaveBeenCalled();
  });
  it("finds by email case-insensitively and notifies when asked", async () => {
    const r = await (await call({ email: "b@y.com", notify: true, admin_password: "pw" })).json();
    expect(r).toMatchObject({ found: true, appointment_id: rows[1].id, notified: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("returns found:false and changes nothing when no booking matches", async () => {
    const r = await (await call({ phone: "07999999999", email: "none@z.com", admin_password: "pw" })).json();
    expect(r).toMatchObject({ found: false });
    expect(updates).toEqual([]);
  });
  it("admin page path (appointment_id) still notifies by default", async () => {
    const r = await (await call({ appointment_id: rows[1].id, admin_password: "pw" })).json();
    expect(r).toMatchObject({ found: true, notified: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
