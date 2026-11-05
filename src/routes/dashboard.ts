import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import prisma from '../utils/prisma';
import { hasFeature, resolveOrgFeatures, resolveUserPermissions } from '../services/authorization';
import { scopedEmployeeIds } from '../services/locationScope';
import { listPendingApprovals, type ApprovalType } from '../services/approval-workflows';
import { dateOnlyInTz } from '../utils/shift';
import { getScheduleIssues } from '../services/scheduleIssues';
import { ok } from '../utils/response';
import { documentResponse } from '../middleware/validate';
import { z } from 'zod';
import { parseAccrualConfig } from '../services/leaveAccrual';

const router = Router();
router.use(authenticate);

const dashboardSummaryResponse = z.object({
  generated_at: z.string().datetime(),
  today: z.object({
    date: z.string(),
    timezone: z.string(),
    attendance: z.unknown().nullable(),
  }),
  team: z.unknown().optional(),
  my_shifts: z.array(z.unknown()).optional(),
  approvals: z.unknown().optional(),
  schedule: z.unknown().optional(),
  setup: z.object({
    checks: z.array(z.object({ key: z.string(), label: z.string(), configured: z.boolean(), href: z.string() })),
  }).optional(),
  access: z.object({
    team_attendance: z.boolean(),
    approvals: z.boolean(),
    schedule: z.boolean(),
  }),
});

const approvalPermissions: Record<ApprovalType, string> = {
  leave: 'leave.approve', overtime: 'overtime.manage', remote: 'remote.approve',
  swap: 'shifts.swaps.approve', late_notice: 'attendance.late_notices.manage',
  expense: 'expenses.view', correction: 'attendance.override', timesheet: 'time.approve',
};

