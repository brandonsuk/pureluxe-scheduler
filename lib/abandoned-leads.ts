import { subMinutes } from "date-fns";
import { env } from "@/lib/env";
import { sendAbandonedLeadSms } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDateInTimeZone } from "@/lib/time";

type LeadProgressRow = Record<string, unknown> & {
  submission_id?: string;
  lead_session_id?: string;
  client_name?: string;
  client_email?: string;
  client_phone?: string;
  postcode?: string;
  current_step?: number;
  created_at?: string;
  updated_at?: string;
  last_activity_at?: string;
  is_disqualified?: boolean;
};

type AbandonedTrackerRow = {
  lead_session_id: string;
  reminder_sent_at: string | null;
  suppressed_reason: string | null;
};

function normalizePhoneForMatch(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

function phoneCandidates(rawPhone: string): string[] {
  const normalized = normalizePhoneForMatch(rawPhone);
  const out = new Set<string>([normalized]);
  const digitsOnly = normalized.replace(/^\+/, "");

  if (digitsOnly.startsWith("44")) out.add(`0${digitsOnly.slice(2)}`);
  if (digitsOnly.startsWith("0")) out.add(`+44${digitsOnly.slice(1)}`);

  return [...out].filter(Boolean);
}

function hasValidPhone(phone: string): boolean {
  const digitsOnly = normalizePhoneForMatch(phone).replace(/\D/g, "");
  return digitsOnly.length >= 10;
}

function hasMinimumLeadData(row: LeadProgressRow): boolean {
  return Boolean(row.client_name && row.client_phone && row.client_email && row.postcode);
}

function isDisqualified(row: LeadProgressRow): boolean {
  return row.is_disqualified === true;
}

function rowLastActivityIso(row: LeadProgressRow): string | null {
  const lastActivity = typeof row.last_activity_at === "string" ? row.last_activity_at : null;
  const updated = typeof row.updated_at === "string" ? row.updated_at : null;
  const created = typeof row.created_at === "string" ? row.created_at : null;
  return lastActivity || updated || created;
}

function latestBySession(rows: LeadProgressRow[]): LeadProgressRow[] {
  const bySession = new Map<string, LeadProgressRow>();

  for (const row of rows) {
    const sessionId = typeof row.lead_session_id === "string" ? row.lead_session_id : "";
    if (!sessionId) continue;

    const existing = bySession.get(sessionId);
    const rowTs = Date.parse(rowLastActivityIso(row) || "");
    const existingTs = existing ? Date.parse(rowLastActivityIso(existing) || "") : Number.NEGATIVE_INFINITY;

    if (!existing || rowTs > existingTs) bySession.set(sessionId, row);
  }

  return [...bySession.values()];
}

function buildResumeLink(leadSessionId: string): string {
  return `${env.funnelBaseUrl.replace(/\/$/, "")}/resume?session=${encodeURIComponent(leadSessionId)}`;
}

async function loadExistingTrackers(sessionIds: string[]): Promise<Map<string, AbandonedTrackerRow>> {
  if (!sessionIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("abandoned_followups")
    .select("lead_session_id,reminder_sent_at,suppressed_reason")
    .in("lead_session_id", sessionIds);

  if (error) throw new Error(error.message);
  return new Map(((data || []) as AbandonedTrackerRow[]).map((row) => [row.lead_session_id, row]));
}

async function hasUpcomingConfirmedBooking(phone: string): Promise<boolean> {
  const today = todayIsoDateInTimeZone(env.googleCalendarTimezone);
  const { count, error } = await supabaseAdmin
    .from("appointments")
    .select("id", { count: "exact", head: true })
    .eq("status", "confirmed")
    .gte("date", today)
    .in("client_phone", phoneCandidates(phone));

  if (error) throw new Error(error.message);
  return (count || 0) > 0;
}

async function upsertTracker(row: {
  lead_session_id: string;
  submission_id: string | null;
  client_name: string;
  client_phone: string;
  client_email: string;
  postcode: string;
  current_step: number;
  last_activity_at: string;
  is_disqualified: boolean;
  reminder_sent_at?: string | null;
  suppressed_reason?: string | null;
}) {
  const { error } = await supabaseAdmin
    .from("abandoned_followups")
    .upsert(
      {
        ...row,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "lead_session_id" },
    );

  if (error) throw new Error(error.message);
}

export async function runAbandonedLeadCheck(): Promise<{
  scanned: number;
  eligible: number;
  sent: number;
  suppressed_booked: number;
  suppressed_disqualified: number;
  suppressed_already_sent: number;
  suppressed_invalid_phone: number;
  send_failed: number;
}> {
  const thresholdDate = subMinutes(new Date(), 20);

  const { data, error } = await supabaseAdmin
    .from("abandoned_followups")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(error.message);

  const latestRows = latestBySession(
    ((data || []) as LeadProgressRow[])
      .filter(hasMinimumLeadData)
      .filter((row) => {
        const lastActivity = rowLastActivityIso(row);
        return Boolean(lastActivity && Date.parse(lastActivity) <= thresholdDate.getTime());
      }),
  );
  const trackers = await loadExistingTrackers(
    latestRows
      .map((row) => (typeof row.lead_session_id === "string" ? row.lead_session_id : ""))
      .filter(Boolean),
  );

  let eligible = 0;
  let sent = 0;
  let suppressedBooked = 0;
  let suppressedDisqualified = 0;
  let suppressedAlreadySent = 0;
  let suppressedInvalidPhone = 0;
  let sendFailed = 0;

  for (const row of latestRows) {
    const leadSessionId = String(row.lead_session_id || "");
    const clientName = String(row.client_name || "").trim();
    const clientPhone = String(row.client_phone || "").trim();
    const clientEmail = String(row.client_email || "").trim();
    const postcode = String(row.postcode || "").trim();
    const currentStep = Number(row.current_step || 1);
    const lastActivityAt = rowLastActivityIso(row);

    if (!leadSessionId || !clientName || !clientPhone || !clientEmail || !postcode || !lastActivityAt) continue;

    if (!hasValidPhone(clientPhone)) {
      suppressedInvalidPhone += 1;
      await upsertTracker({
        lead_session_id: leadSessionId,
        submission_id: typeof row.submission_id === "string" ? row.submission_id : null,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        postcode,
        current_step: currentStep,
        last_activity_at: lastActivityAt,
        is_disqualified: false,
        suppressed_reason: "invalid_phone",
      });
      continue;
    }

    const tracker = trackers.get(leadSessionId);
    if (tracker?.suppressed_reason?.startsWith("send_failed")) {
      sendFailed += 1;
      continue;
    }

    if (tracker?.reminder_sent_at) {
      suppressedAlreadySent += 1;
      await upsertTracker({
        lead_session_id: leadSessionId,
        submission_id: typeof row.submission_id === "string" ? row.submission_id : null,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        postcode,
        current_step: currentStep,
        last_activity_at: lastActivityAt,
        is_disqualified: isDisqualified(row),
        reminder_sent_at: tracker.reminder_sent_at,
        suppressed_reason: "already_sent",
      });
      continue;
    }

    if (isDisqualified(row)) {
      suppressedDisqualified += 1;
      await upsertTracker({
        lead_session_id: leadSessionId,
        submission_id: typeof row.submission_id === "string" ? row.submission_id : null,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        postcode,
        current_step: currentStep,
        last_activity_at: lastActivityAt,
        is_disqualified: true,
        suppressed_reason: "disqualified",
      });
      continue;
    }

    if (await hasUpcomingConfirmedBooking(clientPhone)) {
      suppressedBooked += 1;
      await upsertTracker({
        lead_session_id: leadSessionId,
        submission_id: typeof row.id === "string" ? row.id : null,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        postcode,
        current_step: currentStep,
        last_activity_at: lastActivityAt,
        is_disqualified: false,
        suppressed_reason: "booked",
      });
      continue;
    }

    eligible += 1;
    try {
      await sendAbandonedLeadSms({
        clientName,
        clientPhone,
        resumeLink: buildResumeLink(leadSessionId),
      });

      const sentAt = new Date().toISOString();
      await upsertTracker({
        lead_session_id: leadSessionId,
        submission_id: typeof row.submission_id === "string" ? row.submission_id : null,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        postcode,
        current_step: currentStep,
        last_activity_at: lastActivityAt,
        is_disqualified: false,
        reminder_sent_at: sentAt,
        suppressed_reason: null,
      });
      sent += 1;
    } catch (error) {
      sendFailed += 1;
      await upsertTracker({
        lead_session_id: leadSessionId,
        submission_id: typeof row.submission_id === "string" ? row.submission_id : null,
        client_name: clientName,
        client_phone: clientPhone,
        client_email: clientEmail,
        postcode,
        current_step: currentStep,
        last_activity_at: lastActivityAt,
        is_disqualified: false,
        suppressed_reason: error instanceof Error ? `send_failed:${error.message}` : "send_failed",
      });
    }
  }

  return {
    scanned: latestRows.length,
    eligible,
    sent,
    suppressed_booked: suppressedBooked,
    suppressed_disqualified: suppressedDisqualified,
    suppressed_already_sent: suppressedAlreadySent,
    suppressed_invalid_phone: suppressedInvalidPhone,
    send_failed: sendFailed,
  };
}
