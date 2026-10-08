import { createHmac, timingSafeEqual } from "crypto";
import { env } from "@/lib/env";

// Signed "manage your visit" links for customer emails (Cancel / Reschedule).
// The signature is an HMAC of the appointment id, keyed with a server-only secret,
// so a link only works for the appointment it was issued for.

export const MAX_RESCHEDULES = 2;

const MANAGE_BASE_URL = process.env.MANAGE_BASE_URL || "https://pureluxe-scheduler-sejo.vercel.app";

export type ManageAction = "cancel" | "reschedule";

export function manageSignature(appointmentId: string): string {
  return createHmac("sha256", env.supabaseServiceRoleKey)
    .update(`manage-visit:${appointmentId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function verifyManageSignature(appointmentId: string, signature: string): boolean {
  const expected = Buffer.from(manageSignature(appointmentId));
  const given = Buffer.from(signature || "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function manageUrl(appointmentId: string, action: ManageAction): string {
  const params = new URLSearchParams({ id: appointmentId, sig: manageSignature(appointmentId), action });
  return `${MANAGE_BASE_URL}/api/manage?${params.toString()}`;
}
