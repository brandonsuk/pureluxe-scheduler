import { Resend } from "resend";
import twilio from "twilio";
import { env } from "@/lib/env";

const resend = env.resendApiKey ? new Resend(env.resendApiKey) : null;
const twilioClient = env.twilioSid && env.twilioAuthToken ? twilio(env.twilioSid, env.twilioAuthToken) : null;

type BookingPayload = {
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  date: string;
  startTime: string;
  durationMins: number;
  address: string;
  readinessLevel: string;
};

function emailShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;background:#f5f2ea;font-family:Arial,sans-serif;color:#171717;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f2ea;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7dfcf;">
            <tr>
              <td style="background:#171717;padding:20px 24px;">
                <p style="margin:0;color:#d5b36a;font-size:12px;letter-spacing:2px;text-transform:uppercase;">PureLuxe</p>
                <h1 style="margin:8px 0 0 0;color:#ffffff;font-size:22px;font-weight:700;">Scotland&apos;s Finest Bathrooms</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;border-top:1px solid #eee7d9;background:#fbf8f1;">
                <p style="margin:0;color:#5f5a4f;font-size:12px;">PureLuxe Bathrooms • Glasgow-Edinburgh Corridor</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function bookingLeadHtml(payload: BookingPayload): string {
  return emailShell(
    "Booking Confirmed",
    `
    <h2 style="margin:0 0 14px 0;color:#171717;font-size:24px;">Your appointment is confirmed</h2>
    <p style="margin:0 0 18px 0;color:#2f2f2f;line-height:1.6;">Thanks ${payload.clientName}, your quote visit is booked.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #ece3d0;border-radius:10px;background:#fffcf6;">
      <tr><td style="padding:14px 16px;">
        <p style="margin:0 0 8px 0;"><strong>Date:</strong> ${payload.date}</p>
        <p style="margin:0 0 8px 0;"><strong>Time:</strong> ${payload.startTime}</p>
        <p style="margin:0 0 8px 0;"><strong>Duration:</strong> ${payload.durationMins} mins</p>
        <p style="margin:0;"><strong>Address:</strong> ${payload.address}</p>
      </td></tr>
    </table>
    <p style="margin:16px 0 8px 0;color:#2f2f2f;line-height:1.6;">Thomas will be coming to quote. If needed, call <strong>07710597590</strong>.</p>
    <p style="margin:0;color:#2f2f2f;line-height:1.6;">To cancel by email, reply with <strong>CA</strong>.</p>
  `,
  );
}

function cancellationLeadHtml(date: string, startTime: string): string {
  return emailShell(
    "Appointment Cancelled",
    `
    <h2 style="margin:0 0 14px 0;color:#171717;font-size:24px;">Your appointment has been cancelled</h2>
    <p style="margin:0 0 18px 0;color:#2f2f2f;line-height:1.6;">Your PureLuxe appointment on <strong>${date}</strong> at <strong>${startTime}</strong> is now cancelled.</p>
    <p style="margin:0;color:#2f2f2f;line-height:1.6;">If this was a mistake, reply to this email or contact us to rebook.</p>
  `,
  );
}

export async function sendBookingNotifications(payload: BookingPayload) {
  const leadEmailText = `PureLuxe booking confirmed: ${payload.date} at ${payload.startTime} (${payload.durationMins} mins) at ${payload.address}.

Thomas will be coming to quote, his phone number is 07710597590 incase you need it.

Reply with the word CA to this email if you need to cancel your appointment.`;
  const leadSmsText = `PureLuxe booking confirmed: ${payload.date} at ${payload.startTime} (${payload.durationMins} mins) at ${payload.address}.

Thomas will be coming to quote, his phone number is 07710597590 incase you need it.

Reply with the word CA by SMS if you need to cancel your appointment.`;
  const adminText = `New booking: ${payload.clientName}, ${payload.date} ${payload.startTime}, ${payload.address}, ${payload.durationMins} mins, readiness: ${payload.readinessLevel}.`;

  await Promise.allSettled([
    sendEmail(payload.clientEmail, "Your PureLuxe appointment is confirmed", leadEmailText, {
      html: bookingLeadHtml(payload),
    }),
    sendSms(payload.clientPhone, leadSmsText),
    sendEmail("admin@pureluxe.co.uk", "New PureLuxe booking", adminText),
  ]);
}

