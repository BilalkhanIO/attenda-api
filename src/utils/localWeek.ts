import { fromZonedTime } from 'date-fns-tz';
import { ValidationError } from './response';
import { dateOnlyInTz } from './shift';

export type LocalWeekRange = {
  /** UTC-midnight date keys for DATE columns and unique timesheet identity. */
  startDate: Date;
  endDate: Date;
  /** Exact UTC instants bounding this Monday-to-Monday local calendar week. */
  startInstant: Date;
  endInstant: Date;
};

/**
 * Interpret the supplied Monday date key in the user's work timezone. The
 * date key remains stable for the Timesheet row while timestamp queries use
 * the correct local-midnight boundaries (including DST transitions).
 */
export function localWeekRange(value: unknown, timezone: string): LocalWeekRange {
  const text = String(value ?? '');
  const dateText = text.length >= 10 ? text.slice(0, 10) : text;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new ValidationError('week_start must be a Monday date');
  const startDate = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || startDate.toISOString().slice(0, 10) !== dateText || startDate.getUTCDay() !== 1) {
    throw new ValidationError('week_start must be a valid Monday date');
  }
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const endText = endDate.toISOString().slice(0, 10);
  try {
    const startInstant = fromZonedTime(`${dateText}T00:00:00`, timezone || 'UTC');
    const endInstant = fromZonedTime(`${endText}T00:00:00`, timezone || 'UTC');
    if (!Number.isFinite(startInstant.getTime()) || !Number.isFinite(endInstant.getTime())) throw new Error('Invalid timezone');
    return { startDate, endDate, startInstant, endInstant };
  } catch {
    throw new ValidationError('The employee work timezone is invalid');
  }
}

/** Current Monday date key according to the employee's assigned work location. */
export function currentLocalWeekStart(now: Date, timezone: string): Date {
  const today = dateOnlyInTz(now, timezone);
  today.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  return today;
}
