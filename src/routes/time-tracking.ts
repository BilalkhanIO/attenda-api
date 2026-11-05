import { Router } from 'express';
import { authenticate, requireOrgFeature, requirePermission } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import prisma from '../utils/prisma';
import { AppError, created, NotFoundError, ok, ValidationError } from '../utils/response';
import { recordAudit } from '../services/audit';
import { resolveUserPermissions } from '../services/authorization';
import { createNotification, emitOrgEvent } from '../services/notifications';
import { reviewApproval } from '../services/approval-workflows';
import { dateOnlyInTz } from '../utils/shift';
import type { Prisma } from '@prisma/client';

const router = Router();
router.use(authenticate);
router.use(requireOrgFeature('time_tracking'));

async function lockUserTimeEntries(tx: Prisma.TransactionClient, orgId: string, userId: string) {
  const lockName = `attenda:time-entries:${orgId}:${userId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
}

function intervalOverlapWhere(orgId: string, userId: string, start: Date, end: Date, exceptId?: string) {
  return {
    org_id: orgId,
    user_id: userId,
    ...(exceptId ? { id: { not: exceptId } } : {}),
    started_at: { lt: end },
    OR: [{ ended_at: null }, { ended_at: { gt: start } }],
  };
}

function asDate(value: unknown, label: string): Date {
  const date = new Date(String(value ?? ''));
  if (!Number.isFinite(date.getTime())) throw new ValidationError(`${label} must be a valid date`);
  return date;
}
function weekRange(value: unknown) {
  const start = asDate(value, 'week_start');
  if (start.getUTCDay() !== 1 || start.toISOString().slice(11, 19) !== '00:00:00') throw new ValidationError('week_start must be a Monday at 00:00 UTC');
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}
async function attendanceForWorkDate(orgId: string, userId: string, at: Date) {
  const user = await prisma.user.findFirst({
    where: { id: userId, org_id: orgId },
    select: { primary_location: { select: { timezone: true } }, org: { select: { timezone: true } } },
  });
  if (!user) return null;
  const date = dateOnlyInTz(at, user.primary_location?.timezone ?? user.org.timezone);
  return prisma.attendanceRecord.findFirst({
    where: { org_id: orgId, user_id: userId, date },
    select: { id: true },
  });
}
async function validateProjectTask(orgId: string, userId: string, projectId?: string | null, taskId?: string | null) {
  if (!projectId && !taskId) return;
  const task = taskId ? await prisma.projectTask.findFirst({ where: { id: taskId, project: { org_id: orgId } }, select: { id: true, project_id: true, assignee_id: true } }) : null;
  if (taskId && !task) throw new NotFoundError('Project task');
  const actualProjectId = task?.project_id ?? projectId;
  if (!actualProjectId) throw new ValidationError('A task must belong to a project');
  const project = await prisma.project.findFirst({ where: { id: actualProjectId, org_id: orgId }, select: { id: true } });
  if (!project) throw new NotFoundError('Project');
  const permissions = await resolveUserPermissions(userId, orgId);
  if (!permissions.has('projects.manage')) {
    const membership = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: project.id, user_id: userId } }, select: { project_id: true } });
    if (!membership && task?.assignee_id !== userId) throw new NotFoundError('Project');
  }
}

async function notifyTimesheetApprovers(orgId: string, userId: string, timesheetId: string, weekStart: Date) {
  const [submitter, roleAssignments, directAllows] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, org_id: orgId }, select: { name: true, manager_id: true } }),
    prisma.userOrgRole.findMany({ where: { org_role: { org_id: orgId, permissions: { some: { permission_key: 'time.approve' } } }, user: { org_id: orgId, is_active: true, deleted_at: null } }, select: { user_id: true } }),
    prisma.userPermissionGrant.findMany({ where: { org_id: orgId, permission_key: 'time.approve', effect: 'allow', user: { is_active: true, deleted_at: null } }, select: { user_id: true } }),
  ]);
  const candidates = [...new Set([...roleAssignments.map(row => row.user_id), ...directAllows.map(row => row.user_id), ...(submitter?.manager_id ? [submitter.manager_id] : [])])].filter(id => id !== userId);
  const authorized = await Promise.all(candidates.map(async id => ({ id, perms: await resolveUserPermissions(id, orgId) })));
  const targets = authorized.filter(row => row.perms.has('time.approve'));
  const week = weekStart.toISOString().slice(0, 10);
  await Promise.all(targets.map(({ id }) => createNotification({ userId: id, orgId, type: 'timesheet_submitted', title: 'Timesheet submitted for review', body: `${submitter?.name ?? 'An employee'} submitted project time for the week of ${week}.`, actionType: 'timesheet', actionId: timesheetId })));
}

router.get('/timer', requirePermission('time.view'), async (req, res, next) => {
  try {
    const entry = await prisma.timeEntry.findFirst({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, ended_at: null }, include: { project: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } } });
    ok(res, entry);
  } catch (error) { next(error); }
});

router.post('/timer/start', requirePermission('time.view'), idempotency, async (req, res, next) => {
  try {
    const projectId = req.body.project_id ? String(req.body.project_id) : null;
    const taskId = req.body.task_id ? String(req.body.task_id) : null;
    await validateProjectTask(req.user!.org_id, req.user!.sub, projectId, taskId);
    const now = new Date();
    const startedAt = new Date();
    const attendance = await attendanceForWorkDate(req.user!.org_id, req.user!.sub, startedAt);
    const entry = await prisma.$transaction(async tx => {
      await lockUserTimeEntries(tx, req.user!.org_id, req.user!.sub);
      const overlap = await tx.timeEntry.findFirst({
        where: {
          org_id: req.user!.org_id,
          user_id: req.user!.sub,
          OR: [
            { started_at: { lte: now }, OR: [{ ended_at: null }, { ended_at: { gt: now } }] },
            { started_at: { gt: now } },
          ],
        },
        select: { id: true, ended_at: true },
      });
      if (overlap?.ended_at === null) throw new AppError('Stop the running timer before starting another.', 409, 'TIMER_ALREADY_RUNNING');
      if (overlap) throw new ValidationError('This time overlaps another time entry');
      return tx.timeEntry.create({ data: {
        org_id: req.user!.org_id, user_id: req.user!.sub, project_id: projectId, task_id: taskId,
        attendance_id: attendance?.id ?? null, started_at: startedAt, source: 'timer', billable: Boolean(req.body.billable), description: req.body.description ? String(req.body.description).slice(0, 500) : null,
      }, include: { project: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } } });
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'time.timer.start', entityType: 'time_entry', entityId: entry.id, after: { project_id: projectId, task_id: taskId } });
    created(res, entry);
  } catch (error: any) {
    if (error?.code === 'P2002') return next(new AppError('A timer is already running. Stop it before starting another.', 409, 'TIMER_ALREADY_RUNNING'));
    next(error);
  }
});

router.post('/timer/stop', requirePermission('time.view'), idempotency, async (req, res, next) => {
  try {
    const now = new Date();
    const entry = await prisma.timeEntry.findFirst({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, ended_at: null } });
    if (!entry) throw new NotFoundError('Running timer');
    const minutes = Math.max(1, Math.round((now.getTime() - entry.started_at.getTime()) / 60000));
    const attendance = await attendanceForWorkDate(req.user!.org_id, req.user!.sub, entry.started_at);
    const updated = await prisma.timeEntry.updateMany({ where: { id: entry.id, ended_at: null, status: 'draft' }, data: { ended_at: now, minutes, attendance_id: attendance?.id ?? entry.attendance_id } });
    if (!updated.count) throw new AppError('Timer has already been stopped.', 409, 'TIMER_ALREADY_STOPPED');
    const saved = await prisma.timeEntry.findUnique({ where: { id: entry.id }, include: { project: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } } });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'time.timer.stop', entityType: 'time_entry', entityId: entry.id, after: { minutes } });
    created(res, saved);
  } catch (error) { next(error); }
});

router.get('/entries', requirePermission('time.view'), async (req, res, next) => {
  try {
    const from = req.query.from ? asDate(req.query.from, 'from') : undefined;
    const to = req.query.to ? asDate(req.query.to, 'to') : undefined;
    const permissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    const team = req.query.scope === 'team' && permissions.has('time.view_team');
    const entries = await prisma.timeEntry.findMany({ where: {
      org_id: req.user!.org_id,
      ...(team ? {} : { user_id: req.user!.sub }),
      ...(from || to ? { started_at: { ...(from && { gte: from }), ...(to && { lt: to }) } } : {}),
      ...(req.query.project_id ? { project_id: String(req.query.project_id) } : {}),
      ...(req.query.status ? { status: String(req.query.status) } : {}),
    }, include: { user: { select: { id: true, name: true } }, project: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } }, orderBy: { started_at: 'desc' }, take: 500 });
    ok(res, entries);
  } catch (error) { next(error); }
});

router.post('/entries', requirePermission('time.view'), idempotency, async (req, res, next) => {
  try {
    const start = asDate(req.body.started_at, 'started_at');
    const end = asDate(req.body.ended_at, 'ended_at');
    if (end <= start) throw new ValidationError('End time must be after start time');
    const duration = Math.round((end.getTime() - start.getTime()) / 60000);
    if (duration > 24 * 60) throw new ValidationError('A time entry cannot exceed 24 hours');
    const projectId = req.body.project_id ? String(req.body.project_id) : null;
    const taskId = req.body.task_id ? String(req.body.task_id) : null;
    await validateProjectTask(req.user!.org_id, req.user!.sub, projectId, taskId);
    const attendance = await attendanceForWorkDate(req.user!.org_id, req.user!.sub, start);
    const entry = await prisma.$transaction(async tx => {
      await lockUserTimeEntries(tx, req.user!.org_id, req.user!.sub);
      const overlap = await tx.timeEntry.findFirst({ where: intervalOverlapWhere(req.user!.org_id, req.user!.sub, start, end), select: { id: true } });
      if (overlap) throw new ValidationError('This time overlaps another time entry');
      return tx.timeEntry.create({ data: { org_id: req.user!.org_id, user_id: req.user!.sub, project_id: projectId, task_id: taskId, attendance_id: attendance?.id ?? null, started_at: start, ended_at: end, minutes: duration, source: 'manual', billable: Boolean(req.body.billable), description: req.body.description ? String(req.body.description).slice(0, 500) : null } });
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'time.entry.create', entityType: 'time_entry', entityId: entry.id, after: { minutes: duration, project_id: projectId, task_id: taskId } });
    created(res, entry);
  } catch (error) { next(error); }
});

router.put('/entries/:id', requirePermission('time.view'), idempotency, async (req, res, next) => {
  try {
    const entry = await prisma.timeEntry.findFirst({ where: { id: String(req.params.id), org_id: req.user!.org_id, user_id: req.user!.sub } });
    if (!entry) throw new NotFoundError('Time entry');
    if (!['draft', 'rejected'].includes(entry.status) || !entry.ended_at) throw new ValidationError('Only completed draft or returned entries can be edited');
    const start = req.body.started_at !== undefined ? asDate(req.body.started_at, 'started_at') : entry.started_at;
    const end = req.body.ended_at !== undefined ? asDate(req.body.ended_at, 'ended_at') : entry.ended_at;
    if (end <= start) throw new ValidationError('End time must be after start time');
    if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) throw new ValidationError('A time entry cannot exceed 24 hours');
    const projectId = req.body.project_id !== undefined ? (req.body.project_id ? String(req.body.project_id) : null) : entry.project_id;
    const taskId = req.body.task_id !== undefined ? (req.body.task_id ? String(req.body.task_id) : null) : entry.task_id;
    await validateProjectTask(req.user!.org_id, req.user!.sub, projectId, taskId);
    const attendance = await attendanceForWorkDate(req.user!.org_id, req.user!.sub, start);
    const updated = await prisma.$transaction(async tx => {
      await lockUserTimeEntries(tx, req.user!.org_id, req.user!.sub);
      const overlap = await tx.timeEntry.findFirst({ where: intervalOverlapWhere(req.user!.org_id, req.user!.sub, start, end, entry.id), select: { id: true } });
      if (overlap) throw new ValidationError('This time overlaps another time entry');
      const moved = await tx.timeEntry.updateMany({
        where: { id: entry.id, org_id: req.user!.org_id, user_id: req.user!.sub, status: { in: ['draft', 'rejected'] }, ended_at: { not: null } },
        data: { status: 'draft', started_at: start, ended_at: end, minutes: Math.round((end.getTime() - start.getTime()) / 60000), project_id: projectId, task_id: taskId, attendance_id: attendance?.id ?? null, ...(req.body.description !== undefined && { description: String(req.body.description).slice(0, 500) }), ...(req.body.billable !== undefined && { billable: Boolean(req.body.billable) }) },
      });
      if (!moved.count) throw new AppError('This time entry changed while you were editing it. Refresh and try again.', 409, 'TIME_ENTRY_CONFLICT');
      return tx.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'time.entry.update', entityType: 'time_entry', entityId: entry.id, before: { minutes: entry.minutes }, after: { minutes: updated.minutes } });
    ok(res, updated);
  } catch (error) { next(error); }
});

router.get('/timesheets/me', requirePermission('time.view'), async (req, res, next) => {
  try {
    const { start, end } = weekRange(req.query.week_start);
    const [timesheet, entries, attendance] = await Promise.all([
      prisma.timesheet.findUnique({ where: { org_id_user_id_week_start: { org_id: req.user!.org_id, user_id: req.user!.sub, week_start: start } } }),
      prisma.timeEntry.findMany({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, started_at: { gte: start, lt: end } }, include: { project: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } }, orderBy: { started_at: 'asc' } }),
      prisma.attendanceRecord.findMany({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, date: { gte: start, lt: end } }, select: { date: true, net_hours_worked: true, hours_worked: true } }),
    ]);
    const loggedByDay = new Map<string, number>();
    for (const entry of entries) {
      const day = entry.started_at.toISOString().slice(0, 10);
      loggedByDay.set(day, (loggedByDay.get(day) ?? 0) + entry.minutes);
    }
    const attendanceByDay = new Map(attendance.map(row => [row.date.toISOString().slice(0, 10), Math.round(Number(row.net_hours_worked ?? row.hours_worked ?? 0) * 60)]));
    const allocationWarnings = [...loggedByDay].filter(([day, minutes]) => minutes > (attendanceByDay.get(day) ?? 0)).map(([date, logged_minutes]) => ({ date, logged_minutes, attendance_minutes: attendanceByDay.get(date) ?? 0 }));
    ok(res, { timesheet, entries, total_minutes: entries.reduce((sum, item) => sum + item.minutes, 0), allocation_warnings: allocationWarnings });
  } catch (error) { next(error); }
});

router.post('/timesheets/submit', requirePermission('time.view'), idempotency, async (req, res, next) => {
  try {
    const { start, end } = weekRange(req.body.week_start);
    const pendingTimer = await prisma.timeEntry.findFirst({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, ended_at: null, started_at: { gte: start, lt: end } }, select: { id: true } });
    if (pendingTimer) throw new ValidationError('Stop the running timer before submitting this week');
    const count = await prisma.timeEntry.count({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, started_at: { gte: start, lt: end }, ended_at: { not: null } } });
    if (!count) throw new ValidationError('Add at least one completed time entry before submitting');
    const sheet = await prisma.$transaction(async tx => {
      const existing = await tx.timesheet.findUnique({ where: { org_id_user_id_week_start: { org_id: req.user!.org_id, user_id: req.user!.sub, week_start: start } } });
      if (existing?.status === 'approved' || existing?.status === 'locked') throw new ValidationError('This timesheet is already approved and locked');
      await tx.timeEntry.updateMany({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, started_at: { gte: start, lt: end }, status: { in: ['draft', 'rejected'] }, ended_at: { not: null } }, data: { status: 'submitted' } });
      return tx.timesheet.upsert({ where: { org_id_user_id_week_start: { org_id: req.user!.org_id, user_id: req.user!.sub, week_start: start } }, create: { org_id: req.user!.org_id, user_id: req.user!.sub, week_start: start, status: 'submitted', submitted_at: new Date() }, update: { status: 'submitted', submitted_at: new Date(), reviewed_by: null, reviewed_at: null, review_note: null } });
    });
    recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'timesheet.submit', entityType: 'timesheet', entityId: sheet.id, after: { week_start: start.toISOString() } });
    notifyTimesheetApprovers(req.user!.org_id, req.user!.sub, sheet.id, start).catch(() => {});
    emitOrgEvent(req.user!.org_id, 'timesheet_changed');
    created(res, sheet);
  } catch (error) { next(error); }
});

router.get('/timesheets', requirePermission('time.approve'), async (req, res, next) => {
  try {
    const sheets = await prisma.timesheet.findMany({ where: { org_id: req.user!.org_id, status: 'submitted' }, include: { user: { select: { id: true, name: true, department: true } } }, orderBy: { submitted_at: 'asc' }, take: 200 });
    ok(res, sheets);
  } catch (error) { next(error); }
});

router.put('/timesheets/:id/review', requirePermission('time.approve'), idempotency, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const decision = req.body.decision as 'approve' | 'reject';
    const note = req.body.note ? String(req.body.note).trim() : undefined;
    const result = await reviewApproval({ userId: req.user!.sub, orgId: req.user!.org_id }, { type: 'timesheet', id, action: decision, reason: note, note });
    ok(res, result);
  } catch (error) { next(error); }
});

router.get('/reports/project/:id', requirePermission('time.view_team'), async (req, res, next) => {
  try {
    const projectId = String(req.params.id);
    const project = await prisma.project.findFirst({ where: { id: projectId, org_id: req.user!.org_id }, select: { id: true, name: true, budget_hours: true, start_date: true, created_at: true } });
    if (!project) throw new NotFoundError('Project');
    const permissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    if (!permissions.has('projects.manage')) {
      const member = await prisma.projectMember.findUnique({ where: { project_id_user_id: { project_id: projectId, user_id: req.user!.sub } }, select: { project_id: true } });
      const assigned = await prisma.projectTask.findFirst({ where: { project_id: projectId, assignee_id: req.user!.sub }, select: { id: true } });
      if (!member && !assigned) throw new NotFoundError('Project');
    }
    const defaultFrom = project.start_date ?? project.created_at;
    const maxWindowStart = new Date(); maxWindowStart.setUTCDate(maxWindowStart.getUTCDate() - 365);
    const from = req.query.from ? asDate(req.query.from, 'from') : defaultFrom > maxWindowStart ? defaultFrom : maxWindowStart;
    const toInclusive = req.query.to ? asDate(req.query.to, 'to') : new Date();
    if (toInclusive < from) throw new ValidationError('to must be on or after from');
    const to = new Date(toInclusive); to.setUTCHours(23, 59, 59, 999);
    if (to.getTime() - from.getTime() > 366 * 24 * 60 * 60_000) throw new ValidationError('Project time reports are limited to 366 days per request');

    const entries = await prisma.timeEntry.findMany({
      where: { org_id: req.user!.org_id, project_id: projectId, ended_at: { not: null }, started_at: { gte: from, lte: to }, status: { in: ['submitted', 'approved', 'locked'] } },
      include: { user: { select: { id: true, name: true } }, task: { select: { id: true, title: true } } },
      orderBy: [{ started_at: 'asc' }, { id: 'asc' }], take: 5001,
    });
    if (entries.length > 5000) throw new ValidationError('This project has too many time entries for one report. Narrow the date range.');
    const userIds = [...new Set(entries.map(entry => entry.user_id))];
    const attendance = userIds.length ? await prisma.attendanceRecord.findMany({ where: { org_id: req.user!.org_id, user_id: { in: userIds }, date: { gte: from, lte: to } }, select: { user_id: true, date: true, net_hours_worked: true, hours_worked: true } }) : [];
    const minutesByEmployee = new Map<string, number>();
    const attendanceByEmployee = new Map<string, number>();
    const byDay = new Map<string, { date: string; minutes: number; employees: Set<string> }>();
    for (const entry of entries) {
      const minutes = entry.minutes;
      minutesByEmployee.set(entry.user_id, (minutesByEmployee.get(entry.user_id) ?? 0) + minutes);
      const day = entry.started_at.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { date: day, minutes: 0, employees: new Set<string>() };
      bucket.minutes += minutes; bucket.employees.add(entry.user_id); byDay.set(day, bucket);
    }
    for (const row of attendance) {
      const minutes = Math.round(Number(row.net_hours_worked ?? row.hours_worked ?? 0) * 60);
      attendanceByEmployee.set(row.user_id, (attendanceByEmployee.get(row.user_id) ?? 0) + minutes);
    }
    const employeeIds = new Set([...minutesByEmployee.keys(), ...attendanceByEmployee.keys()]);
    const employees = [...employeeIds].map(user_id => {
      const project_minutes = minutesByEmployee.get(user_id) ?? 0;
      const attended_minutes = attendanceByEmployee.get(user_id) ?? 0;
      return { user_id, employee: entries.find(entry => entry.user_id === user_id)?.user.name ?? 'Inactive employee', project_minutes, attended_minutes, utilization_percent: attended_minutes > 0 ? Number((project_minutes * 100 / attended_minutes).toFixed(1)) : null, exceeds_attendance: project_minutes > attended_minutes && attended_minutes > 0 };
    });
    const totalMinutes = entries.reduce((sum, row) => sum + row.minutes, 0);
    const allTimeMinutes = await prisma.timeEntry.aggregate({ where: { org_id: req.user!.org_id, project_id: projectId, ended_at: { not: null }, status: { in: ['submitted', 'approved', 'locked'] } }, _sum: { minutes: true } });
    const budgetBurnMinutes = allTimeMinutes._sum.minutes ?? 0;
    const dayRows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({ date: row.date, minutes: row.minutes, employee_count: row.employees.size }));
    ok(res, {
      project, period: { from: from.toISOString(), to: to.toISOString() }, entries: entries.map(entry => ({ id: entry.id, user_id: entry.user_id, employee: entry.user.name, task_id: entry.task_id, task: entry.task?.title ?? null, started_at: entry.started_at, ended_at: entry.ended_at, minutes: entry.minutes, status: entry.status })),
      employees, days: dayRows, total_minutes: totalMinutes, total_hours: Number((totalMinutes / 60).toFixed(2)),
      budget_hours: project.budget_hours, budget_burn_minutes: budgetBurnMinutes,
      budget_remaining_hours: project.budget_hours === null ? null : Number((Number(project.budget_hours) - budgetBurnMinutes / 60).toFixed(2)),
      allocation_warnings: employees.filter(employee => employee.exceeds_attendance),
    });
  } catch (error) { next(error); }
});

export default router;
