import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  checkinSchema, checkoutSchema, breakStartSchema, breakEndSchema,
  heartbeatSchema, ipEventSchema, lateNoticeSchema, attendanceOverrideSchema,
  attendanceReviewResolveSchema,
} from '../schemas';
import { ok, NotFoundError, ForbiddenError, ValidationError, AppError } from '../utils/response';
import { calcHoursWorked, isOfficeNetwork } from '../utils/auth';
import { lateThresholdFor, earlyOutMinutes, adherenceScore, scheduledWindow, scheduledInstant, dateOnlyInTz, hhmmToMins } from '../utils/shift';
import { settleBreaks, netHoursWorked, netExtraMinutesAfterShift, calculateBreakTotals } from '../utils/attendance';
import prisma from '../utils/prisma';
import type { Shift, ShiftBreak } from '@prisma/client';
import { recordAudit } from '../services/audit';
import { createNotification, emitOrgEvent } from '../services/notifications';
import { hasFeature, resolveOrgFeatures, resolveUserPermissions } from '../services/authorization';
import { reviewableEmployeeIds, scopedEmployeeIds } from '../services/locationScope';
import { reviewApproval } from '../services/approval-workflows';
import { evaluateCheckinLocation, parseAttendanceSecurity, parseLocationGeofence } from '../utils/attendanceSecurity';
import { issueAttendanceClockAnchor, verifyAttendanceClockAnchor } from '../utils/attendanceClock';
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { decodeCursor, encodeCursor, keysetAfter } from '../utils/cursor';
import { idempotency } from '../middleware/idempotency';
import { resolveAttendanceEventTime } from '../utils/offlineAttendanceEvent';
import { fromZonedTime } from 'date-fns-tz';
import { randomUUID } from 'node:crypto';
import redis from '../utils/redis';
import { attendanceSyncSchema } from '../schemas/attendance-sync';

const router = Router();
router.use(authenticate);

const RECORD_INCLUDE = {
  user:  { select: { id: true, name: true, avatar_url: true, department: true, job_title: true } },
  shift: { select: { id: true, name: true, start_time: true, end_time: true, color: true, overtime_enabled: true, overtime_requires_approval: true, extra_time_label: true } },
  break_records: { orderBy: { break_start: 'asc' } },
} as const;

const syncActionPath = { checkin: '/checkin', checkout: '/checkout', break_start: '/break/start', break_end: '/break/end' } as const;

router.post('/sync', validate({ body: attendanceSyncSchema }), async (req, res, next) => {
  const owner = randomUUID();
  const lockKey = `attendance-sync:${req.user!.org_id}:${req.user!.sub}`;
  let lockAcquired = false;
  try {
    const authorization = req.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw new AppError('Batch attendance sync requires bearer-token authentication.', 401, 'UNAUTHENTICATED');
    let lock: string | null;
    try { lock = await redis.set(lockKey, owner, 'PX', 10 * 60_000, 'NX'); }
    catch { throw new AppError('Attendance sync coordination is temporarily unavailable. Keep the events queued and retry.', 503, 'SYNC_COORDINATION_UNAVAILABLE'); }
    if (lock !== 'OK') throw new AppError('An attendance sync is already running for this account.', 409, 'ATTENDANCE_SYNC_IN_PROGRESS');
    lockAcquired = true;
    const events = req.body.events as Array<{ sequence: number; idempotency_key: string; type: keyof typeof syncActionPath; payload: Record<string, unknown> }>;
    const now = new Date();
    const previous = await prisma.attendanceSyncWatermark.findUnique({ where: { org_id_user_id: { org_id: req.user!.org_id, user_id: req.user!.sub } }, select: { last_sequence: true } });
    await prisma.attendanceSyncWatermark.upsert({
      where: { org_id_user_id: { org_id: req.user!.org_id, user_id: req.user!.sub } },
      create: { org_id: req.user!.org_id, user_id: req.user!.sub, last_sequence: Math.max(...events.map(event => event.sequence)), pending_until: new Date(now.getTime() + 5 * 60_000) },
      update: { last_sequence: Math.max(previous?.last_sequence ?? 0, ...events.map(event => event.sequence)), pending_until: new Date(now.getTime() + 5 * 60_000) },
    });

    const internalOrigin = (process.env.API_INTERNAL_ORIGIN || `http://127.0.0.1:${process.env.PORT || '5000'}`).replace(/\/$/, '');
    const outcomes: Array<Record<string, unknown>> = [];
    let stopReason: string | null = null;
    for (const event of events) {
      if (stopReason) {
        outcomes.push({ sequence: event.sequence, idempotency_key: event.idempotency_key, result: 'not_attempted', reason: stopReason });
        continue;
      }
      try {
        await prisma.attendanceSyncWatermark.update({ where: { org_id_user_id: { org_id: req.user!.org_id, user_id: req.user!.sub } }, data: { pending_until: new Date(Date.now() + 5 * 60_000) } });
        const actionBody: Record<string, unknown> = { ...event.payload, offline: true, idempotency_key: event.idempotency_key };
        if (event.type === 'checkin') actionBody.type = 'manual';
        const response = await fetch(`${internalOrigin}/api/v1/attendance${syncActionPath[event.type]}`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
          headers: {
            authorization,
            'content-type': 'application/json',
            'idempotency-key': event.idempotency_key,
            'x-forwarded-for': req.ip || '',
            'user-agent': 'Attenda-Offline-Sync/1.0',
          },
          body: JSON.stringify(actionBody),
        });
        const raw = await response.text();
        let body: any = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        if (response.ok && body?.success !== false) {
          outcomes.push({ sequence: event.sequence, idempotency_key: event.idempotency_key, result: body?.data?.idempotent || body?.data?.action === 'already_recorded' ? 'duplicate' : 'applied', data: body?.data ?? null });
          continue;
        }
        const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
        const rejected = response.status === 400 || response.status === 422;
        const permanent = response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 408 && response.status !== 429;
        const result = rejected ? 'rejected' : permanent ? 'parked_for_review' : 'retry';
        outcomes.push({ sequence: event.sequence, idempotency_key: event.idempotency_key, result, status: response.status, code, message: body?.error ?? 'Attendance event sync failed.' });
        stopReason = `Sequence ${event.sequence} was ${result}; later actions were held to preserve order.`;
      } catch (error) {
        outcomes.push({ sequence: event.sequence, idempotency_key: event.idempotency_key, result: 'retry', code: 'SYNC_TRANSPORT_ERROR', message: 'The event outcome could not be confirmed; retrying uses the same idempotency key.' });
        stopReason = `Sequence ${event.sequence} could not be confirmed; later actions were held to preserve order.`;
      }
    }
    const pending = outcomes.some(item => ['retry', 'not_attempted'].includes(String(item.result)));
    await prisma.attendanceSyncWatermark.update({
      where: { org_id_user_id: { org_id: req.user!.org_id, user_id: req.user!.sub } },
      data: { pending_until: pending ? new Date(Date.now() + 5 * 60_000) : null, last_sync_at: new Date() },
    });
    ok(res, { outcomes, last_sequence: Math.max(previous?.last_sequence ?? 0, ...events.map(event => event.sequence)), pending });
  } catch (error) {
    // If the process aborts mid-batch, retain its short pending lease so
    // late/absent detectors don't race events whose commit result is unknown.
    next(error);
  } finally {
    if (lockAcquired) await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, owner).catch(() => {});
  }
});

