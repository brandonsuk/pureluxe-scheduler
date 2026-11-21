import { corsOptions } from "@/lib/cors";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { addBlock, listActiveBlocks, removeBlock } from "@/lib/blocklist";

export const OPTIONS = corsOptions;

// Block / unblock a contact from booking (CRM "Block" button, 21 Nov 2026). Admin only:
// the CRM server adds the password. Body: { action: "block" | "unblock" | "list", phone?, email?,
// name?, reason?, airtable_record_id?, admin_password }.
// A blocked phone or email can't book (/api/book) and gets no abandoned-form or CRM booking texts.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (!env.adminPassword || body.admin_password !== env.adminPassword) return jsonError("Unauthorised", request, 401);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const action = str(body.action);

    if (action === "list") {
      return jsonOk({ ok: true, blocks: await listActiveBlocks() }, request);
    }

    const phone = str(body.phone);
    const email = str(body.email);
    if (action === "block") {
      try {
        const { block, created } = await addBlock({
          phone,
          email,
          name: str(body.name),
          reason: str(body.reason),
          airtableRecordId: str(body.airtable_record_id),
        });
        // eslint-disable-next-line no-console
        console.info("contact_blocked", { id: block.id, created });
        return jsonOk({ ok: true, created, block }, request);
      } catch (e) {
        if (e instanceof Error && e.message === "a phone or email is required") return jsonError(e.message, request, 422);
        throw e;
      }
    }
    if (action === "unblock") {
      if (!phone && !email) return jsonError("a phone or email is required", request, 422);
      const lifted = await removeBlock({ phone, email });
      // eslint-disable-next-line no-console
      console.info("contact_unblocked", { lifted });
      return jsonOk({ ok: true, lifted }, request);
    }
    return jsonError("unknown action", request, 422);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
