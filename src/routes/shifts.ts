// @ts-nocheck
import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { ok, created, NotFoundError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

const ASSIGN_INCLUDE = {
  shift: true,
  user: { select: { id: true, name: true, avatar_url: true, department: true } },
};

// ─── GET /shifts ───────────────────────────────────────
router.get('/', requireRole('manager'), async (req, res, next) => {
  try {
    const shifts = await prisma.shift.findMany({
      where: { org_id: req.user!.org_id },
      include: { _count: { select: { assignments: true } } },
      orderBy: { name: 'asc' },
    });
    ok(res, shifts);
  } catch (e) { next(e); }
});

// ─── POST /shifts ──────────────────────────────────────
router.post('/', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { name, start_time, end_time, color, active_days } = req.body;
    if (!name || !start_time || !end_time) throw new ValidationError('name, start_time and end_time required');
    const shift = await prisma.shift.create({
      data: { org_id: req.user!.org_id, name, start_time, end_time, color: color || '#1D4ED8', active_days: active_days || [], created_by: req.user!.sub },
    });
    created(res, shift);
  } catch (e) { next(e); }
});

// ─── PUT /shifts/:id ───────────────────────────────────
router.put('/:id', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError('Shift');
    const { name, start_time, end_time, color, active_days } = req.body;
    const updated = await prisma.shift.update({ where: { id: req.params.id }, data: { name, start_time, end_time, color, active_days } });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /shifts/:id ────────────────────────────────
router.delete('/:id', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError('Shift');
    await prisma.shift.delete({ where: { id: req.params.id } });
    ok(res, { message: 'Shift template deleted' });
  } catch (e) { next(e); }
});

// ─── GET /shifts/schedule ──────────────────────────────
router.get('/schedule', requireRole('manager'), async (req, res, next) => {
  try {
    const { week_start } = req.query as { week_start?: string };
    const ws = week_start ? new Date(week_start) : (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1); return d; })();
    const we = new Date(ws); we.setDate(we.getDate() + 6);

    const assignments = await prisma.shiftAssignment.findMany({
      where: { date: { gte: ws, lte: we }, shift: { org_id: req.user!.org_id } },
      include: ASSIGN_INCLUDE,
      orderBy: { date: 'asc' },
    });
    ok(res, assignments);
  } catch (e) { next(e); }
});

// ─── GET /shifts/assignments ───────────────────────────
router.get('/assignments', requireRole('manager'), async (req, res, next) => {
  try {
    const { week_start, department } = req.query as Record<string, string>;
    const ws = week_start ? new Date(week_start) : (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1); return d; })();
    const we = new Date(ws); we.setDate(we.getDate() + 6);

    const where: Record<string, unknown> = { date: { gte: ws, lte: we }, shift: { org_id: req.user!.org_id } };
    if (department) {
      const users = await prisma.user.findMany({ where: { org_id: req.user!.org_id, department }, select: { id: true } });
      where.user_id = { in: users.map(u => u.id) };
    }

    const assignments = await prisma.shiftAssignment.findMany({ where, include: ASSIGN_INCLUDE, orderBy: { date: 'asc' } });
    ok(res, assignments);
  } catch (e) { next(e); }
});

// ─── POST /shifts/assignments ──────────────────────────
router.post('/assignments', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { user_id, shift_id, date } = req.body;
    if (!user_id || !shift_id || !date) throw new ValidationError('user_id, shift_id and date required');

    // Conflict check
    const conflict = await prisma.shiftAssignment.findFirst({
      where: { user_id, date: new Date(date) },
    });
    if (conflict) throw new ValidationError('Employee is already assigned to a shift on this date');

    // Leave conflict check
    const onLeave = await prisma.leaveRequest.findFirst({
      where: { user_id, status: 'approved', start_date: { lte: new Date(date) }, end_date: { gte: new Date(date) } },
    });
    if (onLeave) {
      // Warn but don't block (as per spec)
      console.warn(`[SHIFTS] Warning: ${user_id} has approved leave on ${date}`);
    }

    const assignment = await prisma.shiftAssignment.create({
      data: { shift_id, user_id, date: new Date(date) },
      include: ASSIGN_INCLUDE,
    });
    created(res, { assignment, leave_warning: !!onLeave });
  } catch (e) { next(e); }
});

// ─── DELETE /shifts/assignments/:id ───────────────────
router.delete('/assignments/:id', requireRole('hr_admin'), async (req, res, next) => {
  try {
    await prisma.shiftAssignment.delete({ where: { id: req.params.id } });
    ok(res, { message: 'Assignment removed' });
  } catch (e) { next(e); }
});

