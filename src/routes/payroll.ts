import { Router } from 'express';
import { authenticate, requirePermission, requireOrgFeature } from '../middleware/auth';
import { ok, NotFoundError, ValidationError, AppError } from '../utils/response';
import { startOfMonth, endOfMonth } from '../utils/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);
router.use(requireOrgFeature('payroll'));

const RECORD_INCLUDE = {
  user: { select: { id: true, name: true, department: true, job_title: true } },
  processor: { select: { id: true, name: true } },
};

// ─── GET /payroll ──────────────────────────────────────
router.get('/', requirePermission('payroll.view'), async (req, res, next) => {
  try {
    const { month, year } = req.query as { month?: string; year?: string };
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (month) where.period_month = parseInt(month);
    if (year)  where.period_year  = parseInt(year);

    const records = await prisma.payrollRecord.findMany({
      where, include: RECORD_INCLUDE, orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
    });

    // Group into payroll periods
    const grouped = records.reduce((acc: Record<string, { id: string; month: number; year: number; status: string; records: typeof records; total_gross: number; total_employees: number }>, r: typeof records[0]) => {
      const key = `${r.period_year}-${r.period_month}`;
      if (!acc[key]) {
        acc[key] = { id: key, month: r.period_month, year: r.period_year, status: r.status, records: [], total_gross: 0, total_employees: 0 };
      }
      acc[key].records.push(r);
      acc[key].total_gross += Number(r.gross_pay);
      acc[key].total_employees++;
      return acc;
    }, {});

    ok(res, Object.values(grouped));
  } catch (e) { next(e); }
});

// ─── POST /payroll/generate ────────────────────────────
router.post('/generate', requirePermission('payroll.manage'), async (req, res, next) => {
  try {
    const { month, year } = req.body;
    const m = month || new Date().getMonth() + 1;
    const y = year  || new Date().getFullYear();

    const start = startOfMonth(y, m);
    const end   = endOfMonth(y, m);

    const [users, org] = await Promise.all([
      prisma.user.findMany({ where: { org_id: req.user!.org_id, is_active: true, deleted_at: null } }),
      prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { tax_rate: true, pension_rate: true } }),
    ]);
    const taxRate     = (org?.tax_rate     ?? 0) / 100;
    const pensionRate = (org?.pension_rate ?? 0) / 100;

    const created: string[] = [];
    const incomplete: string[] = [];

    for (const user of users) {
      if (Number(user.hourly_rate) === 0) {
        incomplete.push(user.name);
      }

      // Get attendance records for the month
      const attendance = await prisma.attendanceRecord.findMany({
        where: { user_id: user.id, date: { gte: start, lte: end } },
      });

      // Prefer net_hours_worked (gross minus unpaid breaks) — fall back to hours_worked for old records
      const regularHours  = attendance.reduce((s: number, r: typeof attendance[0]) => s + Number(r.net_hours_worked ?? r.hours_worked ?? 0), 0);
      const overtimeHours = attendance.reduce((s: number, r: typeof attendance[0]) => s + Number(r.overtime_hours), 0);

      // Get unpaid leave days
      const unpaidLeave = await prisma.leaveRequest.findMany({
        where: {
          user_id: user.id, status: 'approved',
          leave_type: 'unpaid',
          start_date: { lte: end }, end_date: { gte: start },
        },
      });
      const unpaidDays  = unpaidLeave.reduce((s: number, l: typeof unpaidLeave[0]) => s + l.working_days, 0);
      const hourlyRate  = Number(user.hourly_rate);
      const dailyRate   = (hourlyRate * 8);
      const basePay     = regularHours * hourlyRate;
      const overtimePay = overtimeHours * hourlyRate * 1.5;
      const deduction   = unpaidDays * dailyRate;
      const grossPay      = Math.max(0, basePay + overtimePay - deduction);
      const taxDeduction  = grossPay * taxRate;
      const pensionDeduct = grossPay * pensionRate;
      const netPay        = Math.max(0, grossPay - taxDeduction - pensionDeduct);

      await prisma.payrollRecord.upsert({
        where: { user_id_period_month_period_year: { user_id: user.id, period_month: m, period_year: y } },
        update: { regular_hours: regularHours, overtime_hours: overtimeHours, hourly_rate: hourlyRate, base_pay: basePay, overtime_pay: overtimePay, unpaid_deduction: deduction, gross_pay: grossPay, tax_deduction: taxDeduction, pension_deduction: pensionDeduct, net_pay: netPay, is_incomplete: Number(user.hourly_rate) === 0 },
        create: {
          user_id: user.id, org_id: req.user!.org_id, period_month: m, period_year: y,
          regular_hours: regularHours, overtime_hours: overtimeHours,
          hourly_rate: hourlyRate, base_pay: basePay, overtime_pay: overtimePay,
          unpaid_deduction: deduction, gross_pay: grossPay,
          tax_deduction: taxDeduction, pension_deduction: pensionDeduct, net_pay: netPay,
          is_incomplete: Number(user.hourly_rate) === 0,
        },
      });
      created.push(user.name);
    }

    ok(res, { generated: created.length, incomplete: incomplete.length, incomplete_users: incomplete, month: m, year: y });
  } catch (e) { next(e); }
});

