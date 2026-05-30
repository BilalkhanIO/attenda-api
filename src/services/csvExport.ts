// @ts-nocheck
import { stringify } from 'csv-stringify/sync';
import { format } from 'date-fns';
import { uploadBuffer, S3Keys, getSignedDownloadUrl, isS3Configured } from './s3';

// ─── Attendance CSV ───────────────────────────────────
export async function generateAttendanceCsv(
  orgId:   string,
  records: any[],
): Promise<string> {
  const rows = [
    ['Date', 'Employee', 'Department', 'Check In', 'Check Out', 'Hours Worked', 'Status', 'Type', 'Overridden', 'Override Reason'],
    ...records.map(r => [
      format(new Date(r.date), 'yyyy-MM-dd'),
      r.user?.name   || r.user_id,
      r.user?.department || '',
      r.check_in_at  ? format(new Date(r.check_in_at),  'HH:mm:ss') : '',
      r.check_out_at ? format(new Date(r.check_out_at), 'HH:mm:ss') : '',
      r.hours_worked  ? Number(r.hours_worked).toFixed(2)  : '',
      r.status,
      r.check_in_type,
      r.is_overridden ? 'Yes' : 'No',
      r.override_reason || '',
    ]),
  ];
  return uploadCsv(orgId, 'attendance', rows);
}

// ─── Payroll CSV ──────────────────────────────────────
export async function generatePayrollCsv(
  orgId:   string,
  records: any[],
  month:   number,
  year:    number,
): Promise<string> {
  const rows = [
    ['Employee', 'Department', 'Regular Hours', 'Overtime Hours', 'Hourly Rate', 'Base Pay', 'Overtime Pay', 'Deductions', 'Adjustments', 'Gross Pay', 'Status'],
    ...records.map(r => [
      r.user?.name       || r.user_id,
      r.user?.department || '',
      Number(r.regular_hours).toFixed(2),
      Number(r.overtime_hours).toFixed(2),
      Number(r.hourly_rate).toFixed(2),
      Number(r.base_pay).toFixed(2),
      Number(r.overtime_pay).toFixed(2),
      Number(r.unpaid_deduction).toFixed(2),
      Number(r.manual_adjustment).toFixed(2),
      Number(r.gross_pay).toFixed(2),
      r.status,
    ]),
  ];
  return uploadCsv(orgId, `payroll-${year}-${String(month).padStart(2,'0')}`, rows);
}

// ─── Leave CSV ────────────────────────────────────────
export async function generateLeaveCsv(
  orgId:    string,
  requests: any[],
): Promise<string> {
  const rows = [
    ['Employee', 'Department', 'Leave Type', 'Start Date', 'End Date', 'Working Days', 'Status', 'Reviewed By', 'Rejection Reason', 'Submitted At'],
    ...requests.map(r => [
      r.user?.name       || r.user_id,
      r.user?.department || '',
      r.leave_type,
      format(new Date(r.start_date), 'yyyy-MM-dd'),
      format(new Date(r.end_date),   'yyyy-MM-dd'),
      r.working_days,
      r.status,
      r.reviewer?.name   || '',
      r.rejection_reason || '',
      format(new Date(r.created_at), 'yyyy-MM-dd HH:mm'),
    ]),
  ];
  return uploadCsv(orgId, 'leave-requests', rows);
}

// ─── Performance CSV ──────────────────────────────────
export async function generatePerformanceCsv(
  orgId:   string,
  reviews: any[],
  month:   number,
  year:    number,
): Promise<string> {
  const rows = [
    ['Employee', 'Department', 'Period', 'Manager Rating (1-5)', 'Attendance Score', 'Overall Score', 'Notes', 'Submitted At'],
    ...reviews.map(r => [
      r.user?.name        || r.user_id,
      r.user?.department  || '',
      `${month}/${year}`,
      r.manager_rating    || '',
      r.attendance_score  ? Number(r.attendance_score).toFixed(1)  : '',
      r.overall_score     ? Number(r.overall_score).toFixed(1) : '',
      (r.notes || '').replace(/\n/g, ' '),
      r.submitted_at ? format(new Date(r.submitted_at), 'yyyy-MM-dd') : '',
    ]),
  ];
  return uploadCsv(orgId, `performance-${year}-${String(month).padStart(2,'0')}`, rows);
}

// ─── Core upload helper ───────────────────────────────
async function uploadCsv(orgId: string, type: string, rows: any[][]): Promise<string> {
  const csv    = stringify(rows, { quoted: true });
  const buffer = Buffer.from(csv, 'utf-8');
  const ts     = Date.now();

  if (isS3Configured()) {
    const key = S3Keys.reportCsv(orgId, type, ts);
    await uploadBuffer(key, buffer, 'text/csv; charset=utf-8');
    return getSignedDownloadUrl(key, 3600); // 1 hour
  }

  // No S3 configured — return a data URI the browser can download directly
  const b64 = buffer.toString('base64');
  return `data:text/csv;charset=utf-8;base64,${b64}`;
}
