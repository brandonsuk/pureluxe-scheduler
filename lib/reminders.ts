import { addDays, format } from "date-fns";
import { env } from "@/lib/env";
import { sendReminder24hSms } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabase";
import { todayIsoDateInTimeZone, zonedDateTimeKey, zonedNowKey } from "@/lib/time";

type ReminderAppointment = {
  id: string;
  date: string;
  start_time: string;
  client_phone: string;
  address: string;
  reminder_24h_sent_at: string | null;
};

const WINDOW_MINS = 15;

function inWindow(diffMins: number, targetMins: number): boolean {
  return diffMins <= targetMins && diffMins > targetMins - WINDOW_MINS;
}

export async function runReminderCheck(): Promise<{
  scanned: number;
  sent_24h: number;
}> {
  const startDate = todayIsoDateInTimeZone(env.googleCalendarTimezone);
  const endDate = format(addDays(new Date(startDate), 2), "yyyy-MM-dd");

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("id,date,start_time,client_phone,address,reminder_24h_sent_at,reminder_2h_sent_at")
    .eq("status", "confirmed")
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date", { ascending: true })
    .order("start_time", { ascending: true });

  if (error) throw new Error(error.message);

  const appointments = (data || []) as ReminderAppointment[];
  const nowKey = zonedNowKey(env.googleCalendarTimezone);
  let sent24h = 0;

  for (const appt of appointments) {
    const appointmentKey = zonedDateTimeKey(appt.date, appt.start_time);
    const diffMins = Math.round((appointmentKey - nowKey) / 60000);

    if (!appt.reminder_24h_sent_at && inWindow(diffMins, 24 * 60)) {
      await sendReminder24hSms({
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
  }

  return {
    scanned: appointments.length,
    sent_24h: sent24h,
  };
}
