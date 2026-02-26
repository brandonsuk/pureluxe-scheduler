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

export type CalendarEventSnapshot =
  | {
      exists: true;
      status: string;
      startDateTime: string | null;
      endDateTime: string | null;
    }
  | { exists: false };

export type CalendarListEvent = {
  id: string;
  summary: string;
  status: string;
  startDateTime: string | null;
  endDateTime: string | null;
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

export async function cancelCalendarEventByAppointmentId(appointmentId: string): Promise<boolean> {
  if (!appointmentId || !isCalendarConfigured()) return false;

  const calendar = getCalendarClient();
  const list = await calendar.events.list({
    calendarId: env.googleCalendarId,
    q: appointmentId,
    singleEvents: true,
    maxResults: 10,
  });

  const match = list.data.items?.find((event) =>
    event.description?.includes(`Appointment ID: ${appointmentId}`),
  );
  if (!match?.id) return false;

  await calendar.events.delete({
    calendarId: env.googleCalendarId,
    eventId: match.id,
  });

  return true;
}

export async function getCalendarEventSnapshot(eventId: string | null | undefined): Promise<CalendarEventSnapshot> {
  if (!eventId || !isCalendarConfigured()) return { exists: false };

  const calendar = getCalendarClient();
  try {
    const event = await calendar.events.get({
      calendarId: env.googleCalendarId,
      eventId,
    });
    return {
      exists: true,
      status: event.data.status || "confirmed",
      startDateTime: event.data.start?.dateTime || null,
      endDateTime: event.data.end?.dateTime || null,
    };
  } catch {
    return { exists: false };
  }
}

export async function listCalendarEvents(params: {
  calendarId?: string;
  timeMinIso: string;
  timeMaxIso: string;
  query?: string;
  maxResults?: number;
}): Promise<CalendarListEvent[]> {
  const calendarId = params.calendarId || env.googleCalendarId;
  if (!calendarId || !isCalendarConfigured()) return [];

  const calendar = getCalendarClient();
  const response = await calendar.events.list({
    calendarId,
    timeMin: params.timeMinIso,
    timeMax: params.timeMaxIso,
    singleEvents: true,
    orderBy: "startTime",
    q: params.query,
    maxResults: params.maxResults || 2500,
  });

  const events = response.data.items || [];
  return events
    .filter((event) => Boolean(event.id))
    .map((event) => ({
      id: event.id!,
      summary: event.summary || "",
      status: event.status || "confirmed",
      startDateTime: event.start?.dateTime || null,
      endDateTime: event.end?.dateTime || null,
    }));
}
