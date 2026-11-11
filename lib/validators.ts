import { z } from "zod";

export const validateAddressSchema = z.object({
  address: z.string().min(5),
});

export const availableSlotsSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  duration_mins: z.coerce.number().int().min(30).max(180),
  from_date: z.string().optional(),
  override_max_drive: z.boolean().optional(),
});

const readinessSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "ready") return "ready";
  if (normalized === "partial") return "partial";
  if (normalized === "unsure") return "unsure";
  if (normalized === "very-confident") return "ready";
  if (normalized === "confident") return "partial";
  if (normalized === "needs-guidance") return "unsure";
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
  readiness_display: z.string().min(1).optional(),
  renovation_type: z.string().min(1).optional(),
  wall_type: z.string().min(1).optional(),
  budget: z.string().min(1).optional(),
  override_max_drive: z.boolean().optional(),
});

export const preferredSlotsSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  duration_mins: z.coerce.number().int().min(30).max(180),
  preferred_date: z.string(),
  preferred_window: z.enum(["morning", "afternoon", "evening"]),
  preferred_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .optional(),
  override_max_drive: z.boolean().optional(),
  skip_min_lead_time: z.boolean().optional(),
});

export const availableDatesSchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
  duration_mins: z.coerce.number().int().min(30).max(180),
  preferred_window: z.enum(["morning", "afternoon", "evening"]),
  from_date: z.string().optional(),
  days_ahead: z.coerce.number().int().min(1).max(30).optional(),
  override_max_drive: z.boolean().optional(),
});

// Cancel by appointment_id (admin page) or by the lead's phone/email (CRM).
// notify defaults to true: the client gets the cancellation text + email.
export const cancelSchema = z
  .object({
    appointment_id: z.string().uuid().optional(),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(200).optional(),
    notify: z.boolean().optional(),
    admin_password: z.string().min(1),
  })
  .refine((d) => Boolean(d.appointment_id || d.phone || d.email), {
    message: "appointment_id, phone or email is required",
  });

export const workingHoursSchema = z.object({
  admin_password: z.string().min(1),
  start_date: z.string(),
  end_date: z.string().optional(),
  start_time: z.string(),
  end_time: z.string(),
  is_available: z.boolean().default(true),
});

export const leadProgressSchema = z.object({
  lead_session_id: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().min(7),
  email: z.string().email(),
  postcode: z.string().min(2),
  current_step: z.coerce.number().int().min(1),
  disqualified: z.boolean().optional(),
  wall_type: z.string().optional(),
  address: z.string().optional(),
});

// Funnel analytics event (see app/api/funnel-event). Public endpoint, so every text
// field is length-capped and the event name is restricted to simple characters.
export const funnelEventSchema = z.object({
  lead_session_id: z.string().min(8).max(64),
  event: z.string().regex(/^[a-z0-9_]{1,40}$/),
  path: z.string().max(120).optional(),
  variants: z.record(z.string().max(20), z.string().max(20)).optional(),
  device: z.enum(["mobile", "tablet", "desktop"]).optional(),
  viewport_w: z.coerce.number().int().min(0).max(10000).optional(),
  utm_campaign: z.string().max(120).optional(),
  ad_id: z.string().max(120).optional(),
  is_test: z.boolean().optional(),
});
