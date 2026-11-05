import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { idempotency } from '../middleware/idempotency';
import { leaveRequestSchema } from '../schemas';
import { ok, paginated, NotFoundError, ForbiddenError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';
import { emitOrgEvent } from '../services/notifications';
import { decodeCursor, encodeCursor, keysetAfter } from '../utils/cursor';
import { getLeaveLedgerBalances, setLeaveLedgerContext } from '../services/leaveLedger';
import { holidaySetForRange } from '../services/holidays';

const router = Router();
router.use(authenticate);

const LEAVE_INCLUDE = {
  user: { select: { id: true, name: true, avatar_url: true, department: true, email: true } },
  reviewer: { select: { id: true, name: true } },
  location: { select: { id: true, name: true, timezone: true } },
} as const;

// ─── GET /leave/requests/me ────────────────────────────
router.get('/requests/me', async (req, res, next) => {
  try {
    const where = { user_id: req.user!.sub };
    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string';
    if (cursorMode) {
      const parsedLimit = Number.parseInt(String(req.query.limit ?? '25'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 25;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const position = cursor ? decodeCursor(cursor, where) : null;
      if (cursor && !position) {
        const anchor = await prisma.leaveRequest.findFirst({ where: { ...where, id: cursor }, select: { id: true } });
        if (!anchor) throw new ValidationError('Invalid leave-request cursor');
      }
      const rows = await prisma.leaveRequest.findMany({
        where: position ? { ...where, AND: [keysetAfter(position, 'created_at')] } : where,
        ...(!position && cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: LEAVE_INCLUDE, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, where) : null, has_more: hasMore, limit });
      return;
    }
    const requests = await prisma.leaveRequest.findMany({
      where,
      include: LEAVE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    ok(res, requests);
  } catch (e) { next(e); }
});

// ─── GET /leave/requests/team ──────────────────────────
router.get('/requests/team', requirePermission('leave.view_team', 'leave.approve'), async (req, res, next) => {
  try {
    const team = await prisma.user.findMany({
      where: { manager_id: req.user!.sub, is_active: true, org_id: req.user!.org_id },
      select: { id: true },
    });
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw new ValidationError('Invalid leave request status');
    const where = { org_id: req.user!.org_id, user_id: { in: team.map(u => u.id) }, ...(status ? { status } : {}) };
    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string';
    if (cursorMode) {
      const parsedLimit = Number.parseInt(String(req.query.limit ?? '25'), 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 25;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const position = cursor ? decodeCursor(cursor, where) : null;
      if (cursor && !position) {
        const anchor = await prisma.leaveRequest.findFirst({ where: { ...where, id: cursor }, select: { id: true } });
        if (!anchor) throw new ValidationError('Invalid leave-request cursor');
      }
      const rows = await prisma.leaveRequest.findMany({
        where: position ? { ...where, AND: [keysetAfter(position, 'created_at')] } : where,
        ...(!position && cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: LEAVE_INCLUDE, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, where) : null, has_more: hasMore, limit });
      return;
    }
    const requests = await prisma.leaveRequest.findMany({
      where,
      include: LEAVE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    ok(res, requests);
  } catch (e) { next(e); }
});

// ─── GET /leave/requests ───────────────────────────────
router.get('/requests', requirePermission('leave.view_all'), async (req, res, next) => {
  try {
    const { status, department, q, page, limit, sort, order } = req.query as Record<string, string>;
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (status) where.status = status;
    if (department) {
      const deptUsers = await prisma.user.findMany({ where: { org_id: req.user!.org_id, department }, select: { id: true } });
      where.user_id = { in: deptUsers.map(u => u.id) };
    }
    if (q) where.user = { name: { contains: q, mode: 'insensitive' } };

    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string';
    if (cursorMode) {
      const parsedLimit = Number.parseInt(String(req.query.limit ?? '25'), 10);
      const cursorLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 25;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
      const position = cursor ? decodeCursor(cursor, where) : null;
      if (cursor && !position) {
        const anchor = await prisma.leaveRequest.findFirst({ where: { ...where, id: cursor }, select: { id: true } });
        if (!anchor) throw new ValidationError('Invalid leave-request cursor');
      }
      const rows = await prisma.leaveRequest.findMany({
        where: position ? { ...where, AND: [keysetAfter(position, 'created_at')] } : where,
        ...(!position && cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: LEAVE_INCLUDE,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: cursorLimit + 1,
      });
      const hasMore = rows.length > cursorLimit;
      const items = hasMore ? rows.slice(0, cursorLimit) : rows;
      const last = items[items.length - 1];
      ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, where) : null, has_more: hasMore, limit: cursorLimit });
      return;
    }

    const SORTABLE = new Set(['created_at', 'start_date', 'end_date', 'status', 'leave_type']);
    const orderBy = { [SORTABLE.has(sort) ? sort : 'created_at']: order === 'asc' ? 'asc' as const : 'desc' as const };

    // Pagination is opt-in: without page/limit the full list is returned,
    // matching what existing clients expect.
    if (page || limit) {
      const pg = Math.max(1, parseInt(page || '1'));
      const lm = Math.min(100, Math.max(1, parseInt(limit || '25')));
      const [requests, total] = await Promise.all([
        prisma.leaveRequest.findMany({ where, include: LEAVE_INCLUDE, orderBy, skip: (pg - 1) * lm, take: lm }),
        prisma.leaveRequest.count({ where }),
      ]);
      paginated(res, requests, total, pg, lm);
      return;
    }

    const requests = await prisma.leaveRequest.findMany({ where, include: LEAVE_INCLUDE, orderBy });
    ok(res, requests);
  } catch (e) { next(e); }
});

// ─── POST /leave/requests ──────────────────────────────
// Supports both full-day and half-day leave:
//   is_half_day: true + half_day_period: 'morning'|'afternoon'
//   → start_date = end_date (single day), working_days = 0.5
router.post('/requests', idempotency, validate({ body: leaveRequestSchema }), async (req, res, next) => {
  try {
    const { submitLeaveRequest } = await import('../services/leave-request');
    const request = await submitLeaveRequest(req.user!.sub, req.user!.org_id, req.body);
    ok(res, request, 201);
  } catch (error) { next(error); }
});

// ─── DELETE /leave/requests/:id ────────────────────────
router.delete('/requests/:id', idempotency, async (req, res, next) => {
  try {
    const request = await prisma.leaveRequest.findFirst({
      where: { id: String(req.params.id), user_id: req.user!.sub },
    });
    if (!request) throw new NotFoundError('Leave request');
    if (request.status !== 'pending') throw new ValidationError('Only pending requests can be cancelled');
    await prisma.leaveRequest.update({ where: { id: String(req.params.id) }, data: { status: 'cancelled' } });
    ok(res, { message: 'Leave request cancelled' });
  } catch (e) { next(e); }
});

// ─── PUT /leave/requests/:id/approve ──────────────────
router.put('/requests/:id/approve', requirePermission('leave.approve'), idempotency, async (req, res, next) => {
  try {
    const request = await prisma.leaveRequest.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, status: 'pending' },
    });
    if (!request) throw new NotFoundError('Leave request');

    // Approvers without org-wide leave access may only review their direct reports
    if (!req.permissions?.has('leave.view_all')) {
      const requester = await prisma.user.findFirst({
        where: { id: request.user_id, org_id: req.user!.org_id, manager_id: req.user!.sub },
        select: { id: true },
      });
      if (!requester) throw new ForbiddenError('You can only approve leave for your direct reports');
    }

    const holidays = await holidaySetForRange(request.org_id, request.start_date, request.end_date, request.location_id);
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.leaveRequest.updateMany({
        where: { id: String(req.params.id), org_id: req.user!.org_id, status: 'pending' },
        data: { status: 'approved', reviewed_by: req.user!.sub, reviewed_at: new Date() },
      });
      if (!claimed.count) throw new ValidationError('This request has already been reviewed');
      await setLeaveLedgerContext(tx, { reason: 'usage', refId: request.id, actorId: req.user!.sub, note: 'Approved leave request' });
      // Deduct from leave balance
      await tx.leaveBalance.updateMany({
        where: { user_id: request.user_id, leave_type: request.leave_type, year: request.start_date.getUTCFullYear() },
        data: { used_days: { increment: request.working_days } },
      });
      // Update attendance records to 'leave'.
      // For half-day/timed leave: only set status='half_leave' — the employee
      // is expected to check in for the remaining shift window.
      const isPartialLeave = request.is_half_day || !!request.leave_start_time;
      const leaveStatus = isPartialLeave ? 'half_leave' : 'leave';
      const cur = new Date(request.start_date);
      while (cur <= request.end_date) {
        const dateKey = cur.toISOString().slice(0, 10);
        if (cur.getUTCDay() !== 0 && cur.getUTCDay() !== 6 && !holidays.has(dateKey)) {
          // For half-day: if the record already has a check-in (employee worked
          // one half), preserve the check-in data but update status only
          const existingRecord = await tx.attendanceRecord.findUnique({
            where: { user_id_date: { user_id: request.user_id, date: new Date(cur) } },
          });
          if (isPartialLeave && existingRecord?.check_in_at) {
            // Employee already checked in — just note the half-leave on the record
            await tx.attendanceRecord.update({
              where: { id: existingRecord.id },
              data: { status: leaveStatus },
            });
          } else {
            await tx.attendanceRecord.upsert({
              where: { user_id_date: { user_id: request.user_id, date: new Date(cur) } },
              update: { status: leaveStatus },
              create: {
                user_id: request.user_id, org_id: req.user!.org_id,
                date: new Date(cur), check_in_type: 'manual', status: leaveStatus,
              },
            });
          }
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    });

    const updated = await prisma.leaveRequest.findUnique({ where: { id: String(req.params.id) }, include: LEAVE_INCLUDE });

    // Email + WhatsApp notification
    if (updated?.user) {
      const dates = `${updated.start_date.toDateString()} – ${updated.end_date.toDateString()}`;
      const reviewer = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { name: true } });
      const { sendLeaveApprovedEmail } = await import('../services/email');
      await sendLeaveApprovedEmail(updated.user.email, updated.user.name, updated.leave_type, dates, reviewer?.name || 'Your manager').catch(console.error);

      // WhatsApp to employee (if phone configured)
      const employee = await prisma.user.findUnique({ where: { id: updated.user.id }, select: { phone: true } });
      if (employee?.phone) {
        const { notifyLeaveApproved } = await import('../services/whatsapp');
        await notifyLeaveApproved(req.user!.org_id, updated.user.name, updated.leave_type, dates, employee.phone).catch(console.error);
      }

      // In-app notification to employee
      const { createNotification } = await import('../services/notifications');
      createNotification({
        userId: updated.user.id, orgId: req.user!.org_id,
        type: 'leave_approved',
        title: 'Leave approved',
        body: `Your ${updated.leave_type} leave (${dates}) has been approved`,
        actionType: 'leave_request', actionId: updated.id,
      }).catch(console.error);
    }
    emitOrgEvent(req.user!.org_id, 'leave_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PUT /leave/requests/:id/reject ───────────────────
router.put('/requests/:id/reject', requirePermission('leave.approve'), idempotency, async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) throw new ValidationError('Rejection reason required');

    const request = await prisma.leaveRequest.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id, status: 'pending' },
    });
    if (!request) throw new NotFoundError('Leave request');

    // Approvers without org-wide leave access may only review their direct reports
    if (!req.permissions?.has('leave.view_all')) {
      const requester = await prisma.user.findFirst({
        where: { id: request.user_id, org_id: req.user!.org_id, manager_id: req.user!.sub },
        select: { id: true },
      });
      if (!requester) throw new ForbiddenError('You can only reject leave for your direct reports');
    }

    const updated = await prisma.leaveRequest.update({
      where: { id: String(req.params.id) },
      data: { status: 'rejected', reviewed_by: req.user!.sub, reviewed_at: new Date(), rejection_reason: reason },
      include: LEAVE_INCLUDE,
    });

    // Email + WhatsApp notification to employee
    if (updated?.user) {
      const dates = `${updated.start_date.toDateString()} – ${updated.end_date.toDateString()}`;
      const { sendLeaveRejectedEmail } = await import('../services/email');
      await sendLeaveRejectedEmail(updated.user.email, updated.user.name, updated.leave_type, dates, reason).catch(console.error);

      const employee = await prisma.user.findUnique({ where: { id: updated.user.id }, select: { phone: true } });
      if (employee?.phone) {
        const { notifyLeaveRejected } = await import('../services/whatsapp');
        notifyLeaveRejected(req.user!.org_id, updated.user.name, updated.leave_type, dates, reason, employee.phone).catch(console.error);
      }

      // In-app notification to employee
      const { createNotification } = await import('../services/notifications');
      createNotification({
        userId: updated.user.id, orgId: req.user!.org_id,
        type: 'leave_rejected',
        title: 'Leave rejected',
        body: `Your ${updated.leave_type} leave (${dates}) was rejected: ${reason}`,
        actionType: 'leave_request', actionId: updated.id,
      }).catch(console.error);
    }

    emitOrgEvent(req.user!.org_id, 'leave_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /leave/balance/me ─────────────────────────────
router.get('/balance/me', async (req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const balances = await getLeaveLedgerBalances({ userId: req.user!.sub, orgId: req.user!.org_id, year });

    // Annotate rows with the org's accrual policy (additive — clients that
    // don't know the field ignore it) so employees can see how balances grow.
    const { parseAccrualConfig, monthlyIncrement, toDays, availableDays } = await import('../services/leaveAccrual');
    const org = await prisma.organisation.findUnique({
      where: { id: req.user!.org_id },
      select: { leave_accrual: true },
    });
    const accrual = parseAccrualConfig(org?.leave_accrual);
    const annotated = balances.map(b => {
      const policy = accrual?.[b.leave_type];
      // Decimal columns serialize as strings — clients expect numbers
      const row = { ...b, total_days: toDays(b.total_days), used_days: toDays(b.used_days), available_days: availableDays(b.total_days, b.used_days) };
      return policy
        ? { ...row, accrual: { days_per_year: policy.days_per_year, monthly: monthlyIncrement(policy), carry_over_max: policy.carry_over_max ?? 0 } }
        : row;
    });
    ok(res, annotated);
  } catch (e) { next(e); }
});

// ─── GET /leave/balance/:userId ────────────────────────
router.get('/balance/me/ledger', async (req, res, next) => {
  try {
    const parsedYear = Number.parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
    const year = Number.isFinite(parsedYear) ? parsedYear : new Date().getFullYear();
    const leaveType = typeof req.query.leave_type === 'string' ? req.query.leave_type : undefined;
    const limitValue = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 50;
    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { org_id: req.user!.org_id, user_id: req.user!.sub, year, ...(leaveType ? { leave_type: leaveType } : {}) },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit,
    });
    ok(res, { items: entries, limit, year });
  } catch (e) { next(e); }
});

