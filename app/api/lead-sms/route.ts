import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { env } from "@/lib/env";
import { LEAD_SMS_TEMPLATES, LeadSmsTemplate, sendLeadTemplateSms } from "@/lib/notifications";
import { findActiveBlock } from "@/lib/blocklist";

export const OPTIONS = corsOptions;

// UK mobiles to E.164 (Airtable has a mix of 07..., 447... and +447...).
function toE164(raw: string): string {
  const p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("44")) return "+" + p;
  if (p.startsWith("0")) return "+44" + p.slice(1);
  return p;
}

// CRM one-tap lead texts (18 Nov 2026). Admin only (the CRM server adds the password).
// Body: { template: "missed_call" | "as_discussed", name, phone, email?, postcode?, admin_password }
// Returns { ok: true, sent: boolean }; sent=false means a rate limit or Twilio not set up.
export async function POST(request: Request) {
  try {
    const { template, name, phone, email, postcode, admin_password } = await request.json();
    if (!env.adminPassword || admin_password !== env.adminPassword) return jsonError("Unauthorised", request, 401);
    if (!LEAD_SMS_TEMPLATES.includes(template)) return jsonError("unknown template", request, 422);
    const to = toE164(phone);
    if (!name || !/^\+44\d{9,10}$/.test(to)) return jsonError("name and a UK phone are required", request, 422);
    if (await findActiveBlock(to, email)) return jsonError("This contact is blocked from booking", request, 403);
    const sent = await sendLeadTemplateSms({
      template: template as LeadSmsTemplate,
      clientName: String(name).slice(0, 80),
      clientPhone: to,
      clientEmail: email ? String(email).slice(0, 120) : undefined,
      postcode: postcode ? String(postcode).slice(0, 12) : undefined,
    });
    return jsonOk({ ok: true, sent }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
