import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
let failInsert = false;

vi.mock("@/lib/cors", () => ({ corsOptions: () => null, applyCorsHeaders: (_r: Request, res: Response) => res }));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (failInsert) return { error: { message: "db down" } };
        inserted.push({ table, row });
        return { error: null };
      },
    }),
  },
}));

const { POST } = await import("@/app/api/funnel-event/route");
const call = (body: string) => POST(new Request("http://x/api/funnel-event", { method: "POST", body }));
const good = { lead_session_id: "8f0ec4ca-3563-49bc-ba51-fe49cc91b712", event: "page_view", path: "/book", variants: { landing: "B" }, device: "mobile", viewport_w: 390 };

describe("POST /api/funnel-event", () => {
  beforeEach(() => { inserted.length = 0; failInsert = false; });

  it("stores a valid event in funnel_events only", async () => {
    const res = await call(JSON.stringify(good));
    expect(res.status).toBe(204);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].table).toBe("funnel_events");
    expect(inserted[0].row).toMatchObject({ event: "page_view", path: "/book", variants: { landing: "B" }, device: "mobile", is_test: false, utm_campaign: null });
  });

  it("answers 204 and stores nothing for a bad payload", async () => {
    for (const body of ["not json", "{}", JSON.stringify({ ...good, event: "DROP TABLE" }), JSON.stringify({ ...good, path: "x".repeat(500) })]) {
      expect((await call(body)).status).toBe(204);
    }
    expect(inserted).toHaveLength(0);
  });

  it("still answers 204 when the database fails", async () => {
    failInsert = true;
    expect((await call(JSON.stringify(good))).status).toBe(204);
  });
});
