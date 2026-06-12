// @ts-nocheck
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { ok, NotFoundError, ForbiddenError, ValidationError, AppError } from '../utils/response';
import { startOfDay, calcHoursWorked, isOfficeNetwork } from '../utils/auth';
import { lateThresholdFor, earlyOutMinutes, adherenceScore, scheduledWindow, scheduledInstant, dateOnlyInTz, hhmmToMins } from '../utils/shift';
import { settleBreaks, netHoursWorked, netExtraMinutesAfterShift } from '../utils/attendance';
import prisma from '../utils/prisma';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(authenticate);

const RECORD_INCLUDE = {
  user:  { select: { id: true, name: true, avatar_url: true, department: true, job_title: true } },
  shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true, overtime_enabled: true, overtime_requires_approval: true, extra_time_label: true } },
};

async function orgTimeContext(orgId: string) {
  const org = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: { timezone: true, late_threshold: true },
  });
  const timezone = org?.timezone ?? 'UTC';
  return { org, timezone, today: dateOnlyInTz(new Date(), timezone) };
}

function parseDateOnly(value: string, field = 'date'): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (isNaN(parsed.getTime())) throw new ValidationError(`Invalid ${field}`);
  return parsed;
}

function dayMatchesBreak(b: any, date: Date): boolean {
  const day = date.getUTCDay();
  const dateStr = date.toISOString().split('T')[0];
  const days = Array.isArray(b.applies_days) ? b.applies_days : [];
  const dates = Array.isArray(b.exception_dates) ? b.exception_dates : [];
  return (days.length === 0 || days.includes(day)) && (dates.length === 0 || dates.includes(dateStr));
}

async function effectiveShiftForUser(userId: string, orgId: string, date: Date, at = new Date(), includeBreaks = false) {
  const include = includeBreaks ? { breaks: { orderBy: { after_minutes: 'asc' } } } : undefined;
  const assignment = await prisma.shiftAssignment.findFirst({
    where: { user_id: userId, date },
    include: { shift: include ? { include } : true },
  });
  if (assignment?.shift) return assignment.shift;

  // Weekday must be the ORG-LOCAL weekday (matches scheduler.ts and dayMatchesBreak),
  // not the server-local one. `date` is the org-local day anchored at UTC midnight
  // (dateOnlyInTz), so getUTCDay() yields the org-local weekday regardless of where
  // the server runs. Using at.getDay() here resolved a different shift than the
  // scheduler did whenever server tz ≠ org tz near a day boundary.
  const weekday = date.getUTCDay();
  return await prisma.shift.findFirst({
    where: { org_id: orgId, is_org_wide: true, active_days: { has: weekday }, is_published: true },
    include,
  }) || await prisma.shift.findFirst({
    where: { org_id: orgId, is_default: true, active_days: { has: weekday }, is_published: true },
    include,
  });
}

