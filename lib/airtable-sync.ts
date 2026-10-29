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
 * Finds the lead's Airtable record (by lead_session_id first, then phone or
 * email, newest first), then ticks Disqualified and sets wall_type = "tiling".
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

  // These values come from a public endpoint, so keep quotes out of the formulas.
  const sessionId = leadSessionId.replace(/[^\w-]/g, "");
  const cleanEmail = email.toLowerCase().replace(/["\\]/g, "");
  const fallback = [
    ...phoneVariants(phone).filter((p) => /^\+?\d+$/.test(p)).map((p) => `{phone}="${p}"`),
    ...(cleanEmail ? [`{email}="${cleanEmail}"`] : []),
  ];
  const formulas = [
    sessionId ? `{lead_session_id}="${sessionId}"` : "",
    fallback.length ? `OR(${fallback.join(",")})` : "",
  ].filter(Boolean);

  try {
    for (const formula of formulas) {
      const searchRes = await airtableFetch(
        `?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&sort[0][field]=Created Time&sort[0][direction]=desc`,
      );
      if (!searchRes.ok) return false;
      const searchData = (await searchRes.json()) as { records?: { id: string }[] };
      const record = searchData.records?.[0];
      if (!record) continue;

      const patchRes = await airtableFetch(`/${record.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          fields: {
            Disqualified: true,
            wall_type: "tiling",
          },
        }),
      });
      return patchRes.ok;
    }
    return false;
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
 * Finds the Airtable lead record matching the given phone, then ticks the
 * "Appointment Confirmed" checkbox. Called when a lead replies "YES" to the
 * 24h reminder SMS, so the team can see who has confirmed attendance.
 *
 * Returns true if the record was updated, false if not found or not configured.
 */
export async function markAirtableAppointmentConfirmed(phone: string): Promise<boolean> {
  if (!env.airtableApiKey) return false;

  const variants = phoneVariants(phone);
  const formula = `OR(${variants.map((p) => `{phone}="${p}"`).join(",")})`;

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
          "Appointment Confirmed": true,
        },
      }),
    });
    return patchRes.ok;
  } catch {
    return false;
  }
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
