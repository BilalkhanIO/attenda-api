// Pure holiday math — expandHolidays / workingDaysExcluding.

jest.mock('../../utils/prisma', () => ({ __esModule: true, default: {} }));

import { expandHolidays, workingDaysExcluding, HolidayRow } from '../../services/holidays';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const row = (date: string, recurring = false): HolidayRow => ({ date: d(date), name: 'x', recurring });

describe('expandHolidays', () => {
  it('includes one-off holidays only inside the range', () => {
    const rows = [row('2026-08-14'), row('2026-12-25')];
    const set = expandHolidays(rows, d('2026-08-01'), d('2026-08-31'));
    expect([...set]).toEqual(['2026-08-14']);
  });

  it('expands recurring holidays into every year the range touches', () => {
    const set = expandHolidays([row('2020-01-01', true)], d('2026-12-15'), d('2027-01-15'));
    expect(set.has('2027-01-01')).toBe(true);
    expect(set.has('2026-01-01')).toBe(false); // outside range
    expect(set.size).toBe(1);
  });

  it('skips Feb-29 recurrences in non-leap years', () => {
    const set = expandHolidays([row('2024-02-29', true)], d('2026-01-01'), d('2026-12-31'));
    expect(set.size).toBe(0);
    const leap = expandHolidays([row('2024-02-29', true)], d('2028-01-01'), d('2028-12-31'));
    expect(leap.has('2028-02-29')).toBe(true);
  });

  it('returns an empty set for no rows', () => {
    expect(expandHolidays([], d('2026-01-01'), d('2026-12-31')).size).toBe(0);
  });
});

describe('workingDaysExcluding', () => {
  // 2026-08-03 is a Monday.
  it('counts weekdays when there are no holidays', () => {
    expect(workingDaysExcluding(d('2026-08-03'), d('2026-08-07'), new Set())).toBe(5);
    expect(workingDaysExcluding(d('2026-08-01'), d('2026-08-02'), new Set())).toBe(0); // Sat–Sun
  });

  it('excludes holidays that fall on weekdays', () => {
    const holidays = new Set(['2026-08-04', '2026-08-06']);
    expect(workingDaysExcluding(d('2026-08-03'), d('2026-08-07'), holidays)).toBe(3);
  });

  it('ignores holidays that fall on weekends', () => {
    const holidays = new Set(['2026-08-01']); // Saturday
    expect(workingDaysExcluding(d('2026-07-31'), d('2026-08-03'), holidays)).toBe(2); // Fri + Mon
  });
});
