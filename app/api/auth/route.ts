import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const password = searchParams.get("password");
  if (!password) return jsonError("Password required", 401);

  const ok = password === env.adminPassword;
  if (!ok) return jsonError("Unauthorized", 401);

  return jsonOk({ authenticated: true });
}
