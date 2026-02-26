import { corsOptions } from "@/lib/cors";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { runOpenSlotsSync } from "@/lib/open-slots-sync";

export const OPTIONS = corsOptions;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { admin_password?: string; days_ahead?: number };
    if (!body?.admin_password || body.admin_password !== env.adminPassword) {
      return jsonError("Unauthorized", request, 401);
    }

    const daysAhead =
      typeof body.days_ahead === "number" && Number.isFinite(body.days_ahead)
        ? Math.max(1, Math.min(60, Math.floor(body.days_ahead)))
        : 14;

    const result = await runOpenSlotsSync(daysAhead);
    return jsonOk(result, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Open slots sync failed", request, 500);
  }
}
