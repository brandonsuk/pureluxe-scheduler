import { env } from "@/lib/env";
import { emailKey, phoneKey } from "@/lib/phone";

type LeadRecord = { id: string; createdTime?: string; fields: Record<string, unknown> };

async function airtableFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(
    `https://api.airtable.com/v0/${env.airtableBaseId}/leads${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${env.airtableApiKey}`,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
    },
  );
}

// Fields needed to pick the right row (and to check a row really is this person).
const LOOKUP_FIELDS = [
  "lead_session_id", "last_step_at", "first_seen_at", "Created Time", "step_number",
  "phone", "email", "Booked Appointment", "booked_date",
];

// Make sometimes creates 2-3 rows for one form submission: the funnel fires several
// webhooks at once and they race Make's "search, then create" step. The row Make
// keeps updating has last_step_at; the spare rows never get it. So a row without it
// ranks as if it were this much older, and the live row wins when they were created
// seconds apart. A genuinely newer enquiry (days later) still wins.
const NO_LAST_STEP_PENALTY_MS = 5 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

function toMs(value: unknown): number {
  const t = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Most recent activity on the row, minus the penalty for spare (never-updated) rows. */
export function leadRecordScore(record: LeadRecord): number {
  const f = record.fields || {};
  const latest = Math.max(toMs(f.last_step_at), toMs(f.first_seen_at), toMs(f["Created Time"]), toMs(record.createdTime));
  return f.last_step_at ? latest : latest - NO_LAST_STEP_PENALTY_MS;
}

/** Best row first: latest activity, then furthest step. */
export function rankLeadRecords(records: LeadRecord[]): LeadRecord[] {
  return [...records].sort(
    (a, b) => leadRecordScore(b) - leadRecordScore(a)
      || (Number(b.fields?.step_number) || 0) - (Number(a.fields?.step_number) || 0),
  );
}

// These values can come from public endpoints, so keep quotes out of the formulas.
function cleanSessionId(id: string | null | undefined): string {
  return String(id ?? "").replace(/[^\w-]/g, "");
}

function cleanEmail(email: string | null | undefined): string {
  return emailKey(email).replace(/["\\]/g, "");
}

/** OR(phone matches, email matches), skipping whichever is missing. "" if both are. */
function contactFormula(phone: string | null | undefined, email: string | null | undefined): string {
  const key = phoneKey(phone);
  const mail = cleanEmail(email);
  const parts = [
    key ? `RIGHT(REGEX_REPLACE({phone}&"","[^0-9]",""),10)="${key}"` : "",
    mail ? `LOWER(TRIM({email}&""))="${mail}"` : "",
  ].filter(Boolean);
  return parts.length ? `OR(${parts.join(",")})` : "";
}

function bookedFormula(date?: string): string {
  const booked = "{Booked Appointment}=TRUE()";
  return date && DATE_RE.test(date)
    ? `AND(${booked},DATETIME_FORMAT({booked_date},"YYYY-MM-DD")="${date}")`
    : booked;
}

/** True if the row's phone or email matches the given ones. */
function sameContact(record: LeadRecord, phone: string, email: string): boolean {
  const key = phoneKey(phone);
  const mail = emailKey(email);
  return Boolean(
    (key && phoneKey(String(record.fields?.phone ?? "")) === key)
    || (mail && emailKey(String(record.fields?.email ?? "")) === mail),
  );
}

/** null = Airtable error. */
async function searchRecords(formula: string): Promise<LeadRecord[] | null> {
  const fields = LOOKUP_FIELDS.map((f) => `fields[]=${encodeURIComponent(f)}`).join("&");
  const res = await airtableFetch(`?filterByFormula=${encodeURIComponent(formula)}&maxRecords=20&${fields}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { records?: LeadRecord[] };
  return (data.records || []).map((r) => ({ ...r, fields: r.fields || {} }));
}

/**
 * Finds the lead's Airtable rows: by lead_session_id first, then by phone or email.
 * `filter` (an Airtable formula) narrows both searches. Rows come back best first
 * (see rankLeadRecords). Returns null on an Airtable error.
 */
export async function findLeadRecords(opts: {
  sessionId?: string | null;
  phone?: string | null;
  email?: string | null;
  filter?: string;
}): Promise<LeadRecord[] | null> {
  const wrap = (formula: string) => (opts.filter ? `AND(${formula},${opts.filter})` : formula);
  const sessionId = cleanSessionId(opts.sessionId);
  const contact = contactFormula(opts.phone, opts.email);
  const formulas = [
    sessionId ? wrap(`{lead_session_id}="${sessionId}"`) : "",
    contact ? wrap(contact) : "",
  ].filter(Boolean);

  for (const formula of formulas) {
    const records = await searchRecords(formula);
    if (records === null) return null;
    if (records.length) return rankLeadRecords(records);
  }
  return [];
}

async function patchRecord(id: string, fields: Record<string, unknown>): Promise<boolean> {
  const res = await airtableFetch(`/${id}`, { method: "PATCH", body: JSON.stringify({ fields }) });
  return res.ok;
}

/**
 * Marks the lead's Airtable row as booked (Booked Appointment = true, booked_date,
 * booked_time, Cancelled Appointment = false, Disqualified = false). Called when a booking is confirmed
 * via /api/book, and when a visit is moved in a calendar.
 *
 * Which row:
 * - `recordId` (the CRM booking a specific lead): that row, if its phone or email matches.
 * - `previousDate` (a visit being moved): the row that holds the visit on that date.
 * - otherwise the lead's best row (see rankLeadRecords), never every matching row.
 *
 * Returns true if a row was updated, false if not found or not configured.
 */
export async function markAirtableAppointmentBooked(
  phone: string,
  email: string,
  date: string,
  startTime: string,
  opts: { recordId?: string | null; previousDate?: string | null } = {},
): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  // Ensure time is zero-padded HH:MM so Airtable parses it correctly
  const paddedTime = startTime.length === 4 ? `0${startTime}` : startTime;

  try {
    let id = "";

    if (opts.recordId && RECORD_ID_RE.test(opts.recordId)) {
      const res = await airtableFetch(`/${opts.recordId}`);
      if (res.ok) {
        const record = (await res.json()) as LeadRecord;
        if (record?.id && sameContact({ ...record, fields: record.fields || {} }, phone, email)) id = record.id;
      }
    }

    if (!id && opts.previousDate) {
      const holding = await findLeadRecords({ phone, email, filter: bookedFormula(opts.previousDate) });
      if (holding === null) return false;
      id = holding[0]?.id || "";
    }

    if (!id) {
      const records = await findLeadRecords({ phone, email });
      if (records === null) return false;
      id = records[0]?.id || "";
    }

    if (!id) return false;
    return await patchRecord(id, {
      "Booked Appointment": true,
      "Cancelled Appointment": false,
      // A booked lead isn't disqualified (the CRM hides Disqualified rows from Visits).
      Disqualified: false,
      booked_date: date,
      booked_time: paddedTime,
    });
  } catch {
    return false;
  }
}

/**
 * Finds the lead's Airtable rows (by lead_session_id first, then phone or email),
 * then ticks Disqualified and sets wall_type = "tiling". A session match updates
 * every row of that session (Make's spare rows are the same person and answers);
 * a phone/email match updates only the best row.
 * The funnel's "Tiling is a must-have" button only reaches /api/lead-progress,
 * not Make, so without this the lead looks like an in-area drop-off in "Needs
 * Calling". The abandoned-lead cron runs it once more as a catch-up, in case
 * Make hadn't created the record yet.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableLeadTilingDisqualified(
  leadSessionId: string,
  phone: string,
  email: string,
): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  const fields = { Disqualified: true, wall_type: "tiling" };
  const sessionId = cleanSessionId(leadSessionId);

  try {
    if (sessionId) {
      const bySession = await searchRecords(`{lead_session_id}="${sessionId}"`);
      if (bySession === null) return false;
      if (bySession.length) {
        let ok = true;
        for (const record of bySession.slice(0, 5)) ok = (await patchRecord(record.id, fields)) && ok;
        return ok;
      }
    }

    const records = await findLeadRecords({ phone, email });
    if (!records?.length) return false;
    return await patchRecord(records[0].id, fields);
  } catch {
    return false;
  }
}

/**
 * Ticks "Abandoned SMS Sent" on the lead's best Airtable row (by lead_session_id
 * first, then phone or email) so the team can see the follow-up was fired.
 * Called automatically after the abandoned-lead SMS is successfully delivered.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAbandonedSmsSent(
  phone: string,
  email: string,
  leadSessionId?: string | null,
): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  try {
    const records = await findLeadRecords({ sessionId: leadSessionId, phone, email });
    if (!records?.length) return false;
    return await patchRecord(records[0].id, { "Abandoned SMS Sent": true });
  } catch {
    return false;
  }
}

/**
 * Ticks "Appointment Confirmed" on the lead's Airtable row that holds the visit
 * (or their best row if none is marked booked). Called when a lead replies "YES"
 * to the 24h reminder SMS, so the team can see who has confirmed attendance.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAppointmentConfirmed(phone: string): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  try {
    let records = await findLeadRecords({ phone, filter: bookedFormula() });
    if (records === null) return false;
    if (!records.length) records = await findLeadRecords({ phone });
    if (!records?.length) return false;
    return await patchRecord(records[0].id, { "Appointment Confirmed": true });
  } catch {
    return false;
  }
}

/**
 * Marks the lead's booked Airtable row as cancelled (Cancelled Appointment = true,
 * clears Booked Appointment and booking date/time). Called when a lead cancels by
 * text, email or the manage link.
 *
 * With `date` (the cancelled visit's date), clears every matching row that shows a
 * visit on that date, so no spare row keeps showing it. Without it, clears the best
 * booked row only.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAppointmentCancelled(
  phone: string,
  email: string,
  date?: string | null,
): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  const hasDate = Boolean(date && DATE_RE.test(date));

  try {
    const records = await findLeadRecords({ phone, email, filter: bookedFormula(hasDate ? date! : undefined) });
    if (!records?.length) return false;

    let ok = true;
    for (const record of hasDate ? records : records.slice(0, 1)) {
      ok = (await patchRecord(record.id, {
        "Cancelled Appointment": true,
        "Booked Appointment": false,
        booked_date: null,
        booked_time: null,
      })) && ok;
    }
    return ok;
  } catch {
    return false;
  }
}
