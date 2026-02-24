const required = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_MAPS_API_KEY",
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
  loqateApiKey: process.env.NEXT_PUBLIC_LOQATE_API_KEY || "",
  twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  homeBaseLat: Number(process.env.HOME_BASE_LAT || 55.7956),
  homeBaseLng: Number(process.env.HOME_BASE_LNG || -3.7939),
  maxDriveMins: Number(process.env.MAX_DRIVE_MINS || 40),
  bufferMins: Number(process.env.BUFFER_MINS || 5),
  appUrl: process.env.NEXT_PUBLIC_API_URL || "",
};
