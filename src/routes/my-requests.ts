import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import prisma from '../utils/prisma';
import { decodeCursor, encodeCursor, keysetAfter, type CursorPosition } from '../utils/cursor';
import { ok, ValidationError } from '../utils/response';

const router = Router();
router.use(authenticate);

const TYPES = ['leave', 'remote', 'overtime', 'expense', 'attendance_correction', 'shift_swap', 'availability', 'late_notice'] as const;
type RequestType = typeof TYPES[number];
type StreamPosition = { at: Date; id: string };
type RequestItem = {
  id: string;
  type: RequestType;
  title: string;
  detail: string;
  status: string;
  submitted_at: Date;
  decision_note: string | null;
  href: string;
  source_id: string;
};

router.get('/me', async (req, res, next) => {
  try {
    const limitRaw = Number.parseInt(String(req.query.limit ?? '25'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 25;
    const type = typeof req.query.type === 'string' && req.query.type !== 'all' ? req.query.type : undefined;
    if (type && !TYPES.includes(type as RequestType)) throw new ValidationError('Unknown request type.');
    const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
    if (status && status.length > 30) throw new ValidationError('Status filter is too long.');
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 100) throw new ValidationError('Search text must be 100 characters or fewer.');
    const waitingStatuses = ['pending', 'submitted', 'awaiting_review', 'in_progress'];
    const statusFilter = status === 'waiting' ? { status: { in: waitingStatuses } }
      : status === 'decided' ? { status: { notIn: waitingStatuses } }
        : status ? { status } : {};

    const filter = { org_id: req.user!.org_id, user_id: req.user!.sub, ...(type ? { type } : {}), ...statusFilter, ...(q ? { q } : {}) };
    let cursorPositions: Partial<Record<RequestType, StreamPosition>> = {};
    if (typeof req.query.cursor === 'string') {
      const decoded = decodeCursor(req.query.cursor, filter);
      if (!decoded) throw new ValidationError('Invalid or expired request cursor. Refresh and try again.');
      try {
        const value = JSON.parse(decoded.id) as Record<string, { at?: unknown; id?: unknown }>;
        for (const [key, position] of Object.entries(value)) {
          if (!TYPES.includes(key as RequestType) || typeof position?.at !== 'string' || typeof position.id !== 'string') throw new Error('shape');
          const at = new Date(position.at);
          if (!Number.isFinite(at.getTime())) throw new Error('date');
          cursorPositions[key as RequestType] = { at, id: position.id };
        }
      } catch {
        throw new ValidationError('Invalid or expired request cursor. Refresh and try again.');
      }
    }

    const makeWhere = (base: Record<string, unknown>, position: StreamPosition | undefined, searchFields: string[]) => {
      const clauses: Record<string, unknown>[] = [base];
      if (position) clauses.push(keysetAfter(position, 'created_at'));
      if (q && searchFields.length) clauses.push({ OR: searchFields.map(field => ({ [field]: { contains: q, mode: 'insensitive' } })) });
      return clauses.length > 1 ? { AND: clauses } : base;
    };
    const userId = req.user!.sub;
    const orgId = req.user!.org_id;
    const sources: Array<{ type: RequestType; label: string; query: () => Promise<any[]>; map: (row: any) => Omit<RequestItem, 'source_id'> }> = [
      { type: 'leave' as const, label: 'Leave', query: () => prisma.leaveRequest.findMany({ where: makeWhere({ user_id: userId, org_id: orgId, ...statusFilter }, cursorPositions.leave, ['leave_type', 'reason', 'rejection_reason']), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'leave' as const, title: `${String(row.leave_type || 'Leave').replace(/_/g, ' ')} leave`, detail: `${row.start_date.toISOString().slice(0, 10)}${row.end_date.getTime() !== row.start_date.getTime() ? ` – ${row.end_date.toISOString().slice(0, 10)}` : ''}`, status: row.status, submitted_at: row.created_at, decision_note: row.rejection_reason, href: '/leave' }) },
      { type: 'remote' as const, label: 'Remote work', query: () => prisma.remoteSession.findMany({ where: makeWhere({ user_id: userId, attendance: { org_id: orgId }, ...statusFilter }, cursorPositions.remote, ['duration_type', 'review_note']), include: { attendance: { select: { date: true } } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'remote' as const, title: `${String(row.duration_type || 'full day').replace(/_/g, ' ')} remote work`, detail: row.attendance?.date?.toISOString().slice(0, 10) ?? 'Remote work request', status: row.status, submitted_at: row.created_at, decision_note: row.review_note, href: '/remote/me' }) },
      { type: 'overtime' as const, label: 'Overtime', query: () => prisma.overtimeRequest.findMany({ where: makeWhere({ user_id: userId, org_id: orgId, ...statusFilter }, cursorPositions.overtime, ['reason', 'rejection_reason']), include: { attendance: { select: { date: true } } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'overtime' as const, title: 'Overtime request', detail: `${Math.round(row.requested_minutes / 6) / 10} hours${row.attendance?.date ? ` · ${row.attendance.date.toISOString().slice(0, 10)}` : ''}`, status: row.status, submitted_at: row.created_at, decision_note: row.rejection_reason, href: '/overtime' }) },
      { type: 'expense' as const, label: 'Expenses', query: () => prisma.expenseClaim.findMany({ where: makeWhere({ user_id: userId, org_id: orgId, ...statusFilter }, cursorPositions.expense, ['description', 'category', 'review_note']), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'expense' as const, title: row.description || row.category || 'Expense claim', detail: `${row.currency} ${Number(row.amount).toLocaleString()}`, status: row.status, submitted_at: row.created_at, decision_note: row.review_note, href: '/my-requests?type=expense' }) },
      { type: 'attendance_correction' as const, label: 'Attendance corrections', query: () => prisma.attendanceCorrection.findMany({ where: makeWhere({ user_id: userId, org_id: orgId, ...statusFilter }, cursorPositions.attendance_correction, ['reason', 'review_note']), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'attendance_correction' as const, title: 'Attendance correction', detail: row.date.toISOString().slice(0, 10), status: row.status, submitted_at: row.created_at, decision_note: row.review_note, href: '/attendance' }) },
      { type: 'shift_swap' as const, label: 'Shift swaps', query: () => prisma.shiftSwap.findMany({ where: makeWhere({ OR: [{ requester_id: userId, requester_assignment: { shift: { org_id: orgId } } }, { target_id: userId, target_assignment: { shift: { org_id: orgId } } }], ...statusFilter }, cursorPositions.shift_swap, ['reason', 'rejection_reason']), include: { requester_assignment: { include: { shift: true } }, target_assignment: { include: { shift: true } }, target: { select: { name: true } } }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'shift_swap' as const, title: 'Shift swap', detail: `${row.requester_assignment?.shift?.name ?? 'Your shift'} ↔ ${row.target_assignment?.shift?.name ?? row.target?.name ?? 'teammate'}`, status: row.status, submitted_at: row.created_at, decision_note: row.rejection_reason, href: '/shifts/swaps' }) },
      { type: 'availability' as const, label: 'Shift availability', query: () => prisma.shiftAvailability.findMany({ where: makeWhere({ user_id: userId, org_id: orgId, ...statusFilter }, cursorPositions.availability, ['note', 'review_note']), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'availability' as const, title: 'Shift availability', detail: row.date?.toISOString().slice(0, 10) ?? (row.weekday != null ? `Weekly preference · day ${row.weekday + 1}` : 'Availability preference'), status: row.status, submitted_at: row.created_at, decision_note: row.review_note, href: '/shifts/availability' }) },
      { type: 'late_notice' as const, label: 'Late arrival notices', query: () => prisma.lateArrivalNotice.findMany({ where: makeWhere({ user_id: userId, org_id: orgId, ...statusFilter }, cursorPositions.late_notice, ['reason', 'expected_time']), orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 }), map: (row: any) => ({ id: row.id, type: 'late_notice' as const, title: 'Late arrival notice', detail: `${row.date.toISOString().slice(0, 10)}${row.expected_time ? ` · expected ${row.expected_time}` : ''} · ${row.reason}`, status: row.status, submitted_at: row.created_at, decision_note: null, href: '/attendance' }) },
    ].filter(source => !type || source.type === type);

    const results = await Promise.all(sources.map(async source => ({ source, result: await source.query() })).map(promise => promise.then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason }))));
    const unavailable: string[] = [];
    const merged: Array<RequestItem & { _source: RequestType }> = [];
    const nextPositions = { ...cursorPositions };
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const source = sources[index];
      if (result.status === 'rejected') { unavailable.push(source.label); continue; }
      for (const row of result.value.result) merged.push({ ...source.map(row), source_id: row.id, _source: source.type });
    }
    merged.sort((a, b) => b.submitted_at.getTime() - a.submitted_at.getTime() || a.type.localeCompare(b.type) || b.id.localeCompare(a.id));
    const page = merged.slice(0, limit);
    for (const item of page) nextPositions[item._source] = { at: item.submitted_at, id: item.source_id };
    const hasMore = merged.length > page.length || unavailable.length > 0;
    const nextCursor = hasMore && page.length
      ? encodeCursor({ at: new Date(), id: JSON.stringify(Object.fromEntries(Object.entries(nextPositions).map(([key, value]) => [key, value ? { at: value.at.toISOString(), id: value.id } : undefined]).filter(([, value]) => value))) }, filter)
      : null;

    ok(res, { items: page.map(({ _source, source_id, ...item }) => item), next_cursor: nextCursor, has_more: hasMore, limit, unavailable });
  } catch (error) { next(error); }
});

export default router;
