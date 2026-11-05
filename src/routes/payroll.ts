import { Router } from 'express';
import { stringify } from 'csv-stringify/sync';
import { authenticate, requirePermission, requireOrgFeature } from '../middleware/auth';
import { ok, created, NotFoundError, ValidationError, AppError } from '../utils/response';
import { startOfMonth, endOfMonth } from '../utils/auth';
import { localDateStr } from '../utils/shift';
import { recalcPayrollTotals, computePeriodPayroll, payrollInputsHash } from '../utils/payroll';
import prisma from '../utils/prisma';
import { validate } from '../middleware/validate';
import { idempotency } from '../middleware/idempotency';
import { payrollPeriodSchema, payrollAdjustSchema, payrollRecallSchema, payRateSchema } from '../schemas';
import { recordAudit } from '../services/audit';
import { createNotification } from '../services/notifications';
import { statutoryParameterSetSchema } from '../schemas/statutory-payroll';
import { applyStatutoryPayroll } from '../services/statutoryPayroll';
import { buildPayrollJournal } from '../services/payrollJournal';
import { setEffectivePayRate } from '../services/payRates';
import { acquireRedisLease } from '../utils/redisLease';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);
router.use(requireOrgFeature('payroll'));

const RECORD_INCLUDE = {
  user: { select: { id: true, name: true, department: true, job_title: true } },
  generator: { select: { id: true, name: true } },
  processor: { select: { id: true, name: true } },
};

async function acquirePayrollPeriodLease(orgId: string, year: number, month: number) {
  let release: null | (() => Promise<void>);
  try {
    release = await acquireRedisLease(`payroll-process:${orgId}:${year}-${String(month).padStart(2, '0')}`, 15 * 60_000);
  } catch {
    throw new AppError('Payroll coordination is temporarily unavailable. No payroll changes were applied; retry shortly.', 503, 'PAYROLL_COORDINATION_UNAVAILABLE');
  }
  if (!release) throw new AppError('This payroll period is being changed by another administrator. Retry after it completes.', 409, 'PAYROLL_RUN_IN_PROGRESS');
  return release;
}

router.get('/statutory-parameter-sets', requirePermission('payroll.view'), async (req, res, next) => {
  try {
    const [org, sets] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { country_code: true } }),
      prisma.statutoryParameterSet.findMany({
        where: { org_id: req.user!.org_id }, orderBy: [{ effective_from: 'desc' }, { created_at: 'desc' }],
        include: { creator: { select: { id: true, name: true } }, activator: { select: { id: true, name: true } } },
      }),
    ]);
    ok(res, { country_code: org?.country_code ?? null, sets });
  } catch (error) { next(error); }
});

router.get('/rates/:userId', requirePermission('payroll.manage'), async (req, res, next) => {
  try {
    const userId = String(req.params.userId);
    const user = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id, deleted_at: null }, select: { id: true, name: true, hourly_rate: true } });
    if (!user) throw new NotFoundError('Employee');
    const rates = await prisma.payRate.findMany({ where: { org_id: req.user!.org_id, user_id: userId }, orderBy: { effective_from: 'desc' }, include: { creator: { select: { id: true, name: true } } } });
    ok(res, { employee: user, rates });
  } catch (error) { next(error); }
});

router.put('/rates/:userId', requirePermission('payroll.manage'), idempotency, validate({ body: payRateSchema }), async (req, res, next) => {
  try {
    const userId = String(req.params.userId);
    const user = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id, deleted_at: null }, select: { id: true } });
    if (!user) throw new NotFoundError('Employee');
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { currency: true, timezone: true, monthly_pay_divisor: true } });
    const currency = req.body.currency ?? org?.currency ?? 'PKR';
    if (org?.currency && currency !== org.currency) throw new ValidationError(`Pay rate currency must match organization currency (${org.currency})`);
    const effectiveFrom = new Date(`${req.body.effective_from}T00:00:00.000Z`);
    if (Number.isNaN(effectiveFrom.getTime()) || effectiveFrom.toISOString().slice(0, 10) !== req.body.effective_from) throw new ValidationError('effective_from must be a valid date');
    if (!/^\d{4}-\d{2}-01$/.test(req.body.effective_from)) throw new ValidationError('Pay rate changes must take effect on the first day of a payroll month');
    const result = await prisma.$transaction(async tx => {
      const rate = await setEffectivePayRate({ tx, orgId: req.user!.org_id, userId, amount: req.body.amount, basis: req.body.basis, currency, effectiveFrom, actorId: req.user!.sub });
      const today = new Date(`${localDateStr(new Date(), org?.timezone)}T00:00:00.000Z`);
      const activeRate = await tx.payRate.findFirst({ where: { org_id: req.user!.org_id, user_id: userId, effective_from: { lte: today }, OR: [{ effective_to: null }, { effective_to: { gte: today } }] }, orderBy: { effective_from: 'desc' } });
      if (activeRate) {
        const amount = Number(activeRate.amount);
        const equivalentHourly = activeRate.basis === 'daily' ? amount / 8 : activeRate.basis === 'monthly' ? amount / Math.max(1, Number(org?.monthly_pay_divisor) || 26) / 8 : amount;
        await tx.user.update({ where: { id: userId }, data: { hourly_rate: equivalentHourly } });
      }
      const drafts = await tx.payrollRecord.findMany({ where: { org_id: req.user!.org_id, user_id: userId, status: 'draft' }, select: { id: true, period_month: true, period_year: true } });
      for (const draft of drafts) {
        const periodStart = startOfMonth(draft.period_year, draft.period_month);
        const periodEnd = endOfMonth(draft.period_year, draft.period_month);
        if (periodStart <= (rate.effective_to ?? new Date('9999-12-31T00:00:00.000Z')) && periodEnd >= effectiveFrom) {
          await tx.payrollRecord.update({ where: { id: draft.id }, data: { inputs_stale: true } });
        }
      }
      return rate;
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'payroll.rate.update', entityType: 'pay_rate', entityId: result.id, after: { user_id: userId, amount: req.body.amount, basis: req.body.basis, currency, effective_from: result.effective_from, effective_to: result.effective_to } });
    ok(res, result);
  } catch (error) { next(error); }
});

