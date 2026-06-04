// @ts-nocheck
import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { ok, NotFoundError, ForbiddenError, ValidationError } from '../utils/response';
import { calculateWorkingDays } from '../utils/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

const LEAVE_INCLUDE = {
  user: { select: { id: true, name: true, avatar_url: true, department: true } },
  reviewer: { select: { id: true, name: true } },
};

// ─── GET /leave/requests/me ────────────────────────────
router.get('/requests/me', async (req, res, next) => {
  try {
    const requests = await prisma.leaveRequest.findMany({
      where: { user_id: req.user!.sub },
      include: LEAVE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    ok(res, requests);
  } catch (e) { next(e); }
});

// ─── GET /leave/requests/team ──────────────────────────
router.get('/requests/team', requireRole('manager'), async (req, res, next) => {
  try {
    const team = await prisma.user.findMany({
      where: { manager_id: req.user!.sub, is_active: true, org_id: req.user!.org_id },
      select: { id: true },
    });
    const requests = await prisma.leaveRequest.findMany({
      where: { user_id: { in: team.map(u => u.id) } },
      include: LEAVE_INCLUDE,
      orderBy: { created_at: 'desc' },
    });
    ok(res, requests);
  } catch (e) { next(e); }
});

// ─── GET /leave/requests ───────────────────────────────
router.get('/requests', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { status, department } = req.query as Record<string, string>;
    const where: Record<string, unknown> = { org_id: req.user!.org_id };
    if (status) where.status = status;
    if (department) {
      const deptUsers = await prisma.user.findMany({ where: { org_id: req.user!.org_id, department }, select: { id: true } });
      where.user_id = { in: deptUsers.map(u => u.id) };
    }
    const requests = await prisma.leaveRequest.findMany({ where, include: LEAVE_INCLUDE, orderBy: { created_at: 'desc' } });
    ok(res, requests);
  } catch (e) { next(e); }
});

// ─── POST /leave/requests ──────────────────────────────
// Supports both full-day and half-day leave:
//   is_half_day: true + half_day_period: 'morning'|'afternoon'
//   → start_date = end_date (single day), working_days = 0.5
router.post('/requests', async (req, res, next) => {
  try {
    const { leave_type, start_date, end_date, reason, is_half_day, half_day_period, leave_start_time, leave_end_time } = req.body;
    if (!leave_type || !start_date || !end_date) throw new ValidationError('leave_type, start_date and end_date required');

    const start = new Date(start_date);
    const end   = new Date(end_date);
    if (start > end) throw new ValidationError('start_date must be before end_date');
    if (start < new Date(new Date().setHours(0, 0, 0, 0))) throw new ValidationError('Cannot request leave in the past');

    // Half-day validation
    if (is_half_day) {
      if (start_date !== end_date) throw new ValidationError('Half-day leave must be on a single day (start_date = end_date)');
      if (!half_day_period || !['morning', 'afternoon'].includes(half_day_period)) {
        throw new ValidationError('half_day_period must be "morning" or "afternoon" for half-day leave');
      }
    }

    const hasTimeWindow = !!leave_start_time || !!leave_end_time;
    if (hasTimeWindow) {
      if (!leave_start_time || !leave_end_time) throw new ValidationError('leave_start_time and leave_end_time must both be provided');
      if (start_date !== end_date) throw new ValidationError('Mid-shift leave must be on a single day');
      if (!/^\d{1,2}:\d{2}$/.test(leave_start_time) || !/^\d{1,2}:\d{2}$/.test(leave_end_time)) {
        throw new ValidationError('leave_start_time and leave_end_time must be HH:MM');
      }
      const toMins = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      };
      if (toMins(leave_end_time) <= toMins(leave_start_time)) {
        throw new ValidationError('leave_end_time must be after leave_start_time');
      }
    }

    const working_days = hasTimeWindow
      ? Math.max(0.1, Math.round((((leave_end_time.split(':').map(Number)[0] * 60 + leave_end_time.split(':').map(Number)[1]) - (leave_start_time.split(':').map(Number)[0] * 60 + leave_start_time.split(':').map(Number)[1])) / (8 * 60)) * 100) / 100)
      : is_half_day ? 0.5 : calculateWorkingDays(start, end);

    // Check leave balance (skip for unpaid leave)
    if (leave_type !== 'unpaid') {
      const year    = start.getFullYear();
      const balance = await prisma.leaveBalance.findFirst({
        where: { user_id: req.user!.sub, leave_type, year },
      });
      if (balance) {
        const available = balance.total_days - balance.used_days;
        if (working_days > available) {
          throw new ValidationError(`Insufficient ${leave_type} leave balance. Available: ${available} days, requested: ${working_days} days`);
        }
      }
    }

    // Check no overlapping approved leave (full-day overlaps; half-days on same day with different periods can coexist)
    const overlapWhere: Record<string, unknown> = {
      user_id: req.user!.sub, status: { in: ['pending', 'approved'] },
      start_date: { lte: end }, end_date: { gte: start },
    };
    if (is_half_day) {
      // Allow a half-day on the same date as another half-day with a different period
      overlapWhere.OR = [
        { is_half_day: false },
        { is_half_day: true, half_day_period: half_day_period },
      ];
    }
    const overlap = await prisma.leaveRequest.findFirst({ where: overlapWhere });
    if (overlap) throw new ValidationError('You already have a leave request that overlaps with these dates');

    const request = await prisma.leaveRequest.create({
      data: {
        user_id: req.user!.sub, org_id: req.user!.org_id,
        leave_type, start_date: start, end_date: end, working_days, reason,
        is_half_day: !!is_half_day,
        ...(is_half_day && { half_day_period }),
        ...(hasTimeWindow && { leave_start_time, leave_end_time }),
      },
      include: LEAVE_INCLUDE,
    });

    // Notify manager (in-app)
    const submitter = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { name: true, manager_id: true } });
    if (submitter?.manager_id) {
      const label = hasTimeWindow
        ? `${leave_type} leave from ${leave_start_time} to ${leave_end_time}`
        : is_half_day ? `a half-day (${half_day_period}) of ${leave_type}` : `${working_days} day(s) of ${leave_type}`;
      const { createNotification } = await import('../services/notifications');
      createNotification({
        userId: submitter.manager_id, orgId: req.user!.org_id,
        type: 'leave_request',
        title: 'New leave request',
        body: `${submitter.name} has requested ${label} leave`,
        actionType: 'leave_request', actionId: request.id,
      }).catch(console.error);
    }

    ok(res, request, 201);
  } catch (e) { next(e); }
});

