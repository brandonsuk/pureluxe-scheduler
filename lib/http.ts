import { NextResponse } from "next/server";
import { applyCorsHeaders } from "@/lib/cors";

export function jsonOk(data: unknown, request: Request, init?: ResponseInit) {
  return applyCorsHeaders(request, NextResponse.json(data, { status: 200, ...init }));
}

export function jsonError(message: string, request: Request, status = 400) {
  return applyCorsHeaders(request, NextResponse.json({ error: message }, { status }));
}