router.get('/balance/:userId/ledger', requirePermission('leave.view_team', 'leave.balance.manage', 'leave.view_all'), async (req, res, next) => {
  try {
    const userId = String(req.params.userId);
    const target = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id, deleted_at: null }, select: { id: true, manager_id: true } });
    if (!target) throw new NotFoundError('User');
    const canManageAll = req.permissions?.has('leave.balance.manage') || req.permissions?.has('leave.view_all');
    if (!canManageAll && target.manager_id !== req.user!.sub) throw new ForbiddenError('You can only view leave history for your direct reports');
    const parsedYear = Number.parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
    const year = Number.isFinite(parsedYear) ? parsedYear : new Date().getFullYear();
    const leaveType = typeof req.query.leave_type === 'string' ? req.query.leave_type : undefined;
    const limitValue = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(100, limitValue)) : 50;
    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { org_id: req.user!.org_id, user_id: userId, year, ...(leaveType ? { leave_type: leaveType } : {}) },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit,
    });
    ok(res, { items: entries, limit, year });
  } catch (e) { next(e); }
});

router.get('/balance/:userId', requirePermission('leave.view_team', 'leave.balance.manage'), async (req, res, next) => {
  try {
    const year = parseInt((req.query.year as string) || String(new Date().getFullYear()));
    const targetUser = await prisma.user.findFirst({
      where: { id: String(req.params.userId), org_id: req.user!.org_id },
    });
    if (!targetUser) throw new NotFoundError('User');
    const balances = await getLeaveLedgerBalances({ userId: String(req.params.userId), orgId: req.user!.org_id, year });
    ok(res, balances.map(balance => ({ ...balance, available_days: Math.round((balance.total_days - balance.used_days) * 100) / 100 })));
  } catch (e) { next(e); }
});