function minutesToDateOnShiftDay(minutes: number, base: Date, tz: string): Date {
  const dateStr = dateOnlyInTz(base, tz).toISOString().split('T')[0];
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const instant = scheduledInstant(dateStr, `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, tz);
  return minutes >= 1440 ? new Date(instant.getTime() + 24 * 60 * 60 * 1000) : instant;
}

function adjustedWindowForLeave(shift: any, tz: string, at: Date, leave?: any | null): { start: Date; end: Date } {
  const win = scheduledWindow(shift, tz, at);
  if (!leave || (!leave.is_half_day && !leave.leave_start_time)) return win;

  const startMins = hhmmToMins(shift.start_time);
  const endMinsRaw = hhmmToMins(shift.end_time);
  const endMins = endMinsRaw <= startMins ? endMinsRaw + 1440 : endMinsRaw;
  const midpoint = startMins + Math.round((endMins - startMins) / 2);

  if (leave.leave_start_time && leave.leave_end_time) {
    const leaveStart = hhmmToMins(leave.leave_start_time);
    const leaveEnd = hhmmToMins(leave.leave_end_time);
    return {
      start: leaveStart <= startMins ? minutesToDateOnShiftDay(leaveEnd, at, tz) : win.start,
      end: leaveEnd >= endMinsRaw ? minutesToDateOnShiftDay(leaveStart, at, tz) : win.end,
    };
  }

  if (leave.is_half_day && leave.half_day_period === 'morning') {
    return { start: minutesToDateOnShiftDay(midpoint % 1440, at, tz), end: win.end };
  }
  if (leave.is_half_day && leave.half_day_period === 'afternoon') {
    return { start: win.start, end: minutesToDateOnShiftDay(midpoint % 1440, at, tz) };
  }
  return win;
}

async function createAwayGapBreak(record: any, reentryTime: Date, opts: { countAsBreak?: boolean; shiftBreakId?: string | null }) {
  const gapMins = Math.max(1, Math.round((reentryTime.getTime() - record.check_out_at.getTime()) / 60000));
  let policy: any = null;
  if (opts.countAsBreak && opts.shiftBreakId && record.shift_id) {
    policy = await prisma.shiftBreak.findFirst({
      where: { id: opts.shiftBreakId, shift_id: record.shift_id },
    });
  }
  const previousCount = policy
    ? await prisma.breakRecord.count({ where: { attendance_id: record.id, shift_break_id: policy.id } })
    : 0;
  const limitExceeded = !!policy && previousCount >= (policy.allowed_count_per_shift ?? 1);
  const isPaid = policy
    ? !!policy.is_paid && (limitExceeded ? !policy.deduct_extra_time : policy.paid_within_limit)
    : false;

  await prisma.breakRecord.create({
    data: {
      attendance_id: record.id,
      shift_break_id: policy?.id ?? undefined,
      break_start: record.check_out_at,
      break_end: reentryTime,
      break_type: policy?.name ?? 'away',
      duration_mins: gapMins,
      is_paid: isPaid,
      limit_exceeded: limitExceeded,
      counted_as_extra: limitExceeded,
      source: policy ? 'away_choice' : 'away',
    },
  });
  return { gapMins, policy, limitExceeded };
}

// ─── GET /attendance/today ─────────────────────────────
router.get('/today', requirePermission('attendance.view_team'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawDate = req.query.date as string | undefined;
    const { today } = await orgTimeContext(req.user!.org_id);
    const date = rawDate ? parseDateOnly(rawDate) : today;
    const where: Record<string, unknown> = { org_id: req.user!.org_id, date };
    if (!req.permissions?.has('employees.view')) {
      const teamIds = await prisma.user.findMany({
        where: { manager_id: req.user!.sub, is_active: true },
        select: { id: true },
      });
      where.user_id = { in: teamIds.map((u: { id: string }) => u.id) };
    }
    const records = await prisma.attendanceRecord.findMany({ where, include: RECORD_INCLUDE, orderBy: { check_in_at: 'asc' } });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/me ────────────────────────────────
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { days = '30' } = req.query as { days?: string };
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));
    const records = await prisma.attendanceRecord.findMany({
      where: { user_id: req.user!.sub, date: { gte: since } },
      orderBy: { date: 'desc' },
      include: {
        break_records: { orderBy: { break_start: 'asc' } },
      },
    });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/sessions ──────────────────
// Manager sees remote session requests for approval
router.get('/remote/sessions', requirePermission('remote.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as { status?: string };

    const teamIds = !req.permissions?.has('employees.view')
      ? (await prisma.user.findMany({ where: { manager_id: req.user!.sub, org_id: req.user!.org_id }, select: { id: true } })).map((u: { id: string }) => u.id)
      : null;

    const where: Record<string, unknown> = { user: { org_id: req.user!.org_id } };
    if (status) where.status = status;
    if (teamIds) where.user_id = { in: teamIds };

    const sessions = await prisma.remoteSession.findMany({
      where,
      include: {
        user:     { select: { id: true, name: true, department: true, avatar_url: true } },
        attendance: { select: { date: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    ok(res, sessions);
  } catch (e) { next(e); }
});

// ─── PUT /attendance/remote/sessions/:id/approve ──────
router.put('/remote/sessions/:id/approve', requirePermission('remote.approve'), async (req, res, next) => {
  try {
    const session = await prisma.remoteSession.findUnique({
      where: { id: req.params.id },
      include: { user: true },
    });
    if (!session || session.user.org_id !== req.user!.org_id) throw new NotFoundError('Remote session');
    if (session.status !== 'pending') throw new ValidationError('Session is not pending approval');

    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { status: 'approved', approved_by: req.user!.sub },
    });

    // Notify team group via WhatsApp
    const { notifyRemote } = await import('../services/whatsapp');
    await notifyRemote(session.user.org_id, session.user.name).catch(console.error);

    // In-app notification to employee
    const { createNotification } = await import('../services/notifications');
    createNotification({
      userId: session.user.id, orgId: session.user.org_id,
      type: 'remote_approved',
      title: 'Remote work approved',
      body: `Your remote work request for today has been approved`,
      actionType: 'remote_session', actionId: session.id,
    }).catch(console.error);

    ok(res, { message: 'Remote session approved' });
  } catch (e) { next(e); }
});

// ─── PUT /attendance/remote/sessions/:id/reject ───────
router.put('/remote/sessions/:id/reject', requirePermission('remote.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await prisma.remoteSession.findFirst({ where: { id: req.params.id, user: { org_id: req.user!.org_id } } });
    if (!session) throw new NotFoundError('Remote session');
    if (session.status !== 'pending') throw new ValidationError('Session is not pending approval');

    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { status: 'rejected', approved_by: req.user!.sub },
    });

    // Only mark absent if the employee never physically checked in; if they
    // already have a check_in_at (e.g. QR'd in before the manager reviewed),
    // leave the record as-is so we don't erase a real attendance day.
    const linkedRecord = await prisma.attendanceRecord.findUnique({
      where: { id: session.attendance_id },
      select: { check_in_at: true },
    });
    if (linkedRecord && !linkedRecord.check_in_at) {
      await prisma.attendanceRecord.update({
        where: { id: session.attendance_id },
        data: { status: 'absent' },
      });
    }

    // In-app notification to employee
    const rejectedSession = await prisma.remoteSession.findUnique({
      where: { id: session.id }, select: { user: { select: { id: true, org_id: true } } },
    });
    if (rejectedSession?.user) {
      const { createNotification } = await import('../services/notifications');
      createNotification({
        userId: rejectedSession.user.id, orgId: rejectedSession.user.org_id,
        type: 'remote_rejected',
        title: 'Remote work rejected',
        body: `Your remote work request for today was not approved`,
        actionType: 'remote_session', actionId: session.id,
      }).catch(console.error);
    }

    ok(res, { message: 'Remote session rejected' });
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/sessions/me ───────────────
// Employee views their own remote sessions
router.get('/remote/sessions/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessions = await prisma.remoteSession.findMany({
      where: { user_id: req.user!.sub },
      include: {
        attendance:    { select: { date: true } },
        checkin_logs:  true,
      },
      orderBy: { created_at: 'desc' },
      take: 30,
    });
    ok(res, sessions);
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/monitor ───────────────────
// Live dashboard: today's sessions with nudge logs & computed online status
router.get('/remote/monitor', requirePermission('remote.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const today = startOfDay(new Date());
    const now   = new Date();

    const isManager = !req.permissions?.has('employees.view');
    const teamIds = isManager
      ? (await prisma.user.findMany({ where: { manager_id: req.user!.sub, org_id: req.user!.org_id }, select: { id: true } })).map((u: { id: string }) => u.id)
      : null;

    const where: Record<string, unknown> = { user: { org_id: req.user!.org_id }, created_at: { gte: today } };
    if (teamIds) where.user_id = { in: teamIds };

    const sessions = await prisma.remoteSession.findMany({
      where,
      include: {
        user:         { select: { id: true, name: true, department: true, avatar_url: true, phone: true } },
        attendance:   { select: { date: true } },
        checkin_logs: { orderBy: { nudge_sent_at: 'asc' } },
      },
      orderBy: { created_at: 'desc' },
    });

    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    const enriched = sessions.map(s => {
      const logs      = s.checkin_logs;
      const replies   = logs.filter(l => l.reply_at);
      const lastReply = replies.sort((a, b) => new Date(b.reply_at!).getTime() - new Date(a.reply_at!).getTime())[0];
      const is_online = lastReply ? new Date(lastReply.reply_at!).getTime() > twoHoursAgo.getTime() : false;
      const latestLog = [...logs].filter(l => l.sentiment).reverse()[0];
      return {
        ...s,
        is_online,
        last_seen:           lastReply?.reply_at ?? null,
        responded_count:     replies.length,
        no_reply_count:      logs.filter(l => l.no_reply_alerted).length,
        latest_sentiment:    latestLog?.sentiment ?? null,
        latest_task_summary: latestLog?.task_summary ?? null,
      };
    });

    const total       = enriched.length;
    const responded   = enriched.filter(s => s.responded_count > 0).length;
    const noReply     = enriched.filter(s => s.no_reply_count > 0).length;
    const sentiments  = enriched.map(s => s.latest_sentiment).filter(Boolean);
    const positives   = sentiments.filter(s => s === 'positive').length;
    const negatives   = sentiments.filter(s => s === 'negative').length;
    const avgSentiment = sentiments.length === 0 ? null
      : positives > negatives ? 'positive'
      : negatives > positives ? 'negative'
      : 'neutral';

    ok(res, {
      date:  today,
      stats: { total, responded, no_reply: noReply, avg_sentiment: avgSentiment },
      sessions: enriched,
    });
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/sessions/:id/logs ─────────
// Full nudge log for one session — accessible by the employee or their manager
router.get('/remote/sessions/:id/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isEmployee = req.user!.role === 'employee';
    const session = await prisma.remoteSession.findFirst({
      where: isEmployee
        ? { id: req.params.id, user_id: req.user!.sub }
        : { id: req.params.id, user: { org_id: req.user!.org_id } },
      include: {
        user:         { select: { id: true, name: true, department: true, avatar_url: true } },
        attendance:   { select: { date: true } },
        checkin_logs: { orderBy: { nudge_sent_at: 'asc' } },
      },
    });
    if (!session) throw new NotFoundError('Remote session');
    ok(res, session);
  } catch (e) { next(e); }
});
router.post('/break/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { break_type = 'rest', shift_break_id } = req.body;
    const { today } = await orgTimeContext(req.user!.org_id);
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: { break_records: true, shift: { include: { breaks: true } } },
    });
    if (!record || !record.check_in_at) throw new AppError('Not checked in', 400, 'NOT_CHECKED_IN');
    if (record.check_out_at) throw new AppError('Already checked out', 400, 'CHECKED_OUT');
    if (record.break_records.some(b => !b.break_end)) throw new AppError('Break already in progress', 400, 'BREAK_IN_PROGRESS');

    const shift = record.shift ?? await effectiveShiftForUser(req.user!.sub, req.user!.org_id, today, new Date(), true);
    const availableBreaks = (shift?.breaks ?? []).filter(b => dayMatchesBreak(b, today));
    const policy = shift_break_id
      ? availableBreaks.find(b => b.id === shift_break_id)
      : availableBreaks.find(b => b.name === break_type || b.id === break_type);

    const takenCount = policy
      ? record.break_records.filter(b => b.shift_break_id === policy.id).length
      : record.break_records.filter(b => b.break_type === break_type).length;
    const allowedCount = policy?.allowed_count_per_shift ?? 1;
    const limitExceeded = !!policy && policy.break_kind === 'flexible' && takenCount >= allowedCount;
    // Ad-hoc breaks (no shift policy) are always unpaid.
    // Payability is only determined by the linked ShiftBreak policy.
    const isPaid = policy
      ? !!policy.is_paid && (limitExceeded ? !policy.deduct_extra_time : policy.paid_within_limit)
      : false;

    const breakRecord = await prisma.breakRecord.create({
      data: {
        attendance_id: record.id,
        break_start: new Date(),
        break_type: policy?.name ?? break_type,
        is_paid: isPaid,
        shift_break_id: policy?.id ?? undefined,
        limit_exceeded: limitExceeded,
        counted_as_extra: limitExceeded,
        source: 'manual',
      },
    });
    ok(res, {
      ...breakRecord,
      warning: limitExceeded ? 'This is an extra break and may be unpaid by policy.' : null,
      policy,
    });
  } catch (e) { next(e); }
});

// ─── POST /attendance/break/end ───────────────────────
// Body: { wifi_connected?: boolean }
// wifi_connected = true when the device was on the office WiFi at the moment
// the employee tapped "End Break". Used to populate wifi_on_at_end on the
// break record for history and analytics.
router.post('/break/end', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { wifi_connected = false } = req.body as { wifi_connected?: boolean };
    const { today, timezone: tz } = await orgTimeContext(req.user!.org_id);

    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: {
        break_records: {
          where: { break_end: null },
          include: { shift_break: true },
        },
      },
    });
    if (!record) throw new AppError('Not checked in today', 400, 'NOT_CHECKED_IN');
    const activeBreak = record.break_records[0];
    if (!activeBreak) throw new AppError('No break in progress', 400, 'NO_BREAK');

    const now          = new Date();
    const durationMins = Math.max(0, Math.round((now.getTime() - activeBreak.break_start.getTime()) / 60000));

    // ── Compute late_return_minutes ──────────────────────────────────────────
    // Fixed break  : compare actual break_end against the scheduled wall-clock
    //                end time converted to UTC via org timezone.
    // Flexible break: compare actual duration against the allowed break_minutes.
    // Ad-hoc break  : no policy → null (unknown).
    let lateReturnMins: number | null = null;
    const sb = activeBreak.shift_break;
    if (sb) {
      if (sb.break_kind === 'fixed' && sb.break_end_time) {
        const { fromZonedTime, toZonedTime } = await import('date-fns-tz');
        const [h, m]          = sb.break_end_time.split(':').map(Number);
        const localNow        = toZonedTime(now, tz);
        const localEnd        = new Date(localNow);
        localEnd.setHours(h, m, 0, 0);
        const scheduledEndUtc = fromZonedTime(localEnd, tz);
        lateReturnMins        = Math.max(0, Math.round((now.getTime() - scheduledEndUtc.getTime()) / 60000));
      } else if (sb.break_kind === 'flexible') {
        lateReturnMins = Math.max(0, durationMins - sb.break_minutes);
      }
    }

    const ended = await prisma.breakRecord.update({
      where: { id: activeBreak.id },
      data: {
        break_end:           now,
        duration_mins:       durationMins,
        late_return_minutes: lateReturnMins,
        wifi_on_at_end:      !!wifi_connected,
      },
    });

    // Recalculate net_hours_worked on the parent attendance record
    const allBreaks = await prisma.breakRecord.findMany({
      where: { attendance_id: record.id, break_end: { not: null } },
    });
    const unpaidBreakMins = allBreaks.filter(b => !b.is_paid).reduce((s, b) => s + (b.duration_mins ?? 0), 0);
    const paidBreakMins   = allBreaks.filter(b =>  b.is_paid).reduce((s, b) => s + (b.duration_mins ?? 0), 0);
    const totalMins       = record.check_in_at
      ? Math.round((now.getTime() - record.check_in_at.getTime()) / 60000)
      : 0;

    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        break_minutes:    unpaidBreakMins + paidBreakMins,
        paid_break_minutes: paidBreakMins,
        net_hours_worked: parseFloat(((totalMins - unpaidBreakMins) / 60).toFixed(2)),
      },
    });

    ok(res, ended);
  } catch (e) { next(e); }
});

// GET /attendance/break/status was removed — today-status is the single source of truth
// for all break state (upcoming/imminent/active/overdue/done/no_schedule) and active break data.

// ─── GET /attendance/late-notice/me ───────────────────
router.get('/late-notice/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { days = '7' } = req.query as { days?: string };
    const since = new Date(); since.setDate(since.getDate() - parseInt(days));
    const notices = await prisma.lateArrivalNotice.findMany({
      where: { user_id: req.user!.sub, date: { gte: since } },
      orderBy: { date: 'desc' },
    });
    ok(res, notices);
  } catch (e) { next(e); }
});

// ─── POST /attendance/late-notice ─────────────────────
// Employee submits an advance notice that they will arrive late.
// The scheduler respects this: no manager alert until expected_time passes.
router.post('/late-notice', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { date, expected_time, reason } = req.body;
    if (!date || !expected_time || !reason) throw new ValidationError('date, expected_time and reason required');
    if (!reason.trim() || reason.trim().length < 5) throw new ValidationError('reason must be at least 5 characters');

    const noticeDate = parseDateOnly(date);

    // Validate expected_time format HH:MM
    if (!/^\d{1,2}:\d{2}$/.test(expected_time)) throw new ValidationError('expected_time must be HH:MM');

    // Can't submit a notice for a past date (allow today and future)
    const { today } = await orgTimeContext(req.user!.org_id);
    if (noticeDate < today) throw new ValidationError('Cannot submit a late notice for a past date');

    const notice = await prisma.lateArrivalNotice.upsert({
      where: { user_id_date: { user_id: req.user!.sub, date: noticeDate } },
      update: { expected_time, reason: reason.trim(), status: 'pending', acknowledged_by: null, acknowledged_at: null },
      create: { user_id: req.user!.sub, org_id: req.user!.org_id, date: noticeDate, expected_time, reason: reason.trim() },
    });

    // Notify manager immediately (non-blocking)
    prisma.user.findUnique({ where: { id: req.user!.sub }, select: { name: true, manager: { select: { phone: true, id: true } } } })
      .then(async u => {
        if (!u) return;
        if (u.manager?.phone) {
          const { notify } = await import('../services/whatsapp');
          await notify({
            orgId: req.user!.org_id, event: 'shift_reminder' as any,
            message: `🕐 *Late Arrival Notice*\n${u.name} has notified they will arrive late on ${date}.\nExpected arrival: *${expected_time}*\nReason: ${reason.trim()}`,
            recipientType: 'individual', recipientId: u.manager.phone,
          }).catch(console.error);
        }
        if (u.manager?.id) {
          const { createNotification } = await import('../services/notifications');
          createNotification({
            userId: u.manager.id, orgId: req.user!.org_id,
            type: 'late_notice',
            title: 'Late arrival notice',
            body: `${u.name} will be late — expected at ${expected_time}. Reason: ${reason.trim()}`,
            actionType: 'attendance', actionId: req.user!.sub,
          }).catch(console.error);
        }
      }).catch(console.error);

    ok(res, notice, 201);
  } catch (e) { next(e); }
});

// ─── GET /attendance/late-notices ─────────────────────
// Manager/HR: view pending late notices for the org (today + future)
router.get('/late-notices', requirePermission('attendance.late_notices.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { today } = await orgTimeContext(req.user!.org_id);
    const { status } = req.query as { status?: string };

    const isManager = !req.permissions?.has('employees.view');
    const teamIds = isManager
      ? (await prisma.user.findMany({ where: { manager_id: req.user!.sub, org_id: req.user!.org_id }, select: { id: true } })).map((u: { id: string }) => u.id)
      : null;

    const where: Record<string, unknown> = { org_id: req.user!.org_id, date: { gte: today } };
    if (status) where.status = status;
    if (teamIds) where.user_id = { in: teamIds };

    const notices = await prisma.lateArrivalNotice.findMany({
      where,
      include: { user: { select: { id: true, name: true, avatar_url: true, department: true } } },
      orderBy: [{ date: 'asc' }, { created_at: 'asc' }],
    });
    ok(res, notices);
  } catch (e) { next(e); }
});

// ─── PUT /attendance/late-notice/:id/acknowledge ──────
router.put('/late-notice/:id/acknowledge', requirePermission('attendance.late_notices.manage'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notice = await prisma.lateArrivalNotice.findFirst({
      where: { id: req.params.id, org_id: req.user!.org_id },
      include: { user: true },
    });
    if (!notice) throw new NotFoundError('Late arrival notice');
    if (notice.status === 'cancelled') throw new ValidationError('Notice has been cancelled by the employee');

    const updated = await prisma.lateArrivalNotice.update({
      where: { id: notice.id },
      data: { status: 'acknowledged', acknowledged_by: req.user!.sub, acknowledged_at: new Date() },
    });

    // Notify employee
    const { createNotification } = await import('../services/notifications');
    createNotification({
      userId: notice.user_id, orgId: notice.org_id,
      type: 'late_notice_ack',
      title: 'Late notice acknowledged',
      body: `Your late arrival notice for ${notice.date.toISOString().split('T')[0]} has been acknowledged`,
      actionType: 'attendance', actionId: notice.id,
    }).catch(console.error);

    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── DELETE /attendance/late-notice/:id ───────────────
router.delete('/late-notice/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notice = await prisma.lateArrivalNotice.findFirst({
      where: { id: req.params.id, user_id: req.user!.sub },
    });
    if (!notice) throw new NotFoundError('Late arrival notice');
    if (notice.status === 'acknowledged') throw new ValidationError('Cannot cancel an already-acknowledged notice');

    await prisma.lateArrivalNotice.update({
      where: { id: notice.id },
      data: { status: 'cancelled' },
    });
    ok(res, { message: 'Notice cancelled' });
  } catch (e) { next(e); }
});

// ─── GET /attendance/today-status ─────────────────────
// Returns: current shift, break schedule with live timing state, and
// pre-check-in late minutes so the mobile app can show banners without
// a separate poll per feature.
router.get('/today-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const now   = new Date();
    const { org, timezone: tz, today } = await orgTimeContext(req.user!.org_id);

    // Find today's attendance record (with active break)
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: { break_records: { orderBy: { break_start: 'asc' } } },
    });

    const shift = await effectiveShiftForUser(req.user!.sub, req.user!.org_id, today, now, true);

    // ── Break timing enrichment ─────────────────────────
    // Convert "HH:mm" wall-clock string to today's UTC Date in org timezone
    const wallClockToUtc = (hhmm: string): Date => {
      const [h, m] = hhmm.split(':').map(Number);
      // Build a local-date string in the org timezone, then parse as UTC
      const { toZonedTime, fromZonedTime } = require('date-fns-tz');
      const localNow = toZonedTime(now, tz);
      const local = new Date(localNow);
      local.setHours(h, m, 0, 0);
      return fromZonedTime(local, tz);
    };

    const activeBreak = record?.break_records.find(b => !b.break_end) ?? null;

    const enrichedBreaks = (shift?.breaks ?? []).filter(sb => dayMatchesBreak(sb, today)).map(sb => {
      // Determine break window in UTC
      let breakStartUtc: Date | null = null;
      let breakEndUtc:   Date | null = null;

      if (sb.break_start_time && sb.break_end_time) {
        breakStartUtc = wallClockToUtc(sb.break_start_time);
        breakEndUtc   = wallClockToUtc(sb.break_end_time);
      } else if (record?.check_in_at) {
        const ciMs = new Date(record.check_in_at).getTime();
        breakStartUtc = new Date(ciMs + sb.after_minutes * 60_000);
        breakEndUtc   = new Date(breakStartUtc.getTime() + sb.break_minutes * 60_000);
      }

      if (!breakStartUtc || !breakEndUtc) {
        return { ...sb, break_state: 'no_schedule' as const };
      }

      const minsUntilStart = (breakStartUtc.getTime() - now.getTime()) / 60_000;
      const minsUntilEnd   = (breakEndUtc.getTime()   - now.getTime()) / 60_000;
      const linkedBreak = record?.break_records.find(b => b.shift_break_id === sb.id) ?? null;
      const isActiveThisBreak = !!activeBreak && (activeBreak.shift_break_id === sb.id || (!activeBreak.shift_break_id && activeBreak.break_type === sb.name));

      // Determine state
      let break_state: 'upcoming' | 'imminent' | 'active' | 'overdue' | 'done' | 'no_schedule';
      let overdue_minutes = 0;

      if (minsUntilEnd < 0 && !linkedBreak?.break_end) {
        // Break window has passed, still no break taken or not ended
        if (isActiveThisBreak) {
          break_state    = 'overdue';
          overdue_minutes = Math.floor(-minsUntilEnd);
        } else {
          break_state = 'done'; // missed or completed
        }
      } else if (minsUntilStart <= 0 && minsUntilEnd >= 0) {
        // Inside the break window
        if (isActiveThisBreak) {
          break_state = 'active';
        } else {
          break_state    = 'overdue';
          overdue_minutes = Math.floor(-minsUntilStart);
        }
      } else if (minsUntilStart <= 15) {
        break_state = 'imminent'; // ≤ 15 min away — show warning banner
      } else {
        break_state = 'upcoming';
      }

      if (linkedBreak?.break_end) break_state = 'done';

      return {
        ...sb,
        break_state,
        overdue_minutes,
        mins_until_start: Math.max(0, Math.floor(minsUntilStart)),
        remaining_minutes: Math.max(0, Math.ceil(minsUntilEnd)),
        break_start_utc: breakStartUtc.toISOString(),
        break_end_utc:   breakEndUtc.toISOString(),
        linked_break_record: linkedBreak,
      };
    });

    // ── Pre-check-in late minutes ───────────────────────
    // If not yet checked in and shift has started, calculate live late minutes.
    let pre_checkin_late_minutes = 0;
    let shift_start_utc: string | null = null;
    let shift_end_utc: string | null = null;
    if (!record?.check_in_at && shift) {
      const approvedLeave = await prisma.leaveRequest.findFirst({
        where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: today }, end_date: { gte: today } },
        select: { is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
      });
      const adjusted = adjustedWindowForLeave(shift, tz, now, approvedLeave);
      const rawLate = Math.max(0, Math.round((now.getTime() - adjusted.start.getTime()) / 60000));
      pre_checkin_late_minutes = rawLate > lateThresholdFor(shift, org) ? rawLate : 0;
    }
    if (shift) {
      const win = scheduledWindow(shift, tz, now);
      shift_start_utc = win.start.toISOString();
      shift_end_utc = win.end.toISOString();
    }

    ok(res, {
      shift: shift ? {
        id:         shift.id,
        name:       shift.name,
        start_time: shift.start_time,
        end_time:   shift.end_time,
        color:      shift.color,
        overtime_enabled: shift.overtime_enabled,
        overtime_requires_approval: shift.overtime_requires_approval,
        extra_time_label: shift.extra_time_label,
        breaks:     enrichedBreaks,
        shift_start_utc,
        shift_end_utc,
      } : null,
      attendance: record ? {
        id:           record.id,
        status:       record.status,
        check_in_at:  record.check_in_at,
        check_out_at: record.check_out_at,
        late_minutes: record.late_minutes,
        early_out_minutes: record.early_out_minutes,
        early_checkin_minutes: record.early_checkin_minutes,
        net_hours_worked: record.net_hours_worked,
        overtime_hours: record.overtime_hours,
        extra_office_minutes: record.extra_office_minutes,
        break_minutes: record.break_minutes,
        paid_break_minutes: record.paid_break_minutes,
        break_records: record.break_records,
      } : null,
      active_break: activeBreak,
      pre_checkin_late_minutes,
      server_time: now.toISOString(),
    });
  } catch (e) { next(e); }
});

// ─── GET /attendance/leave-check ──────────────────────
// Quick check: is the calling employee on approved leave today?
// Returns full-day, half-day, or no leave. Also returns any active late notice.
router.get('/leave-check', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { today } = await orgTimeContext(req.user!.org_id);
    const [leave, notice] = await Promise.all([
      prisma.leaveRequest.findFirst({
        where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: today }, end_date: { gte: today } },
        select: { id: true, leave_type: true, start_date: true, end_date: true, reason: true, is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
      }),
      prisma.lateArrivalNotice.findUnique({
        where: { user_id_date: { user_id: req.user!.sub, date: today } },
        select: { id: true, expected_time: true, reason: true, status: true },
      }),
    ]);
    const isFullLeave = leave && !leave.is_half_day;
    ok(res, {
      on_leave: !!isFullLeave,
      on_half_leave: !!(leave?.is_half_day),
      half_day_period: leave?.half_day_period ?? null,
      leave,
      late_notice: notice?.status !== 'cancelled' ? notice : null,
    });
  } catch (e) { next(e); }
});

// ─── POST /attendance/checkin ──────────────────────────
router.post('/checkin', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type = 'manual', qr_code, duration_type = 'full_day', count_away_as_break, away_shift_break_id } = req.body;
    const { org: orgInfo, timezone: orgTimezone, today } = await orgTimeContext(req.user!.org_id);
    // Capture client IP — prefer X-Forwarded-For (behind proxy/load balancer)
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;

    // Check no existing check-in today
    const existing = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
    });

    // Re-entry: employee was auto-checked out (WiFi dropout / heartbeat expiry)
    // and has now returned without having logged a break. Log the gap as an
    // unpaid 'away' break and reopen the record so the rest of the day continues.
    if (existing?.check_in_at && existing.check_out_at && existing.auto_checked_out) {
      const reentryTime = new Date();
      const reopenedStatus = (existing.late_minutes ?? 0) > 0 ? 'late' : 'in';
      const gapSinceCheckout = Math.round((reentryTime.getTime() - existing.check_out_at.getTime()) / 60000);

      // Doze-gap forgiveness — see /ip-event re-entry for rationale.
      const forgivenessMins = orgInfo?.gap_forgiveness_mins ?? 15;
      if (gapSinceCheckout <= forgivenessMins) {
        const stitched = await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            check_out_at:      null,
            hours_worked:      null,
            net_hours_worked:  null,
            early_out_minutes: 0,
            adherence_score:   null,
            auto_checked_out:  false,
            status:            reopenedStatus,
            last_heartbeat_at: null,
          },
          include: RECORD_INCLUDE,
        });
        return ok(res, { ...stitched, action: 're_entered', gap_mins: gapSinceCheckout, forgiven: true, warning: null });
      }

      const { gapMins, limitExceeded } = await createAwayGapBreak(existing, reentryTime, {
        countAsBreak: !!count_away_as_break,
        shiftBreakId: away_shift_break_id,
      });
      const reopened = await prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          check_out_at:      null,
          hours_worked:      null,
          net_hours_worked:  null,
          early_out_minutes: 0,
          adherence_score:   null,
          auto_checked_out:  false,
          status:            reopenedStatus,
          break_minutes:     (existing.break_minutes || 0) + gapMins,
          last_heartbeat_at: null,
        },
        include: RECORD_INCLUDE,
      });
      if (reopened.user) {
        const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
        notifyCheckIn(req.user!.org_id, reopened.user.name, formatTime12h(reentryTime), reopened.user.department ?? undefined).catch(console.error);
      }
      return ok(res, { ...reopened, action: 're_entered', gap_mins: gapMins, warning: limitExceeded ? 'This away time used an extra break and may be unpaid by policy.' : null });
    }

    if (existing?.check_in_at) {
      if (type === 'qr') {
        // Already checked in + QR scan = offer checkout
        return ok(res, { action: 'checkout_prompt', record: existing });
      }
      throw new ValidationError('Already checked in today');
    }

    // Validate QR code if provided
    if (type === 'qr') {
      if (!qr_code) throw new ValidationError('QR code required for QR check-in');
      const { verifyQrCode } = await import('../services/qrcode');
      const verification = verifyQrCode(qr_code, req.user!.org_id);
      if (!verification.valid) throw new ValidationError(verification.reason || 'Invalid QR code');
    }

    const now = new Date();

    // ── Check for approved leave ──────────────────────────────────────────────
    // Half-day leave employees are expected to check in for the other half.
    // Full-day leave: allow check-in but flag is_on_approved_leave=true + notify manager.
    const approvedLeave = await prisma.leaveRequest.findFirst({
      where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: today }, end_date: { gte: today } },
      select: { id: true, leave_type: true, is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
    });
    // Half-day leave: not an override — employee IS expected to show up for the other half
    const isFullDayLeaveOverride = !!approvedLeave && !approvedLeave.is_half_day;

    // ── Check for an active late notice ──────────────────────────────────────
    const lateNotice = await prisma.lateArrivalNotice.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      select: { id: true, status: true },
    });
    const activeNoticeId = lateNotice && lateNotice.status !== 'cancelled' ? lateNotice.id : null;

    // Detect status: check if this is a remote check-in
    let status: string = type === 'remote' ? 'remote' : 'in';

    // Shift-based compliance: late detection + scheduled window (timezone-aware)
    let lateMins         = 0;
    let earlyCheckinMins = 0;
    let scheduledStart: Date | null = null;
    let scheduledEnd:   Date | null = null;
    let shiftId: string | null = null;

    if (type !== 'remote') {
      const shift = await effectiveShiftForUser(req.user!.sub, req.user!.org_id, today, now);

      if (shift) {
        shiftId = shift.id;
        const win = adjustedWindowForLeave(shift, orgTimezone, now, approvedLeave);
        scheduledStart = win.start;
        scheduledEnd = win.end;
        const rawLateMins = Math.max(0, Math.round((now.getTime() - scheduledStart.getTime()) / 60000));
        // ONE threshold drives both the late flag and the stored minutes so they
        // can never disagree (shift tolerance → org threshold → 15 default).
        // Previously the flag used the org fallback while the stored value
        // subtracted only the per-shift tolerance, so a within-grace arrival could
        // be flagged on-time yet still carry late_minutes and lose adherence points.
        const lateThreshold = lateThresholdFor(shift, orgInfo);
        if (rawLateMins > lateThreshold) status = 'late';
        lateMins = Math.max(0, rawLateMins - lateThreshold);

        if (scheduledStart && now < scheduledStart) {
          earlyCheckinMins = Math.round((scheduledStart.getTime() - now.getTime()) / 60000);
        }
      }
    }

    const record = existing
      ? await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            check_in_at: now, check_in_type: type, status,
            late_minutes: lateMins,
            early_checkin_minutes: earlyCheckinMins,
            ...(rawIp          && { ip_detected: rawIp }),
            ...(shiftId        && { shift_id: shiftId }),
            ...(scheduledStart && { scheduled_start: scheduledStart }),
            ...(scheduledEnd   && { scheduled_end: scheduledEnd }),
            ...(activeNoticeId         && { late_notice_id: activeNoticeId }),
            ...(isFullDayLeaveOverride && { is_on_approved_leave: true }),
          },
          include: RECORD_INCLUDE,
        })
      : await prisma.attendanceRecord.create({
          data: {
            user_id: req.user!.sub, org_id: req.user!.org_id,
            date: today, check_in_at: now, check_in_type: type, status,
            late_minutes: lateMins,
            early_checkin_minutes: earlyCheckinMins,
            ip_detected:     rawIp          ?? undefined,
            shift_id:        shiftId        ?? undefined,
            scheduled_start: scheduledStart ?? undefined,
            scheduled_end:   scheduledEnd   ?? undefined,
            late_notice_id:  activeNoticeId ?? undefined,
            is_on_approved_leave: isFullDayLeaveOverride,
          },
          include: RECORD_INCLUDE,
        });

    // If on full-day approved leave: alert manager that employee checked in anyway
    if (isFullDayLeaveOverride) {
      const u = await prisma.user.findUnique({
        where: { id: req.user!.sub },
        select: { name: true, manager: { select: { id: true, phone: true } } },
      });
      if (u?.manager?.id) {
        const { createNotification } = await import('../services/notifications');
        createNotification({
          userId: u.manager.id, orgId: req.user!.org_id,
          type: 'leave_checkin_override',
          title: 'Employee checked in while on leave',
          body: `${u.name} has checked in today despite having approved ${approvedLeave.leave_type} leave. Please verify.`,
          actionType: 'attendance', actionId: req.user!.sub,
        }).catch(console.error);
      }
    }

    // Handle remote check-in: create RemoteSession pending manager approval
    if (type === 'remote') {
      const sessionExists = await prisma.remoteSession.findFirst({
        where: { attendance_id: record.id },
      });
      if (!sessionExists) {
        await prisma.remoteSession.create({
          data: {
            attendance_id: record.id,
            user_id:       req.user!.sub,
            status:        'pending',
            duration_type,
          },
        });
      }
    }

    // Fire WhatsApp notifications (non-blocking)
    if (record.user) {
      if (type !== 'remote') {
        const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
        const timeStr = formatTime12h(record.check_in_at || now);
        notifyCheckIn(req.user!.org_id, record.user.name, timeStr, record.user.department ?? undefined).catch(console.error);
      } else {
        // Notify manager that employee wants to work remotely
        prisma.user.findUnique({ where: { id: req.user!.sub }, select: { manager: { select: { phone: true } } } })
          .then(async userWithManager => {
            if (userWithManager?.manager?.phone) {
              const { notifyRemotePending } = await import('../services/whatsapp');
              await notifyRemotePending(req.user!.org_id, record.user!.name, duration_type, userWithManager.manager.phone);
            }
          }).catch(console.error);
      }
    }

    // When an employee actually checks in late, alert their manager with the real arrival time.
    // The scheduler fires "no-show" alerts at +30/+60 min, but never knows when they arrive.
    if (status === 'late' && type !== 'remote') {
      const orgId = req.user!.org_id;
      const userId = req.user!.sub;
      prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, manager: { select: { id: true, phone: true } } },
      }).then(async u => {
        if (!u) return;
        const { formatTime12h, notifyLateArrival } = await import('../services/whatsapp');
        const { createNotification } = await import('../services/notifications');
        if (u.manager?.id) {
          createNotification({
            userId: u.manager.id, orgId,
            type: 'attendance_late',
            title: 'Late check-in',
            body: `${u.name} checked in ${lateMins} min late at ${formatTime12h(now)}`,
            actionType: 'attendance', actionId: userId,
          }).catch(console.error);
        }
        if (u.manager?.phone) {
          notifyLateArrival(orgId, u.name, lateMins, u.manager.phone).catch(console.error);
        }
      }).catch(console.error);
    }

    // Notify manager when employee checks in significantly early (>30 min before shift)
    if (earlyCheckinMins > 30 && type !== 'remote') {
      const orgId  = req.user!.org_id;
      const userId = req.user!.sub;
      prisma.user.findUnique({
        where:  { id: userId },
        select: { name: true, manager: { select: { id: true, phone: true } } },
      }).then(async u => {
        if (!u) return;
        const { formatTime12h, notify } = await import('../services/whatsapp');
        const { createNotification }    = await import('../services/notifications');
        if (u.manager?.id) {
          createNotification({
            userId: u.manager.id, orgId,
            type:       'attendance_early_in',
            title:      'Early check-in',
            body:       `${u.name} checked in ${earlyCheckinMins} min early at ${formatTime12h(now)}`,
            actionType: 'attendance', actionId: userId,
          }).catch(console.error);
        }
        if (u.manager?.phone) {
          notify({
            orgId, event: 'shift_reminder' as any,
            message:       `⏰ *Early Check-in*\n${u.name} arrived ${earlyCheckinMins} min before their shift start.`,
            recipientType: 'individual', recipientId: u.manager.phone,
          }).catch(console.error);
        }
      }).catch(console.error);
    }

    ok(res, record);
  } catch (e) { next(e); }
});

// ─── POST /attendance/checkout ─────────────────────────
router.post('/checkout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { timezone: orgTimezone, today } = await orgTimeContext(req.user!.org_id);
    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
      include: { shift: true },
    });
    if (!record?.check_in_at) throw new ValidationError('No check-in found for today');
    if (record.check_out_at)  throw new ValidationError('Already checked out today');

    const now          = new Date();
    const hoursWorked  = calcHoursWorked(record.check_in_at, now);

    // Settle breaks (close any open break) and compute net hours
    const breaks   = await settleBreaks(record.id, now, orgTimezone);
    const netHours = netHoursWorked(hoursWorked, breaks.unpaidMins);
    const approvedLeave = await prisma.leaveRequest.findFirst({
      where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: today }, end_date: { gte: today } },
      select: { is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
    });

    // Shift-based compliance on checkout (timezone-aware).
    // Prefer the schedule persisted at check-in: for overnight shifts the checkout
    // instant falls on the next org-local day, so recomputing the window from `now`
    // would anchor it to the wrong day and skew early-out / overtime. Fall back to a
    // fresh computation only when no scheduled_end was stored (e.g. legacy records).
    const scheduledEnd: Date | null = record.scheduled_end
      ?? (record.shift ? adjustedWindowForLeave(record.shift, orgTimezone, now, approvedLeave).end : null);
    const rawEarlyMins = scheduledEnd
      ? Math.max(0, Math.round((scheduledEnd.getTime() - now.getTime()) / 60000))
      : 0;
    // One tolerance drives both the stored minutes and the early-leave alert below.
    const earlyTolerance = record.shift?.early_checkout_tolerance_mins ?? 15;
    const earlyMins = Math.max(0, rawEarlyMins - earlyTolerance);
    const score     = adherenceScore(record.late_minutes ?? 0, earlyMins, record.shift);
    const extraOfficeMins = await netExtraMinutesAfterShift(record.id, now, scheduledEnd);
    const autoCountOvertime = !!record.shift?.overtime_enabled && !record.shift?.overtime_requires_approval;
    const overtimeHours = autoCountOvertime
      ? parseFloat((extraOfficeMins / 60).toFixed(2))
      : 0;

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        check_out_at: now, hours_worked: hoursWorked, status: 'out',
        net_hours_worked: netHours,
        overtime_hours: overtimeHours,
        extra_office_minutes: autoCountOvertime ? 0 : extraOfficeMins,
        break_minutes: breaks.totalMins, paid_break_minutes: breaks.paidMins,
        early_out_minutes: earlyMins,
        ...(score != null && { adherence_score: score }),
      },
      include: RECORD_INCLUDE,
    });

    // Fire WhatsApp notification (non-blocking)
    if (updated.user) {
      const { notifyCheckOut, formatTime12h } = await import('../services/whatsapp');
      const timeStr = formatTime12h(updated.check_out_at || now);
      notifyCheckOut(req.user!.org_id, updated.user.name, timeStr, updated.user.department ?? undefined).catch(console.error);
    }

    // Notify manager when employee leaves before their shift ends (compare raw minutes vs tolerance)
    if (rawEarlyMins > earlyTolerance) {
      const orgId  = req.user!.org_id;
      const userId = req.user!.sub;
      prisma.user.findUnique({
        where:  { id: userId },
        select: { name: true, manager: { select: { id: true, phone: true } } },
      }).then(async u => {
        if (!u) return;
        const { formatTime12h, notify } = await import('../services/whatsapp');
        const { createNotification }    = await import('../services/notifications');
        if (u.manager?.id) {
          createNotification({
            userId: u.manager.id, orgId,
            type:       'attendance_early_out',
            title:      'Early check-out',
            body:       `${u.name} left ${earlyMins} min early at ${formatTime12h(now)}`,
            actionType: 'attendance', actionId: userId,
          }).catch(console.error);
        }
        if (u.manager?.phone) {
          notify({
            orgId, event: 'shift_reminder' as any,
            message:       `⚡ *Early Check-out*\n${u.name} left ${earlyMins} min before shift end.`,
            recipientType: 'individual', recipientId: u.manager.phone,
          }).catch(console.error);
        }
      }).catch(console.error);
    }

    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── POST /attendance/heartbeat ────────────────────────
// Called by Flutter app every ~4 min while on office WiFi.
// Server-side expiry job checks out employees when heartbeat goes stale.
router.post('/heartbeat', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ip, ssid } = req.body;
    if (!ip && !ssid) throw new ValidationError('ip or ssid is required');
    const { today } = await orgTimeContext(req.user!.org_id);
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const officeIps   = org?.office_ips   ?? [];
    const officeSsids = org?.office_ssids ?? [];

    if (officeIps.length === 0 && officeSsids.length === 0) {
      return ok(res, { action: 'no_networks_configured' });
    }
    if (!isOfficeNetwork(ip, ssid, officeIps, officeSsids)) {
      return ok(res, { action: 'not_on_office_network' });
    }

    const record = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: today } },
    });
    if (!record?.check_in_at || record.check_out_at) {
      return ok(res, { action: 'not_checked_in' });
    }

    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { last_heartbeat_at: new Date(), last_heartbeat_ssid: ssid ?? null },
    });
    const hbOrg = await prisma.organisation.findUnique({
      where: { id: req.user!.org_id },
      select: { heartbeat_grace_mins: true },
    });
    return ok(res, { action: 'heartbeat_accepted', grace_mins: hbOrg?.heartbeat_grace_mins ?? 20 });
  } catch (e) { next(e); }
});

// ─── POST /attendance/ip-event ─────────────────────────
// Called by Flutter app when WiFi connect detected.
// Accepts: event ('match'), ip (device LAN IP or CIDR), ssid (WiFi network name)
// SSID matching is preferred — more reliable than IP for orgs without static IPs.
router.post('/ip-event', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event, ip, ssid, count_away_as_break, away_shift_break_id } = req.body;
    if (!event) throw new ValidationError('event is required');
    if (!ip && !ssid) throw new ValidationError('ip or ssid is required');
    const { today } = await orgTimeContext(req.user!.org_id);

    // Check against org's registered office networks (SSID first, then IP/CIDR)
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id } });
    const officeIps   = org?.office_ips   ?? [];
    const officeSsids = org?.office_ssids ?? [];

    // Distinguish "admin never configured networks" from "device is on wrong network"
    if (officeIps.length === 0 && officeSsids.length === 0) {
      return ok(res, { action: 'no_networks_configured', reason: 'No office networks configured. Ask your admin to add office IPs or WiFi names in Settings → Office Networks.' });
    }

    if (!isOfficeNetwork(ip, ssid, officeIps, officeSsids)) {
      return ok(res, { action: 'none', reason: 'Not on a registered office network' });
    }

    if (event === 'match') {
      const existing = await prisma.attendanceRecord.findUnique({
        where: { user_id_date: { user_id: req.user!.sub, date: today } },
      });

      if (!existing?.check_in_at) {
        const now = new Date();
        // Detect late arrival for IP-based check-in (timezone-aware, shift-first threshold)
        let status   = 'in';
        let lateMins = 0;
        let scheduledStart: Date | null = null;
        let scheduledEnd:   Date | null = null;
        let shiftId: string | null = null;
        const shift = await effectiveShiftForUser(req.user!.sub, req.user!.org_id, today, now);
        const approvedLeave = await prisma.leaveRequest.findFirst({
          where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: today }, end_date: { gte: today } },
          select: { is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
        });
        if (shift) {
          shiftId  = shift.id;
          const win = adjustedWindowForLeave(shift, org?.timezone ?? 'UTC', now, approvedLeave);
          scheduledStart = win.start;
          scheduledEnd   = win.end;
          const rawIpLateMins = Math.max(0, Math.round((now.getTime() - scheduledStart.getTime()) / 60000));
          // One threshold for both the flag and stored minutes (see /checkin).
          const lateThreshold = lateThresholdFor(shift, org);
          if (rawIpLateMins > lateThreshold) status = 'late';
          lateMins = Math.max(0, rawIpLateMins - lateThreshold);
        }

        let earlyIpMins = 0;
        if (scheduledStart && now < scheduledStart) {
          earlyIpMins = Math.round((scheduledStart.getTime() - now.getTime()) / 60000);
        }

        const checkInData = {
          check_in_at: now, check_in_type: 'auto_ip', status, ip_detected: ip,
          late_minutes: lateMins,
          early_checkin_minutes: earlyIpMins,
          shift_id:        shiftId        ?? undefined,
          scheduled_start: scheduledStart ?? undefined,
          scheduled_end:   scheduledEnd   ?? undefined,
        };
        const record = existing
          ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: checkInData })
          : await prisma.attendanceRecord.create({ data: { user_id: req.user!.sub, org_id: req.user!.org_id, date: today, ...checkInData } });

        // Notify WhatsApp
        const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
        if (user) {
          const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
          notifyCheckIn(req.user!.org_id, user.name, formatTime12h(now)).catch(console.error);
        }

        // Alert manager on late WiFi auto check-in
        if (status === 'late') {
          const orgId = req.user!.org_id;
          const userId = req.user!.sub;
          prisma.user.findUnique({
            where: { id: userId },
            select: { name: true, manager: { select: { id: true, phone: true } } },
          }).then(async u => {
            if (!u) return;
            const { formatTime12h, notifyLateArrival } = await import('../services/whatsapp');
            const { createNotification } = await import('../services/notifications');
            if (u.manager?.id) {
              createNotification({
                userId: u.manager.id, orgId,
                type: 'attendance_late',
                title: 'Late check-in',
                body: `${u.name} checked in ${lateMins} min late at ${formatTime12h(now)}`,
                actionType: 'attendance', actionId: userId,
              }).catch(console.error);
            }
            if (u.manager?.phone) {
              notifyLateArrival(orgId, u.name, lateMins, u.manager.phone).catch(console.error);
            }
          }).catch(console.error);
        }

        // Alert manager on significantly early WiFi auto check-in
        if (earlyIpMins > 30) {
          const orgId  = req.user!.org_id;
          const userId = req.user!.sub;
          prisma.user.findUnique({
            where:  { id: userId },
            select: { name: true, manager: { select: { id: true, phone: true } } },
          }).then(async u => {
            if (!u) return;
            const { formatTime12h, notify } = await import('../services/whatsapp');
            const { createNotification }    = await import('../services/notifications');
            if (u.manager?.id) {
              createNotification({
                userId: u.manager.id, orgId,
                type:       'attendance_early_in',
                title:      'Early check-in',
                body:       `${u.name} checked in ${earlyIpMins} min early at ${formatTime12h(now)}`,
                actionType: 'attendance', actionId: userId,
              }).catch(console.error);
            }
            if (u.manager?.phone) {
              notify({
                orgId, event: 'shift_reminder' as any,
                message:       `⏰ *Early Check-in*\n${u.name} arrived ${earlyIpMins} min before their shift start.`,
                recipientType: 'individual', recipientId: u.manager.phone,
              }).catch(console.error);
            }
          }).catch(console.error);
        }

        return ok(res, { action: 'checked_in', record });
      }

      // Re-entry after WiFi dropout: employee was auto-checked out and has reconnected.
      if (existing?.check_in_at && existing.check_out_at && existing.auto_checked_out) {
        const reentryTime = new Date();
        const reopenedStatus = (existing.late_minutes ?? 0) > 0 ? 'late' : 'in';
        const gapSinceCheckout = Math.round((reentryTime.getTime() - existing.check_out_at.getTime()) / 60000);

        // Doze-gap forgiveness: the device is back on a registered office
        // network after a short gap — almost always a phone with its screen
        // off (Android Doze suppressed heartbeats), not a real departure.
        // Stitch the record as if the checkout never happened: no away
        // break, no break-minute deduction.
        const forgivenessMins = org?.gap_forgiveness_mins ?? 15;
        if (gapSinceCheckout <= forgivenessMins) {
          await prisma.attendanceRecord.update({
            where: { id: existing.id },
            data: {
              check_out_at:      null,
              hours_worked:      null,
              net_hours_worked:  null,
              early_out_minutes: 0,
              adherence_score:   null,
              auto_checked_out:  false,
              status:            reopenedStatus,
              last_heartbeat_at: reentryTime,
              last_heartbeat_ssid: ssid ?? null,
            },
          });
          return ok(res, { action: 're_entered', gap_mins: gapSinceCheckout, forgiven: true, warning: null });
        }

        const { gapMins, limitExceeded } = await createAwayGapBreak(existing, reentryTime, {
          countAsBreak: !!count_away_as_break,
          shiftBreakId: away_shift_break_id,
        });
        await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            check_out_at:      null,
            hours_worked:      null,
            net_hours_worked:  null,
            early_out_minutes: 0,
            adherence_score:   null,
            auto_checked_out:  false,
            status:            reopenedStatus,
            break_minutes:     (existing.break_minutes || 0) + gapMins,
            last_heartbeat_at: reentryTime,
            last_heartbeat_ssid: ssid ?? null,
          },
        });
        const reu = await prisma.user.findUnique({ where: { id: req.user!.sub } });
        if (reu) {
          const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
          notifyCheckIn(req.user!.org_id, reu.name, formatTime12h(reentryTime)).catch(console.error);
        }
        return ok(res, { action: 're_entered', gap_mins: gapMins, forgiven: false, warning: limitExceeded ? 'This away time used an extra break and may be unpaid by policy.' : null });
      }

      return ok(res, { action: 'already_in' });
    }

    ok(res, { action: 'none' });
  } catch (e) { next(e); }
});

// ─── PUT /attendance/:id/override ─────────────────────
router.put('/:id/override', requirePermission('attendance.override'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { check_in_at, check_out_at, reason } = req.body;
    if (!reason) throw new ValidationError('Reason is required for override');

    const record = await prisma.attendanceRecord.findFirst({
      where: { id, org_id: req.user!.org_id },
    });
    if (!record) throw new NotFoundError('Attendance record');

    const updateData: Record<string, unknown> = {
      is_overridden: true,
      override_by: req.user!.sub,
      override_reason: reason,
    };

    if (check_in_at) {
      updateData.check_in_at = new Date(check_in_at);
    }
    if (check_out_at) {
      updateData.check_out_at = new Date(check_out_at);
      const checkIn = check_in_at ? new Date(check_in_at) : record.check_in_at;
      if (checkIn) {
        updateData.hours_worked = calcHoursWorked(checkIn, new Date(check_out_at));
      }
    }

    const updated = await prisma.attendanceRecord.update({
      where: { id },
      data: updateData,
      include: RECORD_INCLUDE,
    });
    recordAudit({
      orgId: req.user!.org_id, actorId: req.user!.sub,
      action: 'attendance.override', entityType: 'attendance_record', entityId: record.id,
      before: { check_in_at: record.check_in_at, check_out_at: record.check_out_at, hours_worked: record.hours_worked },
      after: { check_in_at: updated.check_in_at, check_out_at: updated.check_out_at, hours_worked: updated.hours_worked },
      reason,
    });
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── GET /attendance/report/export ────────────────────
router.get('/report/export', requirePermission('attendance.export'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { start_date, end_date, department } = req.query as Record<string, string>;
    if (!start_date || !end_date) throw new ValidationError('start_date and end_date required');
    const startDate = parseDateOnly(start_date, 'start_date');
    const endDate = parseDateOnly(end_date, 'end_date');

    const where: Record<string, unknown> = {
      org_id: req.user!.org_id,
      date: { gte: startDate, lte: endDate },
    };
    if (department) {
      const deptUsers = await prisma.user.findMany({ where: { org_id: req.user!.org_id, department }, select: { id: true } });
      where.user_id = { in: deptUsers.map((u: { id: string }) => u.id) };
    }

    const records = await prisma.attendanceRecord.findMany({
      where, include: RECORD_INCLUDE, orderBy: [{ date: 'asc' }, { user_id: 'asc' }],
    });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/:userId ───────────────────────────
// NOTE: This parameterised route MUST stay last among GET routes so that
// fixed-path routes like /leave-check, /late-notices, /me, etc. are matched
// before Express falls through to the wildcard segment.
router.get('/:userId', requirePermission('attendance.view_team'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.params;
    const { start, end } = req.query as { start?: string; end?: string };

    const user = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id } });
    if (!user) throw new NotFoundError('User');

    const where: Record<string, unknown> = { user_id: userId };
    if (start || end) {
      where.date = {};
      if (start) (where.date as Record<string, unknown>).gte = parseDateOnly(start, 'start');
      if (end)   (where.date as Record<string, unknown>).lte = parseDateOnly(end, 'end');
    }

    const records = await prisma.attendanceRecord.findMany({
      where, include: RECORD_INCLUDE, orderBy: { date: 'desc' }, take: 90,
    });
    ok(res, records);
  } catch (e) { next(e); }
});

export default router;
