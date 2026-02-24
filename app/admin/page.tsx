"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type Appointment = {
  id: string;
  client_name: string;
  client_phone: string;
  client_email: string;
  date: string;
  start_time: string;
  end_time: string;
  duration_mins: number;
  address: string;
  readiness_level: string;
  lat: number;
  lng: number;
};

type WorkingHour = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
};

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [hours, setHours] = useState<WorkingHour[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");

  const [mapDate, setMapDate] = useState("");

  const dayAppointments = useMemo(() => appointments.filter((a) => a.date === mapDate), [appointments, mapDate]);

  const routeEmbedUrl = useMemo(() => {
    if (!dayAppointments.length) return "";
    const base = "https://www.google.com/maps/embed/v1/directions";
    const origin = encodeURIComponent("55.7956,-3.7939");
    const destination = encodeURIComponent("55.7956,-3.7939");
    const waypoints = dayAppointments.map((a) => `${a.lat},${a.lng}`).join("|");
    const key = process.env.NEXT_PUBLIC_GOOGLE_EMBED_KEY || "";
    return `${base}?key=${key}&origin=${origin}&destination=${destination}&waypoints=${encodeURIComponent(waypoints)}`;
  }, [dayAppointments]);

  async function login() {
    try {
      setError("");
      setStatus("Authenticating...");
      await apiFetch(`/api/auth?password=${encodeURIComponent(password)}`);
      setAuthenticated(true);
      setStatus("");
      await Promise.all([loadAppointments(password), loadWorkingHours(password)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
      setStatus("");
    }
  }

  async function loadAppointments(currentPassword: string) {
    const data = await apiFetch<{ appointments: Appointment[] }>(
      `/api/appointments?password=${encodeURIComponent(currentPassword)}`,
    );
    setAppointments(data.appointments);
  }

  async function loadWorkingHours(currentPassword: string) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const data = await apiFetch<{ hours: WorkingHour[] }>(
      `/api/working-hours?password=${encodeURIComponent(currentPassword)}&from_date=${date}`,
    );
    setHours(data.hours);
  }

  async function cancelAppointment(id: string) {
    try {
      setError("");
      await apiFetch("/api/cancel", {
        method: "POST",
        body: JSON.stringify({ appointment_id: id, admin_password: password }),
      });
      await loadAppointments(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancellation failed");
    }
  }

  async function saveWorkingHours() {
    try {
      setError("");
      await apiFetch("/api/working-hours", {
        method: "POST",
        body: JSON.stringify({
          admin_password: password,
          start_date: startDate,
          end_date: endDate || undefined,
          start_time: startTime,
          end_time: endTime,
          is_available: true,
        }),
      });
      await loadWorkingHours(password);
      setStatus("Working hours updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update working hours");
    }
  }

  if (!authenticated) {
    return (
      <main className="shell">
        <section className="panel">
          <h1>PureLuxe Admin</h1>
          <p className="label">Password</p>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <div className="actions" style={{ marginTop: 12 }}>
            <button onClick={login}>Login</button>
          </div>
          {status ? <p className="status">{status}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="panel grid">
        <h1>Admin Panel</h1>

        <section className="card">
          <h2>Upcoming Appointments</h2>
          <div className="list">
            {appointments.map((appt) => (
              <div key={appt.id} className="card">
                <strong>{appt.client_name}</strong>
                <p>
                  {appt.date} {appt.start_time} ({appt.duration_mins} mins)
                </p>
                <p>{appt.address}</p>
                <p>Readiness: {appt.readiness_level}</p>
                <button onClick={() => cancelAppointment(appt.id)}>Cancel</button>
              </div>
            ))}
            {!appointments.length && <p className="label">No upcoming appointments.</p>}
          </div>
        </section>

        <section className="card">
          <h2>Working Hours</h2>
          <div className="grid grid-2">
            <div>
              <p className="label">Start date</p>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <p className="label">End date (optional)</p>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div>
              <p className="label">Start time</p>
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div>
              <p className="label">End time</p>
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button onClick={saveWorkingHours}>Save</button>
          </div>
          <h3 style={{ marginTop: 16 }}>Current Week</h3>
          <div className="list">
            {hours.map((hour) => (
              <div key={hour.id || hour.date} className="card">
                {hour.date}: {hour.start_time} - {hour.end_time}
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Map View</h2>
          <p className="label">Select date</p>
          <input type="date" value={mapDate} onChange={(e) => setMapDate(e.target.value)} />
          {routeEmbedUrl ? (
            <iframe className="map" src={routeEmbedUrl} loading="lazy" />
          ) : (
            <p className="label">Pick a date with appointments to view route.</p>
          )}
        </section>

        {status ? <p className="success">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
