import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { expenseClaimSchema, expenseReviewSchema, expenseReimburseSchema } from '../schemas';
import { ok, created, NotFoundError, ValidationError, AppError } from '../utils/response';
import { recalcPayrollTotals } from '../utils/payroll';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { createNotification, emitOrgEvent } from '../services/notifications';

/**
 * Employee expense claims: employee submits amount + category + receipt →
 * manager/HR with expenses.manage approves or rejects → an approved claim is
 * reimbursed by adding its amount to the claimant's payroll record
 * manual_adjustment for a chosen period (same math as PUT /payroll/:id/adjust,
 * audited on both sides). Mounted at /expenses.
 */

const router = Router();
router.use(authenticate);

const EXPENSE_INCLUDE = {
  user:     { select: { id: true, name: true, avatar_url: true, department: true } },
  reviewer: { select: { id: true, name: true } },
} as const;

const EXPENSE_STATUSES = ['pending', 'approved', 'rejected', 'reimbursed'] as const;

// ─── POST /expenses ────────────────────────────────────
router.post('/', validate({ body: expenseClaimSchema }), async (req, res, next) => {
  try {
    const { amount, currency, category, description, expense_date, receipt_url } = req.body;

    const day = new Date(`${expense_date}T00:00:00.000Z`);
    if (isNaN(day.getTime())) throw new ValidationError('Invalid expense_date');
    if (day > new Date()) throw new ValidationError('expense_date cannot be in the future');

    const org = await prisma.organisation.findUnique({
      where: { id: req.user!.org_id },
      select: { currency: true },
    });

    const claim = await prisma.expenseClaim.create({
      data: {
        user_id: req.user!.sub, org_id: req.user!.org_id,
        amount, currency: currency || org?.currency || 'USD',
        category, description, expense_date: day,
        receipt_url: receipt_url ?? null,
      },
      include: EXPENSE_INCLUDE,
    });

    // Notify the manager (falls back silently when the user has none —
    // approvers see the queue via GET /expenses).
    const submitter = await prisma.user.findUnique({
      where: { id: req.user!.sub },
      select: { name: true, manager_id: true },
    });
    if (submitter?.manager_id) {
      createNotification({
        userId: submitter.manager_id, orgId: req.user!.org_id,
        type: 'expense_request',
        title: 'Expense claim submitted',
        body: `${submitter.name} claimed ${claim.currency} ${Number(claim.amount).toFixed(2)} for ${category}`,
        actionType: 'expense_claim', actionId: claim.id,
      }).catch(() => {});
    }
    emitOrgEvent(req.user!.org_id, 'expense_changed');
    created(res, claim);
  } catch (e) { next(e); }
});

// ─── GET /expenses/me ──────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const claims = await prisma.expenseClaim.findMany({
      where: { user_id: req.user!.sub },
      include: EXPENSE_INCLUDE,
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    ok(res, claims);
  } catch (e) { next(e); }
});

