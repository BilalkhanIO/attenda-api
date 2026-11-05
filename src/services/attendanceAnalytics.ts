import { dateOnlyInTz } from '../utils/shift';

export function attendanceDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shiftAttendanceDateKey(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return attendanceDateKey(date);
}

export function attendanceDateOffset(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

export function localAttendanceDate(at: Date, timezone: string): string {
  return attendanceDateKey(dateOnlyInTz(at, timezone));
}

export function localAttendanceMonthStart(at: Date, timezone: string): string {
  const local = dateOnlyInTz(at, timezone);
  return attendanceDateKey(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1)));
}
