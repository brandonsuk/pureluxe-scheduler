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
  calendar_sync_state?: "in_sync" | "out_of_sync" | "missing";
  calendar_last_checked_at?: string | null;
  lat: number;
  lng: number;
};

type WorkingHour = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  is_available: boolean;
  source?: "manual" | "google_open_slots";
};

type Tab = "appointments" | "working-hours";

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [hours, setHours] = useState<WorkingHour[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncingOpenSlots, setSyncingOpenSlots] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("appointments");

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("17:00");

  const [mapDate, setMapDate] = useState("");

  const dayAppointments = useMemo(() => appointments.filter((a) => a.date === mapDate), [appointments, mapDate]);

  function syncLabel(state?: Appointment["calendar_sync_state"]) {
    if (state === "out_of_sync") return "Out of Sync";
    if (state === "missing") return "Missing in Calendar";
    return "In Sync";
  }

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

  async function runCalendarSyncNow() {
    try {
      setError("");
      setStatus("Running calendar sync...");
      setSyncing(true);
      const result = await apiFetch<{ checked: number; out_of_sync: number; missing: number }>(
        "/api/calendar-sync-run",
        {
          method: "POST",
          body: JSON.stringify({ admin_password: password }),
        },
      );
      await loadAppointments(password);
      setStatus(`Sync Complete · Checked: ${result.checked} · Out of sync: ${result.out_of_sync} · Missing: ${result.missing}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Calendar sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function runOpenSlotsSyncNow() {
    try {
      setError("");
      setStatus("Syncing open slots from Google Calendar...");
      setSyncingOpenSlots(true);
      const result = await apiFetch<{ window_start: string; window_end: string; imported: number; skipped: number }>(
        "/api/open-slots-sync-run",
        {
          method: "POST",
          body: JSON.stringify({ admin_password: password, days_ahead: 14 }),
        },
      );
      await loadWorkingHours(password);
      setStatus(`Open slots synced · Imported: ${result.imported} · Skipped: ${result.skipped} (${result.window_start} to ${result.window_end})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Open slots sync failed");
    } finally {
      setSyncingOpenSlots(false);
    }
  }

  if (!authenticated) {
    return (
      <main className="shell">
        <section className="panel">
          <h1>PureLuxe Admin</h1>
          <p className="label">Password</p>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} />
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ margin: 0 }}>Admin Panel</h1>
          <button onClick={() => { setAuthenticated(false); setPassword(""); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 20 }}>
            &#x2192;
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setActiveTab("appointments")}
            style={{
              flex: 1,
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              background: activeTab === "appointments" ? "#c9a96e" : "transparent",
              color: activeTab === "appointments" ? "#fff" : "inherit",
              fontWeight: 600,
            }}
          >
            Appointments
          </button>
          <button
            onClick={() => setActiveTab("working-hours")}
            style={{
              flex: 1,
              padding: "10px 16px",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              background: activeTab === "working-hours" ? "#c9a96e" : "transparent",
              color: activeTab === "working-hours" ? "#fff" : "inherit",
              fontWeight: 600,
            }}
          >
            Working Hours
          </button>
        </div>

        {/* Appointments Tab */}
        {activeTab === "appointments" && (
          <section className="card">
            <div className="actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Upcoming Appointments</h2>
              <button onClick={runCalendarSyncNow} disabled={syncing}>
                {syncing ? "Syncing..." : "Run Calendar Sync Now"}
              </button>
            </div>
            <div className="list">
              {appointments.map((appt) => (
                <div key={appt.id} className="card">
                  <strong>{appt.client_name}</strong>
                  <p>
                    {appt.date} {appt.start_time.slice(0, 5)} ({appt.duration_mins} mins)
                  </p>
                  <p>{appt.address}</p>
                  <p>{appt.client_phone} · {appt.client_email}</p>
                  <p className={`sync-badge sync-${appt.calendar_sync_state || "in_sync"}`}>
                    Calendar: {syncLabel(appt.calendar_sync_state)}
                  </p>
                  <button onClick={() => cancelAppointment(appt.id)}>Cancel</button>
                </div>
              ))}
              {!appointments.length && <p className="label">No upcoming appointments.</p>}
            </div>
          </section>
        )}

        {/* Working Hours Tab */}
        {activeTab === "working-hours" && (
          <section className="card">
            <div className="actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ margin: 0 }}>Working Hours</h2>
              <button onClick={runOpenSlotsSyncNow} disabled={syncingOpenSlots}>
                {syncingOpenSlots ? "Syncing..." : "Sync Open Slots from Google"}
              </button>
            </div>

            <div style={{ marginTop: 16 }}>
              <p className="label" style={{ textTransform: "uppercase", fontSize: 11, letterSpacing: 1 }}>Add Working Hours</p>
              <div className="grid grid-2" style={{ marginTop: 8 }}>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="dd/mm/yyyy" />
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="End date (optional)" />
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                <button onClick={saveWorkingHours} style={{ width: "100%" }}>Save</button>
              </div>
            </div>

            <div className="list" style={{ marginTop: 16 }}>
              {hours.map((hour) => (
                <div key={hour.id || hour.date} className="card">
                  {hour.date}: {hour.start_time} – {hour.end_time}
                  {hour.source === "google_open_slots" ? " (Google Open Slots)" : ""}
                </div>
              ))}
              {!hours.length && <p className="label">No working hours set.</p>}
            </div>
          </section>
        )}

        {status ? <p className="success">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
