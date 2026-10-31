import { PrismaClient } from '@prisma/client';
import { ValidationError } from '../../../utils/response';
import { dateOnlyInTz } from '../../../utils/shift';

export interface AttendanceSummaryInput {
  start?: string;
  end?: string;
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('Dates must use YYYY-MM-DD format');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ValidationError('Provide a valid calendar date');
  }
  return date;
}

export async function attendanceSummaryTool(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  input: AttendanceSummaryInput = {},
) {
  if (Boolean(input.start) !== Boolean(input.end)) {
    throw new ValidationError('Provide both a start and end date, or neither');
  }

  const organisation = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: { timezone: true },
  });
  const timezone = organisation?.timezone || 'UTC';
  const today = dateOnlyInTz(new Date(), timezone);
  const start = input.start
    ? parseDate(input.start)
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const end = input.end ? parseDate(input.end) : today;

  if (start > end) {
    throw new ValidationError('The start date must be on or before the end date');
  }

  const records = await prisma.attendanceRecord.findMany({
    where: {
      org_id: orgId,
      user_id: userId,
      date: { gte: start, lte: end },
    },
    select: {
      status: true,
      check_in_at: true,
      hours_worked: true,
      overtime_hours: true,
    },
  });

  const statusCounts: Record<string, number> = {};
  const workRecords = records.filter(record => record.check_in_at || record.hours_worked !== null);
  let recordedHours = 0;
  let recordedHoursDays = 0;
  let overtimeHours = 0;
  let checkedInDays = 0;

  for (const record of records) {
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
    if (record.check_in_at) checkedInDays += 1;
    if ((record.check_in_at || record.hours_worked !== null) && record.hours_worked !== null) {
      recordedHours += Number(record.hours_worked);
      recordedHoursDays += 1;
    }
    overtimeHours += Number(record.overtime_hours ?? 0);
  }

  const roundHours = (hours: number) => Math.round(hours * 100) / 100;
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
    timezone,
    records: records.length,
    status_counts: statusCounts,
    checked_in_days: checkedInDays,
    late_days: statusCounts.late ?? 0,
    absent_days: statusCounts.absent ?? 0,
    hours_worked: recordedHoursDays === workRecords.length ? roundHours(recordedHours) : null,
    hours_recorded_days: recordedHoursDays,
    hours_missing_days: workRecords.length - recordedHoursDays,
    overtime_hours: roundHours(overtimeHours),
  };
}
