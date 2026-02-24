export type ReadinessLevel = "ready" | "partial" | "unsure";
export type AppointmentStatus = "confirmed" | "cancelled" | "completed";

export type Appointment = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_mins: number;
  client_name: string;
  client_phone: string;
  client_email: string;
  address: string;
  lat: number;
  lng: number;
  readiness_level: ReadinessLevel;
  status: AppointmentStatus;
  created_at: string;
};

export type WorkingHours = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
};

export type CandidateSlot = {
  date: string;
  start_time: string;
  end_time: string;
  duration_mins: number;
  score: number;
};

export type Location = {
  lat: number;
  lng: number;
};
