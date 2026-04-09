import { env } from "@/lib/env";

function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/[^\d+]/g, "");
  const variants = new Set<string>([phone, digits]);
  const bare = digits.replace(/^\+/, "");
  if (bare.startsWith("44")) {
    variants.add(`0${bare.slice(2)}`);
    variants.add(`+${bare}`);
  }
  if (bare.startsWith("0")) {
    variants.add(`+44${bare.slice(1)}`);
  }
  return [...variants].filter(Boolean);
}

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

/**
 * Finds the Airtable lead record matching the given phone or email, then marks
 * it as booked (sets Booked Appointment = true, writes booked_date and
 * booked_time, clears Cancelled Appointment). Called when a booking is
 * confirmed via /api/book — covers both normal and abandoned-lead-recovery flows.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAppointmentBooked(
  phone: string,
  email: string,
  date: string,
  startTime: string,
): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  const variants = phoneVariants(phone);
  const phoneFormula = variants.map((p) => `{phone}="${p}"`).join(",");
  const formula = `OR(${phoneFormula},{email}="${email.toLowerCase()}")`;

  try {
    const searchRes = await airtableFetch(
      `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&sort[0][field]=Created Time&sort[0][direction]=desc`,
    );
    if (!searchRes.ok) return false;
    const searchData = (await searchRes.json()) as { records?: { id: string }[] };
    const record = searchData.records?.[0];
    if (!record) return false;

    // Ensure time is zero-padded HH:MM so Airtable parses it correctly
    const paddedTime = startTime.length === 4 ? `0${startTime}` : startTime;

    const patchRes = await airtableFetch(`/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          "Booked Appointment": true,
          "Cancelled Appointment": false,
          booked_date: date,
          booked_time: paddedTime,
        },
      }),
    });
    return patchRes.ok;
  } catch {
    return false;
  }
}

/**
 * Finds the Airtable lead record matching the given phone or email, then ticks
 * the "Abandoned SMS Sent" checkbox so the team can see the follow-up was fired.
 * Called automatically after the abandoned-lead SMS is successfully delivered.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAbandonedSmsSent(phone: string, email: string): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  const variants = phoneVariants(phone);
  const phoneFormula = variants.map((p) => `{phone}="${p}"`).join(",");
  const formula = `OR(${phoneFormula},{email}="${email.toLowerCase()}")`;

  try {
    const searchRes = await airtableFetch(
      `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&sort[0][field]=Created Time&sort[0][direction]=desc`,
    );
    if (!searchRes.ok) return false;
    const searchData = (await searchRes.json()) as { records?: { id: string }[] };
    const record = searchData.records?.[0];
    if (!record) return false;

    const patchRes = await airtableFetch(`/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          "Abandoned SMS Sent": true,
        },
      }),
    });
    return patchRes.ok;
  } catch {
    return false;
  }
}

/**
 * Finds an Airtable lead record by email address.
 * Returns the record id, or null if not found.
 */
async function findAirtableLeadByEmail(email: string): Promise<{ id: string; fields: Record<string, unknown> } | null> {
  if (!env.airtableApiKey) return null;
  const formula = `{email}="${email.toLowerCase()}"`;
  try {
    const res = await airtableFetch(
      `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&sort[0][field]=Created Time&sort[0][direction]=desc`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { records?: { id: string; fields: Record<string, unknown> }[] };
    return data.records?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Marks a lead's "Invalid Phone Sent" checkbox in Airtable.
 * Called when admin clicks the Invalid +44 button.
 */
export async function markAirtableInvalidPhoneSent(email: string): Promise<boolean> {
  const record = await findAirtableLeadByEmail(email);
  if (!record) return false;
  try {
    const res = await airtableFetch(`/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: { "Invalid Phone Sent": true } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Updates the phone field on a lead record and sets "Number Updated" = true.
 * Called when the lead replies to the invalid-phone email with their correct number.
 * Returns the updated phone string, or null on failure.
 */
export async function updateAirtablePhoneNumber(email: string, newPhone: string): Promise<boolean> {
  const record = await findAirtableLeadByEmail(email);
  if (!record) return false;
  try {
    const res = await airtableFetch(`/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          phone: newPhone,
          "Number Updated": true,
          "Invalid Phone Sent": false,
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns true if the lead (by email) has "Invalid Phone Sent" = true in Airtable.
 */
export async function isAirtableInvalidPhonePending(email: string): Promise<boolean> {
  const record = await findAirtableLeadByEmail(email);
  return Boolean(record?.fields["Invalid Phone Sent"]);
}

/**
 * Finds the Airtable lead record matching the given phone or email, then marks
 * it as cancelled (sets Cancelled Appointment = true, clears Booked Appointment
 * and booking date/time). Called automatically when a lead texts/emails "CA".
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAppointmentCancelled(phone: string, email: string): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  const variants = phoneVariants(phone);
  const phoneFormula = variants.map((p) => `{phone}="${p}"`).join(",");
  const formula = `AND(OR(${phoneFormula},{email}="${email.toLowerCase()}"),{Booked Appointment}=TRUE())`;

  try {
    const searchRes = await airtableFetch(`?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`);
    if (!searchRes.ok) return false;
    const searchData = (await searchRes.json()) as { records?: { id: string }[] };
    const record = searchData.records?.[0];
    if (!record) return false;

    const patchRes = await airtableFetch(`/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          "Cancelled Appointment": true,
          "Booked Appointment": false,
          booked_date: null,
          booked_time: null,
        },
      }),
    });
    return patchRes.ok;
  } catch {
    return false;
  }
}
