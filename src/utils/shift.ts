// Timezone-aware shift & attendance compliance helpers.
//
// Shift start/end times are stored as "HH:MM" wall-clock strings interpreted
// in the ORGANISATION's timezone. Check-in/out timestamps are stored as UTC
// Date objects. To compare them correctly we must convert the UTC instant to
// the org's local wall clock before doing any minute math — otherwise late /
// early / auto-checkout detection is wrong by the server↔org UTC offset.
import { toZonedTime } from 'date-fns-tz';

export interface ShiftLike {
  start_time: string;
  end_time:   string;
  late_tolerance_mins?: number | null;
  early_checkout_tolerance_mins?: number | null;
  auto_checkout?: boolean | null;
  auto_checkout_buffer_mins?: number | null;
}

/** Parse an "HH:MM" string to minutes-since-midnight. */
export function hhmmToMins(hhmm: string): number {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Wall-clock minutes-since-midnight in `timezone` for the instant `at`. */
export function minutesOfDayInTz(at: Date, timezone?: string | null): number {
  const zoned = toZonedTime(at, timezone || 'UTC');
  return zoned.getHours() * 60 + zoned.getMinutes();
}

/** A `Date` whose local getters reflect wall-clock time in `timezone`. */
export function nowInTz(timezone?: string | null, at: Date = new Date()): Date {
  return toZonedTime(at, timezone || 'UTC');
}

/**
 * Effective late tolerance (minutes): per-shift value wins, org-wide is the
 * fallback, 15 is the final default. A shift value of 0 is honoured (means
 * "no tolerance — late the moment you pass start"), hence the ?? chain.
 */
export function lateThresholdFor(
  shift?: { late_tolerance_mins?: number | null } | null,
  org?:   { late_threshold?: number | null } | null,
): number {
  return shift?.late_tolerance_mins ?? org?.late_threshold ?? 15;
}

/**
 * Minutes the employee was late past scheduled shift start (>= 0).
 * Returns 0 when there's no shift, or when they arrived early/on-time.
 * Handles overnight shifts: if the raw diff looks like a previous-day start
 * (very large negative), it is treated as on-time rather than wildly early.
 */
export function lateMinutes(checkInAt: Date, shift: ShiftLike | null | undefined, timezone?: string | null): number {
  if (!shift) return 0;
  const start  = hhmmToMins(shift.start_time);
  const actual = minutesOfDayInTz(checkInAt, timezone);
  const diff   = actual - start;
  // Overnight wrap (e.g. shift starts 22:00, checked in 22:05 reads fine;
  // a -1380 diff means we crossed midnight — not "23h early").
  if (diff < -720) return 0;
  return Math.max(0, diff);
}

/** Minutes the employee left before scheduled shift end (>= 0). */
export function earlyOutMinutes(checkOutAt: Date, shift: ShiftLike | null | undefined, timezone?: string | null): number {
  if (!shift) return 0;
  const end    = hhmmToMins(shift.end_time);
  const actual = minutesOfDayInTz(checkOutAt, timezone);
  const diff   = end - actual;
  if (diff < -720) return 0; // checked out well after end (overnight) — not early
  return Math.max(0, diff);
}

/**
 * Adherence score 0-100 for a completed shift. Starts at 100 and deducts for
 * lateness and early departure (each capped so one factor can't sink it past
 * its half). Null shift → null (can't score without a schedule).
 */
export function adherenceScore(lateMins: number, earlyMins: number, shift?: ShiftLike | null): number | null {
  if (!shift) return null;
  const score = 100 - Math.min(50, lateMins) - Math.min(50, earlyMins);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Determines whether an open, shift-assigned record is due for shift-based
 * auto-checkout: shift.auto_checkout enabled AND org-local now is at/past
 * shift end + buffer. Returns the scheduled checkout instant (shift end in
 * org tz, as a UTC Date) or null if not yet due / not eligible.
 */
export function shiftAutoCheckoutDue(
  shift: ShiftLike | null | undefined,
  timezone: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!shift || !shift.auto_checkout) return false;
  const end     = hhmmToMins(shift.end_time);
  const buffer  = shift.auto_checkout_buffer_mins ?? 30;
  const nowMins = minutesOfDayInTz(now, timezone);
  // Only fire on the same calendar day the shift ends (avoids overnight-shift
  // false positives where nowMins has wrapped past midnight).
  const diff = nowMins - (end + buffer);
  return diff >= 0 && diff < 720;
}