// ─── PUT /leave/balance/:userId ────────────────────────
router.put('/balance/:userId', requirePermission('leave.balance.manage'), idempotency, async (req, res, next) => {
  try {
    const { leave_type, adjustment, reason } = req.body;
    if (!leave_type || adjustment === undefined || !reason) throw new ValidationError('leave_type, adjustment and reason required');
    const adj = Number(adjustment);
    if (!Number.isFinite(adj)) throw new ValidationError('adjustment must be a number');

    // Org scoping: the target user must belong to the caller's org
    const targetUser = await prisma.user.findFirst({
      where: { id: String(req.params.userId), org_id: req.user!.org_id },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundError('User');

    const year = new Date().getFullYear();
    const balance = await prisma.leaveBalance.findFirst({
      where: { user_id: String(req.params.userId), org_id: req.user!.org_id, leave_type, year },
    });
    if (!balance) throw new NotFoundError('Leave balance');

    const { toDays } = await import('../services/leaveAccrual');
    const updated = await prisma.$transaction(async tx => {
      await setLeaveLedgerContext(tx, { reason: 'adjustment', note: String(reason), actorId: req.user!.sub });
      return tx.leaveBalance.update({ where: { id: balance.id }, data: { total_days: { increment: adj } } });
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'leave.balance.update', entityType: 'leave_balance', entityId: balance.id,
      before: { total_days: toDays(balance.total_days) },
      after: { total_days: toDays(updated.total_days), adjustment: adj },
      reason,
    });
    ok(res, { ...updated, total_days: toDays(updated.total_days), used_days: toDays(updated.used_days) });
  } catch (e) { next(e); }
});

// ─── GET /leave/calendar ──────────────────────────────
router.get('/calendar', requirePermission('leave.view_team', 'leave.view_all'), async (req, res, next) => {
  try {
    const { month, year } = req.query as { month?: string; year?: string };
    const m = parseInt(month || String(new Date().getMonth() + 1));
    const y = parseInt(year  || String(new Date().getFullYear()));

    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m, 0);

    const requests = await prisma.leaveRequest.findMany({
      where: {
        org_id: req.user!.org_id,
        status: 'approved',
        start_date: { lte: end },
        end_date:   { gte: start },
      },
      include: LEAVE_INCLUDE,
    });
    ok(res, requests);
  } catch (e) { next(e); }
});

export default router;
