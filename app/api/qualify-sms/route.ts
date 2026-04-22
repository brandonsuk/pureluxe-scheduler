import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { env } from "@/lib/env";
import { sendQualificationSms } from "@/lib/notifications";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const { name, phone, postcode, admin_password } = await request.json();
    if (admin_password !== env.adminPassword) return jsonError("Unauthorised", request, 401);
    if (!name || !phone) return jsonError("name and phone required", request, 422);

    const params = new URLSearchParams({ name, phone, ...(postcode ? { postcode } : {}) });
    const bookingLink = `${env.funnelBaseUrl}/book?${params.toString()}`;

    await sendQualificationSms({ clientName: name, clientPhone: phone, bookingLink });
    return jsonOk({ ok: true }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
