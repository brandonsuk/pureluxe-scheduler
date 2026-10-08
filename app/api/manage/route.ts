import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDate } from "@/lib/time";
import { cancelCalendarEvent, cancelCalendarEventByAppointmentId } from "@/lib/google-calendar";
import { markAirtableAppointmentCancelled } from "@/lib/airtable-sync";
import { sendCancellationNotifications } from "@/lib/notifications";
import { MAX_RESCHEDULES, verifyManageSignature } from "@/lib/manage-links";

// Customer "manage your visit" page, linked from the confirmation and reminder emails.
// GET  ?id&sig&action=cancel      -> confirm page (a GET never cancels, so email link
//                                     scanners can't cancel by opening the link)
// POST id&sig (form)              -> cancels the visit
// GET  ?id&sig&action=reschedule  -> sends them to the funnel booking page with details
//                                     prefilled. Their current visit stays booked until
//                                     they pick a new slot (/api/book replaces it then).
//                                     Limited to MAX_RESCHEDULES per booking chain.

type Appointment = {
  id: string;
  date: string;
  start_time: string;
  client_name: string;
  client_email: string;
  client_phone: string;
  address: string;
  status: string;
  google_event_id: string | null;
  thomas_event_id: string | null;
  reschedule_count: number | null;
};

const THOMAS_PHONE = "07803424399";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prettyDate(date: string, time: string): string {
  try {
    const d = new Date(`${date}T00:00:00Z`);
    const day = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    return `${day} at ${time.slice(0, 5)}`;
  } catch {
    return `${date} at ${time.slice(0, 5)}`;
  }
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" /><title>${esc(title)} | PureLuxe</title></head>
<body style="margin:0;background:#f5f2ea;font-family:Arial,sans-serif;color:#171717;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;">
  <div style="background:#fff;border:1px solid #e7dfcf;border-radius:14px;overflow:hidden;">
    <div style="background:#171717;padding:20px 24px;">
      <p style="margin:0;color:#d5b36a;font-size:12px;letter-spacing:2px;text-transform:uppercase;">PureLuxe</p>
      <h1 style="margin:8px 0 0 0;color:#fff;font-size:22px;">${esc(title)}</h1>
    </div>
    <div style="padding:24px;line-height:1.6;">${body}</div>
  </div>
</div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const btn = (bg: string, color: string) =>
  `display:inline-block;background:${bg};color:${color};font-weight:700;padding:14px 24px;border-radius:8px;text-decoration:none;font-size:15px;border:0;cursor:pointer;`;

function rebookUrl(a: Appointment): string {
  const params = new URLSearchParams({
    name: a.client_name || "",
    phone: a.client_phone || "",
    email: a.client_email || "",
    qualified: "1",
    ...(a.address ? { address: a.address } : {}),
  });
  return `${env.funnelBaseUrl}/book?${params.toString()}`;
}

function visitBox(a: Appointment): string {
  return `<div style="border:1px solid #ece3d0;border-radius:10px;background:#fffcf6;padding:14px 16px;margin:0 0 18px 0;">
    <p style="margin:0 0 6px 0;"><strong>When:</strong> ${esc(prettyDate(a.date, a.start_time))}</p>
    <p style="margin:0;"><strong>Address:</strong> ${esc(a.address)}</p></div>`;
}

const invalidLink = () =>
  page("Link not recognised", `<p>Sorry, this link isn't valid. Please call Thomas on <strong>${THOMAS_PHONE}</strong> and he'll sort it for you.</p>`, 400);

const notActive = (a: Appointment) =>
  page(
    "This visit is no longer active",
    `<p>This visit has already been cancelled or has passed.</p>
     <p><a href="${esc(rebookUrl(a))}" style="${btn("#d5b36a", "#171717")}">Book a new visit</a></p>
     <p style="color:#5f5a4f;font-size:14px;">Questions? Call Thomas on <strong>${THOMAS_PHONE}</strong>.</p>`,
  );

async function loadAppointment(id: string): Promise<Appointment | null> {
  const { data } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,client_name,client_email,client_phone,address,status,google_event_id,thomas_event_id,reschedule_count")
    .eq("id", id)
    .maybeSingle();
  return (data as Appointment | null) ?? null;
}

const isActive = (a: Appointment) => a.status === "confirmed" && a.date >= todayIsoDate();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const sig = url.searchParams.get("sig") || "";
  const action = url.searchParams.get("action");
  if (!id || !verifyManageSignature(id, sig)) return invalidLink();

  const a = await loadAppointment(id);
  if (!a) return invalidLink();
  if (!isActive(a)) return notActive(a);

  if (action === "reschedule") {
    if ((a.reschedule_count ?? 0) >= MAX_RESCHEDULES) {
      return page(
        "Change your visit",
        `${visitBox(a)}
         <p>This visit has already been moved ${MAX_RESCHEDULES} times, so online rescheduling isn't available for it.</p>
         <p>Please call or text Thomas on <strong>${THOMAS_PHONE}</strong> and he'll find a time that works.</p>`,
      );
    }
    return page(
      "Choose a new time",
      `${visitBox(a)}
       <p>Pick a new time that suits you. Your details are already filled in.</p>
       <p style="color:#5f5a4f;font-size:14px;">Your current visit stays booked until you confirm the new time, then it's replaced automatically.</p>
       <p><a href="${esc(rebookUrl(a))}" style="${btn("#d5b36a", "#171717")}">Choose a new time</a></p>`,
    );
  }

  // Default: cancel confirmation (no change until they press the button)
  return page(
    "Cancel your visit?",
    `${visitBox(a)}
     <p>Are you sure you want to cancel this visit?</p>
     <form method="POST" action="/api/manage" style="margin:0 0 14px 0;">
       <input type="hidden" name="id" value="${esc(a.id)}" />
       <input type="hidden" name="sig" value="${esc(sig)}" />
       <button type="submit" style="${btn("#171717", "#ffffff")}">Yes, cancel my visit</button>
     </form>
     <p style="color:#5f5a4f;font-size:14px;">Changed your mind? Just close this page and your visit stays booked.
     Need a different time instead? <a href="${esc(rebookUrl(a))}">Choose a new time</a>.</p>`,
  );
}

