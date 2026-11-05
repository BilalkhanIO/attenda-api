import prisma from '../utils/prisma';
import { resolveUserPermissions } from './authorization';
import { createNotification, emitOrgEvent } from './notifications';
import { setLeaveLedgerContext } from './leaveLedger';
import { recordAudit } from './audit';
import { AppError, NotFoundError, ValidationError } from '../utils/response';
import { calcHoursWorked } from '../utils/auth';
import { dateOnlyInTz } from '../utils/shift';
import { decodeCursor, encodeCursor, keysetAfterAscending } from '../utils/cursor';
import { holidaySetForRange } from './holidays';
import { reviewableEmployeeIds } from './locationScope';

export type ApprovalType = 'leave' | 'overtime' | 'remote' | 'swap' | 'late_notice' | 'expense' | 'correction' | 'timesheet';
export type ApprovalAction = 'approve' | 'reject' | 'acknowledge';

export interface ApprovalViewer { userId: string; orgId: string }
export interface ApprovalItem {
  type: ApprovalType;
  id: string;
  requester: string;
  avatarUrl?: string;
  department?: string;
  summary: string;
  detail?: string;
  createdAt?: string;
  ageHours?: number;
  ageLabel?: string;
  urgency?: 'normal' | 'aging' | 'urgent';
  sourceHref?: string;
  sourceLabel?: string;
  rejectNeedsReason: boolean;
  canAct: boolean;
  acknowledgeOnly?: boolean;
}

const dateLabel = (value: Date | null | undefined) => value ? value.toISOString().slice(0, 10) : '';
const timeLabel = (value: Date | null | undefined) => value ? value.toISOString().slice(11, 16) : undefined;
const requestTypes: ApprovalType[] = ['leave', 'overtime', 'remote', 'swap', 'late_notice', 'expense', 'correction', 'timesheet'];

async function accessContext(viewer: ApprovalViewer) {
  const permissions = await resolveUserPermissions(viewer.userId, viewer.orgId);
  const reports = async () => (await reviewableEmployeeIds(viewer.orgId, viewer.userId, permissions, 'employees.view')) ?? [];
  return { permissions, reports };
}

function scopeFor(type: ApprovalType, permissions: Set<string>, viewerId: string, reports: string[]) {
  if (type === 'leave' && permissions.has('leave.view_all')) return undefined;
  if (type === 'remote' || type === 'late_notice') return permissions.has('employees.view') ? undefined : reports;
  if (type === 'leave' || type === 'swap') return permissions.has('employees.view') ? undefined : reports;
  if (type === 'correction') return permissions.has('employees.view') ? undefined : reports;
  if (type === 'timesheet') return permissions.has('employees.view') ? undefined : reports;
  if (type === 'expense') return permissions.has('expenses.manage') || permissions.has('employees.view') ? undefined : reports;
  if (type === 'overtime') return permissions.has('employees.view') ? undefined : reports;
  return undefined;
}

function hasTypePermission(type: ApprovalType, permissions: Set<string>): boolean {
  switch (type) {
    case 'leave': return permissions.has('leave.approve');
    case 'overtime': return permissions.has('overtime.manage');
    case 'remote': return permissions.has('remote.approve');
    case 'swap': return permissions.has('shifts.swaps.approve');
    case 'late_notice': return permissions.has('attendance.late_notices.manage');
    case 'expense': return permissions.has('expenses.view') || permissions.has('expenses.manage');
    case 'correction': return permissions.has('attendance.override');
    case 'timesheet': return permissions.has('time.approve');
  }
}

