import { supabaseAdmin } from "@/lib/supabase";
import { emailKey, phoneKey } from "@/lib/phone";

/**
 * Contacts blocked from booking (CRM "Block" button, 21 Nov 2026).
 * Matched on the phone's last 10 digits or the lowercased email, so a new form
 * with the same number or email is still blocked. Unblocking sets unblocked_at
 * (rows are kept as history).
 *
 * Lookups FAIL OPEN: if the table is missing or Supabase errors, nobody is treated
 * as blocked, so a blocklist problem can never stop real bookings.
 */
export type BlockRow = {
  id: string;
  phone_key: string;
  email_key: string;
  client_name: string | null;
  reason: string | null;
  airtable_record_id: string | null;
  blocked_at: string;
};

const TABLE = "blocked_contacts";
const COLUMNS = "id, phone_key, email_key, client_name, reason, airtable_record_id, blocked_at";

export const BLOCKED_BOOKING_MESSAGE = "Sorry, we're unable to book this visit online.";

async function activeMatches(phone: string | null | undefined, email: string | null | undefined): Promise<BlockRow[]> {
  const p = phoneKey(phone);
  const e = emailKey(email);
  const none = Promise.resolve({ data: [] as BlockRow[], error: null });
  const q = (column: "phone_key" | "email_key", value: string) =>
    supabaseAdmin.from(TABLE).select(COLUMNS).is("unblocked_at", null).eq(column, value);
  const [byPhone, byEmail] = await Promise.all([p ? q("phone_key", p) : none, e ? q("email_key", e) : none]);
  if (byPhone.error || byEmail.error) throw new Error((byPhone.error || byEmail.error)?.message || "blocklist lookup failed");
  const rows = [...((byPhone.data || []) as BlockRow[]), ...((byEmail.data || []) as BlockRow[])];
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}

/** The active block for this phone or email, or null (also null on any error: fail open). */
export async function findActiveBlock(phone: string | null | undefined, email: string | null | undefined): Promise<BlockRow | null> {
  if (!phoneKey(phone) && !emailKey(email)) return null;
  try {
    return (await activeMatches(phone, email))[0] ?? null;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("blocklist_lookup_failed", error);
    return null;
  }
}

export type BlockedContacts = { phones: Set<string>; emails: Set<string> };

/** Every active block as key sets, for batch jobs. Empty on any error (fail open). */
export async function loadBlockedContacts(): Promise<BlockedContacts> {
  const out: BlockedContacts = { phones: new Set(), emails: new Set() };
  try {
    const rows = await listActiveBlocks();
    for (const r of rows) {
      if (r.phone_key) out.phones.add(r.phone_key);
      if (r.email_key) out.emails.add(r.email_key);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("blocklist_load_failed", error);
  }
  return out;
}

export function isBlockedContact(blocked: BlockedContacts, phone: string | null | undefined, email: string | null | undefined): boolean {
  const p = phoneKey(phone);
  const e = emailKey(email);
  return Boolean((p && blocked.phones.has(p)) || (e && blocked.emails.has(e)));
}

/** Active blocks, newest first. Throws on error (the admin endpoint reports it). */
export async function listActiveBlocks(): Promise<BlockRow[]> {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(COLUMNS)
    .is("unblocked_at", null)
    .order("blocked_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  return (data || []) as BlockRow[];
}

/** Block a phone and/or email. Idempotent: an existing active block is returned as is. Throws on error. */
export async function addBlock(input: {
  phone?: string | null;
  email?: string | null;
  name?: string | null;
  reason?: string | null;
  airtableRecordId?: string | null;
}): Promise<{ block: BlockRow; created: boolean }> {
  const p = phoneKey(input.phone);
  const e = emailKey(input.email);
  if (!p && !e) throw new Error("a phone or email is required");
  const existing = await activeMatches(input.phone, input.email);
  // Already blocked on both keys we were given: nothing to add.
  const covered = existing.find((r) => (!p || r.phone_key === p) && (!e || r.email_key === e));
  if (covered) return { block: covered, created: false };
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert({
      phone_key: p,
      email_key: e,
      client_name: input.name ? String(input.name).slice(0, 120) : null,
      reason: input.reason ? String(input.reason).slice(0, 300) : null,
      airtable_record_id: input.airtableRecordId || null,
    })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message || "block insert failed");
  return { block: data as BlockRow, created: true };
}

/** Lift every active block matching this phone or email. Returns how many were lifted. Throws on error. */
export async function removeBlock(input: { phone?: string | null; email?: string | null }): Promise<number> {
  const rows = await activeMatches(input.phone, input.email);
  if (!rows.length) return 0;
  const { error } = await supabaseAdmin
    .from(TABLE)
    .update({ unblocked_at: new Date().toISOString() })
    .in("id", rows.map((r) => r.id));
  if (error) throw new Error(error.message);
  return rows.length;
}