router.post('/statutory-parameter-sets', requirePermission('payroll.manage'), idempotency, validate({ body: statutoryParameterSetSchema }), async (req, res, next) => {
  try {
    const value = req.body;
    const row = await prisma.statutoryParameterSet.create({ data: {
      org_id: req.user!.org_id,
      country_code: value.country_code,
      effective_from: new Date(`${value.effective_from}T00:00:00.000Z`),
      effective_to: value.effective_to ? new Date(`${value.effective_to}T00:00:00.000Z`) : null,
      source_reference: value.source_reference,
      annual_tax_slabs: value.annual_tax_slabs,
      contributions: value.contributions,
      created_by: req.user!.sub,
    }, include: { creator: { select: { id: true, name: true } } } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'payroll.statutory.draft', entityType: 'statutory_parameter_set', entityId: row.id, after: { country_code: row.country_code, effective_from: row.effective_from, source_reference: row.source_reference } });
    created(res, row);
  } catch (error) { next(error); }
});

router.post('/statutory-parameter-sets/:id/activate', requirePermission('payroll.process'), idempotency, async (req, res, next) => {
  try {
    const set = await prisma.statutoryParameterSet.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id } });
    if (!set) throw new NotFoundError('Statutory parameter set');
    if (set.status !== 'draft') throw new AppError('Only draft statutory parameter sets can be activated.', 409, 'STATUTORY_SET_NOT_DRAFT');
    if (set.created_by === req.user!.sub) throw new AppError('A different payroll approver must activate this parameter set.', 403, 'MAKER_CHECKER_REQUIRED');
    const fromYear = set.effective_from.getUTCFullYear();
    const fromMonth = set.effective_from.getUTCMonth() + 1;
    const throughYear = set.effective_to?.getUTCFullYear();
    const throughMonth = set.effective_to ? set.effective_to.getUTCMonth() + 1 : undefined;
    const effectiveRange = !throughYear
      ? { OR: [{ period_year: { gt: fromYear } }, { period_year: fromYear, period_month: { gte: fromMonth } }] }
      : throughYear === fromYear
        ? { period_year: fromYear, period_month: { gte: fromMonth, lte: throughMonth } }
        : { OR: [
          { period_year: fromYear, period_month: { gte: fromMonth } },
          { period_year: { gt: fromYear, lt: throughYear } },
          { period_year: throughYear, period_month: { lte: throughMonth } },
        ] };
    const activated = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${set.org_id}), hashtext(${set.country_code}))`;
      const activeSets = await tx.statutoryParameterSet.findMany({ where: { org_id: set.org_id, country_code: set.country_code, status: 'active', id: { not: set.id } }, select: { id: true, effective_from: true, effective_to: true } });
      const newStart = set.effective_from.getTime();
      const newEnd = set.effective_to?.getTime() ?? Number.POSITIVE_INFINITY;
      for (const active of activeSets) {
        const oldStart = active.effective_from.getTime();
        const oldEnd = active.effective_to?.getTime() ?? Number.POSITIVE_INFINITY;
        if (oldStart > newEnd || oldEnd < newStart) continue;
        if (oldStart >= newStart) throw new AppError('This effective date range overlaps a later active statutory set.', 409, 'STATUTORY_SET_OVERLAP');
        const closeOldOn = new Date(newStart - 86_400_000);
        if (closeOldOn.getTime() < oldStart) throw new AppError('The previous statutory set cannot be closed before its start date.', 409, 'STATUTORY_SET_OVERLAP');
        await tx.statutoryParameterSet.update({ where: { id: active.id }, data: { effective_to: closeOldOn } });
      }
      const row = await tx.statutoryParameterSet.update({ where: { id: set.id }, data: { status: 'active', activated_by: req.user!.sub, activated_at: new Date() }, include: { creator: { select: { id: true, name: true } }, activator: { select: { id: true, name: true } } } });
      await tx.organisation.update({ where: { id: set.org_id }, data: { country_code: set.country_code } });
      await tx.payrollRecord.updateMany({ where: { org_id: set.org_id, status: 'draft', ...effectiveRange }, data: { inputs_stale: true } });
      return row;
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'payroll.statutory.activate', entityType: 'statutory_parameter_set', entityId: set.id, before: { status: set.status }, after: { status: activated.status, country_code: set.country_code, effective_from: set.effective_from, effective_to: set.effective_to } });
    ok(res, activated);
  } catch (error) { next(error); }
});

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
router.post('/generate', requirePermission('payroll.manage'), idempotency, validate({ body: payrollPeriodSchema }), async (req, res, next) => {
  let releaseLease: (() => Promise<void>) | null = null;
  try {
    const { month, year } = req.body;
    const m = month || new Date().getMonth() + 1;
    const y = year  || new Date().getFullYear();
    releaseLease = await acquirePayrollPeriodLease(req.user!.org_id, y, m);

    const start = startOfMonth(y, m);
    const end   = endOfMonth(y, m);

    const [users, org] = await Promise.all([
      prisma.user.findMany({ where: { org_id: req.user!.org_id, is_active: true, deleted_at: null } }),
      prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { tax_rate: true, pension_rate: true, monthly_pay_divisor: true } }),
    ]);

    // Existing records for the period: processed ones are immutable (a re-run
    // must never silently rewrite finalized pay — recall first), and
    // manual_adjustment MUST survive regeneration or reimbursements already
    // applied to the record silently vanish from gross/net.
    const existingRecords = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, period_month: m, period_year: y },
      select: { user_id: true, status: true, manual_adjustment: true },
    });
    const processedUserIds = new Set(existingRecords.filter(r => r.status === 'processed').map(r => r.user_id));
    const manualAdjByUser  = new Map(existingRecords.map(r => [r.user_id, Number(r.manual_adjustment) || 0]));

    const created: string[] = [];
    const incomplete: string[] = [];
    const skippedProcessed: string[] = [];
    const currentPayRates = await prisma.payRate.findMany({
      where: { org_id: req.user!.org_id, user_id: { in: users.map(user => user.id) }, effective_from: { lte: end }, OR: [{ effective_to: null }, { effective_to: { gte: start } }] },
      orderBy: { effective_from: 'desc' },
    });
    const payRateByUser = new Map<string, (typeof currentPayRates)[number]>();
    for (const rate of currentPayRates) if (!payRateByUser.has(rate.user_id) && rate.effective_from <= end && (!rate.effective_to || rate.effective_to >= end)) payRateByUser.set(rate.user_id, rate);

    for (const user of users) {
      if (processedUserIds.has(user.id)) {
        skippedProcessed.push(user.name);
        continue;
      }
      const payRate = payRateByUser.get(user.id);
      const payBasis = (payRate?.basis ?? 'hourly') as 'hourly' | 'daily' | 'monthly';
      const payRateAmount = payRate ? Number(payRate.amount) : Number(user.hourly_rate);
      const monthlyPayDivisor = Math.max(1, Number(org?.monthly_pay_divisor) || 26);
      const hourlyRate = payBasis === 'hourly' ? payRateAmount : payBasis === 'daily' ? payRateAmount / 8 : payRateAmount / monthlyPayDivisor / 8;
      if (payRateAmount === 0) {
        incomplete.push(user.name);
      }

      // Attendance for the month, with each record's shift so overtime is
      // paid at that shift's overtime_multiplier (fallback 1.5)
      const attendance = await prisma.attendanceRecord.findMany({
        where: { user_id: user.id, date: { gte: start, lte: end } },
        include: { shift: { select: { overtime_multiplier: true } } },
      });

      // Get unpaid leave days
      const unpaidLeave = await prisma.leaveRequest.findMany({
        where: {
          user_id: user.id, status: 'approved',
          leave_type: 'unpaid',
          start_date: { lte: end }, end_date: { gte: start },
        },
      });
      const unpaidDays = unpaidLeave.reduce((s: number, l: typeof unpaidLeave[0]) => s + l.working_days, 0);

      const calculated = computePeriodPayroll({
        attendance,
        unpaid_leave_days: unpaidDays,
        hourly_rate: hourlyRate,
        pay_basis: payBasis,
        pay_rate_amount: payRateAmount,
        monthly_pay_divisor: monthlyPayDivisor,
        manual_adjustment: manualAdjByUser.get(user.id) ?? 0,
      }, Number(org?.tax_rate) || 0, Number(org?.pension_rate) || 0);
      const statutory = await applyStatutoryPayroll({ orgId: req.user!.org_id, userId: user.id, year: y, month: m }, calculated);
      const totals = statutory.totals;
      const inputsHash = payrollInputsHash({
        attendance, unpaid_leave_days: unpaidDays, hourly_rate: hourlyRate,
        pay_basis: payBasis, pay_rate_amount: payRateAmount, monthly_pay_divisor: monthlyPayDivisor,
        tax_rate: Number(org?.tax_rate) || 0, pension_rate: Number(org?.pension_rate) || 0,
        statutory_parameter_set_id: statutory.statutory_parameter_set_id,
        pay_rate_id: payRate?.id ?? null,
      });

      const fields = {
        regular_hours: totals.regular_hours, overtime_hours: totals.overtime_hours,
        hourly_rate: hourlyRate, base_pay: totals.base_pay,
        pay_basis: payBasis, pay_rate_amount: payRateAmount, pay_monthly_divisor: monthlyPayDivisor,
        overtime_pay: totals.overtime_pay, unpaid_deduction: totals.unpaid_deduction,
        gross_pay: totals.gross_pay, tax_deduction: totals.tax_deduction,
        pension_deduction: totals.pension_deduction, net_pay: totals.net_pay,
        statutory_parameter_set_id: statutory.statutory_parameter_set_id,
        pay_rate_id: payRate?.id ?? null,
        tax_calculation_method: statutory.tax_calculation_method,
        employee_statutory_deductions: statutory.employee_statutory_deductions,
        employer_statutory_contributions: statutory.employer_statutory_contributions,
        is_incomplete: hourlyRate === 0, inputs_hash: inputsHash, inputs_stale: false,
        generated_by: req.user!.sub,
      };
      await prisma.payrollRecord.upsert({
        where: { user_id_period_month_period_year: { user_id: user.id, period_month: m, period_year: y } },
        update: fields,
        create: { user_id: user.id, org_id: req.user!.org_id, period_month: m, period_year: y, ...fields },
      });
      created.push(user.name);
    }

    ok(res, {
      generated: created.length, incomplete: incomplete.length, incomplete_users: incomplete,
      skipped_processed: skippedProcessed.length, skipped_processed_users: skippedProcessed,
      month: m, year: y,
    });
  } catch (e) { next(e); }
  finally { await releaseLease?.().catch(() => {}); }
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

// Annual statement is an employee-safe summary of processed payroll. It is a
// calculation aid and must not be presented as a government tax certificate.
router.get('/me/annual-statement', async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new ValidationError('A valid year is required.');
    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, user_id: req.user!.sub, period_year: year, status: 'processed' },
      orderBy: { period_month: 'asc' },
      select: { period_month: true, gross_pay: true, tax_deduction: true, pension_deduction: true, net_pay: true, employee_statutory_deductions: true, employer_statutory_contributions: true, tax_calculation_method: true, statutory_parameter_set: { select: { country_code: true, source_reference: true } } },
    });
    ok(res, annualPayrollSummary(records, year));
  } catch (error) { next(error); }
});

router.get('/annual-statement', requirePermission('payroll.view'), async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const userId = String(req.query.user_id ?? '');
    if (!Number.isInteger(year) || year < 2000 || year > 2200 || !userId) throw new ValidationError('A valid year and user_id are required.');
    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, user_id: userId, period_year: year, status: 'processed' },
      orderBy: { period_month: 'asc' },
      select: { period_month: true, gross_pay: true, tax_deduction: true, pension_deduction: true, net_pay: true, employee_statutory_deductions: true, employer_statutory_contributions: true, tax_calculation_method: true, statutory_parameter_set: { select: { country_code: true, source_reference: true } } },
    });
    if (!records.length) throw new NotFoundError('Processed annual payroll records');
    ok(res, annualPayrollSummary(records, year));
  } catch (error) { next(error); }
});

router.get('/me/annual-statement.csv', async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new ValidationError('A valid year is required.');
    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, user_id: req.user!.sub, period_year: year, status: 'processed' },
      orderBy: { period_month: 'asc' },
      include: { user: { select: { id: true, name: true, department: true } }, statutory_parameter_set: { select: { country_code: true, source_reference: true } } },
    });
    if (!records.length) throw new NotFoundError('Processed annual payroll records');
    res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`attenda-payroll-summary-${year}.csv`).send(annualPayrollCsv(records, year));
  } catch (error) { next(error); }
});

router.get('/annual-statement.csv', requirePermission('payroll.view'), async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new ValidationError('A valid year is required.');
    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, period_year: year, status: 'processed', ...(userId ? { user_id: userId } : {}) },
      include: { user: { select: { id: true, name: true, department: true } }, statutory_parameter_set: { select: { country_code: true, source_reference: true } } },
      orderBy: [{ user: { name: 'asc' } }, { period_month: 'asc' }],
    });
    if (userId && !records.length) throw new NotFoundError('Processed annual payroll records');
    res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`attenda-payroll-summary-${year}.csv`).send(annualPayrollCsv(records, year));
  } catch (error) { next(error); }
});

// Accounting journal export is derived only from finalized payroll. It is a
// balanced CSV for posting into an external ledger and never initiates payment.
router.get('/journal.csv', requirePermission('payroll.view'), async (req, res, next) => {
  try {
    const year = Number(req.query.year);
    const month = req.query.month === undefined ? undefined : Number(req.query.month);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new ValidationError('A valid year is required.');
    if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) throw new ValidationError('Month must be between 1 and 12.');

    const [org, records] = await Promise.all([
      prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { currency: true } }),
      prisma.payrollRecord.findMany({
        where: { org_id: req.user!.org_id, period_year: year, status: 'processed', ...(month ? { period_month: month } : {}) },
        select: {
          period_month: true, period_year: true, gross_pay: true, tax_deduction: true,
          pension_deduction: true, net_pay: true, employee_statutory_deductions: true,
          employer_statutory_contributions: true, pay_rate: { select: { currency: true } },
        },
        orderBy: [{ period_month: 'asc' }, { id: 'asc' }],
      }),
    ]);
    if (!records.length) throw new NotFoundError('Processed payroll records');
    const journal = buildPayrollJournal(records.map(record => ({ ...record, currency: record.pay_rate?.currency || org?.currency || 'USD' })));
    const csv = stringify(journal, {
      header: true,
      columns: ['date', 'period', 'currency', 'account_code', 'account_name', 'description', 'debit', 'credit', 'source_records'],
    });
    const periodLabel = month ? `${year}-${String(month).padStart(2, '0')}` : String(year);
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'payroll.journal.export', entityType: 'payroll_period', entityId: periodLabel });
    res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.attachment(`attenda-payroll-journal-${periodLabel}.csv`).send(csv);
  } catch (error) { next(error); }
});

function annualPayrollSummary(records: Array<{
  period_month: number; gross_pay: unknown; tax_deduction: unknown; pension_deduction: unknown; net_pay: unknown;
  employee_statutory_deductions: unknown; employer_statutory_contributions: unknown; tax_calculation_method: string | null;
  statutory_parameter_set: { country_code: string; source_reference: string } | null;
}>, year: number) {
  const sum = (key: 'gross_pay' | 'tax_deduction' | 'pension_deduction' | 'net_pay') => Math.round(records.reduce((total, row) => total + Number(row[key] || 0), 0) * 100) / 100;
  const aggregate = (field: 'employee_statutory_deductions' | 'employer_statutory_contributions') => {
    const totals = new Map<string, { key: string; label: string; amount: number }>();
    for (const row of records) if (Array.isArray(row[field])) for (const item of row[field] as Array<{ key?: string; label?: string; amount?: number }>) {
      if (!item?.key || !item.label) continue;
      const existing = totals.get(item.key) ?? { key: item.key, label: item.label, amount: 0 };
      existing.amount += Number(item.amount) || 0; totals.set(item.key, existing);
    }
    return [...totals.values()].map(item => ({ ...item, amount: Math.round(item.amount * 100) / 100 }));
  };
  return {
    year,
    months_processed: records.map(row => row.period_month),
    gross_earnings: sum('gross_pay'),
    tax_withheld: sum('tax_deduction'),
    pension_deductions: sum('pension_deduction'),
    employee_statutory_deductions: aggregate('employee_statutory_deductions'),
    employer_statutory_contributions: aggregate('employer_statutory_contributions'),
    net_pay: sum('net_pay'),
    countries: [...new Set(records.map(row => row.statutory_parameter_set?.country_code).filter(Boolean))],
    tax_methods: [...new Set(records.map(row => row.tax_calculation_method).filter(Boolean))],
    source_references: [...new Set(records.map(row => row.statutory_parameter_set?.source_reference).filter(Boolean))],
    disclaimer: 'Annual summary of processed Attenda payroll records for reference. This is not a government tax certificate or tax filing; confirm statutory amounts with a qualified payroll or tax adviser.',
  };
}

function annualPayrollCsv(records: Array<any>, year: number): string {
  const rows: unknown[][] = [[
    'Document type', 'Year', 'Employee', 'Employee ID', 'Department', 'Month', 'Gross earnings', 'Tax withheld',
    'Pension deduction', 'Employee statutory deductions', 'Employer statutory contributions', 'Net pay', 'Tax calculation method', 'Country', 'Source references',
  ]];
  const disclaimer = 'Reference summary of processed Attenda payroll; not an official tax certificate or tax filing.';
  for (const row of records) {
    const labels = (value: unknown) => Array.isArray(value) ? value.map((item: any) => `${item.label}: ${Number(item.amount || 0).toFixed(2)}`).join('; ') : '';
    rows.push([
      disclaimer, year, row.user?.name ?? '', row.user?.id ?? row.user_id, row.user?.department ?? '', row.period_month,
      Number(row.gross_pay).toFixed(2), Number(row.tax_deduction).toFixed(2), Number(row.pension_deduction).toFixed(2),
      labels(row.employee_statutory_deductions), labels(row.employer_statutory_contributions), Number(row.net_pay).toFixed(2),
      row.tax_calculation_method ?? '', row.statutory_parameter_set?.country_code ?? '', row.statutory_parameter_set?.source_reference ?? '',
    ]);
  }
  return `\uFEFF${stringify(rows, { quoted: true })}`;
}

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
router.put('/:id/adjust', requirePermission('payroll.manage'), idempotency, validate({ body: payrollAdjustSchema }), async (req, res, next) => {
  let releaseLease: (() => Promise<void>) | null = null;
  try {
    const { field, value, reason } = req.body;
    if (!field || value === undefined || !reason) throw new ValidationError('field, value and reason required');
    if (reason.length < 10) throw new ValidationError('Reason must be at least 10 characters');

    const record = await prisma.payrollRecord.findFirst({
      where: { id: req.params.id as string, org_id: req.user!.org_id },
    });
    if (!record) throw new NotFoundError('Payroll record');
    releaseLease = await acquirePayrollPeriodLease(record.org_id, record.period_year, record.period_month);
    if (record.status === 'processed') throw new AppError('Cannot adjust processed payroll', 400, 'LOCKED');

    const updateData: Record<string, unknown> = { adjustment_reason: reason };

    if (field === 'regular_hours')  updateData.regular_hours = value;
    else if (field === 'overtime_hours') updateData.overtime_hours = value;
    else if (field === 'adjustments') updateData.manual_adjustment = value;

    // Recalculate gross pay
    const org = await prisma.organisation.findUnique({
      where: { id: record.org_id },
      select: { tax_rate: true, pension_rate: true },
    });
    const regularHours = Number(field === 'regular_hours' ? value : record.regular_hours);
    const overtimeHours = Number(field === 'overtime_hours' ? value : record.overtime_hours);
    const hourlyRate = Number(record.hourly_rate);
    const payRateAmount = Number(record.pay_rate_amount);
    const adjustedBasePay = field === 'regular_hours'
      ? record.pay_basis === 'hourly' ? regularHours * hourlyRate
        : record.pay_basis === 'daily' ? regularHours / 8 * payRateAmount
          : Number(record.base_pay)
      : Number(record.base_pay);
    const oldOtHours = Number(record.overtime_hours);
    const otMultiplier = oldOtHours > 0 && hourlyRate > 0 ? Number(record.overtime_pay) / (oldOtHours * hourlyRate) : 1.5;
    const adjustedOvertimePay = field === 'overtime_hours' ? overtimeHours * hourlyRate * (Number.isFinite(otMultiplier) ? otMultiplier : 1.5) : Number(record.overtime_pay);
    const recalculated = recalcPayrollTotals({
      regular_hours: regularHours,
      overtime_hours: overtimeHours,
      manual_adjustment: Number(field === 'adjustments'    ? value : record.manual_adjustment),
      hourly_rate:       hourlyRate,
      unpaid_deduction:  Number(record.unpaid_deduction),
      base_pay: adjustedBasePay,
      overtime_pay: adjustedOvertimePay,
    }, Number(org?.tax_rate) || 0, Number(org?.pension_rate) || 0);
    const statutory = await applyStatutoryPayroll({ orgId: record.org_id, userId: record.user_id, year: record.period_year, month: record.period_month }, recalculated);
    const totals = statutory.totals;
    updateData.gross_pay          = totals.gross_pay;
    updateData.base_pay = adjustedBasePay;
    updateData.overtime_pay = adjustedOvertimePay;
    updateData.tax_deduction      = totals.tax_deduction;
    updateData.pension_deduction  = totals.pension_deduction;
    updateData.net_pay            = totals.net_pay;
    updateData.statutory_parameter_set_id = statutory.statutory_parameter_set_id;
    updateData.tax_calculation_method = statutory.tax_calculation_method;
    updateData.employee_statutory_deductions = statutory.employee_statutory_deductions;
    updateData.employer_statutory_contributions = statutory.employer_statutory_contributions;

    const updated = await prisma.payrollRecord.update({
      where: { id: req.params.id as string },
      data: updateData,
      include: RECORD_INCLUDE,
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'payroll.adjust', entityType: 'payroll_record', entityId: record.id,
      before: { field, value: record[field === 'adjustments' ? 'manual_adjustment' : field as 'regular_hours' | 'overtime_hours'], gross_pay: record.gross_pay, net_pay: record.net_pay },
      after: { field, value, gross_pay: updated.gross_pay, net_pay: updated.net_pay },
      reason,
    });
    ok(res, updated);
  } catch (e) { next(e); }
  finally { await releaseLease?.().catch(() => {}); }
});

// ─── POST /payroll/:id/recall ──────────────────────────
// Controlled reopen of a processed record: status → 'recalled' so it can be
// adjusted and re-processed. The stale payslip stops being served (payslip
// endpoints gate on status === 'processed') and the recall is audited.
router.post('/:id/recall', requirePermission('payroll.process'), idempotency, validate({ body: payrollRecallSchema }), async (req, res, next) => {
  try {
    const { reason } = req.body;

    const record = await prisma.payrollRecord.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
      include: RECORD_INCLUDE,
    });
    if (!record) throw new NotFoundError('Payroll record');
    if (record.status !== 'processed') {
      throw new AppError('Only processed payroll can be recalled', 400, 'NOT_PROCESSED');
    }

    const updated = await prisma.payrollRecord.update({
      where: { id: record.id },
      data: { status: 'recalled', adjustment_reason: reason },
      include: RECORD_INCLUDE,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'payroll.recall', entityType: 'payroll_record', entityId: record.id,
      before: { status: 'processed', processed_at: record.processed_at, net_pay: record.net_pay },
      after: { status: 'recalled' },
      reason,
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
// Finalize payroll records and enqueue payslip-ready notifications separately.
router.post('/process-full', requirePermission('payroll.process'), idempotency, validate({ body: payrollPeriodSchema }), async (req, res, next) => {
  let releaseLease: (() => Promise<void>) | null = null;
  try {
    const { month, year } = req.body;
    const m = month || new Date().getMonth() + 1;
    const y = year  || new Date().getFullYear();

    releaseLease = await acquirePayrollPeriodLease(req.user!.org_id, y, m);

    const incomplete = await prisma.payrollRecord.count({
      where: { org_id: req.user!.org_id, period_month: m, period_year: y, is_incomplete: true },
    });
    if (incomplete > 0) throw new AppError(`${incomplete} records have missing data`, 400);
    const stale = await prisma.payrollRecord.count({
      where: { org_id: req.user!.org_id, period_month: m, period_year: y, status: 'draft', inputs_stale: true },
    });
    if (stale > 0) throw new AppError(`${stale} payroll drafts have changed source inputs. Regenerate the period before processing.`, 409, 'PAYROLL_INPUTS_STALE');

    const records = await prisma.payrollRecord.findMany({
      where: { org_id: req.user!.org_id, period_month: m, period_year: y, status: { not: 'processed' } },
      include: { user: true },
    });

    const selfApproved = records.filter(record => record.generated_by === req.user!.sub);
    if (selfApproved.length) {
      throw new AppError(
        `A different payroll administrator must process this run. You generated ${selfApproved.length} of its remaining ${records.length} draft records.`,
        403,
        'PAYROLL_MAKER_CHECKER_REQUIRED',
      );
    }
    if (!records.length) throw new AppError('There are no unprocessed payroll records for this period.', 409, 'PAYROLL_NOTHING_TO_PROCESS');
    logger.info({ orgId: req.user!.org_id, actorId: req.user!.sub, year: y, month: m, records: records.length }, 'payroll finalization started');

    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const { generatePayslipPDF }  = await import('../services/pdf');
    const periodLabel = new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

    let processed = 0;
    const results: Array<{
      payroll_record_id: string;
      employee_id: string;
      employee_name: string;
      status: 'processed' | 'failed';
      notification_status: 'recorded' | 'queue_failed' | 'not_applicable';
      failure_code?: 'PAYSLIP_GENERATION_FAILED' | 'PAYROLL_RECORD_UPDATE_FAILED';
    }> = [];
    const failures: Array<{
      payroll_record_id: string;
      employee_id: string;
      employee_name: string;
      stage: 'payslip_generation' | 'payroll_record_update';
      code: 'PAYSLIP_GENERATION_FAILED' | 'PAYROLL_RECORD_UPDATE_FAILED';
    }> = [];
    const notificationQueueFailures: Array<{ payroll_record_id: string; employee_id: string; employee_name: string }> = [];

    for (const record of records) {
      let stage: 'payslip_generation' | 'payroll_record_update' = 'payslip_generation';
      try {
        // Generate PDF payslip
        const { key } = await generatePayslipPDF({
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
            payBasis:      record.pay_basis as 'hourly' | 'daily' | 'monthly',
            payRateAmount: Number(record.pay_rate_amount),
            monthlyDivisor: record.pay_monthly_divisor,
            basePay:       Number(record.base_pay),
            overtimePay:   Number(record.overtime_pay),
          },
          deductions: {
            unpaidDays:      record.unpaid_deduction ? Math.round(Number(record.unpaid_deduction) / (Number(record.hourly_rate) * 8)) : 0,
            unpaidDeduction: Number(record.unpaid_deduction),
            manualAdjustment: Number(record.manual_adjustment),
            incomeTax: Number(record.tax_deduction),
            pension: Number(record.pension_deduction),
            employeeStatutory: Array.isArray(record.employee_statutory_deductions) ? record.employee_statutory_deductions as Array<{ label: string; amount: number }> : [],
          },
          employerStatutory: Array.isArray(record.employer_statutory_contributions) ? record.employer_statutory_contributions as Array<{ label: string; amount: number }> : [],
          grossPay:    Number(record.gross_pay),
          netPay:      Number(record.net_pay),
          processedAt: new Date(),
          processedBy: req.user!.name,
        });

        // Update record with payslip URL
        stage = 'payroll_record_update';
        await prisma.payrollRecord.update({
          where: { id: record.id },
          data: { status: 'processed', processed_at: new Date(), processed_by: req.user!.sub, payslip_url: key },
        });

        processed++;

        // The notification router persists channel deliveries independently and
        // retries provider failures. A queue-write failure is reported without
        // changing the already-finalized payroll record.
        let notificationRecorded = false;
        try {
          notificationRecorded = await createNotification({
            userId: record.user.id,
            orgId: req.user!.org_id,
            type: 'payslip_ready',
            title: 'Your payslip is ready',
            body: `Your payslip for ${periodLabel} is available in Attenda under Profile → Payslips.`,
            actionType: 'payslip_ready',
            actionId: record.id,
            dedupeKey: record.id,
          });
        } catch (err) {
          logger.error({ err, orgId: req.user!.org_id, payrollRecordId: record.id }, 'payslip notification enqueue failed');
        }
        if (!notificationRecorded) {
          notificationQueueFailures.push({ payroll_record_id: record.id, employee_id: record.user.id, employee_name: record.user.name });
          logger.error({ orgId: req.user!.org_id, actorId: req.user!.sub, payrollRecordId: record.id }, 'payslip notification could not be queued');
        }
        results.push({
          payroll_record_id: record.id,
          employee_id: record.user.id,
          employee_name: record.user.name,
          status: 'processed',
          notification_status: notificationRecorded ? 'recorded' : 'queue_failed',
        });
      } catch (err) {
        logger.error({ err, orgId: req.user!.org_id, actorId: req.user!.sub, payrollRecordId: record.id, year: y, month: m }, 'payroll record finalization failed');
        failures.push({
          payroll_record_id: record.id,
          employee_id: record.user.id,
          employee_name: record.user.name,
          stage,
          code: stage === 'payslip_generation' ? 'PAYSLIP_GENERATION_FAILED' : 'PAYROLL_RECORD_UPDATE_FAILED',
        });
        results.push({
          payroll_record_id: record.id,
          employee_id: record.user.id,
          employee_name: record.user.name,
          status: 'failed',
          notification_status: 'not_applicable',
          failure_code: stage === 'payslip_generation' ? 'PAYSLIP_GENERATION_FAILED' : 'PAYROLL_RECORD_UPDATE_FAILED',
        });
      }
    }

    const status = failures.length || notificationQueueFailures.length
      ? (processed > 0 ? 'partial' : 'failed')
      : 'completed';

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'payroll.process', entityType: 'payroll_run', entityId: `${y}-${String(m).padStart(2, '0')}`,
      after: { status, processed, failures, notification_queue_failures: notificationQueueFailures },
    });
    logger.info({ orgId: req.user!.org_id, actorId: req.user!.sub, year: y, month: m, status, processed, failedCount: failures.length, notificationQueueFailureCount: notificationQueueFailures.length }, 'payroll finalization completed');
    ok(res, {
      status,
      processed,
      results,
      failed: failures,
      notification_queue_failures: notificationQueueFailures,
      month: m,
      year: y,
      message: status === 'completed'
        ? `Payroll processed for all ${processed} employees.`
        : `Payroll processed for ${processed} employees; ${failures.length} records and ${notificationQueueFailures.length} notification queues need attention.`,
    });
  } catch (e) { next(e); }
  finally { await releaseLease?.().catch(() => {}); }
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
