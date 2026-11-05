import prisma from '../utils/prisma';
import { ValidationError } from '../utils/response';

export type ReportType = 'attendance' | 'leave' | 'payroll' | 'performance';

export function validateReportParameters(type: string, params: Record<string, unknown>): void {
  const { start_date, end_date, month, year } = params;
  if (type === 'attendance' || type === 'leave') {
    if (typeof start_date !== 'string' || typeof end_date !== 'string' || !isDate(start_date) || !isDate(end_date) || start_date > end_date) {
      throw new ValidationError(`Choose a valid ${type} date range`);
    }
    return;
  }
  if (type === 'payroll' || type === 'performance') {
    validatePeriod(month, year);
    return;
  }
  throw new ValidationError('Unsupported report type');
}

export function validateScheduledReportParameters(type: string, params: Record<string, unknown>): void {
  if (params.relative_period === true) {
    if (!['attendance', 'leave', 'payroll', 'performance'].includes(type)) throw new ValidationError('Unsupported report type');
    return;
  }
  validateReportParameters(type, params);
}

export async function generateReport(orgId: string, type: string, params: Record<string, unknown>) {
  validateReportParameters(type, params);
  let downloadUrl: string | null = null;
  let rowCount = 0;
  const { start_date, end_date, month, year } = params;
  if (type === 'attendance' && typeof start_date === 'string' && typeof end_date === 'string') {
    const records = await prisma.attendanceRecord.findMany({
      where: { org_id: orgId, date: { gte: new Date(start_date), lte: new Date(end_date) } },
      include: { user: { select: { name: true, department: true } } }, orderBy: [{ date: 'asc' }],
    });
    rowCount = records.length;
    downloadUrl = await (await import('./csvExport')).generateAttendanceCsv(orgId, records);
  } else if (type === 'payroll' && month && year) {
    validatePeriod(month, year);
    const records = await prisma.payrollRecord.findMany({
      where: { org_id: orgId, period_month: Number(month), period_year: Number(year) },
      include: { user: { select: { name: true, department: true } } },
    });
    rowCount = records.length;
    downloadUrl = await (await import('./csvExport')).generatePayrollCsv(orgId, records, Number(month), Number(year));
  } else if (type === 'leave' && typeof start_date === 'string' && typeof end_date === 'string') {
    const requests = await prisma.leaveRequest.findMany({
      where: { org_id: orgId, start_date: { lte: new Date(end_date) }, end_date: { gte: new Date(start_date) } },
      include: { user: { select: { name: true, department: true } }, reviewer: { select: { name: true } } },
    });
    rowCount = requests.length;
    downloadUrl = await (await import('./csvExport')).generateLeaveCsv(orgId, requests);
  } else if (type === 'performance' && month && year) {
    validatePeriod(month, year);
    const reviews = await prisma.performanceReview.findMany({
      where: { org_id: orgId, period_month: Number(month), period_year: Number(year) },
      include: { user: { select: { name: true, department: true } } },
    });
    rowCount = reviews.length;
    downloadUrl = await (await import('./csvExport')).generatePerformanceCsv(orgId, reviews, Number(month), Number(year));
  } else {
    throw new ValidationError('Invalid report type or missing parameters');
  }
  return { download_url: downloadUrl, row_count: rowCount, type, generated_at: new Date() };
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function validatePeriod(month: unknown, year: unknown): void {
  const m = Number(month); const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < 2000 || y > 2200) {
    throw new ValidationError('Choose a valid month and year');
  }
}
