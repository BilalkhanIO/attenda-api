import prisma from '../utils/prisma';
import { generateCustomCsv } from './csvExport';
import { CustomReportInput } from '../schemas/custom-reports';
import { ForbiddenError, ValidationError } from '../utils/response';

type ReportColumn = { label: string; get: (row: Record<string, any>) => unknown };
type DatasetConfig = Record<string, ReportColumn>;

const DATASETS: Record<CustomReportInput['dataset'], DatasetConfig> = {
  employees: {
    name: { label: 'Employee', get: row => row.name },
    email: { label: 'Work email', get: row => row.email },
    department: { label: 'Department', get: row => row.department },
    job_title: { label: 'Job title', get: row => row.job_title },
    active: { label: 'Active', get: row => row.is_active ? 'Yes' : 'No' },
    joined_on: { label: 'Joined on', get: row => dateValue(row.created_at) },
  },
  attendance: {
    date: { label: 'Date', get: row => dateValue(row.date) },
    employee: { label: 'Employee', get: row => row.user?.name },
    department: { label: 'Department', get: row => row.user?.department },
    status: { label: 'Status', get: row => row.status },
    check_in: { label: 'Check in', get: row => timeValue(row.check_in_at) },
    check_out: { label: 'Check out', get: row => timeValue(row.check_out_at) },
    hours: { label: 'Hours worked', get: row => row.hours_worked == null ? '' : Number(row.hours_worked).toFixed(2) },
    check_in_type: { label: 'Check-in type', get: row => row.check_in_type },
  },
  leave: {
    employee: { label: 'Employee', get: row => row.user?.name },
    department: { label: 'Department', get: row => row.user?.department },
    leave_type: { label: 'Leave type', get: row => row.leave_type },
    start_date: { label: 'Start date', get: row => dateValue(row.start_date) },
    end_date: { label: 'End date', get: row => dateValue(row.end_date) },
    working_days: { label: 'Working days', get: row => row.working_days },
    status: { label: 'Status', get: row => row.status },
    submitted_at: { label: 'Submitted', get: row => dateTimeValue(row.created_at) },
  },
};

export function canGenerateCustomDataset(dataset: CustomReportInput['dataset'], permissions: Set<string>): boolean {
  if (dataset === 'employees') return permissions.has('employees.view') || permissions.has('employees.view_team');
  if (dataset === 'attendance') return permissions.has('attendance.export') || permissions.has('attendance.view_team');
  return permissions.has('leave.view_all') || permissions.has('leave.view_team');
}

function dateValue(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function timeValue(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 19);
}

function dateTimeValue(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').slice(0, 16);
}

function dateBoundary(value: string, end = false): Date {
  return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`);
}

export async function generateCustomReport(
  orgId: string,
  actorId: string,
  permissions: Set<string>,
  input: CustomReportInput,
) {
  const config = DATASETS[input.dataset];
  const selected = input.columns.map(key => {
    const column = config[key];
    if (!column) throw new ValidationError(`Column "${key}" is not available for ${input.dataset} reports.`);
    return column;
  });
  if (new Set(input.columns).size !== input.columns.length) throw new ValidationError('Choose each report column only once.');

  const { date_from: dateFrom, date_to: dateTo, department, status, employee_id: employeeId, is_active: isActive } = input.filters;
  if (!canGenerateCustomDataset(input.dataset, permissions)) {
    throw new ForbiddenError(`You do not have permission to export the ${input.dataset} dataset.`);
  }
  let visibleUserIds: string[] | undefined;
  if (input.dataset === 'employees') {
    if (permissions.has('employees.view')) visibleUserIds = undefined;
    else if (permissions.has('employees.view_team')) visibleUserIds = [actorId, ...(await directReportIds(orgId, actorId))];
    else throw new ForbiddenError('Employee report access is required.');
  } else if (input.dataset === 'attendance') {
    if (permissions.has('attendance.export')) visibleUserIds = undefined;
    else if (permissions.has('attendance.view_team')) visibleUserIds = [actorId, ...(await directReportIds(orgId, actorId))];
    else throw new ForbiddenError('Attendance report access is required.');
  } else {
    if (permissions.has('leave.view_all')) visibleUserIds = undefined;
    else if (permissions.has('leave.view_team')) visibleUserIds = [actorId, ...(await directReportIds(orgId, actorId))];
    else throw new ForbiddenError('Leave report access is required.');
  }

  if (input.dataset === 'employees') {
    if (dateFrom || dateTo || status) throw new ValidationError('Employee reports support department, active status, and employee filters only.');
    const rows = await prisma.user.findMany({
      where: {
        org_id: orgId,
        deleted_at: null,
        ...(visibleUserIds && { id: { in: visibleUserIds } }),
        ...(employeeId && { id: employeeId }),
        ...(department && { department }),
        ...(isActive !== undefined && { is_active: isActive }),
      },
      select: { id: true, name: true, email: true, department: true, job_title: true, is_active: true, created_at: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 5001,
    });
    return saveReport(orgId, input.dataset, input.columns, selected, rows);
  }

  if (isActive !== undefined) throw new ValidationError('Active status is only available for employee reports.');
  if (input.dataset === 'attendance') {
    const rows = await prisma.attendanceRecord.findMany({
      where: {
        org_id: orgId,
        ...(visibleUserIds && { user_id: { in: visibleUserIds } }),
        ...(employeeId && { user_id: employeeId }),
        ...(department && { user: { department } }),
        ...(status && { status }),
        ...(dateFrom || dateTo ? { date: { ...(dateFrom && { gte: dateBoundary(dateFrom) }), ...(dateTo && { lte: dateBoundary(dateTo, true) }) } } : {}),
      },
      include: { user: { select: { name: true, department: true } } },
      orderBy: [{ date: 'desc' }, { id: 'desc' }], take: 5001,
    });
    return saveReport(orgId, input.dataset, input.columns, selected, rows);
  }

  const rows = await prisma.leaveRequest.findMany({
    where: {
      org_id: orgId,
      ...(visibleUserIds && { user_id: { in: visibleUserIds } }),
      ...(employeeId && { user_id: employeeId }),
      ...(department && { user: { department } }),
      ...(status && { status }),
      ...(dateFrom && { end_date: { gte: dateBoundary(dateFrom) } }),
      ...(dateTo && { start_date: { lte: dateBoundary(dateTo, true) } }),
    },
    include: { user: { select: { name: true, department: true } } },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 5001,
  });
  return saveReport(orgId, input.dataset, input.columns, selected, rows);
}

async function directReportIds(orgId: string, actorId: string): Promise<string[]> {
  const reports = await prisma.user.findMany({ where: { org_id: orgId, manager_id: actorId, deleted_at: null }, select: { id: true } });
  return reports.map(user => user.id);
}

async function saveReport(orgId: string, dataset: CustomReportInput['dataset'], keys: string[], columns: ReportColumn[], rows: Record<string, any>[]) {
  if (rows.length > 5000) throw new ValidationError('This custom report exceeds 5,000 rows. Narrow the filters and try again.');
  const url = await generateCustomCsv(orgId, dataset,
    columns.map(column => column.label), rows.map(row => columns.map(column => column.get(row))));
  return { download_url: url, row_count: rows.length, dataset, columns: keys, generated_at: new Date() };
}
