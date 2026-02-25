import { env } from "@/lib/env";
import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";
import { runCalendarSyncCheck } from "@/lib/calendar-sync";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { admin_password?: string };
    if (!body?.admin_password || body.admin_password !== env.adminPassword) {
      return jsonError("Unauthorized", request, 401);
    }

    const result = await runCalendarSyncCheck(250);
    return jsonOk(result, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Sync failed", request, 500);
  }
}
