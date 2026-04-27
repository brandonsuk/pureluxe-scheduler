import { addDays, format } from "date-fns";
import { env } from "@/lib/env";
import { sendReminder24h } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDateInTimeZone } from "@/lib/time";

type ReminderAppointment = {
  id: string;
  date: string;
  start_time: string;
  client_name: string;
  client_email: string;
  client_phone: string;
  address: string;
  reminder_24h_sent_at: string | null;
};

// Cron runs every 15 mins; reminders fire in the 20:00–20:14 window the night before
const EVENING_HOUR = 20;
const WINDOW_MINS = 15;

function isEveningWindow(timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return parseInt(map.hour, 10) === EVENING_HOUR && parseInt(map.minute, 10) < WINDOW_MINS;
}

export async function runReminderCheck(): Promise<{
  scanned: number;
  sent_24h: number;
}> {
  const tz = env.googleCalendarTimezone;

  if (!isEveningWindow(tz)) {
    return { scanned: 0, sent_24h: 0 };
  }

  const today = todayIsoDateInTimeZone(tz);
  const tomorrow = format(addDays(new Date(today), 1), "yyyy-MM-dd");

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,client_name,client_email,client_phone,address,reminder_24h_sent_at")
    .eq("status", "confirmed")
    .eq("date", tomorrow)
    .order("start_time", { ascending: true });

  if (error) throw new Error(error.message);

  const appointments = (data || []) as ReminderAppointment[];
  let sent24h = 0;

  for (const appt of appointments) {
    if (appt.reminder_24h_sent_at) continue;

    await sendReminder24h({
      clientName: appt.client_name,
      clientEmail: appt.client_email,
      clientPhone: appt.client_phone,
      date: appt.date,
      startTime: appt.start_time.slice(0, 5),
      address: appt.address,
    });
    sent24h += 1;
    await supabaseAdmin
      .from("appointments")
      .update({ reminder_24h_sent_at: new Date().toISOString() })
      .eq("id", appt.id);
  }

  return {
    scanned: appointments.length,
    sent_24h: sent24h,
  };
}
