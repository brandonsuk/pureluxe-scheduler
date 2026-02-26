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

export async function sendBookingNotifications(payload: BookingPayload) {
  const leadText = `PureLuxe booking confirmed: ${payload.date} at ${payload.startTime} (${payload.durationMins} mins) at ${payload.address}.

Thomas will be coming to quote, his phone number is 07710597590 incase you need it.

Reply here with the word CA if you need to cancel your appointment.`;
  const adminText = `New booking: ${payload.clientName}, ${payload.date} ${payload.startTime}, ${payload.address}, ${payload.durationMins} mins, readiness: ${payload.readinessLevel}.`;

  await Promise.allSettled([
    sendEmail(payload.clientEmail, "Your PureLuxe appointment is confirmed", leadText),
    sendSms(payload.clientPhone, leadText),
    sendEmail("admin@pureluxe.co.uk", "New PureLuxe booking", adminText),
  ]);
}

export async function sendCancellationNotifications(payload: Pick<BookingPayload, "clientEmail" | "clientPhone" | "date" | "startTime">) {
  const text = `Your PureLuxe appointment on ${payload.date} at ${payload.startTime} has been cancelled.`;
  await Promise.allSettled([
    sendEmail(payload.clientEmail, "Your PureLuxe appointment was cancelled", text),
    sendSms(payload.clientPhone, text),
  ]);
}

async function sendEmail(to: string, subject: string, text: string) {
  if (!resend) return;
  await resend.emails.send({
    from: "PureLuxe <bookings@pureluxe.co.uk>",
    to,
    subject,
    text,
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
