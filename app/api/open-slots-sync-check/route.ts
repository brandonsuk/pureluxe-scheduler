import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { runOpenSlotsSync } from "@/lib/open-slots-sync";

function isAuthorized(request: Request): boolean {
  if (!env.cronSecret) return false;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${env.cronSecret}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) return jsonError("Unauthorized", request, 401);
  try {
    const result = await runOpenSlotsSync(14);
    return jsonOk(result, request);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Open slots sync failed", request, 500);
  }
}