export async function sendCancellationNotifications(
  payload: Pick<BookingPayload, "clientEmail" | "clientPhone" | "date" | "startTime">,
  options?: { sendSms?: boolean },
) {
  const text = `Your PureLuxe appointment on ${payload.date} at ${payload.startTime} has been cancelled.`;
  const adminText = `Cancellation: ${payload.date} ${payload.startTime}. Lead email: ${payload.clientEmail}. Lead phone: ${payload.clientPhone}.`;
  const sendSmsEnabled = options?.sendSms ?? true;
  await Promise.allSettled([
    sendEmail(payload.clientEmail, "Your PureLuxe appointment was cancelled", text, {
      html: cancellationLeadHtml(payload.date, payload.startTime),
    }),
    sendEmail(env.adminAlertEmail, "PureLuxe booking cancelled", adminText),
    ...(sendSmsEnabled ? [sendSms(payload.clientPhone, text)] : []),
  ]);
}

async function sendEmail(to: string, subject: string, text: string, options?: { html?: string }) {
  if (!resend) return;
  await resend.emails.send({
    from: "PureLuxe <contact@pureluxebathrooms.co.uk>",
    to,
    subject,
    text,
    html: options?.html,
  });
}

async function sendSms(to: string, body: string) {
  if (!twilioClient || !env.twilioPhoneNumber) return;
  await twilioClient.messages.create({
    from: env.twilioPhoneNumber,
    to,
    body,
  });
}

export function reminderSchedulingStub() {
  // Intended for Vercel Cron or queue integration.
  return { status: "not_implemented" as const };
}

type ReminderPayload = Pick<BookingPayload, "clientPhone" | "date" | "startTime" | "address">;

export async function sendReminder24hSms(payload: ReminderPayload) {
  const body = `Reminder: your PureLuxe quote visit is tomorrow, ${payload.date} at ${payload.startTime}, at ${payload.address}.

Thomas' number is 07710597590 if needed.

Reply CA by SMS if you need to cancel.`;
  await sendSms(payload.clientPhone, body);
}

type AbandonedLeadPayload = {
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  resumeLink: string;
};

function abandonedLeadHtml(payload: AbandonedLeadPayload): string {
  return emailShell(
    "Complete your PureLuxe booking",
    `
    <h2 style="margin:0 0 14px 0;color:#171717;font-size:24px;">You're almost there!</h2>
    <p style="margin:0 0 18px 0;color:#2f2f2f;line-height:1.6;">Hi ${payload.clientName}, you were very close to booking your free PureLuxe quote visit.</p>
    <p style="margin:0 0 24px 0;color:#2f2f2f;line-height:1.6;">Click the button below to pick your preferred time — it only takes a moment.</p>
    <a href="${payload.resumeLink}" style="display:inline-block;background:#d5b36a;color:#171717;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none;font-size:15px;">Complete My Booking</a>
  `,
  );
}

export async function sendAbandonedLeadFollowUp(payload: AbandonedLeadPayload) {
  const smsBody = `Hi ${payload.clientName}, you were very close to booking your free PureLuxe quote visit. Finish your booking here: ${payload.resumeLink}`;
  await Promise.allSettled([
    sendSms(payload.clientPhone, smsBody),
    sendEmail(payload.clientEmail, "Complete your PureLuxe booking", smsBody, {
      html: abandonedLeadHtml(payload),
    }),
  ]);
}

export async function sendAbandonedLeadSms(payload: AbandonedLeadPayload) {
  const body = `Hi ${payload.clientName}, you were very close to booking your free PureLuxe quote visit. Finish your booking here: ${payload.resumeLink}`;
  await sendSms(payload.clientPhone, body);
}

export async function sendQualificationSms(payload: {
  clientName: string;
  clientPhone: string;
  bookingLink: string;
}) {
  const body = `We'd love to visit you for your free PureLuxe Bathroom consultation! Slots are now available, book one that suits you here: ${payload.bookingLink}`;
  await sendSms(payload.clientPhone, body);
}
