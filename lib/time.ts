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