/** Permission-scoped home data. Source features remain authoritative. */
router.get('/summary', documentResponse(dashboardSummaryResponse), async (req, res, next) => {
  try {
    const userId = req.user!.sub;
    const orgId = req.user!.org_id;
    const permissions = await resolveUserPermissions(userId, orgId);
    const canSeeTeam = permissions.has('attendance.view_team');
    const [user, org] = await Promise.all([
      prisma.user.findFirst({
        where: { id: userId, org_id: orgId, deleted_at: null },
        select: { id: true, primary_location: { select: { id: true, timezone: true } } },
      }),
      prisma.organisation.findUnique({ where: { id: orgId }, select: { timezone: true } }),
    ]);
    const timezone = user?.primary_location?.timezone ?? org?.timezone ?? 'UTC';
    const today = dateOnlyInTz(new Date(), timezone);
    const dayKey = today.toISOString().slice(0, 10);
    const features = await resolveOrgFeatures(orgId);

    const teamPromise = canSeeTeam ? (async () => {
      const visibleIds = await scopedEmployeeIds(orgId, userId, permissions, 'employees.view');
      const employees = await prisma.user.findMany({
        where: { org_id: orgId, is_active: true, deleted_at: null, ...(visibleIds ? { id: { in: visibleIds } } : {}) },
        select: { id: true, primary_location: { select: { id: true, timezone: true } } },
      });
      const orgTimezone = org?.timezone ?? 'UTC';
      const dateGroups = new Map<string, { date: Date; locationId: string | null; ids: string[] }>();
      for (const employee of employees) {
        const locationId = employee.primary_location?.id ?? null;
        const date = dateOnlyInTz(new Date(), employee.primary_location?.timezone ?? orgTimezone);
        const key = `${locationId ?? 'legacy'}:${date.toISOString()}`;
        const group = dateGroups.get(key) ?? { date, locationId, ids: [] };
        group.ids.push(employee.id);
        dateGroups.set(key, group);
      }
      const records = dateGroups.size ? await prisma.attendanceRecord.findMany({
        where: { org_id: orgId, OR: [...dateGroups.values()].map(group => ({
          date: group.date, user_id: { in: group.ids }, ...(group.locationId ? { location_id: group.locationId } : {}),
        })) },
        include: {
          user: { select: { id: true, name: true, avatar_url: true, department: true, job_title: true } },
          shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true } },
          break_records: { orderBy: { break_start: 'asc' } },
        },
        orderBy: { check_in_at: 'asc' },
      }) : [];
      const checkedIn = records.filter(record => record.status === 'in' || (record.status === 'late' && !!record.check_in_at)).length;
      return { date: dayKey, headcount: employees.length, checked_in: checkedIn, records };
    })() : Promise.resolve(undefined);

    const canReview = Object.values(approvalPermissions).some(permission => permissions.has(permission))
      || permissions.has('expenses.manage');
    const approvalsPromise = canReview
      ? listPendingApprovals({ userId, orgId }, 'all', { enabled: true, limit: 5 })
      : Promise.resolve(undefined);
    const ownAttendancePromise = prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: userId, date: today } },
      select: { id: true, date: true, status: true, check_in_at: true, check_out_at: true, late_minutes: true, early_out_minutes: true, net_hours_worked: true, break_minutes: true },
    });
    const myShiftsPromise = hasFeature(features, 'shifts') ? prisma.shiftAssignment.findMany({
      where: {
        user_id: userId,
        is_published: true,
        date: { gte: today, lte: new Date(today.getTime() + 28 * 86400000) },
        acknowledgement_status: { in: ['pending', 'conflict', 'help_requested'] },
        shift: { org_id: orgId },
      },
      include: { shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true } } },
      orderBy: { date: 'asc' },
      take: 5,
    }) : Promise.resolve(undefined);

    const schedulePromise = permissions.has('shifts.view') && hasFeature(features, 'shifts')
      ? (async () => {
        const monday = new Date(today);
        monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
        const visibleAssignmentIds = await scopedEmployeeIds(orgId, userId, permissions, 'shifts.manage');
        const [issues, openShifts, acknowledgementQueue] = await Promise.all([
          getScheduleIssues(orgId, userId, permissions, monday),
          prisma.emergencyShiftOffer.findMany({
            where: { org_id: orgId, status: 'open', expires_at: { gt: new Date() }, date: { gte: today } },
            include: { shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true } } },
            orderBy: [{ date: 'asc' }, { created_at: 'asc' }], take: 5,
          }),
          prisma.shiftAssignment.findMany({
            where: {
              is_published: true,
              date: { gte: new Date(today.getTime() - 14 * 86400000), lte: new Date(today.getTime() + 28 * 86400000) },
              shift: { org_id: orgId },
              ...(visibleAssignmentIds ? { user_id: { in: visibleAssignmentIds } } : {}),
              OR: [
                { acknowledgement_status: { in: ['conflict', 'help_requested'] } },
                { acknowledgement_status: 'pending', acknowledgement_due_at: { lt: new Date() } },
              ],
            },
            include: {
              user: { select: { id: true, name: true, avatar_url: true, department: true } },
              shift: { select: { id: true, name: true, start_time: true, end_time: true } },
            },
            orderBy: [{ date: 'asc' }, { acknowledgement_due_at: 'asc' }],
            take: 10,
          }),
        ]);
        return { ...issues, open_shifts: openShifts, acknowledgement_queue: acknowledgementQueue };
      })()
      : Promise.resolve(undefined);

    const setupPromise = permissions.has('org.settings.view') && permissions.has('org.settings.update') ? (async () => {
      const [settings, activeShiftCount, locations] = await Promise.all([
        prisma.organisation.findUnique({ where: { id: orgId }, select: { office_ips: true, office_ssids: true, leave_accrual: true } }),
        prisma.shift.count({ where: { org_id: orgId } }),
        prisma.location.findMany({ where: { org_id: orgId, is_active: true }, select: { office_ips: true, office_ssids: true } }),
      ]);
      const hasOfficeNetwork = !!settings?.office_ips.length || !!settings?.office_ssids.length
        || locations.some(location => location.office_ips.length > 0 || location.office_ssids.length > 0);
      const hasAccrualPolicy = !!parseAccrualConfig(settings?.leave_accrual);
      return { checks: [
        { key: 'office_network', label: 'Office network', configured: hasOfficeNetwork, href: '/settings/attendance' },
        { key: 'leave_policy', label: 'Leave accrual policy', configured: hasAccrualPolicy, href: '/settings/leave-policy' },
        { key: 'shift', label: 'Shift templates', configured: activeShiftCount > 0, href: '/shifts/templates' },
      ] };
    })() : Promise.resolve(undefined);

    const [team, approvals, ownAttendance, myShifts, schedule, setup] = await Promise.all([teamPromise, approvalsPromise, ownAttendancePromise, myShiftsPromise, schedulePromise, setupPromise]);
    ok(res, {
      generated_at: new Date().toISOString(),
      today: { date: dayKey, timezone, attendance: ownAttendance },
      ...(myShifts ? { my_shifts: myShifts } : {}),
      ...(team ? { team } : {}),
      ...(approvals ? { approvals } : {}),
      ...(schedule ? { schedule } : {}),
      ...(setup ? { setup } : {}),
      access: {
        team_attendance: canSeeTeam,
        approvals: canReview,
        schedule: !!schedule,
      },
    });
  } catch (error) { next(error); }
});

export default router;
