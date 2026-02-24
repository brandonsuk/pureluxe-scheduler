import { z } from "zod";

export const validateAddressSchema = z.object({
  address: z.string().min(5),
});

export const availableSlotsSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  duration_mins: z.number().int().min(30).max(180),
  from_date: z.string().optional(),
});

export const bookSchema = z.object({
  date: z.string(),
  start_time: z.string(),
  duration_mins: z.number().int().min(30).max(180),
  client_name: z.string().min(2),
  client_phone: z.string().min(7),
  client_email: z.string().email(),
  address: z.string().min(5),
  lat: z.number(),
  lng: z.number(),
  readiness_level: z.enum(["ready", "partial", "unsure"]),
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