function actionEventTime(req: Request, receivedAt = new Date()) {
  if (req.body?.offline && req.get('Idempotency-Key') !== req.body?.idempotency_key) {
    throw new AppError('Offline attendance sync requires a matching Idempotency-Key header.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return resolveAttendanceEventTime(req.body ?? {}, req.user!.sub, req.user!.org_id, receivedAt);
}

function payloadHash(body: unknown): string {
  const stableBody = body && typeof body === 'object'
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'offline'))
    : body;
  return createHash('sha256').update(JSON.stringify(stableBody)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function notifyOfflineAttendanceReview(userId: string, orgId: string, recordId: string, action: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, manager_id: true } });
  if (!user?.manager_id) return;
  await createNotification({
    userId: user.manager_id, orgId, type: 'attendance_checkin_review',
    title: 'Offline attendance needs review',
    body: `${user.name} synced an offline ${action} with uncertain timing. Review the attendance evidence before using it for payroll decisions.`,
    actionType: 'attendance', actionId: recordId,
  }).catch((error) => console.error('[Attendance] Could not notify manager about offline review:', error));
}

async function resolvePriorNoShowAlerts(userId: string, orgId: string, recordId: string, attendanceDate: Date, timezone: string) {
  const date = attendanceDate.toISOString().slice(0, 10);
  const start = fromZonedTime(`${date}T00:00:00`, timezone);
  const nextDate = new Date(`${date}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const end = fromZonedTime(`${nextDate.toISOString().slice(0, 10)}T00:00:00`, timezone);
  const alerts = await prisma.inAppNotification.findMany({
    where: {
      org_id: orgId, action_id: userId,
      type: { in: ['attendance_late', 'attendance_late_escalation', 'attendance_absent'] },
      created_at: { gte: start, lt: end },
    },
    take: 100,
  });
  const noShowAlerts = alerts.filter(alert =>
    alert.title === 'Employee late' ||
    alert.title === 'Employee late (past expected time)' ||
    alert.title === '1-hour late escalation' ||
    alert.title === 'Employee absent',
  );
  const resolvedAt = new Date();
  await Promise.all(noShowAlerts.filter(alert => !alert.title.startsWith('Resolved · ')).map(alert => {
    const metadata = alert.metadata && typeof alert.metadata === 'object' && !Array.isArray(alert.metadata)
      ? alert.metadata as Record<string, unknown>
      : {};
    return prisma.inAppNotification.update({
      where: { id: alert.id },
      data: {
        title: `Resolved · ${alert.title}`,
        body: `${alert.body}\n\nResolved: the employee's check-in for this work date has now been received. The original alert is retained for context.`,
        metadata: { ...metadata, resolved_reason: 'attendance_checkin_reconciled', resolved_at: resolvedAt.toISOString() },
      },
    });
  }));
  const resolvedIds = noShowAlerts.filter(alert => !alert.title.startsWith('Resolved · ')).map(alert => alert.id);
  if (resolvedIds.length) await recordAudit({
    orgId, actorId: userId, action: 'attendance.no_show_alerts.resolved',
    entityType: 'attendance_record', entityId: recordId,
    before: { stale_notification_ids: resolvedIds },
    after: { reason: 'attendance_checkin_reconciled', work_date: date },
  });
}

router.get('/reviews', requirePermission('attendance.review_flags'), async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const records = await prisma.attendanceRecord.findMany({
      where: { org_id: req.user!.org_id, checkin_requires_review: true },
      include: RECORD_INCLUDE,
      orderBy: [{ checkin_received_at: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    ok(res, records);
  } catch (e) { next(e); }
});

router.put('/reviews/:id/resolve', requirePermission('attendance.review_flags'), idempotency, validate({ body: attendanceReviewResolveSchema }), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const { decision, note } = req.body as { decision: 'approve' | 'reject' | 'request_recheck'; note: string };
    const record = await prisma.attendanceRecord.findFirst({ where: { id, org_id: req.user!.org_id, checkin_requires_review: true } });
    if (!record) throw new NotFoundError('Attendance review');
    const resolvedAt = new Date();
    const changed = await prisma.attendanceRecord.updateMany({
      where: { id, org_id: req.user!.org_id, checkin_requires_review: true },
      data: {
        checkin_requires_review: false,
        checkin_reviewed_at: resolvedAt,
        checkin_reviewed_by: req.user!.sub,
        checkin_review_decision: decision,
        checkin_review_note: note,
      },
    });
    if (!changed.count) throw new AppError('This review was already handled. Reload the queue.', 409, 'STALE_REVIEW');
    await recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: `attendance.checkin_review.${decision}`, entityType: 'attendance_record', entityId: id, before: { checkin_requires_review: true }, after: { checkin_requires_review: false, decision, note } });
    createNotification({
      userId: record.user_id, orgId: req.user!.org_id, type: 'attendance_checkin_review',
      title: decision === 'approve' ? 'Offline check-in verified' : decision === 'reject' ? 'Offline check-in evidence rejected' : 'Please recheck your attendance',
      body: note, actionType: 'attendance', actionId: record.id,
    }).catch(console.error);
    emitOrgEvent(req.user!.org_id, 'attendance_changed');
    const updated = await prisma.attendanceRecord.findUnique({ where: { id }, include: RECORD_INCLUDE });
    ok(res, updated);
  } catch (e) { next(e); }
});

async function orgTimeContext(orgId: string, userId?: string) {
  const org = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: { timezone: true, late_threshold: true, gap_forgiveness_mins: true, attendance_security: true, wifi_auto_checkin_enabled: true, wifi_auto_checkout_enabled: true, heartbeat_grace_mins: true },
  });
  const employee = userId ? await prisma.user.findFirst({
    where: { id: userId, org_id: orgId },
    select: { primary_location: { select: { id: true, timezone: true, office_ips: true, office_ssids: true, geofence: true } } },
  }) : null;
  const mainLocation = !employee?.primary_location ? await prisma.location.findFirst({
    where: { org_id: orgId, is_main: true, is_active: true },
    select: { id: true, timezone: true, office_ips: true, office_ssids: true, geofence: true },
  }) : null;
  const location = employee?.primary_location ?? mainLocation;
  const timezone = location?.timezone ?? org?.timezone ?? 'UTC';
  return { org, location, timezone, today: dateOnlyInTz(new Date(), timezone) };
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

// The conditional include hides `breaks` from Prisma's inferred payload, so the
// return type is declared explicitly: `breaks` is present iff includeBreaks was true.
type EffectiveShift = Shift & { breaks?: ShiftBreak[] };

async function effectiveShiftForUser(userId: string, orgId: string, date: Date, at = new Date(), includeBreaks = false): Promise<EffectiveShift | null> {
  const include = includeBreaks ? ({ breaks: { orderBy: { after_minutes: 'asc' } } } as const) : undefined;
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
    let visibleUserIds: string[] | undefined;
    if (!req.permissions?.has('employees.view')) {
      const [directReports, managedLocations] = await Promise.all([
        req.permissions?.has('employees.view_team')
          ? prisma.user.findMany({ where: { org_id: req.user!.org_id, manager_id: req.user!.sub, is_active: true, deleted_at: null }, select: { id: true } })
          : Promise.resolve([] as { id: string }[]),
        req.permissions?.has('employees.view_location')
          ? prisma.locationManager.findMany({ where: { user_id: req.user!.sub, location: { org_id: req.user!.org_id, is_active: true } }, select: { location_id: true } })
          : Promise.resolve([] as { location_id: string }[]),
      ]);
      const locationUsers = managedLocations.length ? await prisma.user.findMany({ where: { org_id: req.user!.org_id, primary_location_id: { in: managedLocations.map(item => item.location_id) }, is_active: true, deleted_at: null }, select: { id: true } }) : [];
      visibleUserIds = [...new Set([...directReports, ...locationUsers].map(user => user.id))];
    }
    let dateWhere: Record<string, unknown>;
    if (rawDate) {
      dateWhere = { date: parseDateOnly(rawDate), ...(visibleUserIds ? { user_id: { in: visibleUserIds } } : {}) };
    } else {
      const employees = await prisma.user.findMany({
        where: { org_id: req.user!.org_id, is_active: true, deleted_at: null, ...(visibleUserIds ? { id: { in: visibleUserIds } } : {}) },
        select: { id: true, primary_location: { select: { id: true, timezone: true } } },
      });
      const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { timezone: true } });
      const localDates = new Map<string, { locationId: string | null; date: Date; users: string[] }>();
      for (const employee of employees) {
        const locationId = employee.primary_location?.id ?? null;
        const timezone = employee.primary_location?.timezone ?? org?.timezone ?? 'UTC';
        const date = dateOnlyInTz(new Date(), timezone);
        const key = `${locationId ?? 'legacy'}:${date.toISOString()}`;
        const group = localDates.get(key) ?? { locationId, date, users: [] };
        group.users.push(employee.id);
        localDates.set(key, group);
      }
      dateWhere = { OR: [...localDates.values()].map(group => ({
        user_id: { in: group.users }, date: group.date,
        ...(group.locationId ? { location_id: group.locationId } : {}),
      })) };
    }
    const records = await prisma.attendanceRecord.findMany({ where: { org_id: req.user!.org_id, ...dateWhere }, include: RECORD_INCLUDE, orderBy: { check_in_at: 'asc' } });
    ok(res, records);
  } catch (e) { next(e); }
});

