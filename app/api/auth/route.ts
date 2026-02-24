import { env } from "@/lib/env";
import { corsOptions } from "@/lib/cors";
import { jsonError, jsonOk } from "@/lib/http";

export const OPTIONS = corsOptions;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const password = searchParams.get("password");
  if (!password) return jsonError("Password required", request, 401);

  const ok = password === env.adminPassword;
  if (!ok) return jsonError("Unauthorized", request, 401);

  return jsonOk({ authenticated: true }, request);
}