export async function POST(request: Request) {
  let id = "";
  let sig = "";
  try {
    const form = await request.formData();
    id = String(form.get("id") || "");
    sig = String(form.get("sig") || "");
  } catch {
    return invalidLink();
  }
  if (!id || !verifyManageSignature(id, sig)) return invalidLink();

  const a = await loadAppointment(id);
  if (!a) return invalidLink();
  if (!isActive(a)) return notActive(a);

  const { error } = await supabaseAdmin
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", a.id)
    .eq("status", "confirmed");
  if (error) {
    // eslint-disable-next-line no-console
    console.error("manage_cancel_failed", error);
    return page("Something went wrong", `<p>We couldn't cancel online just now. Please call Thomas on <strong>${THOMAS_PHONE}</strong>.</p>`, 500);
  }

  markAirtableAppointmentCancelled(a.client_phone, a.client_email).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("manage_cancel_airtable_sync_failed", e);
  });

  try {
    if (a.google_event_id) {
      await cancelCalendarEvent(a.google_event_id);
    } else {
      await cancelCalendarEventByAppointmentId(a.id);
    }
    if (a.thomas_event_id && env.googleOpenSlotsCalendarId) {
      await cancelCalendarEvent(a.thomas_event_id, env.googleOpenSlotsCalendarId);
    }
  } catch (calendarError) {
    // eslint-disable-next-line no-console
    console.error("manage_cancel_calendar_failed", calendarError);
  }

  await sendCancellationNotifications({
    clientEmail: a.client_email,
    clientPhone: a.client_phone,
    date: a.date,
    startTime: a.start_time.slice(0, 5),
  });

  return page(
    "Your visit is cancelled",
    `<p>Your visit on <strong>${esc(prettyDate(a.date, a.start_time))}</strong> has been cancelled. We've sent you a confirmation.</p>
     <p>If you'd like to book another time, it only takes a minute:</p>
     <p><a href="${esc(rebookUrl(a))}" style="${btn("#d5b36a", "#171717")}">Book a new time</a></p>`,
  );
}