// ─── GET /attendance/late-summary ──────────────────────
// Rolling lateness totals + policy points per user (org late_policy tiers).
// Team-level viewers see their direct reports; org viewers see everyone.
router.get('/late-summary', requirePermission('attendance.view_team'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { parseLatePolicy, lateSummaryForOrg, DEFAULT_POINTS_WINDOW_DAYS } = await import('../services/latePolicy');
    const org = await prisma.organisation.findUnique({
      where: { id: req.user!.org_id },
      select: { late_policy: true },
    });
    const policy = parseLatePolicy(org?.late_policy);

    const rawDays = parseInt(String(req.query.days ?? ''));
    const windowDays = Number.isFinite(rawDays) && rawDays >= 7 && rawDays <= 365
      ? rawDays
      : policy?.points_window_days ?? DEFAULT_POINTS_WINDOW_DAYS;

    let userIds: string[] | undefined;
    if (!req.permissions?.has('employees.view')) {
      const team = await prisma.user.findMany({
        where: { manager_id: req.user!.sub, is_active: true },
        select: { id: true },
      });
      userIds = team.map(u => u.id);
    }

    const summary = await lateSummaryForOrg(req.user!.org_id, policy, windowDays, userIds);
    ok(res, {
      window_days: windowDays,
      policy_configured: !!policy?.tiers?.length,
      alert_threshold_points: policy?.alert_threshold_points ?? null,
      users: summary,
    });
  } catch (e) { next(e); }
});

// ─── GET /attendance/me ────────────────────────────────
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { days = '30' } = req.query as { days?: string };
    const parsedDays = Number.parseInt(days, 10);
    const historyDays = Number.isFinite(parsedDays) ? Math.max(1, Math.min(365, parsedDays)) : 30;
    const since = new Date();
    since.setDate(since.getDate() - historyDays);
    const where = { user_id: req.user!.sub, date: { gte: since } };
    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || typeof req.query.cursor === 'string';
    const parsedLimit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, parsedLimit)) : 50;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const position = cursorMode && cursor ? decodeCursor(cursor, where) : null;

    if (cursorMode && cursor && !position) {
      const anchor = await prisma.attendanceRecord.findFirst({ where: { ...where, id: cursor }, select: { id: true } });
      if (!anchor) throw new ValidationError('Invalid attendance cursor');
    }

    const records = await prisma.attendanceRecord.findMany({
      where: position ? { ...where, AND: [keysetAfter(position, 'date')] } : where,
      ...(!position && cursorMode && cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      ...(cursorMode ? { take: limit + 1 } : {}),
      include: {
        break_records: { orderBy: { break_start: 'asc' } },
      },
    });
    if (!cursorMode) {
      ok(res, records);
      return;
    }
    const hasMore = records.length > limit;
    const items = hasMore ? records.slice(0, limit) : records;
    const last = items[items.length - 1];
    ok(res, { items, next_cursor: hasMore && last ? encodeCursor({ at: last.date, id: last.id }, where) : null, has_more: hasMore, limit });
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/sessions ──────────────────
// Manager sees remote session requests for approval
router.get('/remote/sessions', requirePermission('remote.approve'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query as { status?: string };
    const permissions = req.permissions ?? await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    const employeeIds = await reviewableEmployeeIds(req.user!.org_id, req.user!.sub, permissions, 'employees.view');
    const where = {
      user: { org_id: req.user!.org_id, ...(employeeIds !== null && { id: { in: employeeIds } }) },
      ...(status ? { status } : {}),
    };

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
router.put('/remote/sessions/:id/approve', requirePermission('remote.approve'), idempotency, async (req, res, next) => {
  try {
    const result = await reviewApproval(
      { userId: req.user!.sub, orgId: req.user!.org_id },
      { type: 'remote', id: String(req.params.id), action: 'approve' },
    );
    const { notifyRemote } = await import('../services/whatsapp');
    await notifyRemote(req.user!.org_id, result.requester).catch(console.error);
    ok(res, { message: result.summary });
  } catch (e) { next(e); }
});

// ─── PUT /attendance/remote/sessions/:id/reject ───────
router.put('/remote/sessions/:id/reject', requirePermission('remote.approve'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const result = await reviewApproval(
      { userId: req.user!.sub, orgId: req.user!.org_id },
      { type: 'remote', id: String(req.params.id), action: 'reject', reason },
    );
    ok(res, { message: result.summary });
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
    const now   = new Date();
    const orgTimezone = await prisma.organisation.findUnique({
      where: { id: req.user!.org_id },
      select: { timezone: true },
    });
    // Attendance.date is stored as a UTC-midnight date-only value representing
    // the employee's work date. Query a broad UTC window, then select today's
    // records using each employee's assigned location timezone.
    const dateWindowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 2));
    const dateWindowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 3));

    const permissions = req.permissions ?? await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    const employeeIds = await reviewableEmployeeIds(req.user!.org_id, req.user!.sub, permissions, 'employees.view');

    const where: Record<string, unknown> = {
      user: { org_id: req.user!.org_id },
      attendance: { date: { gte: dateWindowStart, lt: dateWindowEnd } },
    };
    if (employeeIds !== null) where.user_id = { in: employeeIds };

    const sessions = await prisma.remoteSession.findMany({
      where,
      include: {
        user:         { select: { id: true, name: true, department: true, avatar_url: true, phone: true } },
        attendance:   { select: {
          date: true,
          location: { select: { timezone: true } },
          user: { select: {
            primary_location: { select: { timezone: true } },
            org: { select: { timezone: true } },
          } },
        } },
        checkin_logs: { orderBy: { nudge_sent_at: 'asc' } },
      },
      orderBy: { created_at: 'desc' },
    });

    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    const todaysSessions = sessions.filter((session) => {
      const timezone = session.attendance.location?.timezone
        || session.attendance.user.primary_location?.timezone
        || session.attendance.user.org.timezone
        || 'UTC';
      return dateOnlyInTz(now, timezone).toISOString() === session.attendance.date.toISOString();
    });

    const enriched = todaysSessions.map(s => {
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
      date:  dateOnlyInTz(now, orgTimezone?.timezone || 'UTC'),
      stats: { total, responded, no_reply: noReply, avg_sentiment: avgSentiment },
      sessions: enriched,
    });
  } catch (e) { next(e); }
});

