import { NextResponse } from "next/server";

const explicitAllowedOrigins = new Set([
  "https://pureluxeleadmagnet1.lovable.app",
  "https://id-preview--3dec7234-57be-49c6-bcda-483a794727cb.lovable.app",
  "https://3dec7234-57be-49c6-bcda-483a794727cb.lovableproject.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

const extraOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

for (const origin of extraOrigins) explicitAllowedOrigins.add(origin);

function isAllowedOrigin(origin: string): boolean {
  if (explicitAllowedOrigins.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lovable\.app$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.lovableproject\.com$/i.test(origin)) return true;
  return false;
}

export function applyCorsHeaders(request: Request, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedOrigin(origin)) return response;

  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  response.headers.set("Access-Control-Max-Age", "86400");

  return response;
}

export function corsOptions(request: Request): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  return applyCorsHeaders(request, response);
}

