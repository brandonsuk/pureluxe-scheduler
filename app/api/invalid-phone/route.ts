import { corsOptions } from "@/lib/cors";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { markAirtableInvalidPhoneSent } from "@/lib/airtable-sync";
import { sendInvalidPhoneEmail } from "@/lib/notifications";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      admin_password?: string;
      name?: string;
      email?: string;
    };

    if (!body.admin_password || body.admin_password !== env.adminPassword) {
      return jsonError("Unauthorized", request, 401);
    }

    const name = (body.name || "").trim();
    const email = (body.email || "").trim().toLowerCase();

    if (!email) return jsonError("email required", request, 422);

    await sendInvalidPhoneEmail({ clientName: name || "there", clientEmail: email });
    markAirtableInvalidPhoneSent(email).catch(() => {});

    return jsonOk({ sent: true }, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unexpected error", request, 500);
  }
}
