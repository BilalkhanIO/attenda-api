import { localWeekRange } from '../../utils/localWeek';

describe('localWeekRange', () => {
  it('keeps the date identity while translating local midnight to UTC', () => {
    const week = localWeekRange('2026-11-02', 'Asia/Karachi');
    expect(week.startDate.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(week.endDate.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(week.startInstant.toISOString()).toBe('2026-11-01T19:00:00.000Z');
    expect(week.endInstant.toISOString()).toBe('2026-11-08T19:00:00.000Z');
  });

  it('uses the actual local week duration across daylight saving changes', () => {
    const week = localWeekRange('2026-03-02', 'America/New_York');
    expect(week.startInstant.toISOString()).toBe('2026-03-02T05:00:00.000Z');
    expect(week.endInstant.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(week.endInstant.getTime() - week.startInstant.getTime()).toBe(167 * 60 * 60 * 1000);
  });

  it('rejects invalid and non-Monday date keys', () => {
    expect(() => localWeekRange('2026-02-30', 'UTC')).toThrow('valid Monday');
    expect(() => localWeekRange('2026-11-03', 'UTC')).toThrow('Monday');
  });
});