// ─── GET /payroll/me ───────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const records = await prisma.payrollRecord.findMany({
      where: { user_id: req.user!.sub },
      orderBy: [{ period_year: 'desc' }, { period_month: 'desc' }],
      take: 24,
    });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /payroll/:id ──────────────────────────────────
router.get('/:id', requirePermission('payroll.view'), async (req, res, next) => {
  try {
    const record = await prisma.payrollRecord.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
      include: RECORD_INCLUDE,
    });
    if (!record) throw new NotFoundError('Payroll record');
    ok(res, record);
  } catch (e) { next(e); }
});

// ─── PUT /payroll/:id/adjust ───────────────────────────
router.put('/:id/adjust', requirePermission('payroll.manage'), async (req, res, next) => {
  try {
    const { field, value, reason } = req.body;
    if (!field || value === undefined || !reason) throw new ValidationError('field, value and reason required');
    if (reason.length < 10) throw new ValidationError('Reason must be at least 10 characters');

    const record = await prisma.payrollRecord.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
    });
    if (!record) throw new NotFoundError('Payroll record');
    if (record.status === 'processed') throw new AppError('Cannot adjust processed payroll', 400, 'LOCKED');

    const updateData: Record<string, unknown> = { adjustment_reason: reason };

    if (field === 'regular_hours')  updateData.regular_hours = value;
    else if (field === 'overtime_hours') updateData.overtime_hours = value;
    else if (field === 'adjustments') updateData.manual_adjustment = value;

    // Recalculate gross pay
    const rh  = Number(field === 'regular_hours'  ? value : record.regular_hours);
    const oh  = Number(field === 'overtime_hours' ? value : record.overtime_hours);
    const adj = Number(field === 'adjustments'    ? value : record.manual_adjustment);
    const grossPay = Math.max(0,
      rh * Number(record.hourly_rate) +
      oh * Number(record.hourly_rate) * 1.5 -
      Number(record.unpaid_deduction) +
      adj
    );
    const org = await prisma.organisation.findUnique({
      where: { id: record.org_id },
      select: { tax_rate: true, pension_rate: true },
    });
    const taxRate     = (Number(org?.tax_rate)     || 0) / 100;
    const pensionRate = (Number(org?.pension_rate) || 0) / 100;
    const taxDeduction     = grossPay * taxRate;
    const pensionDeduction = grossPay * pensionRate;
    updateData.gross_pay          = grossPay;
    updateData.tax_deduction      = taxDeduction;
    updateData.pension_deduction  = pensionDeduction;
    updateData.net_pay            = Math.max(0, grossPay - taxDeduction - pensionDeduction);

    const updated = await prisma.payrollRecord.update({
      where: { id: req.params.id as string },
      data: updateData,
      include: RECORD_INCLUDE,
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /payroll/payslips/:id ─────────────────────────
router.get('/payslips/:id', async (req, res, next) => {
  try {
    const record = await prisma.payrollRecord.findFirst({
      where: { id: req.params.id, user_id: req.user!.sub },
    });
    if (!record) throw new NotFoundError('Payslip');
    if (record.status !== 'processed') throw new AppError('Payslip not yet available', 400);
    ok(res, { url: record.payslip_url, record });
  } catch (e) { next(e); }
});

// ─── POST /payroll/process-with-payslips ──────────────
// Full process: generate PDFs, upload to S3, email employees
router.post('/process-full', requirePermission('payroll.process'), async (req, res, next) => {
  try {
    const { month, year } = req.body;
    const m = month || new Date().getMonth() + 1;
    const y = year  || new Date().getFullYear();

    const incomplete = await prisma.payrollRecord.count({
      where: { org_id: req.user!.org_id, period_month: m, period_year: y, is_incomplete: true },
    });
    if (incomplete > 0) throw new AppError(`${incomplete} records have missing data`, 400);

    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, period_month: m, period_year: y, status: { not: 'processed' } },
      include: { user: true },
    });

    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const { generatePayslipPDF }  = await import('../services/pdf');
    const { sendPayslipEmail }    = await import('../services/email');
    const { notifyPayslip } = await import('../services/whatsapp');
    const periodLabel = new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    let processed = 0;
    const errors: string[] = [];

    for (const record of records) {
      try {
        // Generate PDF payslip
        const { url, key } = await generatePayslipPDF({
          orgId:     req.user!.org_id,
          orgName:   org?.name || 'Your Company',
          currency:  org?.currency || 'USD',
          employee: {
            id:         record.user.id,
            name:       record.user.name,
            email:      record.user.email,
            jobTitle:   record.user.job_title  || undefined,
            department: record.user.department || undefined,
          },
          period: { month: m, year: y, label: periodLabel },
          earnings: {
            regularHours:  Number(record.regular_hours),
            overtimeHours: Number(record.overtime_hours),
            hourlyRate:    Number(record.hourly_rate),
            basePay:       Number(record.base_pay),
            overtimePay:   Number(record.overtime_pay),
          },
          deductions: {
            unpaidDays:      record.unpaid_deduction ? Math.round(Number(record.unpaid_deduction) / (Number(record.hourly_rate) * 8)) : 0,
            unpaidDeduction: Number(record.unpaid_deduction),
            manualAdjustment: Number(record.manual_adjustment),
          },
          grossPay:    Number(record.gross_pay),
          processedAt: new Date(),
          processedBy: req.user!.name,
        });

        // Update record with payslip URL
        await prisma.payrollRecord.update({
          where: { id: record.id },
          data: { status: 'processed', processed_at: new Date(), processed_by: req.user!.sub, payslip_url: key },
        });

        // Email employee
        await sendPayslipEmail(record.user.email, record.user.name, periodLabel, url).catch(console.error);

        // WhatsApp notification
        if (record.user.phone) {
          await notifyPayslip(req.user!.org_id, record.user.name, periodLabel, record.user.phone).catch(console.error);
        }

        processed++;
      } catch (err) {
        console.error(`[PAYROLL] Failed for ${record.user.name}:`, err);
        errors.push(record.user.name);
      }
    }

    ok(res, { processed, errors, month: m, year: y, message: `Payroll processed for ${processed} employees. ${errors.length} failed.` });
  } catch (e) { next(e); }
});

// ─── GET /payroll/payslips/:id/download ───────────────
router.get('/payslips/:id/download', async (req, res, next) => {
  try {
    const record = await prisma.payrollRecord.findFirst({
      where: { id: req.params.id, user_id: req.user!.sub },
    });
    if (!record) throw new NotFoundError('Payslip');
    if (record.status !== 'processed') throw new AppError('Payslip not yet processed', 400);
    if (!record.payslip_url) throw new AppError('Payslip PDF not yet generated', 400);

    const { getSignedDownloadUrl } = await import('../services/s3');
    const url = await getSignedDownloadUrl(record.payslip_url, 900);
    ok(res, { url });
  } catch (e) { next(e); }
});

export default router;
