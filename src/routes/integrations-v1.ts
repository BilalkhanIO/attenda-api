import { Router } from 'express';
import { authenticateApiKey, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { attendanceExportQuerySchema, employeeDirectoryQuerySchema, leaveExportQuerySchema } from '../schemas/api-keys';
import { decodeCursor, encodeCursor, keysetAfter } from '../utils/cursor';
import { ok, ValidationError } from '../utils/response';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticateApiKey);

router.get('/employees', requirePermission('employees.view', 'employees.view_team'), validate({ query: employeeDirectoryQuerySchema }), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const search = String(req.query.search ?? '').trim().slice(0, 100);
    const filters = { org_id: req.user!.org_id, reviewer_id: req.user!.sub, scope: req.permissions?.has('employees.view') ? 'all' : 'team', search };
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const position = cursor ? decodeCursor(cursor, filters) : null;
    const canViewAll = req.permissions?.has('employees.view') ?? false;
    const reports = canViewAll ? [] : await prisma.user.findMany({ where: { org_id: req.user!.org_id, manager_id: req.user!.sub, deleted_at: null }, select: { id: true } });
    const rows = reports.length === 0 && !canViewAll ? [] : await prisma.user.findMany({
      where: {
        org_id: req.user!.org_id, is_active: true, deleted_at: null,
        ...(!canViewAll ? { id: { in: reports.map(row => row.id) } } : {}),
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }, { department: { contains: search, mode: 'insensitive' as const } }] } : {}),
        ...(position ? keysetAfter(position, 'created_at') : {}),
      },
      select: { id: true, name: true, email: true, department: true, job_title: true, employment_type: true, joined_at: true, manager_id: true, created_at: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, filters) : null, has_more: hasMore, limit });
  } catch (error) { next(error); }
});

router.get('/attendance', requirePermission('attendance.view_team'), validate({ query: attendanceExportQuerySchema }), async (req, res, next) => {
  try {
    const { from, to, limit } = req.query as unknown as { from: string; to: string; limit: number };
    const startDate = new Date(`${from}T00:00:00.000Z`);
    const endDate = new Date(`${to}T00:00:00.000Z`);
    if (endDate.getTime() - startDate.getTime() > 93 * 24 * 60 * 60_000) throw new ValidationError('Date range cannot exceed 93 days');
    const canViewAll = req.permissions?.has('employees.view') ?? false;
    const reports = canViewAll ? [] : await prisma.user.findMany({ where: { org_id: req.user!.org_id, manager_id: req.user!.sub, deleted_at: null }, select: { id: true } });
    const filters = { org_id: req.user!.org_id, reviewer_id: req.user!.sub, from, to, scope: canViewAll ? 'all' : 'team' };
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const position = cursor ? decodeCursor(cursor, filters) : null;
    const rows = reports.length === 0 && !canViewAll ? [] : await prisma.attendanceRecord.findMany({
      where: {
        org_id: req.user!.org_id, date: { gte: startDate, lte: endDate },
        ...(!canViewAll ? { user_id: { in: reports.map(row => row.id) } } : {}),
        ...(position ? keysetAfter(position, 'date') : {}),
      },
      select: { id: true, user_id: true, date: true, check_in_at: true, check_out_at: true, status: true, hours_worked: true, net_hours_worked: true, late_minutes: true, break_minutes: true, overtime_hours: true },
      orderBy: [{ date: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.date, id: last.id }, filters) : null, has_more: hasMore, limit });
  } catch (error) { next(error); }
});

router.get('/leave', requirePermission('leave.view_all', 'leave.view_team'), validate({ query: leaveExportQuerySchema }), async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const canViewAll = req.permissions?.has('leave.view_all') ?? false;
    const reports = canViewAll ? [] : await prisma.user.findMany({ where: { org_id: req.user!.org_id, manager_id: req.user!.sub, deleted_at: null }, select: { id: true } });
    const filters = { org_id: req.user!.org_id, reviewer_id: req.user!.sub, scope: canViewAll ? 'all' : 'team' };
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const position = cursor ? decodeCursor(cursor, filters) : null;
    const rows = reports.length === 0 && !canViewAll ? [] : await prisma.leaveRequest.findMany({
      where: { org_id: req.user!.org_id, ...(canViewAll ? {} : { user_id: { in: reports.map(row => row.id) } }), ...(position ? keysetAfter(position, 'created_at') : {}) },
      select: { id: true, user_id: true, leave_type: true, start_date: true, end_date: true, working_days: true, status: true, reason: true, created_at: true, reviewed_at: true, review_note: true },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, filters) : null, has_more: hasMore, limit });
  } catch (error) { next(error); }
});

router.get('/projects', requirePermission('projects.view'), async (req, res, next) => {
  try {
    const canManage = req.permissions?.has('projects.manage') ?? false;
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const filters = { org_id: req.user!.org_id, user_id: req.user!.sub, scope: canManage ? 'all' : 'member' };
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const position = cursor ? decodeCursor(cursor, filters) : null;
    const rows = await prisma.project.findMany({
      where: {
        org_id: req.user!.org_id,
        ...(!canManage ? { OR: [{ owner_id: req.user!.sub }, { members: { some: { user_id: req.user!.sub } } }, { tasks: { some: { assignee_id: req.user!.sub } } }] } : {}),
        ...(position ? keysetAfter(position, 'created_at') : {}),
      },
      select: { id: true, name: true, description: true, status: true, priority: true, start_date: true, due_date: true, created_at: true, owner: { select: { id: true, name: true } }, _count: { select: { tasks: true, members: true } } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.created_at, id: last.id }, filters) : null, has_more: hasMore, limit });
  } catch (error) { next(error); }
});

export default router;
