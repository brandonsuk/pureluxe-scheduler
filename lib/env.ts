const required = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_LOQATE_API_KEY",
  "ADMIN_PASSWORD",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    // eslint-disable-next-line no-console
    console.warn(`Missing env var: ${key}`);
  }
}

export const env = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || "",
  tomtomApiKey: process.env.TOMTOM_API_KEY || "",
  distanceProvider: process.env.DISTANCE_PROVIDER || "tomtom",
  loqateApiKey: process.env.NEXT_PUBLIC_LOQATE_API_KEY || "",
  twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || "",
  googleOpenSlotsCalendarId: process.env.GOOGLE_OPEN_SLOTS_CALENDAR_ID || "",
  googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  googleServiceAccountPrivateKey: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  googleCalendarTimezone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Europe/London",
  cronSecret: process.env.CRON_SECRET || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  homeBaseLat: Number(process.env.HOME_BASE_LAT || 55.7956),
  homeBaseLng: Number(process.env.HOME_BASE_LNG || -3.7939),
  maxDriveMins: Number(process.env.MAX_DRIVE_MINS || 40),
  bufferMins: Number(process.env.BUFFER_MINS || 0),
  appUrl: process.env.NEXT_PUBLIC_API_URL || "",
};