/** Build the shared, permission-scoped approval inbox used by the UI and AI. */
export async function listPendingApprovals(
  viewer: ApprovalViewer,
  typeFilter?: ApprovalType | 'all',
  pagination?: { enabled: boolean; cursor?: string; limit: number },
): Promise<{ total?: number; availableTypes: ApprovalType[]; countsByType: Partial<Record<ApprovalType, number>>; items: ApprovalItem[]; next_cursor?: string | null; has_more?: boolean; limit?: number; counts_are_page_local?: boolean }> {
  const { permissions, reports } = await accessContext(viewer);
  const permittedTypes = requestTypes.filter(type => hasTypePermission(type, permissions));
  const selectedTypes = typeFilter && typeFilter !== 'all'
    ? permittedTypes.filter(type => type === typeFilter)
    : permittedTypes;
  const cursorFilters = { org_id: viewer.orgId, user_id: viewer.userId, type: typeFilter ?? 'all', permitted_types: selectedTypes };
  const position = pagination?.enabled && pagination.cursor ? decodeCursor(pagination.cursor, cursorFilters) : null;
  const pageTake = pagination?.enabled ? pagination.limit + 1 : 200;
  const after = (type: ApprovalType, field: 'created_at' | 'submitted_at' = 'created_at') => position
    ? keysetAfterAscending(position, field, type, requestTypes)
    : {};
  const reportIds = selectedTypes.some(type => scopeFor(type, permissions, viewer.userId, []) !== undefined)
    ? await reports() : [];
  const items: ApprovalItem[] = [];

  for (const type of selectedTypes) {
    const scopedIds = scopeFor(type, permissions, viewer.userId, reportIds);
    if (scopedIds && scopedIds.length === 0) continue;
    const userWhere = scopedIds ? { in: scopedIds } : undefined;

    if (type === 'leave') {
      const rows = await prisma.leaveRequest.findMany({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }), ...after(type) }, include: { user: { select: { name: true, avatar_url: true, department: true } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      const shifts = rows.length ? await prisma.shiftAssignment.findMany({
        where: { user_id: { in: [...new Set(rows.map(row => row.user_id))] }, date: { gte: rows.reduce((min, row) => row.start_date < min ? row.start_date : min, rows[0].start_date), lte: rows.reduce((max, row) => row.end_date > max ? row.end_date : max, rows[0].end_date) } },
        select: { user_id: true, date: true },
      }) : [];
      items.push(...rows.map(row => {
        const conflictCount = shifts.filter(shift => shift.user_id === row.user_id && shift.date >= row.start_date && shift.date <= row.end_date).length;
        const conflictNote = conflictCount ? `⚠ Overlaps ${conflictCount} scheduled shift${conflictCount === 1 ? '' : 's'}; reassign them before approving.` : undefined;
        return { type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `${row.leave_type} leave · ${dateLabel(row.start_date)} – ${dateLabel(row.end_date)} · ${row.working_days} day${row.working_days === 1 ? '' : 's'}`, detail: [row.reason, conflictNote].filter(Boolean).join('\n') || undefined, createdAt: row.created_at.toISOString(), rejectNeedsReason: true, canAct: true };
      }));
    } else if (type === 'overtime') {
      const rows = await prisma.overtimeRequest.findMany({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }), ...after(type) }, include: { user: { select: { name: true, avatar_url: true, department: true } }, attendance: { select: { date: true } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      const leaves = rows.length ? await prisma.leaveRequest.findMany({ where: { status: 'approved', user_id: { in: [...new Set(rows.map(row => row.user_id))] }, start_date: { lte: rows.reduce((max, row) => row.attendance.date > max ? row.attendance.date : max, rows[0].attendance.date) }, end_date: { gte: rows.reduce((min, row) => row.attendance.date < min ? row.attendance.date : min, rows[0].attendance.date) } }, select: { user_id: true, start_date: true, end_date: true } }) : [];
      items.push(...rows.map(row => {
        const conflict = leaves.some(leave => leave.user_id === row.user_id && leave.start_date <= row.attendance.date && leave.end_date >= row.attendance.date);
        return { type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `${row.requested_minutes} minutes overtime · ${dateLabel(row.attendance.date)}`, detail: [row.reason, conflict ? '⚠ This date overlaps approved leave.' : undefined].filter(Boolean).join('\n') || undefined, createdAt: row.created_at.toISOString(), rejectNeedsReason: true, canAct: true };
      }));
    } else if (type === 'remote') {
      const rows = await prisma.remoteSession.findMany({ where: { status: 'pending', user: { org_id: viewer.orgId, ...(userWhere && { id: userWhere }) }, ...after(type) }, include: { user: { select: { name: true, avatar_url: true, department: true } }, attendance: { select: { date: true } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      const leaves = rows.length ? await prisma.leaveRequest.findMany({ where: { status: 'approved', user_id: { in: [...new Set(rows.map(row => row.user_id))] }, start_date: { lte: rows.reduce((max, row) => row.attendance.date > max ? row.attendance.date : max, rows[0].attendance.date) }, end_date: { gte: rows.reduce((min, row) => row.attendance.date < min ? row.attendance.date : min, rows[0].attendance.date) } }, select: { user_id: true, start_date: true, end_date: true } }) : [];
      items.push(...rows.map(row => {
        const conflict = leaves.some(leave => leave.user_id === row.user_id && leave.start_date <= row.attendance.date && leave.end_date >= row.attendance.date);
        return { type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `Remote work · ${row.duration_type.replace(/_/g, ' ')} · ${dateLabel(row.attendance.date)}`, detail: [row.review_note, conflict ? '⚠ This date overlaps approved leave.' : undefined].filter(Boolean).join('\n') || undefined, createdAt: row.created_at.toISOString(), rejectNeedsReason: true, canAct: true };
      }));
    } else if (type === 'swap') {
      const rows = await prisma.shiftSwap.findMany({ where: { status: 'pending', requester: { org_id: viewer.orgId, ...(userWhere && { id: userWhere }) }, ...after(type) }, include: { requester: { select: { name: true, avatar_url: true, department: true } }, target: { select: { name: true } }, requester_assignment: { include: { shift: { select: { name: true } } } }, target_assignment: { include: { shift: { select: { name: true } } } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      items.push(...rows.map(row => ({ type, id: row.id, requester: row.requester.name, avatarUrl: row.requester.avatar_url ?? undefined, department: row.requester.department ?? undefined, summary: `Shift swap with ${row.target.name} · ${row.requester_assignment.shift.name} for ${row.target_assignment.shift.name}`, detail: row.reason ?? undefined, createdAt: row.created_at.toISOString(), rejectNeedsReason: true, canAct: true })));
    } else if (type === 'late_notice') {
      const org = await prisma.organisation.findUnique({ where: { id: viewer.orgId }, select: { timezone: true } });
      const today = dateOnlyInTz(new Date(), org?.timezone ?? 'UTC');
      const rows = await prisma.lateArrivalNotice.findMany({ where: { org_id: viewer.orgId, status: 'pending', date: { gte: today }, ...(userWhere && { user_id: userWhere }), ...after(type) }, include: { user: { select: { name: true, avatar_url: true, department: true } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      items.push(...rows.map(row => ({ type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `Late arrival · ${dateLabel(row.date)} · expected ${row.expected_time}`, detail: row.reason, createdAt: row.created_at.toISOString(), rejectNeedsReason: false, canAct: true, acknowledgeOnly: true })));
    } else if (type === 'expense') {
      const rows = await prisma.expenseClaim.findMany({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }), ...after(type) }, include: { user: { select: { name: true, avatar_url: true, department: true } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      items.push(...rows.map(row => ({ type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `${row.category} · ${row.currency} ${Number(row.amount).toFixed(2)} · ${dateLabel(row.expense_date)}`, detail: row.description, createdAt: row.created_at.toISOString(), rejectNeedsReason: true, canAct: permissions.has('expenses.manage') })));
    } else if (type === 'timesheet') {
      const rows = await prisma.timesheet.findMany({ where: { org_id: viewer.orgId, status: 'submitted', ...(userWhere && { user_id: userWhere }), ...after(type, 'submitted_at') }, include: { user: { select: { name: true, avatar_url: true, department: true } } }, orderBy: { submitted_at: 'asc' }, take: pageTake });
      const ranges = await Promise.all(rows.map(async row => {
        const end = new Date(row.week_start); end.setUTCDate(end.getUTCDate() + 7);
        const total = await prisma.timeEntry.aggregate({ where: { org_id: viewer.orgId, user_id: row.user_id, started_at: { gte: row.week_start, lt: end }, status: 'submitted' }, _sum: { minutes: true } });
        return { row, minutes: total._sum.minutes ?? 0 };
      }));
      items.push(...ranges.map(({ row, minutes }) => ({ type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `Timesheet · week of ${dateLabel(row.week_start)} · ${(minutes / 60).toFixed(1)} hours`, detail: 'Approval locks the submitted project time entries.', createdAt: row.submitted_at?.toISOString() ?? row.created_at.toISOString(), rejectNeedsReason: true, canAct: true })));
    } else {
      const rows = await prisma.attendanceCorrection.findMany({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }), ...after(type) }, include: { user: { select: { name: true, avatar_url: true, department: true } } }, orderBy: { created_at: 'asc' }, take: pageTake });
      items.push(...rows.map(row => {
        const times = [row.requested_check_in && `check-in ${timeLabel(row.requested_check_in)}`, row.requested_check_out && `check-out ${timeLabel(row.requested_check_out)}`].filter(Boolean).join(' · ');
        return { type, id: row.id, requester: row.user.name, avatarUrl: row.user.avatar_url ?? undefined, department: row.user.department ?? undefined, summary: `Attendance correction · ${dateLabel(row.date)}${times ? ` · ${times}` : ''}`, detail: row.reason, createdAt: row.created_at.toISOString(), rejectNeedsReason: true, canAct: true };
      }));
    }
  }

  const sourcePages: Record<ApprovalType, { href: string; label: string }> = {
    leave: { href: '/leave', label: 'Open leave' },
    overtime: { href: '/overtime', label: 'Open overtime' },
    remote: { href: '/remote', label: 'Open remote work' },
    swap: { href: '/shifts/swaps', label: 'Open shift swaps' },
    late_notice: { href: '/attendance', label: 'Open attendance' },
    expense: { href: '/approvals/expense', label: 'Open expense request' },
    correction: { href: '/attendance', label: 'Open attendance' },
    timesheet: { href: '/projects/time', label: 'Open timesheet' },
  };
  const now = Date.now();
  for (const item of items) {
    const submitted = item.createdAt ? new Date(item.createdAt).getTime() : now;
    item.ageHours = Math.max(0, Math.floor((now - submitted) / 3_600_000));
    item.ageLabel = item.ageHours < 1 ? 'Just now' : item.ageHours < 24 ? `${item.ageHours}h waiting` : `${Math.floor(item.ageHours / 24)}d waiting`;
    item.urgency = item.ageHours >= 72 ? 'urgent' : item.ageHours >= 24 ? 'aging' : 'normal';
    item.sourceHref = sourcePages[item.type].href;
    item.sourceLabel = sourcePages[item.type].label;
  }
  items.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || requestTypes.indexOf(a.type) - requestTypes.indexOf(b.type) || a.id.localeCompare(b.id));
  const hasMore = !!pagination?.enabled && items.length > pagination.limit;
  const pageItems = pagination?.enabled ? items.slice(0, pagination.limit) : items;
  const countsByType: Partial<Record<ApprovalType, number>> = {};
  if (pagination?.enabled) {
    for (const item of pageItems) countsByType[item.type] = (countsByType[item.type] ?? 0) + 1;
  } else {
    const exactCounts = await Promise.all(selectedTypes.map(async type => {
      const scopedIds = scopeFor(type, permissions, viewer.userId, reportIds);
      if (scopedIds && scopedIds.length === 0) return [type, 0] as const;
      const userWhere = scopedIds ? { in: scopedIds } : undefined;
      let count: number;
      switch (type) {
        case 'leave': count = await prisma.leaveRequest.count({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }) } }); break;
        case 'overtime': count = await prisma.overtimeRequest.count({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }) } }); break;
        case 'remote': count = await prisma.remoteSession.count({ where: { status: 'pending', user: { org_id: viewer.orgId, ...(userWhere && { id: userWhere }) } } }); break;
        case 'swap': count = await prisma.shiftSwap.count({ where: { status: 'pending', requester: { org_id: viewer.orgId, ...(userWhere && { id: userWhere }) } } }); break;
        case 'late_notice': {
          const org = await prisma.organisation.findUnique({ where: { id: viewer.orgId }, select: { timezone: true } });
          const today = dateOnlyInTz(new Date(), org?.timezone ?? 'UTC');
          count = await prisma.lateArrivalNotice.count({ where: { org_id: viewer.orgId, status: 'pending', date: { gte: today }, ...(userWhere && { user_id: userWhere }) } });
          break;
        }
        case 'expense': count = await prisma.expenseClaim.count({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }) } }); break;
        case 'correction': count = await prisma.attendanceCorrection.count({ where: { org_id: viewer.orgId, status: 'pending', ...(userWhere && { user_id: userWhere }) } }); break;
        case 'timesheet': count = await prisma.timesheet.count({ where: { org_id: viewer.orgId, status: 'submitted', ...(userWhere && { user_id: userWhere }) } }); break;
      }
      return [type, count] as const;
    }));
    for (const [type, count] of exactCounts) countsByType[type] = count;
  }
  const last = pageItems[pageItems.length - 1];
  return {
    ...(pagination?.enabled ? { next_cursor: hasMore && last?.createdAt ? encodeCursor({ at: new Date(last.createdAt), id: last.id, tie: last.type }, cursorFilters) : null, has_more: hasMore, limit: pagination.limit, counts_are_page_local: true } : { total: Object.values(countsByType).reduce((sum, count) => sum + (count ?? 0), 0) }),
    availableTypes: permittedTypes, countsByType, items: pageItems,
  };
}

async function assertReviewerScope(viewer: ApprovalViewer, type: ApprovalType, requesterId: string) {
  const { permissions } = await accessContext(viewer);
  if (type === 'leave' && permissions.has('leave.view_all')) return;
  const employeeIds = await reviewableEmployeeIds(viewer.orgId, viewer.userId, permissions, 'employees.view');
  if (employeeIds !== null && !employeeIds.includes(requesterId)) {
    throw new AppError('You can only review requests for your direct reports or managed locations', 403, 'FORBIDDEN');
  }
}

/** Apply one decision with tenant, permission, scope, and pending-state checks. */
export async function reviewApproval(
  viewer: ApprovalViewer,
  input: { type: ApprovalType; id: string; action: ApprovalAction; reason?: string; note?: string },
) {
  const { type, id, action } = input;
  const reason = input.reason?.trim() ?? '';
  const note = input.note?.trim() || null;
  if (!id) throw new ValidationError('An approval ID is required');
  if (!hasTypePermission(type, (await accessContext(viewer)).permissions)) throw new AppError(`You do not have permission to review ${type} requests`, 403, 'FORBIDDEN');
  if (action === 'reject' && reason.length < 5) throw new ValidationError('A rejection reason of at least 5 characters is required');
  if (type === 'late_notice' && action !== 'acknowledge') throw new ValidationError('Late-arrival notices can only be acknowledged');
  if (type !== 'late_notice' && action === 'acknowledge') throw new ValidationError('Only late-arrival notices can be acknowledged');

  const now = new Date();
  const actionPast = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'acknowledged';
  let requesterId = '';
  let requesterName = 'Employee';
  let summary = '';
  let event: Parameters<typeof emitOrgEvent>[1] = 'attendance_changed';
  let notification: { type: any; title: string; body: string; actionType: string } | undefined;
  let audit: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; reason?: string } | undefined;

  if (type === 'leave') {
    const request = await prisma.leaveRequest.findFirst({ where: { id, org_id: viewer.orgId }, include: { user: { select: { name: true, primary_location_id: true } } } });
    if (!request) throw new NotFoundError('Leave request');
    await assertReviewerScope(viewer, type, request.user_id);
    if (action === 'approve') {
      const locationId = request.location_id ?? request.user.primary_location_id;
      const holidays = await holidaySetForRange(viewer.orgId, request.start_date, request.end_date, locationId);
      const scheduledShifts = await prisma.shiftAssignment.findMany({
        where: { user_id: request.user_id, date: { gte: request.start_date, lte: request.end_date } },
        select: { date: true },
      });
      if (scheduledShifts.length) throw new ValidationError('This leave overlaps scheduled shifts. Reassign or remove those shifts before approving the leave.');
      await prisma.$transaction(async tx => {
        const claimed = await tx.leaveRequest.updateMany({ where: { id, org_id: viewer.orgId, status: 'pending' }, data: { status: 'approved', reviewed_by: viewer.userId, reviewed_at: now } });
        if (!claimed.count) throw new ValidationError('This request has already been reviewed');
        await setLeaveLedgerContext(tx, { reason: 'usage', refId: request.id, actorId: viewer.userId, note: 'Approved leave request' });
        await tx.leaveBalance.updateMany({ where: { user_id: request.user_id, leave_type: request.leave_type, year: request.start_date.getUTCFullYear() }, data: { used_days: { increment: request.working_days } } });
        const status = request.is_half_day || !!request.leave_start_time ? 'half_leave' : 'leave';
        const day = new Date(request.start_date);
        while (day <= request.end_date) {
          if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !holidays.has(day.toISOString().slice(0, 10))) {
            const date = new Date(day);
            const existing = await tx.attendanceRecord.findUnique({ where: { user_id_date: { user_id: request.user_id, date } } });
            if (status === 'half_leave' && existing?.check_in_at) {
              await tx.attendanceRecord.update({ where: { id: existing.id }, data: { status } });
            } else {
              await tx.attendanceRecord.upsert({ where: { user_id_date: { user_id: request.user_id, date } }, update: { status }, create: { user_id: request.user_id, org_id: viewer.orgId, location_id: locationId, date, check_in_type: 'manual', status } });
            }
          }
          day.setUTCDate(day.getUTCDate() + 1);
        }
      });
    } else {
      await prisma.$transaction(async tx => {
        const changed = await tx.leaveRequest.updateMany({ where: { id, org_id: viewer.orgId, status: 'pending' }, data: { status: 'rejected', reviewed_by: viewer.userId, reviewed_at: now, rejection_reason: reason } });
        if (!changed.count) throw new ValidationError('This request has already been reviewed');
      });
    }
    requesterId = request.user_id; requesterName = request.user.name; event = 'leave_changed';
    notification = { type: action === 'approve' ? 'leave_approved' : 'leave_rejected', title: `Leave ${actionPast}`, body: action === 'approve' ? `Your ${request.leave_type} leave was approved` : `Your ${request.leave_type} leave was rejected: ${reason}`, actionType: 'leave_request' };
    summary = `${requesterName}'s ${request.leave_type} leave was ${actionPast}`;
    audit = { action: `leave.${action}`, entityType: 'leave_request', entityId: id, before: { status: 'pending' }, after: { status: action === 'approve' ? 'approved' : 'rejected' }, reason: action === 'reject' ? reason : note ?? undefined };
  } else if (type === 'overtime') {
    const request = await prisma.overtimeRequest.findFirst({ where: { id, org_id: viewer.orgId }, include: { attendance: true, user: { select: { id: true, name: true } } } });
    if (!request) throw new NotFoundError('Overtime request');
    await assertReviewerScope(viewer, type, request.user_id);
    await prisma.$transaction(async tx => {
      const changed = await tx.overtimeRequest.updateMany({ where: { id, org_id: viewer.orgId, status: 'pending' }, data: { status: action === 'approve' ? 'approved' : 'rejected', reviewed_by: viewer.userId, reviewed_at: now, rejection_reason: action === 'reject' ? reason : null } });
      if (!changed.count) throw new ValidationError('This request has already been reviewed');
      if (action === 'approve') await tx.attendanceRecord.update({ where: { id: request.attendance_id }, data: { overtime_hours: Number((request.requested_minutes / 60).toFixed(2)), extra_office_minutes: Math.max(0, (request.attendance.extra_office_minutes ?? 0) - request.requested_minutes) } });
    });
    requesterId = request.user_id; requesterName = request.user.name; event = 'overtime_changed';
    notification = { type: action === 'approve' ? 'overtime_approved' : 'overtime_rejected', title: `Overtime ${actionPast}`, body: action === 'approve' ? `Your ${request.requested_minutes}-minute overtime request was approved` : `Your overtime request was rejected: ${reason}`, actionType: 'overtime_request' };
    summary = `${requesterName}'s overtime request was ${actionPast}`;
    audit = { action: `overtime.${action}`, entityType: 'overtime_request', entityId: id, before: { status: 'pending' }, after: { status: action === 'approve' ? 'approved' : 'rejected' }, reason: action === 'reject' ? reason : note ?? undefined };
  } else if (type === 'remote') {
    const request = await prisma.remoteSession.findFirst({ where: { id, user: { org_id: viewer.orgId } }, include: { user: { select: { id: true, name: true } }, attendance: { select: { check_in_at: true } } } });
    if (!request) throw new NotFoundError('Remote-work request');
    await assertReviewerScope(viewer, type, request.user_id);
    await prisma.$transaction(async tx => {
      const changed = await tx.remoteSession.updateMany({ where: { id, status: 'pending', user: { org_id: viewer.orgId } }, data: { status: action === 'approve' ? 'approved' : 'rejected', approved_by: viewer.userId, reviewed_at: now, review_note: action === 'reject' ? reason : note } });
      if (!changed.count) throw new ValidationError('This request has already been reviewed');
      if (action === 'reject' && !request.attendance.check_in_at) await tx.attendanceRecord.updateMany({ where: { id: request.attendance_id, check_in_at: null }, data: { status: 'absent' } });
    });
    requesterId = request.user_id; requesterName = request.user.name; event = 'remote_changed';
    notification = { type: action === 'approve' ? 'remote_approved' : 'remote_rejected', title: `Remote work ${actionPast}`, body: action === 'approve' ? 'Your remote work request was approved' : `Your remote work request was rejected: ${reason}`, actionType: 'remote_session' };
    summary = `${requesterName}'s remote-work request was ${actionPast}`;
    audit = { action: `remote.${action}`, entityType: 'remote_session', entityId: id, before: { status: 'pending' }, after: { status: action === 'approve' ? 'approved' : 'rejected' }, reason: action === 'reject' ? reason : note ?? undefined };
  } else if (type === 'swap') {
    const request = await prisma.shiftSwap.findFirst({ where: { id, requester: { org_id: viewer.orgId } }, include: { requester: { select: { id: true, name: true } }, requester_assignment: true, target_assignment: { include: { user: { select: { id: true, name: true } } } } } });
    if (!request) throw new NotFoundError('Shift swap request');
    await assertReviewerScope(viewer, type, request.requester_id);
    await prisma.$transaction(async tx => {
      const changed = await tx.shiftSwap.updateMany({ where: { id, status: 'pending' }, data: { status: action === 'approve' ? 'approved' : 'rejected', manager_id: viewer.userId, rejection_reason: action === 'reject' ? reason : null } });
      if (!changed.count) throw new ValidationError('This request has already been reviewed');
      if (action === 'approve') {
        const [requesterLeave, targetLeave] = await Promise.all([
          tx.leaveRequest.findFirst({ where: { status: 'approved', user_id: request.requester_id, start_date: { lte: request.requester_assignment.date }, end_date: { gte: request.requester_assignment.date } }, select: { id: true } }),
          tx.leaveRequest.findFirst({ where: { status: 'approved', user_id: request.target_assignment.user_id, start_date: { lte: request.target_assignment.date }, end_date: { gte: request.target_assignment.date } }, select: { id: true } }),
        ]);
        if (requesterLeave || targetLeave) throw new ValidationError('This shift swap conflicts with approved leave for one of the employees');
        await tx.shiftAssignment.update({ where: { id: request.requester_assign_id }, data: { shift_id: request.target_assignment.shift_id } });
        await tx.shiftAssignment.update({ where: { id: request.target_assign_id }, data: { shift_id: request.requester_assignment.shift_id } });
      }
    });
    requesterId = request.requester_id; requesterName = request.requester.name; event = 'swap_changed';
    notification = { type: action === 'approve' ? 'shift_swap_approved' : 'shift_swap_rejected', title: `Shift swap ${actionPast}`, body: action === 'approve' ? 'Your shift swap was approved' : `Your shift swap was rejected: ${reason}`, actionType: 'shift_swap' };
    summary = `${requesterName}'s shift swap was ${actionPast}`;
    audit = { action: `shift_swap.${action}`, entityType: 'shift_swap', entityId: id, before: { status: 'pending' }, after: { status: action === 'approve' ? 'approved' : 'rejected' }, reason: action === 'reject' ? reason : note ?? undefined };
  } else if (type === 'late_notice') {
    const org = await prisma.organisation.findUnique({ where: { id: viewer.orgId }, select: { timezone: true } });
    const today = dateOnlyInTz(now, org?.timezone ?? 'UTC');
    const request = await prisma.lateArrivalNotice.findFirst({ where: { id, org_id: viewer.orgId }, include: { user: { select: { id: true, name: true } } } });
    if (!request) throw new NotFoundError('Late-arrival notice');
    if (request.date < today) throw new ValidationError('Past late-arrival notices cannot be acknowledged');
    await assertReviewerScope(viewer, type, request.user_id);
    await prisma.$transaction(async tx => {
      const changed = await tx.lateArrivalNotice.updateMany({ where: { id, org_id: viewer.orgId, status: 'pending' }, data: { status: 'acknowledged', acknowledged_by: viewer.userId, acknowledged_at: now } });
      if (!changed.count) throw new ValidationError('This notice has already been acknowledged');
    });
    requesterId = request.user_id; requesterName = request.user.name;
    notification = { type: 'late_notice_ack', title: 'Late notice acknowledged', body: `Your late-arrival notice for ${dateLabel(request.date)} was acknowledged`, actionType: 'attendance' };
    summary = `${requesterName}'s late-arrival notice was acknowledged`;
    audit = { action: 'attendance.late_notice.acknowledge', entityType: 'late_arrival_notice', entityId: id, before: { status: 'pending' }, after: { status: 'acknowledged' } };
  } else if (type === 'correction') {
    const request = await prisma.attendanceCorrection.findFirst({ where: { id, org_id: viewer.orgId }, include: { user: { select: { id: true, name: true } } } });
    if (!request) throw new NotFoundError('Attendance correction');
    await assertReviewerScope(viewer, type, request.user_id);
    await prisma.$transaction(async tx => {
      if (action === 'approve') {
        const processedPayroll = await tx.payrollRecord.findFirst({
          where: {
            org_id: viewer.orgId,
            user_id: request.user_id,
            period_month: request.date.getUTCMonth() + 1,
            period_year: request.date.getUTCFullYear(),
            status: 'processed',
          },
          select: { id: true },
        });
        if (processedPayroll) throw new AppError('This attendance period is already in processed payroll. Recall the payroll run before approving this correction.', 409, 'ATTENDANCE_PERIOD_PAYROLL_PROCESSED');
      }
      const claimed = await tx.attendanceCorrection.updateMany({ where: { id, org_id: viewer.orgId, status: 'pending' }, data: { status: action === 'approve' ? 'approved' : 'rejected', reviewed_by: viewer.userId, reviewed_at: now, review_note: action === 'reject' ? reason : note } });
      if (!claimed.count) throw new ValidationError('This request has already been reviewed');
      if (action === 'reject') {
        await tx.auditLog.create({
          data: {
            org_id: viewer.orgId,
            actor_id: viewer.userId,
            action: 'attendance.correction.reject',
            entity_type: 'attendance_correction',
            entity_id: id,
            before: { status: 'pending' },
            after: { status: 'rejected' },
            reason,
          },
        });
        await tx.outboxEvent.create({
          data: {
            org_id: viewer.orgId,
            event_type: 'notification_requested',
            entity_type: 'attendance_correction',
            entity_id: id,
            payload: {
              userId: request.user_id,
              orgId: viewer.orgId,
              type: 'correction_rejected',
              title: 'Attendance correction rejected',
              body: `Your correction was rejected: ${reason}`,
              actionType: 'attendance_correction',
              actionId: id,
              dedupeKey: id,
            },
          },
        });
        return;
      }
      let record = request.attendance_id ? await tx.attendanceRecord.findFirst({ where: { id: request.attendance_id, org_id: viewer.orgId } }) : await tx.attendanceRecord.findUnique({ where: { user_id_date: { user_id: request.user_id, date: request.date } } });
      const checkIn = request.requested_check_in ?? record?.check_in_at ?? null;
      const checkOut = request.requested_check_out ?? record?.check_out_at ?? null;
      const hours = checkIn && checkOut ? calcHoursWorked(checkIn, checkOut) : record?.hours_worked ?? null;
      const before = record ? { check_in_at: record.check_in_at, check_out_at: record.check_out_at, hours_worked: record.hours_worked } : null;
      if (record) record = await tx.attendanceRecord.update({ where: { id: record.id }, data: { ...(request.requested_check_in ? { check_in_at: request.requested_check_in } : {}), ...(request.requested_check_out ? { check_out_at: request.requested_check_out } : {}), ...(hours !== null ? { hours_worked: hours } : {}), is_overridden: true, override_by: viewer.userId, override_reason: `correction: ${request.reason}` } });
      else {
        const subject = await tx.user.findFirst({ where: { id: request.user_id, org_id: viewer.orgId }, select: { primary_location_id: true } });
        record = await tx.attendanceRecord.create({ data: { user_id: request.user_id, org_id: viewer.orgId, location_id: subject?.primary_location_id ?? null, date: request.date, check_in_at: request.requested_check_in, check_out_at: request.requested_check_out, ...(hours !== null ? { hours_worked: hours } : {}), check_in_type: 'manual', status: 'in', is_overridden: true, override_by: viewer.userId, override_reason: `correction: ${request.reason}` } });
      }
      await tx.attendanceCorrection.update({ where: { id }, data: { attendance_id: record.id } });
      const actionNotification = {
        userId: request.user_id,
        orgId: viewer.orgId,
        type: action === 'approve' ? 'correction_approved' as const : 'correction_rejected' as const,
        title: `Attendance correction ${actionPast}`,
        body: action === 'approve' ? `Your correction for ${dateLabel(request.date)} was approved` : `Your correction was rejected: ${reason}`,
        actionType: 'attendance_correction',
        actionId: id,
        dedupeKey: id,
      };
      const auditAction = `attendance.correction.${action}`;
      const auditEntityType = action === 'approve' ? 'attendance_record' : 'attendance_correction';
      const auditEntityId = action === 'approve' ? record.id : id;
      const auditBefore = action === 'approve' ? before : { status: 'pending' };
      const auditAfter = action === 'approve'
        ? { check_in_at: record.check_in_at, check_out_at: record.check_out_at, hours_worked: record.hours_worked }
        : { status: 'rejected' };
      await tx.auditLog.create({
        data: {
          org_id: viewer.orgId,
          actor_id: viewer.userId,
          action: auditAction,
          entity_type: auditEntityType,
          entity_id: auditEntityId,
          before: auditBefore ?? undefined,
          after: auditAfter,
          reason: request.reason,
        },
      });
      await tx.outboxEvent.create({
        data: {
          org_id: viewer.orgId,
          event_type: 'notification_requested',
          entity_type: 'attendance_correction',
          entity_id: id,
          payload: actionNotification,
        },
      });
      return { record, before };
    });
    requesterId = request.user_id; requesterName = request.user.name; event = 'attendance_changed';
    notification = undefined;
    summary = `${requesterName}'s attendance correction was ${actionPast}`;
    audit = undefined;
  } else if (type === 'timesheet') {
    const sheet = await prisma.timesheet.findFirst({ where: { id, org_id: viewer.orgId, status: 'submitted' }, include: { user: { select: { id: true, name: true } } } });
    if (!sheet) throw new NotFoundError('Submitted timesheet');
    await assertReviewerScope(viewer, type, sheet.user_id);
    if (sheet.user_id === viewer.userId) throw new AppError('You cannot approve your own timesheet.', 403, 'MAKER_CHECKER_REQUIRED');
    const end = new Date(sheet.week_start); end.setUTCDate(end.getUTCDate() + 7);
    const targetStatus = action === 'approve' ? 'locked' : 'rejected';
    await prisma.$transaction(async tx => {
      const changed = await tx.timesheet.updateMany({ where: { id, org_id: viewer.orgId, status: 'submitted' }, data: { status: targetStatus, reviewed_by: viewer.userId, reviewed_at: now, review_note: action === 'reject' ? reason : note } });
      if (!changed.count) throw new ValidationError('This timesheet has already been reviewed');
      await tx.timeEntry.updateMany({ where: { org_id: viewer.orgId, user_id: sheet.user_id, started_at: { gte: sheet.week_start, lt: end }, status: 'submitted' }, data: { status: targetStatus } });
    });
    requesterId = sheet.user_id; requesterName = sheet.user.name; event = 'timesheet_changed';
    notification = { type: action === 'approve' ? 'timesheet_approved' : 'timesheet_rejected', title: `Timesheet ${actionPast}`, body: action === 'approve' ? 'Your timesheet was approved and locked.' : `Your timesheet was returned: ${reason}`, actionType: 'timesheet' };
    summary = `${requesterName}'s timesheet was ${actionPast}`;
    audit = { action: `timesheet.${action}`, entityType: 'timesheet', entityId: id, before: { status: 'submitted' }, after: { status: targetStatus }, reason: action === 'reject' ? reason : note ?? undefined };
  } else {
    const request = await prisma.expenseClaim.findFirst({ where: { id, org_id: viewer.orgId }, include: { user: { select: { id: true, name: true } } } });
    if (!request) throw new NotFoundError('Expense claim');
    if (!((await accessContext(viewer)).permissions.has('expenses.manage'))) throw new AppError('You can view expenses but cannot approve them', 403, 'FORBIDDEN');
    await assertReviewerScope(viewer, type, request.user_id);
    await prisma.$transaction(async tx => {
      const changed = await tx.expenseClaim.updateMany({ where: { id, org_id: viewer.orgId, status: 'pending' }, data: { status: action === 'approve' ? 'approved' : 'rejected', reviewed_by: viewer.userId, reviewed_at: now, review_note: action === 'reject' ? reason : note } });
      if (!changed.count) throw new ValidationError('This request has already been reviewed');
    });
    requesterId = request.user_id; requesterName = request.user.name; event = 'expense_changed';
    notification = { type: action === 'approve' ? 'expense_approved' : 'expense_rejected', title: `Expense claim ${actionPast}`, body: action === 'approve' ? `Your ${request.category} claim for ${request.currency} ${Number(request.amount).toFixed(2)} was approved` : `Your expense claim was rejected: ${reason}`, actionType: 'expense_claim' };
    summary = `${requesterName}'s ${request.category} expense claim was ${actionPast}`;
    audit = { action: `expense.${action}`, entityType: 'expense_claim', entityId: id, before: { status: 'pending' }, after: { status: action === 'approve' ? 'approved' : 'rejected' }, reason: action === 'reject' ? reason : note ?? request.description };
  }

  if (notification && requesterId) await createNotification({ userId: requesterId, orgId: viewer.orgId, ...notification, actionId: id });
  if (audit) await recordAudit({ orgId: viewer.orgId, actorId: viewer.userId, ...audit });
  emitOrgEvent(viewer.orgId, event);
  return { type, id, action, summary, requester: requesterName };
}

