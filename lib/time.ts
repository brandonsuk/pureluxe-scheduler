import { addMinutes, format, parse, parseISO } from "date-fns";

function normalizeTime(value: string): string {
  return value.length >= 5 ? value.slice(0, 5) : value;
}

export function combineDateTime(date: string, time: string): Date {
  return parse(`${date} ${normalizeTime(time)}`, "yyyy-MM-dd HH:mm", new Date());
}

export function toTimeString(date: Date): string {
  return format(date, "HH:mm");
}

export function addMins(time: string, mins: number): string {
  const base = parse(normalizeTime(time), "HH:mm", new Date());
  return format(addMinutes(base, mins), "HH:mm");
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 60000);
}

export function todayIsoDate(): string {
  return format(new Date(), "yyyy-MM-dd");
}

export function parseDateOnly(value: string): Date {
  return parseISO(`${value}T00:00:00Z`);
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function todayIsoDateInTimeZone(timeZone: string): string {
  const parts = zonedParts(new Date(), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function zonedDateTimeKey(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = normalizeTime(time).split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute);
}

export function zonedNowKey(timeZone: string): number {
  const parts = zonedParts(new Date(), timeZone);
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
}
