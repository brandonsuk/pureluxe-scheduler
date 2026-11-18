/**
 * Matching key for a UK phone number: its last 10 digits, so "+44 7700 900123",
 * "+447700900123", "447700900123" and "07700 900123" all give "7700900123".
 * Returns "" when there are fewer than 10 digits (not a usable number).
 */
export function phoneKey(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/** Lowercased, trimmed email, or "" when it doesn't look like an email. */
export function emailKey(email: string | null | undefined): string {
  const clean = String(email ?? "").trim().toLowerCase();
  return clean.includes("@") ? clean : "";
}

/** Exact-match lookups (Supabase .in()): the number in every format bookings are stored in. */
export function phoneCandidates(rawPhone: string): string[] {
  const normalized = rawPhone.replace(/[^\d+]/g, "");
  const out = new Set<string>([rawPhone.trim(), normalized]);
  const digitsOnly = normalized.replace(/^\+/, "");

  if (digitsOnly.startsWith("44")) out.add(`0${digitsOnly.slice(2)}`);
  if (digitsOnly.startsWith("0")) out.add(`+44${digitsOnly.slice(1)}`);

  // Bookings store numbers in several spaced formats ("+44 7894328018",
  // "07894 328018"), so exact-match lookups need those too (same list as inbound SMS).
  const national = digitsOnly.startsWith("44") ? digitsOnly.slice(2) : digitsOnly.replace(/^0/, "");
  if (national.length === 10) {
    out.add(`+44 ${national}`);
    out.add(`+44 ${national.slice(0, 4)} ${national.slice(4)}`);
    out.add(`0${national.slice(0, 4)} ${national.slice(4)}`);
    out.add(`0${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`);
    out.add(`44${national}`);
  }

  return [...out].filter(Boolean);
}
