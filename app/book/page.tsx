"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api-client";
import type { ReadinessLevel } from "@/lib/types";

type Slot = {
  date: string;
  start_time: string;
  end_time: string;
  duration_mins: number;
  score: number;
};

type AddressValidation = {
  valid: boolean;
  lat: number;
  lng: number;
  message: string;
};

type AvailableSlotsResponse = {
  featured_slots: Slot[];
  all_slots: Record<string, Slot[]>;
};

type BookingResponse = {
  confirmation: {
    appointment_id: string;
    date: string;
    time: string;
  };
};

const readinessChoices: Array<{ label: string; value: ReadinessLevel; duration: number }> = [
  { label: "I know exactly what I want", value: "ready", duration: 30 },
  { label: "I have some ideas but need guidance", value: "partial", duration: 60 },
  { label: "I'm not sure yet, I need help deciding", value: "unsure", duration: 90 },
];

export default function BookingPage() {
  const searchParams = useSearchParams();
  const prefill = useMemo(
    () => ({
      name: searchParams.get("name") || "",
      email: searchParams.get("email") || "",
      phone: searchParams.get("phone") || "",
    }),
    [searchParams],
  );

  const [step, setStep] = useState(1);
  const [address, setAddress] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [readiness, setReadiness] = useState<ReadinessLevel | null>(null);
  const [duration, setDuration] = useState<number>(30);
  const [featuredSlots, setFeaturedSlots] = useState<Slot[]>([]);
  const [allSlots, setAllSlots] = useState<Record<string, Slot[]>>({});
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [name, setName] = useState(prefill.name);
  const [email, setEmail] = useState(prefill.email);
  const [phone, setPhone] = useState(prefill.phone);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<BookingResponse["confirmation"] | null>(null);

  async function validateAddress() {
    try {
      setError("");
      setStatus("Validating address...");
      const result = await apiFetch<AddressValidation>("/api/validate-address", {
        method: "POST",
        body: JSON.stringify({ address }),
      });

      if (!result.valid) {
        setError("Sorry, PureLuxe doesn't currently cover your area");
        setStatus("");
        return;
      }

      setCoords({ lat: result.lat, lng: result.lng });
      setStatus("");
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Address validation failed");
      setStatus("");
    }
  }

  async function loadSlots() {
    if (!coords) return;
    try {
      setError("");
      setStatus("Finding best slots...");
      const result = await apiFetch<AvailableSlotsResponse>("/api/available-slots", {
        method: "POST",
        body: JSON.stringify({ lat: coords.lat, lng: coords.lng, duration_mins: duration }),
      });
      setSelectedSlot(null);
      setFeaturedSlots(result.featured_slots || []);
      setAllSlots(result.all_slots || {});
      setStatus("");
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load slots");
      setStatus("");
    }
  }

  async function confirmBooking() {
    if (!coords || !selectedSlot || !readiness) return;

    try {
      setError("");
      setStatus("Confirming booking...");
      const result = await apiFetch<BookingResponse>("/api/book", {
        method: "POST",
        body: JSON.stringify({
          date: selectedSlot.date,
          start_time: selectedSlot.start_time,
          duration_mins: selectedSlot.duration_mins,
          client_name: name,
          client_phone: phone,
          client_email: email,
          address,
          lat: coords.lat,
          lng: coords.lng,
          readiness_level: readiness,
        }),
      });

      setConfirmation(result.confirmation);
      setStatus("");
      setStep(6);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking failed");
      setStatus("");
    }
  }

  async function requestManualBookingHelp() {
    try {
      await apiFetch<{ success: boolean }>("/api/slot-help-request", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          phone,
          address,
          readiness_level: readiness,
          duration_mins: duration,
          selected_slot: selectedSlot,
          coords,
        }),
      });
      setStatus("Thanks. Our team will contact you to help book a suitable slot.");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit request");
    }
  }

  return (
    <main className="shell">
      <section className="panel">
        <h1>Book Your PureLuxe Quote Visit</h1>

        {step === 1 && (
          <div className="grid">
            <div>
              <p className="label">Address</p>
              <input
                placeholder="Start typing your full address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <button onClick={validateAddress}>Continue</button>
          </div>
        )}

        {step === 2 && (
          <div className="grid">
            <h2>How ready are you to go ahead?</h2>
            <div className="readiness">
              {readinessChoices.map((choice) => (
                <button
                  key={choice.value}
                  className={readiness === choice.value ? "active" : ""}
                  onClick={() => {
                    setReadiness(choice.value);
                    setDuration(choice.duration);
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <button disabled={!readiness} onClick={loadSlots}>
              Find Available Slots
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="grid">
            <h2>Select a Slot</h2>
            {!featuredSlots.length && !Object.keys(allSlots).length && (
              <p className="label">No valid slots found right now. Try a different readiness option or check back later.</p>
            )}
            {!!featuredSlots.length && (
              <div className="slot-group">
                <h3>Top 5 Featured Options</h3>
                <div className="slot-list">
                  {featuredSlots.map((slot, index) => (
                    <button
                      key={`featured-${slot.date}-${slot.start_time}`}
                      className={`slot ${selectedSlot?.date === slot.date && selectedSlot.start_time === slot.start_time ? "selected" : ""}`}
                      onClick={() => setSelectedSlot(slot)}
                    >
                      #{index + 1} {slot.date} {slot.start_time}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <h3>All Available Slots (Next 7 Days)</h3>
            {Object.entries(allSlots).map(([date, dateSlots]) => (
              <div key={date} className="slot-group">
                <h3>{date}</h3>
                <div className="slot-list">
                  {dateSlots.map((slot) => (
                    <button
                      key={`${slot.date}-${slot.start_time}`}
                      className={`slot ${selectedSlot?.date === slot.date && selectedSlot.start_time === slot.start_time ? "selected" : ""}`}
                      onClick={() => setSelectedSlot(slot)}
                    >
                      {slot.start_time}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button disabled={!selectedSlot} onClick={() => setStep(4)}>
              Continue
            </button>
            <button className="button-outline" onClick={requestManualBookingHelp}>
              Can&apos;t see a slot that works for you?
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="grid">
            <h2>Your Details</h2>
            <div>
              <p className="label">Name</p>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <p className="label">Email</p>
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <p className="label">Phone</p>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <button onClick={() => setStep(5)}>Review Booking</button>
          </div>
        )}

        {step === 5 && selectedSlot && (
          <div className="grid">
            <h2>Confirm Booking</h2>
            <div className="card">
              <p>Name: {name}</p>
              <p>Date: {selectedSlot.date}</p>
              <p>Time: {selectedSlot.start_time}</p>
              <p>Address: {address}</p>
              <p>Duration: {selectedSlot.duration_mins} mins</p>
            </div>
            <button onClick={confirmBooking}>Confirm Booking</button>
          </div>
        )}

        {step === 6 && confirmation && (
          <div className="grid">
            <h2>Thank you, you're booked.</h2>
            <div className="card">
              <p>Reference: {confirmation.appointment_id}</p>
              <p>Date: {confirmation.date}</p>
              <p>Time: {confirmation.time}</p>
              <p>Address: {address}</p>
            </div>
          </div>
        )}

        {status ? <p className="status">{status}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>
    </main>
  );
}
