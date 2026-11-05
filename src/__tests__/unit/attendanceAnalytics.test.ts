import { attendanceDateKey, attendanceDateOffset, localAttendanceDate, localAttendanceMonthStart, shiftAttendanceDateKey } from '../../services/attendanceAnalytics';

describe('location-local attendance analytics dates', () => {
  it('resolves the same instant to each location’s own calendar day', () => {
    const instant = new Date('2026-11-05T01:00:00.000Z');
    expect(localAttendanceDate(instant, 'America/Los_Angeles')).toBe('2026-11-04');
    expect(localAttendanceDate(instant, 'Asia/Karachi')).toBe('2026-11-05');
  });

  it('counts trend offsets relative to each record location’s local today', () => {
    const instant = new Date('2026-11-05T01:00:00.000Z');
    const laToday = localAttendanceDate(instant, 'America/Los_Angeles');
    const khiToday = localAttendanceDate(instant, 'Asia/Karachi');
    expect(attendanceDateOffset(laToday, '2026-11-03')).toBe(-1);
    expect(attendanceDateOffset(khiToday, '2026-11-03')).toBe(-2);
  });

  it('uses the local month boundary and shifts date-only keys without DST drift', () => {
    const instant = new Date('2026-11-01T00:30:00.000Z');
    expect(localAttendanceMonthStart(instant, 'America/Los_Angeles')).toBe('2026-10-01');
    expect(shiftAttendanceDateKey('2026-03-08', 1)).toBe('2026-03-09');
    expect(attendanceDateKey(new Date('2026-11-05T00:00:00.000Z'))).toBe('2026-11-05');
  });
});
