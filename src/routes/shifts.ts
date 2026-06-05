import { Router } from 'express';
import { authenticate, requireOrgFeature, requirePermission } from '../middleware/auth';
import { ok, created, noContent, NotFoundError, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

// Employee self-service routes (visible without shifts plan feature)

function timeToMins(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function parseDateOnly(value: string, field = 'date'): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (isNaN(parsed.getTime())) throw new ValidationError(`Invalid ${field}`);
  return parsed;
}

function startOfCurrentWeek(): Date {
  const d = new Date();
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

const ASSIGN_INCLUDE = {
  shift: true,
  user: { select: { id: true, name: true, avatar_url: true, department: true } },
};

function readBreakPolicy(body: Record<string, unknown>, shiftStart: string, existing?: { break_kind?: string | null; break_start_time?: string | null; break_end_time?: string | null; break_minutes?: number | null; after_minutes?: number | null; allowed_count_per_shift?: number | null; paid_within_limit?: boolean | null; deduct_extra_time?: boolean | null; allow_extra_breaks?: boolean | null; applies_days?: number[] | null; exception_dates?: string[] | null }) {
  const breakKind = String(body.break_kind ?? body.kind ?? existing?.break_kind ?? 'fixed');
  if (!['fixed', 'flexible'].includes(breakKind)) throw new ValidationError('break_kind must be fixed or flexible');

  const startTime = body.start_time as string | undefined;
  const endTime = body.end_time as string | undefined;
  let afterMinutes = 0;
  let breakMinutes = Number(body.break_minutes ?? body.duration_minutes ?? existing?.break_minutes ?? 0);
  let breakStartTime: string | null | undefined = startTime ?? existing?.break_start_time ?? null;
  let breakEndTime: string | null | undefined = endTime ?? existing?.break_end_time ?? null;

  if (breakKind === 'fixed') {
    if (!breakStartTime || !breakEndTime) throw new ValidationError('start_time and end_time required for fixed breaks');
    afterMinutes = timeToMins(breakStartTime) - timeToMins(shiftStart);
    breakMinutes = timeToMins(breakEndTime) - timeToMins(breakStartTime);
    if (breakMinutes <= 0) throw new ValidationError('end_time must be after start_time');
  } else {
    if (!breakMinutes || breakMinutes <= 0) throw new ValidationError('duration_minutes is required for flexible breaks');
    afterMinutes = Number(body.after_minutes ?? existing?.after_minutes ?? 0);
    breakStartTime = null;
    breakEndTime = null;
  }

  const appliesDays = Array.isArray(body.applies_days) ? body.applies_days.map(Number) : (existing?.applies_days ?? []);
  const exceptionDates = Array.isArray(body.exception_dates) ? body.exception_dates.map(String) : (existing?.exception_dates ?? []);
  return {
    break_kind: breakKind,
    break_minutes: breakMinutes,
    after_minutes: afterMinutes,
    break_start_time: breakStartTime,
    break_end_time: breakEndTime,
    allowed_count_per_shift: Number(body.allowed_count_per_shift ?? existing?.allowed_count_per_shift ?? 1),
    paid_within_limit: body.paid_within_limit !== undefined ? !!body.paid_within_limit : (existing?.paid_within_limit ?? true),
    deduct_extra_time: body.deduct_extra_time !== undefined ? !!body.deduct_extra_time : (existing?.deduct_extra_time ?? true),
    allow_extra_breaks: body.allow_extra_breaks !== undefined ? !!body.allow_extra_breaks : (existing?.allow_extra_breaks ?? true),
    applies_days: appliesDays,
    exception_dates: exceptionDates,
  };
}

// ─── GET /shifts ───────────────────────────────────────
router.get('/', requireOrgFeature('shifts'), requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const shifts = await prisma.shift.findMany({
      where: { org_id: req.user!.org_id },
      include: { _count: { select: { assignments: true } }, breaks: { orderBy: { after_minutes: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    ok(res, shifts);
  } catch (e) { next(e); }
});

// ─── POST /shifts ──────────────────────────────────────
router.post('/', requireOrgFeature('shifts'), requirePermission('shifts.manage'), async (req, res, next) => {
  try {
    const { name, start_time, end_time, color, active_days, days_of_week, overtime_multiplier, min_rest_hours, late_tolerance_mins, early_checkout_tolerance_mins, auto_checkout, auto_checkout_buffer_mins, overtime_enabled, overtime_requires_approval, extra_time_label, is_org_wide, is_default } = req.body;
    if (!name || !start_time || !end_time) throw new ValidationError('name, start_time and end_time required');
    const shift = await prisma.shift.create({
      data: {
        org_id: req.user!.org_id, name, start_time, end_time, color: color || '#f15153',
        active_days: active_days ?? days_of_week ?? [],
        created_by: req.user!.sub,
        ...(overtime_multiplier !== undefined && { overtime_multiplier: parseFloat(overtime_multiplier) }),
        ...(min_rest_hours !== undefined && { min_rest_hours: parseFloat(min_rest_hours) }),
        ...(late_tolerance_mins !== undefined && { late_tolerance_mins: +late_tolerance_mins }),
        ...(early_checkout_tolerance_mins !== undefined && { early_checkout_tolerance_mins: +early_checkout_tolerance_mins }),
        ...(auto_checkout !== undefined && { auto_checkout: !!auto_checkout }),
        ...(auto_checkout_buffer_mins !== undefined && { auto_checkout_buffer_mins: +auto_checkout_buffer_mins }),
        ...(overtime_enabled !== undefined && { overtime_enabled: !!overtime_enabled }),
        ...(overtime_requires_approval !== undefined && { overtime_requires_approval: !!overtime_requires_approval }),
        ...(extra_time_label !== undefined && { extra_time_label: String(extra_time_label || 'Extra office time') }),
        ...(is_org_wide !== undefined && { is_org_wide: !!is_org_wide }),
        ...(is_default !== undefined && { is_default: !!is_default }),
      },
    });
    created(res, shift);
  } catch (e) { next(e); }
});

// ─── POST /shifts/:id/breaks ───────────────────────────
router.post('/:id/breaks', requirePermission('shifts.breaks.manage'), async (req, res, next) => {
  try {
    const { name, is_paid } = req.body;
    if (!name) throw new ValidationError('name required');
    const shift = await prisma.shift.findUnique({ where: { id: req.params.id as string } });
    if (!shift || shift.org_id !== req.user!.org_id) throw new NotFoundError('Shift');
    const policy = readBreakPolicy(req.body, shift.start_time);
    const b = await prisma.shiftBreak.create({
      data: { shift_id: shift.id, name, is_paid: !!is_paid, ...policy },
    });
    created(res, b);
  } catch (e) { next(e); }
});

// ─── PUT /shifts/:shiftId/breaks/:breakId ─────────────
router.put('/:shiftId/breaks/:breakId', requirePermission('shifts.breaks.manage'), async (req, res, next) => {
  try {
    const { name, is_paid } = req.body;
    const b = await prisma.shiftBreak.findFirst({
      where: { id: req.params.breakId as string, shift: { org_id: req.user!.org_id } },
      include: { shift: true },
    });
    if (!b) throw new NotFoundError('ShiftBreak');
    const policy = readBreakPolicy(req.body, b.shift.start_time, b);
    const updated = await prisma.shiftBreak.update({
      where: { id: b.id },
      data: { ...(name !== undefined && { name }), ...(is_paid !== undefined && { is_paid: !!is_paid }), ...policy },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /shifts/:shiftId/breaks/:breakId ──────────
router.delete('/:shiftId/breaks/:breakId', requirePermission('shifts.breaks.manage'), async (req, res, next) => {
  try {
    const b = await prisma.shiftBreak.findFirst({
      where: { id: req.params.breakId as string, shift: { org_id: req.user!.org_id } },
    });
    if (!b) throw new NotFoundError('ShiftBreak');
    await prisma.shiftBreak.delete({ where: { id: b.id } });
    noContent(res);
  } catch (e) { next(e); }
});

// ─── PUT /shifts/:id ───────────────────────────────────
router.put('/:id', requirePermission('shifts.manage'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError('Shift');
    const { name, start_time, end_time, color, active_days, days_of_week, overtime_multiplier, min_rest_hours, late_tolerance_mins, early_checkout_tolerance_mins, auto_checkout, auto_checkout_buffer_mins, overtime_enabled, overtime_requires_approval, extra_time_label, is_org_wide, is_default } = req.body;

    if (is_default && !shift.is_default) {
      await prisma.shift.updateMany({ where: { org_id: req.user!.org_id }, data: { is_default: false } });
    }

    const updated = await prisma.shift.update({
      where: { id: req.params.id },
      data: {
        name, start_time, end_time, color,
        active_days: active_days ?? days_of_week,
        is_org_wide: is_org_wide !== undefined ? !!is_org_wide : undefined,
        is_default: is_default !== undefined ? !!is_default : undefined,
        ...(overtime_multiplier !== undefined && { overtime_multiplier: parseFloat(overtime_multiplier) }),
        ...(min_rest_hours !== undefined && { min_rest_hours: parseFloat(min_rest_hours) }),
        ...(late_tolerance_mins !== undefined && { late_tolerance_mins: +late_tolerance_mins }),
        ...(early_checkout_tolerance_mins !== undefined && { early_checkout_tolerance_mins: +early_checkout_tolerance_mins }),
        ...(auto_checkout !== undefined && { auto_checkout: !!auto_checkout }),
        ...(auto_checkout_buffer_mins !== undefined && { auto_checkout_buffer_mins: +auto_checkout_buffer_mins }),
        ...(overtime_enabled !== undefined && { overtime_enabled: !!overtime_enabled }),
        ...(overtime_requires_approval !== undefined && { overtime_requires_approval: !!overtime_requires_approval }),
        ...(extra_time_label !== undefined && { extra_time_label: String(extra_time_label || 'Extra office time') }),
      },
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── PUT /shifts/:id/set-default ──────────────────────
router.put('/:id/set-default', requirePermission('shifts.manage'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError('Shift');

    await prisma.$transaction([
      prisma.shift.updateMany({ where: { org_id: req.user!.org_id }, data: { is_default: false } }),
      prisma.shift.update({ where: { id: req.params.id }, data: { is_default: true } }),
    ]);

    ok(res, { message: 'Shift set as default for the organisation' });
  } catch (e) { next(e); }
});

// ─── DELETE /shifts/:id ────────────────────────────────
router.delete('/:id', requirePermission('shifts.manage'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError('Shift');
    await prisma.shift.delete({ where: { id: req.params.id } });
    ok(res, { message: 'Shift template deleted' });
  } catch (e) { next(e); }
});

// ─── GET /shifts/schedule ──────────────────────────────
router.get('/schedule', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const { week_start } = req.query as { week_start?: string };
    const ws = week_start ? parseDateOnly(week_start, 'week_start') : startOfCurrentWeek();
    const we = addUtcDays(ws, 6);

    const assignments = await prisma.shiftAssignment.findMany({
      where: { date: { gte: ws, lte: we }, shift: { org_id: req.user!.org_id } },
      include: ASSIGN_INCLUDE,
      orderBy: { date: 'asc' },
    });
    ok(res, assignments);
  } catch (e) { next(e); }
});

// ─── GET /shifts/assignments ───────────────────────────
router.get('/assignments', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const { week_start, department } = req.query as Record<string, string>;
    const ws = week_start ? parseDateOnly(week_start, 'week_start') : startOfCurrentWeek();
    const we = addUtcDays(ws, 6);

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
router.post('/assignments', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const { user_id, shift_id, date } = req.body;
    if (!user_id || !shift_id || !date) throw new ValidationError('user_id, shift_id and date required');

    const assignDate = parseDateOnly(date);

    // Both the employee and the shift must belong to the caller's org
    const [user, shift] = await Promise.all([
      prisma.user.findFirst({ where: { id: user_id, org_id: req.user!.org_id, is_active: true } }),
      prisma.shift.findFirst({ where: { id: shift_id, org_id: req.user!.org_id } }),
    ]);
    if (!user)  throw new NotFoundError('Employee');
    if (!shift) throw new NotFoundError('Shift');

    // Conflict check (scoped to org via the shift relation above)
    const conflict = await prisma.shiftAssignment.findFirst({
      where: { user_id, date: assignDate },
    });
    if (conflict) throw new ValidationError('Employee is already assigned to a shift on this date');

    // Leave conflict check
    const onLeave = await prisma.leaveRequest.findFirst({
      where: { user_id, status: 'approved', start_date: { lte: assignDate }, end_date: { gte: assignDate } },
    });
    if (onLeave) console.warn(`[SHIFTS] Warning: ${user_id} has approved leave on ${date}`);

    // Active-day check: warn (don't block) if the date's weekday isn't in the
    // shift's active_days. JS getDay() is 0=Sun..6=Sat — match that convention.
    const weekday = assignDate.getDay();
    const offDay  = Array.isArray(shift.active_days) && shift.active_days.length > 0 && !shift.active_days.includes(weekday);

    const assignment = await prisma.shiftAssignment.create({
      data: { shift_id, user_id, date: assignDate },
      include: ASSIGN_INCLUDE,
    });
    created(res, { assignment, leave_warning: !!onLeave, off_day_warning: offDay });
  } catch (e) { next(e); }
});

// ─── PUT /shifts/assignments/:id ──────────────────────
// Change the shift or date of an existing assignment.
router.put('/assignments/:id', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const assignment = await prisma.shiftAssignment.findFirst({
      where: { id: req.params.id, shift: { org_id: req.user!.org_id } },
    });
    if (!assignment) throw new NotFoundError('Assignment');

    const { shift_id, date } = req.body;
    const updateData: Record<string, unknown> = {};

    if (shift_id) {
      const shift = await prisma.shift.findFirst({ where: { id: shift_id, org_id: req.user!.org_id } });
      if (!shift) throw new NotFoundError('Shift');
      updateData.shift_id = shift_id;
    }

    if (date) {
      const assignDate = parseDateOnly(date);

      // Conflict check: ensure no other assignment exists for this user on the new date
      const conflict = await prisma.shiftAssignment.findFirst({
        where: { user_id: assignment.user_id, date: assignDate, id: { not: assignment.id } },
      });
      if (conflict) throw new ValidationError('Employee already has a shift on that date');
      updateData.date = assignDate;
    }

    if (!shift_id && !date) throw new ValidationError('shift_id or date required');

    const updated = await prisma.shiftAssignment.update({
      where: { id: assignment.id },
      data:  updateData,
      include: ASSIGN_INCLUDE,
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /shifts/assignments/:id/detail ───────────────
router.get('/assignments/:id/detail', async (req, res, next) => {
  try {
    const assignment = await prisma.shiftAssignment.findFirst({
      where: {
        id: req.params.id,
        ...(req.user!.role === 'employee'
          ? { user_id: req.user!.sub }
          : { shift: { org_id: req.user!.org_id } }),
      },
      include: {
        shift: { include: { breaks: { orderBy: { after_minutes: 'asc' } } } },
        user: { select: { id: true, name: true, avatar_url: true, department: true, job_title: true } },
      },
    });
    if (!assignment) throw new NotFoundError('Assignment');

    const attendance = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: assignment.user_id, date: assignment.date } },
      include: { break_records: { orderBy: { break_start: 'asc' } } },
    });

    ok(res, {
      assignment,
      shift: assignment.shift,
      user: assignment.user,
      attendance,
      history: attendance ? {
        check_in_at: attendance.check_in_at,
        check_out_at: attendance.check_out_at,
        late_minutes: attendance.late_minutes,
        early_out_minutes: attendance.early_out_minutes,
        early_checkin_minutes: attendance.early_checkin_minutes,
        break_minutes: attendance.break_minutes,
        paid_break_minutes: attendance.paid_break_minutes,
        net_hours_worked: attendance.net_hours_worked,
        overtime_hours: attendance.overtime_hours,
        extra_office_minutes: attendance.extra_office_minutes,
        breaks: attendance.break_records,
      } : null,
    });
  } catch (e) { next(e); }
});

// ─── POST /shifts/assignments/bulk ────────────────────
// Assign a shift to multiple employees across multiple dates in one call.
// Returns created assignments, skipped conflicts, and leave/off-day warnings.
router.post('/assignments/bulk', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const { user_ids, shift_id, dates } = req.body;
    if (!Array.isArray(user_ids) || user_ids.length === 0) throw new ValidationError('user_ids array required');
    if (!shift_id)                                          throw new ValidationError('shift_id required');
    if (!Array.isArray(dates)    || dates.length === 0)    throw new ValidationError('dates array required');

    const shift = await prisma.shift.findFirst({ where: { id: shift_id, org_id: req.user!.org_id } });
    if (!shift) throw new NotFoundError('Shift');

    // Validate all employees belong to org
    const users = await prisma.user.findMany({
      where: { id: { in: user_ids }, org_id: req.user!.org_id, is_active: true },
      select: { id: true, name: true },
    });
    if (users.length !== user_ids.length) throw new ValidationError('One or more employees not found in your organisation');

    const parsedDates = dates.map((d: string) => parseDateOnly(d));

    // Pre-fetch existing assignments and approved leave to avoid N+1 checks
    const existingAssignments = await prisma.shiftAssignment.findMany({
      where: { user_id: { in: user_ids }, date: { in: parsedDates } },
      select: { user_id: true, date: true },
    });
    const conflictSet = new Set(existingAssignments.map(a => `${a.user_id}:${a.date.toISOString().split('T')[0]}`));

    const approvedLeave = await prisma.leaveRequest.findMany({
      where: {
        user_id: { in: user_ids }, status: 'approved',
        start_date: { lte: parsedDates[parsedDates.length - 1] },
        end_date:   { gte: parsedDates[0] },
      },
      select: { user_id: true, start_date: true, end_date: true },
    });

    const created: { user_id: string; user_name: string; date: string }[] = [];
    const skipped: { user_id: string; user_name: string; date: string; reason: string }[] = [];
    const warnings: { user_id: string; user_name: string; date: string; type: string }[] = [];

    const userMap = new Map(users.map(u => [u.id, u.name]));

    for (const userId of user_ids) {
      for (const assignDate of parsedDates) {
        const dateStr  = assignDate.toISOString().split('T')[0];
        const userName = userMap.get(userId) ?? userId;

        if (conflictSet.has(`${userId}:${dateStr}`)) {
          skipped.push({ user_id: userId, user_name: userName, date: dateStr, reason: 'already_assigned' });
          continue;
        }

        // Leave warning (don't block — HR may be overriding)
        const onLeave = approvedLeave.some(l =>
          l.user_id === userId &&
          new Date(l.start_date) <= assignDate &&
          new Date(l.end_date)   >= assignDate
        );
        const weekday = assignDate.getDay();
        const offDay  = Array.isArray(shift.active_days) && shift.active_days.length > 0 && !shift.active_days.includes(weekday);

        await prisma.shiftAssignment.create({ data: { shift_id, user_id: userId, date: assignDate } });
        created.push({ user_id: userId, user_name: userName, date: dateStr });

        if (onLeave) warnings.push({ user_id: userId, user_name: userName, date: dateStr, type: 'leave_overlap' });
        if (offDay)  warnings.push({ user_id: userId, user_name: userName, date: dateStr, type: 'off_day' });
      }
    }

    ok(res, { created: created.length, skipped: skipped.length, warnings: warnings.length, details: { created, skipped, warnings } }, 201);
  } catch (e) { next(e); }
});

// ─── DELETE /shifts/assignments/:id ───────────────────
router.delete('/assignments/:id', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const assignment = await prisma.shiftAssignment.findFirst({
      where: { id: req.params.id, shift: { org_id: req.user!.org_id } },
    });
    if (!assignment) throw new NotFoundError('Assignment');
    await prisma.shiftAssignment.delete({ where: { id: req.params.id } });
    ok(res, { message: 'Assignment removed' });
  } catch (e) { next(e); }
});

// ─── POST /shifts/schedule/publish ────────────────────
router.post('/schedule/publish', requirePermission('shifts.assign'), async (req, res, next) => {
  try {
    const { week_start } = req.body;
    const ws = week_start ? parseDateOnly(week_start, 'week_start') : startOfCurrentWeek();
    const we = addUtcDays(ws, 6);

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

    // Mark only the shift templates that appear in this week as published
    const shiftIds = [...new Set(assignments.map(a => a.shift_id))];
    if (shiftIds.length > 0) {
      await prisma.shift.updateMany({
        where: { id: { in: shiftIds }, org_id: req.user!.org_id },
        data: { is_published: true },
      });
    }

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
    const today = parseDateOnly(new Date().toISOString().split('T')[0]);
    const future = addUtcDays(today, -1);
    const until  = addUtcDays(today, 28);
    const assignments = await prisma.shiftAssignment.findMany({
      where: { user_id: req.user!.sub, date: { gte: future, lte: until } },
      include: { shift: { include: { breaks: { orderBy: { after_minutes: 'asc' } } } } },
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
router.get('/swaps', requirePermission('shifts.swaps.approve'), async (req, res, next) => {
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

    const requesterAssign = await prisma.shiftAssignment.findFirst({
      where: { id: requester_assign_id, user_id: req.user!.sub, shift: { org_id: req.user!.org_id } },
    });
    if (!requesterAssign) throw new NotFoundError('Your shift assignment');

    const targetAssign = await prisma.shiftAssignment.findFirst({
      where: { id: target_assign_id, shift: { org_id: req.user!.org_id } },
    });
    if (!targetAssign) throw new NotFoundError('Target shift assignment');

    const swap = await prisma.shiftSwap.create({
      data: { requester_id: req.user!.sub, target_id, requester_assign_id, target_assign_id, reason },
    });
    ok(res, swap, 201);
  } catch (e) { next(e); }
});

// ─── PUT /shifts/swaps/:id/approve ────────────────────
router.put('/swaps/:id/approve', requirePermission('shifts.swaps.approve'), async (req, res, next) => {
  try {
    const swap = await prisma.shiftSwap.findFirst({
      where: { id: req.params.id, requester: { org_id: req.user!.org_id } },
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
router.put('/swaps/:id/reject', requirePermission('shifts.swaps.approve'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason) throw new ValidationError('Rejection reason required');
    const swap = await prisma.shiftSwap.findFirst({
      where: { id: req.params.id, requester: { org_id: req.user!.org_id } },
    });
    if (!swap) throw new NotFoundError('Swap request');
    await prisma.shiftSwap.update({ where: { id: swap.id }, data: { status: 'rejected', manager_id: req.user!.sub, rejection_reason: reason } });
    ok(res, { message: 'Swap rejected' });
  } catch (e) { next(e); }
});

// ─── POST /shifts/ai-schedule ─────────────────────────
// Describe staffing needs in plain English; AI returns a shift plan
router.post('/ai-schedule', requirePermission('shifts.ai_schedule'), async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ValidationError('AI service not configured');

    const { description, week_start, department } = req.body;
    if (!description) throw new ValidationError('description required (e.g. "Cover Mon-Fri 9-5 for Engineering, 3 people each day")');

    const existingShifts = await prisma.shift.findMany({
      where: { org_id: req.user!.org_id, ...(department ? {} : {}) },
      select: { id: true, name: true, start_time: true, end_time: true, active_days: true },
    });

    const employees = await prisma.user.findMany({
      where: { org_id: req.user!.org_id, is_active: true, deleted_at: null, ...(department ? { department } : {}) },
      select: { id: true, name: true, department: true, job_title: true },
    });

    const axios = (await import('axios')).default;
    const aiRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: `You are an HR scheduling AI. Create an optimal shift assignment plan based on this request.\n\nRequest: "${description}"\nWeek starting: ${week_start || 'next Monday'}\nDepartment filter: ${department || 'all'}\n\nAvailable shifts:\n${JSON.stringify(existingShifts, null, 2)}\n\nAvailable employees:\n${JSON.stringify(employees, null, 2)}\n\nReturn a JSON object with:\n- "plan": array of { user_id, user_name, shift_id, shift_name, dates: ["YYYY-MM-DD", ...] }\n- "summary": plain English explanation of the schedule (2-3 sentences)\n- "warnings": any coverage gaps or concerns\n\nEnsure fair distribution and no employee is double-booked. Use only the shift IDs and user IDs from the provided lists.`,
        }],
      },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } },
    );

    const text = aiRes.data.content?.[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { plan: [], summary: text, warnings: [] };
    ok(res, result);
  } catch (e) { next(e); }
});

// ─── GET /shifts/:id/breaks ────────────────────────────
// Must be registered after all literal two-segment routes (/assignments/me, /swaps/me)
router.get('/:id/breaks', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findUnique({
      where: { id: req.params.id as string },
      include: { breaks: { orderBy: { after_minutes: 'asc' } } },
    });
    if (!shift || shift.org_id !== req.user!.org_id) throw new NotFoundError('Shift');
    ok(res, shift.breaks);
  } catch (e) { next(e); }
});

// ─── GET /shifts/:id ───────────────────────────────────
// Must be registered after all literal single-segment routes (/schedule, /assignments, /swaps)
router.get('/:id', requirePermission('shifts.view'), async (req, res, next) => {
  try {
    const shift = await prisma.shift.findUnique({
      where: { id: req.params.id as string },
      include: { breaks: { orderBy: { after_minutes: 'asc' } } },
    });
    if (!shift || shift.org_id !== req.user!.org_id) throw new NotFoundError('Shift');
    ok(res, shift);
  } catch (e) { next(e); }
});

export default router;