// ─── GET /attendance/remote/sessions/:id/logs ─────────
// Full nudge log for one session — accessible by the employee or their manager
router.get('/remote/sessions/:id/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const permissions = await resolveUserPermissions(req.user!.sub, req.user!.org_id);
    const canReviewRemote = permissions.has('remote.approve');
    const canViewTeam = permissions.has('attendance.view_team') || permissions.has('attendance.override');
    const teamIds = canReviewRemote
      ? await reviewableEmployeeIds(req.user!.org_id, req.user!.sub, permissions, 'employees.view')
      : canViewTeam
        ? await scopedEmployeeIds(req.user!.org_id, req.user!.sub, permissions, 'employees.view')
        : null;
    const session = await prisma.remoteSession.findFirst({
      where: (canReviewRemote || canViewTeam)
        ? { id: String(req.params.id), user: { org_id: req.user!.org_id, ...(teamIds !== null && { id: { in: teamIds } }) } }
        : { id: String(req.params.id), user_id: req.user!.sub },
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
router.post('/break/start', validate({ body: breakStartSchema }), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { break_type = 'rest', shift_break_id } = req.body;
    const { today } = await orgTimeContext(req.user!.org_id);
    const { eventAt, requiresReview } = actionEventTime(req);
    const key = req.body?.idempotency_key as string | undefined;
    const hash = key ? payloadHash(req.body) : null;
    if (key) {
      const previous = await prisma.breakRecord.findFirst({ where: { start_idempotency_key: key }, include: { attendance: true, shift_break: true } });
      if (previous) {
        if (previous.start_request_hash !== hash || previous.attendance.user_id !== req.user!.sub || previous.attendance.org_id !== req.user!.org_id) throw new AppError('This idempotency key was already used with a different break-start payload.', 409, 'IDEMPOTENCY_KEY_REUSED');
        return ok(res, { ...previous, action: 'already_recorded', idempotent: true });
      }
    }
    const record = req.body?.offline
      ? await prisma.attendanceRecord.findFirst({
          where: { org_id: req.user!.org_id, user_id: req.user!.sub, check_in_at: { lte: eventAt }, check_out_at: null },
          orderBy: { check_in_at: 'desc' },
          include: { break_records: true, shift: { include: { breaks: true } } },
        })
      : await prisma.attendanceRecord.findUnique({
          where: { user_id_date: { user_id: req.user!.sub, date: today } },
          include: { break_records: true, shift: { include: { breaks: true } } },
        });
    if (!record || !record.check_in_at) throw new AppError('Not checked in', 400, 'NOT_CHECKED_IN');
    if (record.check_out_at) throw new AppError('Already checked out', 400, 'CHECKED_OUT');
    if (eventAt < record.check_in_at) throw new AppError('Break start is before check-in. This event needs review.', 409, 'OFFLINE_EVENT_REVIEW');
    if (record.break_records.some(b => !b.break_end)) throw new AppError('Break already in progress', 400, 'BREAK_IN_PROGRESS');

    const shift = record.shift ?? await effectiveShiftForUser(req.user!.sub, req.user!.org_id, today, new Date(), true);
    const availableBreaks = (shift?.breaks ?? []).filter(b => dayMatchesBreak(b, req.body?.offline ? record.date : today));
    const policy = shift_break_id
      ? availableBreaks.find(b => b.id === shift_break_id)
      : availableBreaks.find(b => b.name === break_type || b.id === break_type);

    const allowedCount = policy?.allowed_count_per_shift ?? 1;
    if (shift_break_id && !policy) throw new AppError('This break is not available today', 400, 'INVALID_BREAK');
    const { breakRecord, limitExceeded } = await prisma.$transaction(async tx => {
      // Serialize break starts against checkout and other break actions by
      // locking the parent attendance row, then re-read the authoritative state.
      const activeAttendance = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM attendance_records
        WHERE id = ${record.id} AND org_id = ${req.user!.org_id} AND user_id = ${req.user!.sub} AND check_out_at IS NULL
        FOR UPDATE
      `;
      if (!activeAttendance.length) throw new AppError('This attendance record has already been checked out.', 409, 'CHECKED_OUT');
      const currentBreaks = await tx.breakRecord.findMany({ where: { attendance_id: record.id }, select: { shift_break_id: true, break_type: true, break_end: true } });
      if (currentBreaks.some(item => !item.break_end)) throw new AppError('Break already in progress', 409, 'BREAK_IN_PROGRESS');
      const takenCount = policy
        ? currentBreaks.filter(item => item.shift_break_id === policy.id).length
        : currentBreaks.filter(item => item.break_type === break_type).length;
      const limitExceeded = !!policy && policy.break_kind === 'flexible' && takenCount >= allowedCount;
      if (limitExceeded && !policy!.allow_extra_breaks) throw new AppError('No more breaks of this type are allowed today', 400, 'BREAK_LIMIT_REACHED');
      // Ad-hoc breaks (no shift policy) are always unpaid.
      const isPaid = policy
        ? !!policy.is_paid && (limitExceeded ? !policy.deduct_extra_time : policy.paid_within_limit)
        : false;
      const breakRecord = await tx.breakRecord.create({
        data: {
          attendance_id: record.id,
          break_start: eventAt,
          break_type: policy?.name ?? break_type,
          is_paid: isPaid,
          shift_break_id: policy?.id ?? undefined,
          limit_exceeded: limitExceeded,
          counted_as_extra: limitExceeded,
          source: req.body?.offline ? 'offline' : 'manual',
          ...(key && { start_idempotency_key: key, start_request_hash: hash }),
        },
      });
      if (req.body?.offline) await tx.attendanceRecord.update({ where: { id: record.id }, data: { offline_reconciled: true, ...(requiresReview && { checkin_requires_review: true }) } });
      return { breakRecord, limitExceeded };
    });
    if (req.body?.offline && requiresReview) await notifyOfflineAttendanceReview(req.user!.sub, req.user!.org_id, record.id, 'break start');
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
router.post('/break/end', validate({ body: breakEndSchema }), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { wifi_connected } = req.body as { wifi_connected?: boolean };
    const { today, timezone: tz } = await orgTimeContext(req.user!.org_id);
    const { eventAt: now, requiresReview } = actionEventTime(req);
    const key = req.body?.idempotency_key as string | undefined;
    const hash = key ? payloadHash(req.body) : null;
    if (key) {
      const previous = await prisma.breakRecord.findFirst({ where: { end_idempotency_key: key }, include: { attendance: true, shift_break: true } });
      if (previous) {
        if (previous.end_request_hash !== hash || previous.attendance.user_id !== req.user!.sub || previous.attendance.org_id !== req.user!.org_id) throw new AppError('This idempotency key was already used with a different break-end payload.', 409, 'IDEMPOTENCY_KEY_REUSED');
        return ok(res, { ...previous, action: 'already_recorded', idempotent: true });
      }
    }
    const record = req.body?.offline
      ? await prisma.attendanceRecord.findFirst({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, check_in_at: { lte: now }, check_out_at: null }, orderBy: { check_in_at: 'desc' }, include: { break_records: { where: { break_end: null }, include: { shift_break: true } } } })
      : await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: req.user!.sub, date: today } }, include: { break_records: { where: { break_end: null }, include: { shift_break: true } } } });
    if (!record) throw new AppError('Not checked in today', 400, 'NOT_CHECKED_IN');
    const activeBreak = record.break_records[0];
    if (!activeBreak) throw new AppError('No break in progress', 400, 'NO_BREAK');
    if (now <= activeBreak.break_start) throw new AppError('Break end must be after break start. This event needs review.', 409, 'OFFLINE_EVENT_REVIEW');
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

    const ended = await prisma.$transaction(async tx => {
      const activeAttendance = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM attendance_records
        WHERE id = ${record.id} AND org_id = ${req.user!.org_id} AND user_id = ${req.user!.sub} AND check_out_at IS NULL
        FOR UPDATE
      `;
      if (!activeAttendance.length) throw new AppError('This attendance record has already been checked out.', 409, 'CHECKED_OUT');
      const currentBreak = await tx.breakRecord.findFirst({
        where: { id: activeBreak.id, attendance_id: record.id, break_end: null },
        select: { id: true, break_start: true },
      });
      if (!currentBreak) throw new AppError('This break has already ended.', 409, 'BREAK_ALREADY_ENDED');
      if (now <= currentBreak.break_start) throw new AppError('Break end must be after break start. This event needs review.', 409, 'OFFLINE_EVENT_REVIEW');
      const currentDuration = Math.max(0, Math.round((now.getTime() - currentBreak.break_start.getTime()) / 60000));
      const updatedCount = await tx.breakRecord.updateMany({
        where: { id: currentBreak.id, attendance_id: record.id, break_end: null },
        data: {
          break_end: now,
          duration_mins: currentDuration,
          late_return_minutes: lateReturnMins,
          wifi_on_at_end: wifi_connected ?? null,
          ...(key && { end_idempotency_key: key, end_request_hash: hash }),
          ...(req.body?.offline && { source: 'offline' }),
        },
      });
      if (!updatedCount.count) throw new AppError('This break has already ended.', 409, 'BREAK_ALREADY_ENDED');
      const breakTotals = await calculateBreakTotals(record.id, tx);
      const totalMins = record.check_in_at ? Math.round((now.getTime() - record.check_in_at.getTime()) / 60000) : 0;
      await tx.attendanceRecord.update({
        where: { id: record.id },
        data: {
          break_minutes: breakTotals.totalMins,
          paid_break_minutes: breakTotals.paidMins,
          net_hours_worked: parseFloat(((totalMins - breakTotals.unpaidMins) / 60).toFixed(2)),
          ...(req.body?.offline && { offline_reconciled: true, ...(requiresReview && { checkin_requires_review: true }) }),
        },
      });
      return tx.breakRecord.findUniqueOrThrow({ where: { id: currentBreak.id } });
    });
    if (req.body?.offline && requiresReview) await notifyOfflineAttendanceReview(req.user!.sub, req.user!.org_id, record.id, 'break end');

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
router.post('/late-notice', idempotency, validate({ body: lateNoticeSchema }), async (req: Request, res: Response, next: NextFunction) => {
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
router.put('/late-notice/:id/acknowledge', requirePermission('attendance.late_notices.manage'), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notice = await prisma.lateArrivalNotice.findFirst({
      where: { id: String(req.params.id), org_id: req.user!.org_id },
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
router.delete('/late-notice/:id', idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notice = await prisma.lateArrivalNotice.findFirst({
      where: { id: String(req.params.id), user_id: req.user!.sub },
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
    const { org, location, timezone: tz, today } = await orgTimeContext(req.user!.org_id, req.user!.sub);
    const attendanceSecurity = parseLocationGeofence(location?.geofence) ?? parseAttendanceSecurity(org?.attendance_security);

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
    const breakTotals = record ? await calculateBreakTotals(record.id) : null;

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
    let expected_checkin_utc: string | null = null;
    const late_tolerance_minutes = lateThresholdFor(shift, org);
    let shift_start_utc: string | null = null;
    let shift_end_utc: string | null = null;
    if (!record?.check_in_at && shift) {
      const approvedLeave = await prisma.leaveRequest.findFirst({
        where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: today }, end_date: { gte: today } },
        select: { is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
      });
      const adjusted = adjustedWindowForLeave(shift, tz, now, approvedLeave);
      expected_checkin_utc = adjusted.start.toISOString();
      const rawLate = Math.max(0, Math.round((now.getTime() - adjusted.start.getTime()) / 60000));
      pre_checkin_late_minutes = Math.max(0, rawLate - late_tolerance_minutes);
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
        date:         record.date,
        status:       record.status,
        check_in_at:  record.check_in_at,
        check_out_at: record.check_out_at,
        check_in_type: record.check_in_type,
        hours_worked: record.hours_worked,
        late_minutes: record.late_minutes,
        early_out_minutes: record.early_out_minutes,
        early_checkin_minutes: record.early_checkin_minutes,
        net_hours_worked: record.net_hours_worked,
        overtime_hours: record.overtime_hours,
        extra_office_minutes: record.extra_office_minutes,
        break_minutes: breakTotals?.totalMins ?? record.break_minutes,
        paid_break_minutes: breakTotals?.paidMins ?? record.paid_break_minutes,
        auto_checked_out: record.auto_checked_out,
        late_notice_id: record.late_notice_id,
        last_heartbeat_at: record.last_heartbeat_at,
        break_records: record.break_records,
      } : null,
      active_break: activeBreak,
      date: today.toISOString().split('T')[0],
      pre_checkin_late_minutes,
      expected_checkin_utc,
      late_tolerance_minutes,
      location_capture_enabled: attendanceSecurity?.geofence_enabled ?? false,
      location_required: !!attendanceSecurity?.geofence_enabled && attendanceSecurity.require_location,
      server_time: now.toISOString(),
      attendance_clock_anchor: issueAttendanceClockAnchor(req.user!.sub, req.user!.org_id, now),
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
router.post('/checkin', idempotency, validate({ body: checkinSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      type = 'manual', qr_code, duration_type = 'full_day', count_away_as_break,
      away_shift_break_id, idempotency_key, client_event_at, offline = false,
      latitude, longitude, accuracy_m, is_mocked = false,
      device_uptime_ms, server_anchor_uptime_ms, clock_epoch, server_anchor_epoch, attendance_clock_anchor,
      device_proof,
    } = req.body;
    if (type === 'remote' && !hasFeature(await resolveOrgFeatures(req.user!.org_id), 'remote_work')) {
      throw new ForbiddenError('Remote work is not enabled for this organization');
    }
    const { org: orgInfo, location, timezone: orgTimezone } = await orgTimeContext(req.user!.org_id, req.user!.sub);
    const receivedAt = new Date();
    const clientEventAt = client_event_at ? new Date(client_event_at) : null;
    if (offline && (!idempotency_key || !clientEventAt || !attendance_clock_anchor || device_uptime_ms === undefined || server_anchor_uptime_ms === undefined || !clock_epoch || !server_anchor_epoch)) {
      throw new AppError('Offline check-in needs a trusted time anchor. Reconnect before retrying.', 409, 'OFFLINE_CHECKIN_REVIEW');
    }
    const hashBody = Object.fromEntries(Object.entries(req.body).filter(([key]) => key !== 'offline').sort(([a], [b]) => a.localeCompare(b)));
    const requestHash = idempotency_key ? createHash('sha256').update(JSON.stringify(hashBody)).digest('hex') : null;
    let checkInAt = receivedAt;
    let requiresCheckinReview = false;
    let deviceProofStatus = 'missing';
    let verifiedDeviceId: string | null = null;
    let deviceSignatureVerified = false;
    if (offline && clientEventAt) {
      const anchor = verifyAttendanceClockAnchor(attendance_clock_anchor!, req.user!.sub, req.user!.org_id);
      const anchorAt = new Date(anchor.server_time);
      const elapsedMs = device_uptime_ms! - server_anchor_uptime_ms!;
      const anchorAgeMs = receivedAt.getTime() - anchorAt.getTime();
      const monotonicValid = clock_epoch === server_anchor_epoch && elapsedMs >= 0 && elapsedMs <= 12 * 60 * 60_000 && anchorAgeMs >= 0 && anchorAgeMs <= 12 * 60 * 60_000;
      if (monotonicValid) {
        checkInAt = new Date(anchorAt.getTime() + elapsedMs);
        if (checkInAt.getTime() > receivedAt.getTime() + 2 * 60_000) throw new AppError('Offline time proof is outside the valid range. Contact your manager.', 409, 'OFFLINE_CHECKIN_REVIEW');
        requiresCheckinReview = Math.abs(checkInAt.getTime() - clientEventAt.getTime()) > 2 * 60_000 || receivedAt.getTime() - checkInAt.getTime() > 10 * 60_000 || anchorAgeMs > 10 * 60_000;
      } else {
        // A reboot/process reset breaks the monotonic chain. Do not trust the
        // wall clock; record at receipt time and send the event to review.
        checkInAt = receivedAt;
        requiresCheckinReview = true;
      }
    }
    if (device_proof) {
      const proof = device_proof as { device_id: string; challenge: string; signature: string; signed_payload: string };
      const device = await prisma.attendanceDevice.findFirst({
        where: { id: proof.device_id, org_id: req.user!.org_id, user_id: req.user!.sub, status: 'approved' },
        select: { id: true, public_key: true },
      });
      const challengeHash = createHash('sha256').update(proof.challenge).digest();
      const challengeRecord = device ? await prisma.attendanceDeviceChallenge.findFirst({
        where: { org_id: req.user!.org_id, user_id: req.user!.sub, device_id: device.id, challenge_hash: challengeHash.toString('hex') },
        select: { id: true, challenge_hash: true, expires_at: true, consumed_at: true },
      }) : null;
      const proofRequest = Object.fromEntries(Object.entries(req.body as Record<string, unknown>)
        .filter(([key]) => key !== 'offline' && key !== 'device_proof')
        .sort(([a], [b]) => a.localeCompare(b)));
      let signedPayloadMatches = false;
      try {
        const signedPayload = JSON.parse(proof.signed_payload) as unknown;
        signedPayloadMatches = !!signedPayload && typeof signedPayload === 'object' && !Array.isArray(signedPayload) && stableJson(signedPayload) === stableJson(proofRequest);
      } catch { signedPayloadMatches = false; }
      const expectedChallengeHash = challengeRecord ? Buffer.from(challengeRecord.challenge_hash, 'hex') : Buffer.alloc(0);
      const challengeMatches = !!device && !!challengeRecord && expectedChallengeHash.length === challengeHash.length && timingSafeEqual(expectedChallengeHash, challengeHash);
      const requestMatches = signedPayloadMatches;
      const challengeFresh = !!challengeRecord && !challengeRecord.consumed_at && challengeRecord.expires_at.getTime() > receivedAt.getTime();
      let signatureValid = false;
      if (device && challengeMatches && requestMatches && challengeFresh) {
        try {
          const publicKey = createPublicKey({ key: Buffer.from(device.public_key, 'base64'), format: 'der', type: 'spki' });
          const signingPrefix = ['attenda-checkin-v2', req.user!.org_id, req.user!.sub, device.id, proof.challenge, ''].join('\n');
          const message = `${signingPrefix}${proof.signed_payload}`;
          signatureValid = verifySignature('sha256', Buffer.from(message, 'utf8'), publicKey, Buffer.from(proof.signature, 'base64'));
        } catch { signatureValid = false; }
      }
      if (device && challengeMatches && requestMatches && challengeFresh && signatureValid) {
        const consumed = await prisma.attendanceDeviceChallenge.updateMany({
          where: { id: challengeRecord!.id, org_id: req.user!.org_id, user_id: req.user!.sub, device_id: device.id, consumed_at: null, expires_at: { gt: receivedAt } },
          data: { consumed_at: receivedAt },
        });
        if (consumed.count) {
          verifiedDeviceId = device.id;
          deviceSignatureVerified = true;
          deviceProofStatus = 'verified';
          await prisma.attendanceDevice.update({ where: { id: device.id }, data: { last_used_at: receivedAt } })
            .catch(error => console.error('[Attendance] Could not update trusted-device last-used time:', error));
        } else {
          deviceProofStatus = 'replayed';
          requiresCheckinReview = true;
        }
      } else {
        deviceProofStatus = !device ? 'untrusted' : challengeRecord?.consumed_at ? 'replayed' : challengeRecord && !challengeFresh ? 'expired' : 'invalid';
        requiresCheckinReview = true;
      }
    }
    const attendanceDate = dateOnlyInTz(checkInAt, orgTimezone);
    const serverAnchorAt = offline ? new Date(verifyAttendanceClockAnchor(attendance_clock_anchor!, req.user!.sub, req.user!.org_id).server_time) : null;
    const checkinTrustData = {
      checkin_request_hash: requestHash,
      checkin_source: offline ? 'offline' : type,
      checkin_requires_review: requiresCheckinReview,
      checkin_review_reason: null as string | null,
      attendance_device_id: verifiedDeviceId,
      device_proof_status: deviceProofStatus,
      device_signature_verified: deviceSignatureVerified,
      ...(offline && { device_uptime_ms, server_anchor_uptime_ms, server_anchor_at: serverAnchorAt, clock_epoch }),
    };

    if (idempotency_key) {
      const duplicate = await prisma.attendanceRecord.findFirst({
        where: { user_id: req.user!.sub, checkin_idempotency_key: idempotency_key },
        include: RECORD_INCLUDE,
      });
      if (duplicate) {
        if (duplicate.checkin_request_hash && requestHash && duplicate.checkin_request_hash !== requestHash) throw new AppError('This idempotency key was already used with a different check-in payload.', 409, 'IDEMPOTENCY_KEY_REUSED');
        return ok(res, { ...duplicate, action: 'already_recorded', idempotent: true });
      }
    }
    const locationPolicy = type === 'remote' ? null : (parseLocationGeofence(location?.geofence) ?? parseAttendanceSecurity(orgInfo?.attendance_security));
    const locationCheck = evaluateCheckinLocation(locationPolicy, { latitude, longitude, accuracy_m, is_mocked });
    const locationReviewReason = locationPolicy?.geofence_enabled && locationCheck && locationCheck.status !== 'inside'
      ? `geofence_${locationCheck.status}`
      : null;
    if (locationReviewReason) {
      requiresCheckinReview = true;
      checkinTrustData.checkin_requires_review = true;
      checkinTrustData.checkin_review_reason = locationReviewReason;
    }
    // Capture client IP — prefer X-Forwarded-For (behind proxy/load balancer)
    const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null;

    // Check no existing check-in on the event's organization-local day.
    const existing = await prisma.attendanceRecord.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: attendanceDate } },
    });

    // Re-entry: employee was auto-checked out (WiFi dropout / heartbeat expiry)
    // and has now returned without having logged a break. Log the gap as an
    // unpaid 'away' break and reopen the record so the rest of the day continues.
    if (existing?.check_in_at && existing.check_out_at && existing.auto_checked_out) {
      const reentryTime = checkInAt;
      const reopenedStatus = (existing.late_minutes ?? 0) > 0 ? 'late' : 'in';
      const gapSinceCheckout = Math.round((reentryTime.getTime() - existing.check_out_at.getTime()) / 60000);

      // Doze-gap forgiveness — see /ip-event re-entry for rationale.
      const forgivenessMins = orgInfo?.gap_forgiveness_mins ?? 15;
      if (gapSinceCheckout <= forgivenessMins) {
        const stitched = await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            check_out_at:      null,
            location_id:       location?.id ?? existing.location_id,
            hours_worked:      null,
            net_hours_worked:  null,
            early_out_minutes: 0,
            adherence_score:   null,
            auto_checked_out:  false,
            status:            reopenedStatus,
            last_heartbeat_at: null,
            ...(idempotency_key && { checkin_idempotency_key: idempotency_key }),
            ...(clientEventAt && { client_checkin_at: clientEventAt }),
            checkin_received_at: receivedAt,
            offline_reconciled: offline,
            ...checkinTrustData,
            ...(locationPolicy?.geofence_enabled && latitude !== undefined && { latitude }),
            ...(locationPolicy?.geofence_enabled && longitude !== undefined && { longitude }),
            ...(locationPolicy?.geofence_enabled && accuracy_m !== undefined && { location_accuracy_m: accuracy_m }),
            mock_location_detected: locationPolicy?.geofence_enabled ? is_mocked : false,
            geofence_status: locationCheck?.status,
            geofence_distance_m: locationCheck?.distance_m ?? undefined,
          },
          include: RECORD_INCLUDE,
        });
        return ok(res, { ...stitched, action: 're_entered', gap_mins: gapSinceCheckout, forgiven: true, warning: null });
      }

      const { gapMins, limitExceeded } = await createAwayGapBreak(existing, reentryTime, {
        countAsBreak: !!count_away_as_break,
        shiftBreakId: away_shift_break_id,
      });
      const breakTotals = await calculateBreakTotals(existing.id);
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
          break_minutes:     breakTotals.totalMins,
          paid_break_minutes: breakTotals.paidMins,
          last_heartbeat_at: null,
          ...(idempotency_key && { checkin_idempotency_key: idempotency_key }),
          ...(clientEventAt && { client_checkin_at: clientEventAt }),
          checkin_received_at: receivedAt,
          offline_reconciled: offline,
          ...checkinTrustData,
          ...(locationPolicy?.geofence_enabled && latitude !== undefined && { latitude }),
          ...(locationPolicy?.geofence_enabled && longitude !== undefined && { longitude }),
          ...(locationPolicy?.geofence_enabled && accuracy_m !== undefined && { location_accuracy_m: accuracy_m }),
          mock_location_detected: locationPolicy?.geofence_enabled ? is_mocked : false,
          geofence_status: locationCheck?.status,
          geofence_distance_m: locationCheck?.distance_m ?? undefined,
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

    const now = checkInAt;

    // ── Check for approved leave ──────────────────────────────────────────────
    // Half-day leave employees are expected to check in for the other half.
    // Full-day leave: allow check-in but flag is_on_approved_leave=true + notify manager.
    const approvedLeave = await prisma.leaveRequest.findFirst({
      where: { user_id: req.user!.sub, status: 'approved', start_date: { lte: attendanceDate }, end_date: { gte: attendanceDate } },
      select: { id: true, leave_type: true, is_half_day: true, half_day_period: true, leave_start_time: true, leave_end_time: true },
    });
    // Half-day leave: not an override — employee IS expected to show up for the other half
    const isFullDayLeaveOverride = !!approvedLeave && !approvedLeave.is_half_day;

    // ── Check for an active late notice ──────────────────────────────────────
    const lateNotice = await prisma.lateArrivalNotice.findUnique({
      where: { user_id_date: { user_id: req.user!.sub, date: attendanceDate } },
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
      const shift = await effectiveShiftForUser(req.user!.sub, req.user!.org_id, attendanceDate, now);

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

    let record;
    try {
      record = existing
      ? await prisma.attendanceRecord.update({
          where: { id: existing.id },
          data: {
            check_in_at: now, check_in_type: type, status,
            checkin_idempotency_key: idempotency_key ?? undefined,
            client_checkin_at: clientEventAt ?? undefined,
            checkin_received_at: receivedAt,
            offline_reconciled: offline,
            ...checkinTrustData,
            ...(locationPolicy?.geofence_enabled && latitude !== undefined && { latitude }),
            ...(locationPolicy?.geofence_enabled && longitude !== undefined && { longitude }),
            ...(locationPolicy?.geofence_enabled && accuracy_m !== undefined && { location_accuracy_m: accuracy_m }),
            mock_location_detected: locationPolicy?.geofence_enabled ? is_mocked : false,
            geofence_status: locationCheck?.status,
            geofence_distance_m: locationCheck?.distance_m ?? undefined,
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
            user_id: req.user!.sub, org_id: req.user!.org_id, location_id: location?.id,
            date: attendanceDate, check_in_at: now, check_in_type: type, status,
            checkin_idempotency_key: idempotency_key ?? undefined,
            client_checkin_at: clientEventAt ?? undefined,
            checkin_received_at: receivedAt,
            offline_reconciled: offline,
            ...checkinTrustData,
            ...(locationPolicy?.geofence_enabled && latitude !== undefined && { latitude }),
            ...(locationPolicy?.geofence_enabled && longitude !== undefined && { longitude }),
            ...(locationPolicy?.geofence_enabled && accuracy_m !== undefined && { location_accuracy_m: accuracy_m }),
            mock_location_detected: locationPolicy?.geofence_enabled ? is_mocked : false,
            geofence_status: locationCheck?.status,
            geofence_distance_m: locationCheck?.distance_m ?? undefined,
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
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const concurrentRecord = await prisma.attendanceRecord.findUnique({
        where: { user_id_date: { user_id: req.user!.sub, date: attendanceDate } },
        include: RECORD_INCLUDE,
      });
      if (!concurrentRecord?.check_in_at) throw error;
      if (idempotency_key && concurrentRecord.checkin_idempotency_key === idempotency_key && concurrentRecord.checkin_request_hash && requestHash && concurrentRecord.checkin_request_hash !== requestHash) {
        throw new AppError('This idempotency key was already used with a different check-in payload.', 409, 'IDEMPOTENCY_KEY_REUSED');
      }
      return ok(res, {
        ...concurrentRecord,
        action: 'already_recorded',
        idempotent: !!idempotency_key && concurrentRecord.checkin_idempotency_key === idempotency_key,
      });
    }

    if (type !== 'remote') {
      await resolvePriorNoShowAlerts(req.user!.sub, req.user!.org_id, record.id, attendanceDate, orgTimezone)
        .catch(error => console.error('[Attendance] Could not reconcile prior no-show notifications:', error));
    }

    if (requiresCheckinReview) {
      const reviewer = await prisma.user.findUnique({ where: { id: req.user!.sub }, select: { manager_id: true } });
      if (reviewer?.manager_id) createNotification({
        userId: reviewer.manager_id, orgId: req.user!.org_id,
        type: 'attendance_checkin_review', title: 'Offline check-in needs review',
        body: `${req.user!.name} submitted an offline check-in with uncertain timing. Review the evidence before using it for payroll decisions.`,
        actionType: 'attendance', actionId: record.id,
      }).catch(console.error);
    }

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

    emitOrgEvent(req.user!.org_id, 'attendance_changed');
    ok(res, record);
  } catch (e) { next(e); }
});

// ─── POST /attendance/checkout ─────────────────────────
router.post('/checkout', validate({ body: checkoutSchema }), idempotency, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { timezone: orgTimezone, today } = await orgTimeContext(req.user!.org_id, req.user!.sub);
    const receivedAt = new Date();
    const { eventAt: now, requiresReview } = actionEventTime(req, receivedAt);
    const key = req.body?.idempotency_key as string | undefined;
    const hash = key ? payloadHash(req.body) : null;
    if (key) {
      const previous = await prisma.attendanceRecord.findFirst({ where: { user_id: req.user!.sub, checkout_idempotency_key: key }, include: RECORD_INCLUDE });
      if (previous) {
        if (previous.checkout_request_hash !== hash) throw new AppError('This idempotency key was already used with a different check-out payload.', 409, 'IDEMPOTENCY_KEY_REUSED');
        return ok(res, { ...previous, action: 'already_recorded', idempotent: true });
      }
    }
    const record = req.body?.offline
      ? await prisma.attendanceRecord.findFirst({ where: { org_id: req.user!.org_id, user_id: req.user!.sub, check_in_at: { lte: now }, check_out_at: null }, orderBy: { check_in_at: 'desc' }, include: { shift: true } })
      : await prisma.attendanceRecord.findUnique({ where: { user_id_date: { user_id: req.user!.sub, date: today } }, include: { shift: true } });
    if (!record?.check_in_at) throw new ValidationError('No check-in found for today');
    if (record.check_out_at)  throw new ValidationError('Already checked out today');
    if (now < record.check_in_at) throw new AppError('Check-out time is before check-in. This event needs review.', 409, 'OFFLINE_EVENT_REVIEW');
    const hoursWorked  = calcHoursWorked(record.check_in_at, now);

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
    const autoCountOvertime = !!record.shift?.overtime_enabled && !record.shift?.overtime_requires_approval;
    // Claim the attendance row first, then close breaks and the linked project
    // timer in the same transaction. A second checkout waits for the claim and
    // sees check_out_at set; any timer/break database error rolls the checkout
    // back instead of returning a misleading success.
    const { updated, stoppedTimerId } = await prisma.$transaction(async tx => {
      const claimed = await tx.attendanceRecord.updateMany({
        where: { id: record.id, org_id: req.user!.org_id, user_id: req.user!.sub, check_out_at: null },
        data: {
          check_out_at: now,
          status: 'out',
          ...(key && { checkout_idempotency_key: key, checkout_request_hash: hash }),
        },
      });
      if (!claimed.count) throw new AppError('This attendance record has already been checked out.', 409, 'ALREADY_CHECKED_OUT');

      const breaks = await settleBreaks(record.id, now, orgTimezone, tx);
      const netHours = netHoursWorked(hoursWorked, breaks.unpaidMins);
      const extraOfficeMins = await netExtraMinutesAfterShift(record.id, now, scheduledEnd, tx);
      const overtimeHours = autoCountOvertime ? parseFloat((extraOfficeMins / 60).toFixed(2)) : 0;
      const updated = await tx.attendanceRecord.update({
        where: { id: record.id },
        data: {
          hours_worked: hoursWorked,
          net_hours_worked: netHours,
          overtime_hours: overtimeHours,
          extra_office_minutes: autoCountOvertime ? 0 : extraOfficeMins,
          break_minutes: breaks.totalMins,
          paid_break_minutes: breaks.paidMins,
          early_out_minutes: earlyMins,
          ...(req.body?.offline && { offline_reconciled: true, checkin_requires_review: record.checkin_requires_review || requiresReview }),
          ...(score != null && { adherence_score: score }),
        },
        include: RECORD_INCLUDE,
      });

      const runningTimer = await tx.timeEntry.findFirst({
        where: { org_id: req.user!.org_id, user_id: req.user!.sub, ended_at: null, status: 'draft' },
        orderBy: { started_at: 'desc' },
        select: { id: true, started_at: true },
      });
      let stoppedTimerId: string | null = null;
      if (runningTimer) {
        const stopped = await tx.timeEntry.updateMany({
          where: { id: runningTimer.id, ended_at: null, status: 'draft' },
          data: { ended_at: now, minutes: Math.max(1, Math.round((now.getTime() - runningTimer.started_at.getTime()) / 60000)), attendance_id: record.id },
        });
        if (stopped.count) stoppedTimerId = runningTimer.id;
      }
      return { updated, stoppedTimerId };
    });
    if (stoppedTimerId) recordAudit({ orgId: req.user!.org_id, actorId: req.user!.sub, action: 'time.timer.auto_stop', entityType: 'time_entry', entityId: stoppedTimerId, after: { attendance_id: record.id, ended_at: now.toISOString() } });
    if (req.body?.offline && requiresReview) await notifyOfflineAttendanceReview(req.user!.sub, req.user!.org_id, record.id, 'check-out');

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

    emitOrgEvent(req.user!.org_id, 'attendance_changed');
    ok(res, updated);
  } catch (e) { next(e); }
});

// ─── POST /attendance/heartbeat ────────────────────────
// Called by Flutter app every ~4 min while on office WiFi.
// Server-side expiry job checks out employees when heartbeat goes stale.
router.post('/heartbeat', validate({ body: heartbeatSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ip, ssid } = req.body;
    if (!ip && !ssid) throw new ValidationError('ip or ssid is required');
    const { today, location } = await orgTimeContext(req.user!.org_id, req.user!.sub);
    const org = await prisma.organisation.findUnique({ where: { id: req.user!.org_id }, select: { heartbeat_grace_mins: true } });
    const officeIps   = location?.office_ips   ?? [];
    const officeSsids = location?.office_ssids ?? [];

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
      data: { last_heartbeat_at: new Date(), last_heartbeat_ssid: ssid ?? null, ip_checkout_pending_at: null },
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
router.post('/ip-event', validate({ body: ipEventSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { event, ip, ssid, count_away_as_break, away_shift_break_id } = req.body;
    if (!event) throw new ValidationError('event is required');
    if (!ip && !ssid) throw new ValidationError('ip or ssid is required');
    const { org, today, location, timezone } = await orgTimeContext(req.user!.org_id, req.user!.sub);

    // Check against org's registered office networks (SSID first, then IP/CIDR)
    const officeIps   = location?.office_ips   ?? [];
    const officeSsids = location?.office_ssids ?? [];

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
        if (!org?.wifi_auto_checkin_enabled) return ok(res, { action: 'disabled' });
        const attendanceSecurity = parseLocationGeofence(location?.geofence) ?? parseAttendanceSecurity(org?.attendance_security);
        if (attendanceSecurity?.geofence_enabled) {
          return ok(res, { action: 'manual_checkin_required', reason: 'Location verification must be completed in the app.' });
        }
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
          const win = adjustedWindowForLeave(shift, timezone, now, approvedLeave);
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
          last_heartbeat_at: now,
          last_heartbeat_ssid: ssid ?? null,
        };
        const record = existing
          ? await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { ...checkInData, location_id: location?.id ?? existing.location_id } })
          : await prisma.attendanceRecord.create({ data: { user_id: req.user!.sub, org_id: req.user!.org_id, location_id: location?.id, date: today, ...checkInData } });

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

        emitOrgEvent(req.user!.org_id, 'attendance_changed');
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
          emitOrgEvent(req.user!.org_id, 'attendance_changed');
          return ok(res, { action: 're_entered', gap_mins: gapSinceCheckout, forgiven: true, warning: null });
        }

        const { gapMins, limitExceeded } = await createAwayGapBreak(existing, reentryTime, {
          countAsBreak: !!count_away_as_break,
          shiftBreakId: away_shift_break_id,
        });
        const breakTotals = await calculateBreakTotals(existing.id);
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
            break_minutes:     breakTotals.totalMins,
            paid_break_minutes: breakTotals.paidMins,
            last_heartbeat_at: reentryTime,
            last_heartbeat_ssid: ssid ?? null,
          },
        });
        const reu = await prisma.user.findUnique({ where: { id: req.user!.sub } });
        if (reu) {
          const { notifyCheckIn, formatTime12h } = await import('../services/whatsapp');
          notifyCheckIn(req.user!.org_id, reu.name, formatTime12h(reentryTime)).catch(console.error);
        }
        emitOrgEvent(req.user!.org_id, 'attendance_changed');
        return ok(res, { action: 're_entered', gap_mins: gapMins, forgiven: false, warning: limitExceeded ? 'This away time used an extra break and may be unpaid by policy.' : null });
      }

      await prisma.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          last_heartbeat_at: new Date(),
          last_heartbeat_ssid: ssid ?? null,
          ip_checkout_pending_at: null,
        },
      });
      return ok(res, { action: 'already_in', grace_mins: org?.heartbeat_grace_mins ?? 20 });
    }

    ok(res, { action: 'none' });
  } catch (e) { next(e); }
});

// ─── PUT /attendance/:id/override ─────────────────────
router.put('/:id/override', requirePermission('attendance.override'), idempotency, validate({ body: attendanceOverrideSchema }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
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
    emitOrgEvent(req.user!.org_id, 'attendance_changed');
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
    const userId = String(req.params.userId);
    const { start, end } = req.query as { start?: string; end?: string };

    const user = await prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id } });
    if (!user) throw new NotFoundError('User');
    if (userId !== req.user!.sub && !req.permissions?.has('employees.view')) {
      const [directReport, locationMembership] = await Promise.all([
        prisma.user.findFirst({ where: { id: userId, org_id: req.user!.org_id, manager_id: req.user!.sub }, select: { id: true } }),
        req.permissions?.has('employees.view_location') && user.primary_location_id
          ? prisma.locationManager.findFirst({ where: { user_id: req.user!.sub, location_id: user.primary_location_id }, select: { location_id: true } })
          : Promise.resolve(null),
      ]);
      if (!directReport && !locationMembership) throw new ForbiddenError();
    }

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