// ─── POST /shifts/schedule/publish ────────────────────
router.post('/schedule/publish', requireRole('hr_admin'), async (req, res, next) => {
  try {
    const { week_start } = req.body;
    const ws = week_start ? new Date(week_start) : (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay() + 1); return d; })();
    const we = new Date(ws); we.setDate(we.getDate() + 6);

    // Mark shift templates as published
    await prisma.shift.updateMany({
      where: { org_id: req.user!.org_id },
      data: { is_published: true },
    });

    // Get all assignments for the week and notify employees
    const assignments = await prisma.shiftAssignment.findMany({
      where: {
        date:  { gte: ws, lte: we },
        shift: { org_id: req.user!.org_id },
      },
      include: {
        user:  { select: { id: true, name: true, phone: true, org_id: true } },
        shift: { select: { name: true, start_time: true } },
      },
    });

    let notified = 0;
    const { notifyShiftReminder } = await import('../services/whatsapp');
    for (const a of assignments) {
      if (a.user.phone) {
        await notifyShiftReminder(a.user.org_id, a.user.name, a.shift.start_time, a.user.phone).catch(console.error);
        notified++;
      }
    }

    ok(res, {
      message: `Schedule published. ${notified} employees notified via WhatsApp.`,
      week_start:  ws.toISOString().split('T')[0],
      week_end:    we.toISOString().split('T')[0],
      assignments: assignments.length,
      notified,
    });
  } catch (e) { next(e); }
});

// ─── GET /shifts/assignments/me ────────────────────────
router.get('/assignments/me', async (req, res, next) => {
  try {
    const future = new Date(); future.setDate(future.getDate() - 1);
    const until  = new Date(); until.setDate(until.getDate() + 28);
    const assignments = await prisma.shiftAssignment.findMany({
      where: { user_id: req.user!.sub, date: { gte: future, lte: until } },
      include: { shift: true },
      orderBy: { date: 'asc' },
    });
    ok(res, assignments);
  } catch (e) { next(e); }
});

// ─── GET /shifts/swaps/me ──────────────────────────────
router.get('/swaps/me', async (req, res, next) => {
  try {
    const swaps = await prisma.shiftSwap.findMany({
      where: {
        OR: [
          { requester_id: req.user!.sub },
          { target_id:    req.user!.sub },
        ],
      },
      include: {
        requester:            { select: { id: true, name: true } },
        target:               { select: { id: true, name: true } },
        requester_assignment: { include: { shift: true } },
        target_assignment:    { include: { shift: true } },
      },
      orderBy: { created_at: 'desc' },
    });
    ok(res, swaps);
  } catch (e) { next(e); }
});

// ─── GET /shifts/swaps ─────────────────────────────────
router.get('/swaps', requireRole('manager'), async (req, res, next) => {
  try {
    const swaps = await prisma.shiftSwap.findMany({
      where: {
        OR: [
          { requester: { org_id: req.user!.org_id } },
          { target:    { org_id: req.user!.org_id } },
        ],
      },
      include: {
        requester:            { select: { id: true, name: true } },
        target:               { select: { id: true, name: true } },
        requester_assignment: { include: { shift: true } },
        target_assignment:    { include: { shift: true } },
      },
      orderBy: { created_at: 'desc' },
    });
    ok(res, swaps);
  } catch (e) { next(e); }
});

// ─── POST /shifts/swaps ────────────────────────────────
router.post('/swaps', async (req, res, next) => {
  try {
    const { target_id, requester_assign_id, target_assign_id, reason } = req.body;
    if (!target_id || !requester_assign_id || !target_assign_id) throw new ValidationError('Missing required fields');

    const swap = await prisma.shiftSwap.create({
      data: { requester_id: req.user!.sub, target_id, requester_assign_id, target_assign_id, reason },
    });
    ok(res, swap, 201);
  } catch (e) { next(e); }
});

// ─── PUT /shifts/swaps/:id/approve ────────────────────
router.put('/swaps/:id/approve', requireRole('manager'), async (req, res, next) => {
  try {
    const swap = await prisma.shiftSwap.findUnique({
      where: { id: req.params.id },
      include: { requester_assignment: true, target_assignment: true },
    });
    if (!swap) throw new NotFoundError('Swap request');

    await prisma.$transaction(async (tx) => {
      // Swap the shift_ids between the two assignments
      await tx.shiftAssignment.update({ where: { id: swap.requester_assign_id }, data: { shift_id: swap.target_assignment.shift_id } });
      await tx.shiftAssignment.update({ where: { id: swap.target_assign_id },    data: { shift_id: swap.requester_assignment.shift_id } });
      await tx.shiftSwap.update({ where: { id: swap.id }, data: { status: 'approved', manager_id: req.user!.sub } });
    });
    ok(res, { message: 'Swap approved and schedules updated' });
  } catch (e) { next(e); }
});

// ─── PUT /shifts/swaps/:id/reject ─────────────────────
router.put('/swaps/:id/reject', requireRole('manager'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) throw new ValidationError('Rejection reason required');
    const swap = await prisma.shiftSwap.findUnique({ where: { id: req.params.id } });
    if (!swap) throw new NotFoundError('Swap request');
    await prisma.shiftSwap.update({ where: { id: swap.id }, data: { status: 'rejected', manager_id: req.user!.sub, rejection_reason: reason } });
    ok(res, { message: 'Swap rejected' });
  } catch (e) { next(e); }
});

export default router;
