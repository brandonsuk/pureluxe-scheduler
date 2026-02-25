import { google } from "googleapis";
import { env } from "@/lib/env";

type CreateEventInput = {
  appointmentId: string;
  date: string;
  startTime: string;
  endTime: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  address: string;
  readinessLevel: string;
  durationMins: number;
};

function isCalendarConfigured(): boolean {
  return Boolean(
    env.googleCalendarId && env.googleServiceAccountEmail && env.googleServiceAccountPrivateKey,
  );
}

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: env.googleServiceAccountEmail,
    key: env.googleServiceAccountPrivateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  return google.calendar({ version: "v3", auth });
}

export async function createCalendarEvent(input: CreateEventInput): Promise<string | null> {
  if (!isCalendarConfigured()) return null;

  const calendar = getCalendarClient();
  const response = await calendar.events.insert({
    calendarId: env.googleCalendarId,
    requestBody: {
      summary: `PureLuxe Quote Visit - ${input.clientName}`,
      description: [
        `Appointment ID: ${input.appointmentId}`,
        `Client: ${input.clientName}`,
        `Phone: ${input.clientPhone}`,
        `Email: ${input.clientEmail}`,
        `Address: ${input.address}`,
        `Readiness: ${input.readinessLevel}`,
        `Duration: ${input.durationMins} mins`,
      ].join("\n"),
      location: input.address,
      start: {
        dateTime: `${input.date}T${input.startTime}:00`,
        timeZone: env.googleCalendarTimezone,
      },
      end: {
        dateTime: `${input.date}T${input.endTime}:00`,
        timeZone: env.googleCalendarTimezone,
      },
    },
  });

  return response.data.id || null;
}

export async function cancelCalendarEvent(eventId: string | null | undefined): Promise<void> {
  if (!eventId || !isCalendarConfigured()) return;

  const calendar = getCalendarClient();
  await calendar.events.delete({
    calendarId: env.googleCalendarId,
    eventId,
  });
}

