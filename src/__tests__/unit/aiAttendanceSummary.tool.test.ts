import { PrismaClient } from '@prisma/client';
import { attendanceSummaryTool } from '../../services/ai/tools/attendance-summary';

const prismaMock = {
  organisation: { findUnique: jest.fn() },
  attendanceRecord: { findMany: jest.fn() },
};

const prisma = prismaMock as unknown as PrismaClient;

describe('attendanceSummaryTool', () => {
  beforeEach(() => {
    jest.useRealTimers();
    prismaMock.organisation.findUnique.mockResolvedValue({ timezone: 'UTC' });
    prismaMock.attendanceRecord.findMany.mockResolvedValue([]);
  });

  it('returns exact counts and totals for the signed-in employee and date range', async () => {
    prismaMock.attendanceRecord.findMany.mockResolvedValue([
      { status: 'late', check_in_at: new Date(), hours_worked: 7.5, overtime_hours: 1.25 },
      { status: 'present', check_in_at: new Date(), hours_worked: 8, overtime_hours: 0.5 },
      { status: 'absent', check_in_at: null, hours_worked: null, overtime_hours: 0 },
    ]);

    const result = await attendanceSummaryTool(prisma, 'org-1', 'user-1', {
      start: '2026-10-01',
      end: '2026-10-31',
    });

    expect(prismaMock.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: {
        org_id: 'org-1',
        user_id: 'user-1',
        date: { gte: new Date('2026-10-01T00:00:00.000Z'), lte: new Date('2026-10-31T00:00:00.000Z') },
      },
      select: { status: true, check_in_at: true, hours_worked: true, overtime_hours: true },
    });
    expect(result).toMatchObject({
      period_start: '2026-10-01',
      period_end: '2026-10-31',
      records: 3,
      status_counts: { late: 1, present: 1, absent: 1 },
      checked_in_days: 2,
      late_days: 1,
      absent_days: 1,
      hours_worked: 15.5,
      hours_recorded_days: 2,
      hours_missing_days: 0,
      overtime_hours: 1.75,
    });
  });

  it('does not present partial hours as a complete total', async () => {
    prismaMock.attendanceRecord.findMany.mockResolvedValue([
      { status: 'present', check_in_at: new Date(), hours_worked: null, overtime_hours: 0 },
    ]);

    const result = await attendanceSummaryTool(prisma, 'org-1', 'user-1', {
      start: '2026-10-01',
      end: '2026-10-31',
    });

    expect(result.hours_worked).toBeNull();
    expect(result.hours_missing_days).toBe(1);
  });

  it('defaults to the current month in the organisation timezone', async () => {
    prismaMock.organisation.findUnique.mockResolvedValue({ timezone: 'Asia/Karachi' });
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T23:30:00.000Z'));

    const result = await attendanceSummaryTool(prisma, 'org-1', 'user-1');

    expect(result.period_start).toBe('2026-11-01');
    expect(result.period_end).toBe('2026-11-01');
    expect(result.timezone).toBe('Asia/Karachi');
  });

  it('rejects invalid or incomplete date ranges', async () => {
    await expect(attendanceSummaryTool(prisma, 'org-1', 'user-1', {
      start: '2026-02-30',
      end: '2026-03-01',
    })).rejects.toThrow('valid calendar date');

    await expect(attendanceSummaryTool(prisma, 'org-1', 'user-1', {
      start: '2026-10-01',
    })).rejects.toThrow('both a start and end date');
    expect(prismaMock.attendanceRecord.findMany).not.toHaveBeenCalled();
  });
});
