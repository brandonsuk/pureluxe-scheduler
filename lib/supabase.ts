import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

export const supabasePublic = createClient(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: false },
});