// ─── GET /expenses ─────────────────────────────────────
router.get('/', requirePermission('expenses.view'), async (req, res, next) => {
  try {
    const { status = 'pending' } = req.query as Record<string, string>;
    if (status !== 'all' && !EXPENSE_STATUSES.includes(status as typeof EXPENSE_STATUSES[number])) {
      throw new ValidationError(`status must be one of ${EXPENSE_STATUSES.join('|')}|all`);
    }
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (status !== 'all') where.status = status;

    const claims = await prisma.expenseClaim.findMany({
      where,
      include: EXPENSE_INCLUDE,
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    ok(res, claims);
  } catch (e) { next(e); }
});

async function loadClaim(id: string, orgId: string, expectedStatus: string) {
  const claim = await prisma.expenseClaim.findFirst({
    where: { id, org_id: orgId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!claim) throw new NotFoundError('Expense claim');
  if (claim.status !== expectedStatus) {
    throw new AppError(
      `Expense claim is '${claim.status}' — expected '${expectedStatus}'`,
      400, 'INVALID_STATUS',
    );
  }
  return claim;
}

// ─── PUT /expenses/:id/approve ─────────────────────────
router.put('/:id/approve', requirePermission('expenses.manage'), validate({ body: expenseReviewSchema }), async (req, res, next) => {
  try {
    const claim = await loadClaim(String(req.params.id), req.user!.org_id, 'pending');
    const note = req.body.note as string | undefined;

    const updated = await prisma.expenseClaim.update({
      where: { id: claim.id },
      data: { status: 'approved', reviewed_by: req.user!.sub, reviewed_at: new Date(), review_note: note ?? null },
      include: EXPENSE_INCLUDE,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'expense.approve', entityType: 'expense_claim', entityId: claim.id,
      before: { status: 'pending' },
      after: { status: 'approved', amount: claim.amount, currency: claim.currency, category: claim.category },
      reason: note ?? claim.description,
    });
    createNotification({
      userId: claim.user_id, orgId: req.user!.org_id,
      type: 'expense_approved',
      title: 'Expense claim approved',
      body: `Your ${claim.category} claim for ${claim.currency} ${Number(claim.amount).toFixed(2)} was approved`,
      actionType: 'expense_claim', actionId: claim.id,
    }).catch(() => {});
    emitOrgEvent(req.user!.org_id, 'expense_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PUT /expenses/:id/reject ──────────────────────────
router.put('/:id/reject', requirePermission('expenses.manage'), validate({ body: expenseReviewSchema }), async (req, res, next) => {
  try {
    const claim = await loadClaim(String(req.params.id), req.user!.org_id, 'pending');
    const note = req.body.note as string | undefined;

    const updated = await prisma.expenseClaim.update({
      where: { id: claim.id },
      data: { status: 'rejected', reviewed_by: req.user!.sub, reviewed_at: new Date(), review_note: note ?? null },
      include: EXPENSE_INCLUDE,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'expense.reject', entityType: 'expense_claim', entityId: claim.id,
      before: { status: 'pending' },
      after: { status: 'rejected' },
      reason: note ?? claim.description,
    });
    createNotification({
      userId: claim.user_id, orgId: req.user!.org_id,
      type: 'expense_rejected',
      title: 'Expense claim rejected',
      body: note ? `Your expense claim was rejected: ${note}` : 'Your expense claim was rejected',
      actionType: 'expense_claim', actionId: claim.id,
    }).catch(() => {});
    emitOrgEvent(req.user!.org_id, 'expense_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── POST /expenses/:id/reimburse ──────────────────────
// Adds the approved claim amount to the claimant's payroll record for the
// given period as a manual adjustment, recalculated with the exact same
// gross→tax→pension→net pipeline as PUT /payroll/:id/adjust.
router.post('/:id/reimburse', requirePermission('expenses.manage'), validate({ body: expenseReimburseSchema }), async (req, res, next) => {
  try {
    const { month, year } = req.body;
    const claim = await loadClaim(String(req.params.id), req.user!.org_id, 'approved');

    const record = await prisma.payrollRecord.findUnique({
      where: { user_id_period_month_period_year: { user_id: claim.user_id, period_month: month, period_year: year } },
    });
    if (!record || record.org_id !== req.user!.org_id) {
      throw new AppError(
        `No payroll record for ${claim.user.name} in ${month}/${year} — generate payroll for that period first`,
        404, 'NO_PAYROLL_RECORD',
      );
    }
    if (record.status === 'processed') {
      throw new AppError(
        'Payroll for that period is already processed — recall it first, then reimburse',
        400, 'LOCKED',
      );
    }

    const newAdjustment = Number(record.manual_adjustment) + Number(claim.amount);
    const reason = `Expense reimbursement: ${claim.category} (${claim.id})`;

    const org = await prisma.organisation.findUnique({
      where: { id: record.org_id },
      select: { tax_rate: true, pension_rate: true },
    });
    const totals = recalcPayrollTotals({
      regular_hours:     Number(record.regular_hours),
      overtime_hours:    Number(record.overtime_hours),
      hourly_rate:       Number(record.hourly_rate),
      unpaid_deduction:  Number(record.unpaid_deduction),
      manual_adjustment: newAdjustment,
    }, Number(org?.tax_rate) || 0, Number(org?.pension_rate) || 0);

    const updatedRecord = await prisma.payrollRecord.update({
      where: { id: record.id },
      data: {
        manual_adjustment: newAdjustment,
        adjustment_reason: reason,
        gross_pay:         totals.gross_pay,
        tax_deduction:     totals.tax_deduction,
        pension_deduction: totals.pension_deduction,
        net_pay:           totals.net_pay,
      },
    });

    const updatedClaim = await prisma.expenseClaim.update({
      where: { id: claim.id },
      data: { status: 'reimbursed', reimbursed_in_payroll_id: record.id },
      include: EXPENSE_INCLUDE,
    });

    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'expense.reimburse', entityType: 'expense_claim', entityId: claim.id,
      before: { status: 'approved' },
      after: { status: 'reimbursed', payroll_record_id: record.id, amount: claim.amount, currency: claim.currency },
      reason,
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'payroll.adjust', entityType: 'payroll_record', entityId: record.id,
      before: { manual_adjustment: record.manual_adjustment, gross_pay: record.gross_pay, net_pay: record.net_pay },
      after: { manual_adjustment: updatedRecord.manual_adjustment, gross_pay: updatedRecord.gross_pay, net_pay: updatedRecord.net_pay },
      reason,
    });
    createNotification({
      userId: claim.user_id, orgId: req.user!.org_id,
      type: 'expense_reimbursed',
      title: 'Expense reimbursed',
      body: `Your ${claim.category} claim for ${claim.currency} ${Number(claim.amount).toFixed(2)} will be paid with ${month}/${year} payroll`,
      actionType: 'expense_claim', actionId: claim.id,
    }).catch(() => {});
    emitOrgEvent(req.user!.org_id, 'expense_changed');
    ok(res, { claim: updatedClaim, payroll_record: updatedRecord });
  } catch (e) { next(e); }
});

export default router;
