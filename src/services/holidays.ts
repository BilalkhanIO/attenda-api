import prisma from '../utils/prisma';

/**
 * Per-org public-holiday calendar. Holidays feed four engines: leave
 * working-days math, the absent detector, and (via clients) calendars.
 * `recurring` holidays repeat every year on the same month/day.
 */

export interface HolidayRow {
  date: Date;
  name: string;
  recurring: boolean;
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Expand holiday rows into the set of concrete YYYY-MM-DD dates that fall
 * inside [start, end] (inclusive, UTC date-only). Non-recurring rows match
 * their exact date; recurring rows match their month/day in every year the
 * range touches. Pure — unit tested.
 */
export function expandHolidays(rows: HolidayRow[], start: Date, end: Date): Set<string> {
  const out = new Set<string>();
  const startKey = dayKey(start);
  const endKey = dayKey(end);

  for (const row of rows) {
    if (!row.recurring) {
      const key = dayKey(row.date);
      if (key >= startKey && key <= endKey) out.add(key);
      continue;
    }
    const month = row.date.getUTCMonth();
    const day = row.date.getUTCDate();
    for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year++) {
      const candidate = new Date(Date.UTC(year, month, day));
      // Feb-29 recurring holidays only exist in leap years — skip rollovers.
      if (candidate.getUTCMonth() !== month) continue;
      const key = dayKey(candidate);
      if (key >= startKey && key <= endKey) out.add(key);
    }
  }
  return out;
}

/** Weekday count in [start, end] excluding the given holiday dates. Pure. */
export function workingDaysExcluding(start: Date, end: Date, holidays: Set<string>): number {
  let count = 0;
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const endUtc = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur <= endUtc) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.has(dayKey(cur))) count++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return count;
}

/** Concrete holiday dates for an org inside [start, end]. */
export async function holidaySetForRange(orgId: string, start: Date, end: Date): Promise<Set<string>> {
  const rows = await prisma.orgHoliday.findMany({
    where: { org_id: orgId },
    select: { date: true, name: true, recurring: true },
  });
  return expandHolidays(rows, start, end);
}

/** Org-aware working days: weekdays minus the org's holidays. */
export async function workingDaysForOrg(orgId: string, start: Date, end: Date): Promise<number> {
  const holidays = await holidaySetForRange(orgId, start, end);
  return workingDaysExcluding(start, end, holidays);
}

/** True when the given org-local date (UTC-anchored date-only) is a holiday. */
export async function isOrgHoliday(orgId: string, date: Date): Promise<boolean> {
  const set = await holidaySetForRange(orgId, date, date);
  return set.size > 0;
}
