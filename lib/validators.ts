import { z } from "zod";

export const validateAddressSchema = z.object({
  address: z.string().min(5),
});

export const availableSlotsSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  duration_mins: z.coerce.number().int().min(30).max(180),
  from_date: z.string().optional(),
});

const readinessSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "ready") return "ready";
  if (normalized === "partial") return "partial";
  if (normalized === "unsure") return "unsure";
  if (normalized === "i know exactly what i want") return "ready";
  if (normalized === "i have some ideas but need guidance") return "partial";
  if (normalized === "i'm not sure yet, i need help deciding") return "unsure";
  return normalized;
}, z.enum(["ready", "partial", "unsure"]));

export const bookSchema = z.object({
  date: z.string(),
  start_time: z.string(),
  duration_mins: z.coerce.number().int().min(30).max(180),
  client_name: z.string().min(2),
  client_phone: z.string().min(7),
  client_email: z.string().email(),
  address: z.string().min(5),
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  readiness_level: readinessSchema,
});

export const preferredSlotsSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  duration_mins: z.coerce.number().int().min(30).max(180),
  preferred_date: z.string(),
  preferred_window: z.enum(["morning", "afternoon", "evening"]),
});

export const cancelSchema = z.object({
  appointment_id: z.string().uuid(),
  admin_password: z.string().min(1),
});

export const workingHoursSchema = z.object({
  admin_password: z.string().min(1),
  start_date: z.string(),
  end_date: z.string().optional(),
  start_time: z.string(),
  end_time: z.string(),
  is_available: z.boolean().default(true),
});