// ─── DELETE /leave/requests/:id ────────────────────────
router.delete('/requests/:id', async (req, res, next) => {
  try {
    const request = await prisma.leaveRequest.findFirst({
      where: { id: req.params.id, user_id: req.user!.sub },
    });
    if (!request) throw new NotFoundError('Leave request');
    if (request.status !== 'pending') throw new ValidationError('Only pending requests can be cancelled');
    await prisma.leaveRequest.update({ where: { id: req.params.id }, data: { status: 'cancelled' } });
    ok(res, { message: 'Leave request cancelled' });
  } catch (e) { next(e); }
});

// ─── PUT /leave/requests/:id/approve ──────────────────
router.put('/requests/:id/approve', requireRole('manager'), async (req, res, next) => {
  try {
    const request = await prisma.leaveRequest.findFirst({
      where: { id: req.params.id, org_id: req.user!.org_id, status: 'pending' },
    });
    if (!request) throw new NotFoundError('Leave request');

    await prisma.$transaction(async (tx) => {
      await tx.leaveRequest.update({
        where: { id: req.params.id },
        data: { status: 'approved', reviewed_by: req.user!.sub, reviewed_at: new Date() },
      });
      // Deduct from leave balance
      await tx.leaveBalance.updateMany({
        where: { user_id: request.user_id, leave_type: request.leave_type, year: request.start_date.getFullYear() },
        data: { used_days: { increment: request.working_days } },
      });
      // Update attendance records to 'leave'.
      // For half-day/timed leave: only set status='half_leave' — the employee
      // is expected to check in for the remaining shift window.
      const isPartialLeave = request.is_half_day || !!request.leave_start_time;
      const leaveStatus = isPartialLeave ? 'half_leave' : 'leave';
      const cur = new Date(request.start_date);
      while (cur <= request.end_date) {
        if (cur.getDay() !== 0 && cur.getDay() !== 6) {
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
        cur.setDate(cur.getDate() + 1);
      }
    });

    const updated = await prisma.leaveRequest.findUnique({ where: { id: req.params.id }, include: LEAVE_INCLUDE });

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
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PUT /leave/requests/:id/reject ───────────────────
router.put('/requests/:id/reject', requireRole('manager'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) throw new ValidationError('Rejection reason required');

    const request = await prisma.leaveRequest.findFirst({
      where: { id: req.params.id, org_id: req.user!.org_id, status: 'pending' },
    });
    if (!request) throw new NotFoundError('Leave request');

    const updated = await prisma.leaveRequest.update({
      where: { id: req.params.id },
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

    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /leave/balance/me ─────────────────────────────
router.get('/balance/me', async (req, res, next) => {
  try {
    const year = new Date().getFullYear();
    const balances = await prisma.leaveBalance.findMany({
      where: { user_id: req.user!.sub, year },
    });
    ok(res, balances);
  } catch (e) { next(e); }
});

// ─── GET /leave/balance/:userId ────────────────────────
router.get('/balance/:userId', requireRole('manager'), async (req, res, next) => {
  try {
    const year = parseInt((req.query.year as string) || String(new Date().getFullYear()));
    const targetUser = await prisma.user.findFirst({
      where: { id: req.params.userId, org_id: req.user!.org_id },
    });
    if (!targetUser) throw new NotFoundError('User');
    const balances = await prisma.leaveBalance.findMany({
      where: { user_id: req.params.userId, year },
    });
    ok(res, balances);
  } catch (e) { next(e); }
});

// ─── PUT /leave/balance/:userId ────────────────────────
router.put('/balance/:userId', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { leave_type, adjustment, reason } = req.body;
    if (!leave_type || adjustment === undefined || !reason) throw new ValidationError('leave_type, adjustment and reason required');

    const year = new Date().getFullYear();
    const balance = await prisma.leaveBalance.findFirst({
      where: { user_id: req.params.userId, leave_type, year },
    });
    if (!balance) throw new NotFoundError('Leave balance');

    const updated = await prisma.leaveBalance.update({
      where: { id: balance.id },
      data: { total_days: balance.total_days + adjustment },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /leave/calendar ──────────────────────────────
router.get('/calendar', requireRole('manager'), async (req, res, next) => {
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
