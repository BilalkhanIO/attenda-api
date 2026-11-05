import cron from 'node-cron';
import redis from '../utils/redis';
import { jobLogger } from '../utils/logger';
import { toZonedTime } from 'date-fns-tz';
import prisma from '../utils/prisma';
import {
  notifyLateArrival, notifyAbsent, notifyCheckOut,
  sendDailyRemoteNudge, formatTime12h, notify
} from '../services/whatsapp';
import {
  minutesOfDayInTz, hhmmToMins, lateThresholdFor, earlyOutMinutes, adherenceScore, dateOnlyInTz, scheduledWindow, scheduledInstant, shiftAutoCheckoutDue
} from '../utils/shift';
import { settleBreaks, netHoursWorked, netExtraMinutesAfterShift, updateAttendanceBreakSummary } from '../utils/attendance';
import { isPushConfigured, sendPresenceChallenge } from '../services/pushChallenge';
import { createNotification } from '../services/notifications';
import { randomUUID } from 'node:crypto';
import { claimSchedulerMarker, completeSchedulerMarker, retrySchedulerMarker, startSchedulerMarkerCleanup } from '../services/schedulerState';
import { getDueOrganizationJobs, markOrganizationJobComplete, ORG_SCHEDULED_JOBS, reconcileOrganizationJobSchedules } from '../services/orgJobSchedules';
import { mergeShiftCandidates } from '../utils/schedulerCandidates';

// Resolve the shift-end instant for overtime math: prefer the value persisted at
// check-in (correct for overnight shifts), else recompute the window from checkOut.
function resolveScheduledEnd(record: any, tz: string, checkOut: Date): Date | null {
  if (record.scheduled_end) return new Date(record.scheduled_end);
  if (!record.shift) return null;
  return scheduledWindow(record.shift, tz, checkOut).end;
}

function activeBreakDueAt(record: any, tz: string): Date | null {
  const active = record.break_records?.find((b: any) => !b.break_end);
  if (!active) return null;

  const policy = active.shift_break;
  if (policy?.break_kind === 'fixed' && policy.break_end_time) {
    const dateStr = record.date.toISOString().split('T')[0];
    let dueAt = scheduledInstant(dateStr, policy.break_end_time, tz);
    if (policy.break_start_time &&
        hhmmToMins(policy.break_end_time) <= hhmmToMins(policy.break_start_time)) {
      dueAt = new Date(dueAt.getTime() + 24 * 60 * 60 * 1000);
    }
    return dueAt;
  }

  if (policy?.break_kind === 'flexible' && policy.break_minutes) {
    return new Date(active.break_start.getTime() + policy.break_minutes * 60_000);
  }

  return null;
}

// ─── Job: Late Arrival Detector ───────────────────────

// ─── Multi-instance safety ────────────────────────────
// One lease per job, held for the whole execution. A minute-bucket lock only
// prevents duplicate starts in one minute; a long-running handler could overlap
// the next bucket. Redis is mandatory coordination: skip when it is unhealthy.
async function acquireJobLock(name: string): Promise<null | (() => Promise<void>)> {
  const key = `cronlock:${name}`;
  const token = randomUUID();
  const ttlMs = 15 * 60_000;
  try {
    const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;

    const renewal = setInterval(() => {
      void redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
        1, key, token, ttlMs,
      ).then(result => {
        if (result !== 1) jobLogger.warn({ job: name }, 'scheduler lease renewal lost');
      }).catch(err => jobLogger.error({ err, job: name }, 'scheduler lease renewal failed'));
    }, Math.floor(ttlMs / 3));
    renewal.unref();
    return async () => {
      clearInterval(renewal);
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1, key, token,
      );
    };
  } catch (err) {
    jobLogger.warn({ err, job: name }, 'skipping scheduled job because Redis lock is unavailable');
    return null;
  }
}

type ScheduledJobContext = { since: Date | null; now: Date };

function scheduledJob(name: string, pattern: string, handler: (context: ScheduledJobContext) => Promise<void>) {
  cron.schedule(pattern, async () => {
    const release = await acquireJobLock(name);
    if (!release) return;
    const startedAt = new Date();
    try {
      const prior = await prisma.schedulerJobState.findUnique({ where: { job_key: name }, select: { last_success_at: true } });
      await prisma.schedulerJobState.upsert({ where: { job_key: name }, create: { job_key: name, last_started_at: startedAt }, update: { last_started_at: startedAt, last_error: null } });
      await handler({ since: prior?.last_success_at ?? null, now: startedAt });
      await prisma.schedulerJobState.update({ where: { job_key: name }, data: { last_success_at: new Date(), last_error: null } });
    } catch (err) {
      await prisma.schedulerJobState.updateMany({ where: { job_key: name }, data: { last_error: String(err).slice(0, 4000) } }).catch(() => {});
      jobLogger.error({ err, job: name }, 'scheduled job failed');
    } finally {
      await release().catch(err => jobLogger.warn({ err, job: name }, 'scheduler lease release failed'));
    }
  });
}

export function startLateArrivalDetector() {
  scheduledJob('startLateArrivalDetector', '* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true, late_threshold: true } });
      for (const org of orgs) {
        const hrAdmins = await prisma.user.findMany({
          where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true, deleted_at: null },
          select: { id: true, phone: true },
        });
        const locations = await prisma.location.findMany({ where: { org_id: org.id }, select: { id: true, timezone: true } });
        const locationContexts = [...locations, { id: null, timezone: org.timezone }];
        const orgShifts = await prisma.shift.findMany({ where: { org_id: org.id, is_published: true } });
        const detectorUserSelect = {
          id: true, name: true, manager_id: true, primary_location_id: true,
          manager: { select: { phone: true } },
          primary_location: { select: { id: true, timezone: true } },
        } as const;

        for (const location of locationContexts) {
        const tz = location.timezone || org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();
        const shifts = orgShifts.filter(shift => shift.active_days.includes(weekday));
        const orgWideShift = shifts.find(s => s.is_org_wide);
        const defaultShift = shifts.find(s => s.is_default);
        const assignments = await prisma.shiftAssignment.findMany({
          where: { date: orgToday, user: { org_id: org.id, is_active: true, deleted_at: null, primary_location_id: location.id } },
          include: { shift: true, user: { select: detectorUserSelect } },
        });
        if (!assignments.length && !orgWideShift && !defaultShift) continue;
        // Employees are queried only when an active organization-wide/default
        // shift makes every employee in this branch a candidate. Otherwise the
        // dated assignment index identifies the small scheduled set directly.
        const defaultEmployees = orgWideShift || defaultShift
          ? await prisma.user.findMany({ where: { org_id: org.id, is_active: true, deleted_at: null, primary_location_id: location.id }, select: detectorUserSelect })
          : [];
        const { employees: group, shiftByUserId: assignMap } = mergeShiftCandidates(assignments, defaultEmployees);
        const groupUserIds = group.map(employee => employee.id);
        if (!groupUserIds.length) continue;
        const pendingSync = await prisma.attendanceSyncWatermark.findMany({ where: { org_id: org.id, user_id: { in: groupUserIds }, pending_until: { gt: now } }, select: { user_id: true } });
        const pendingSyncUsers = new Set(pendingSync.map(item => item.user_id));

        const [records, lateNotices] = await Promise.all([
          prisma.attendanceRecord.findMany({ where: { org_id: org.id, user_id: { in: groupUserIds }, date: orgToday } }),
          prisma.lateArrivalNotice.findMany({ where: { org_id: org.id, user_id: { in: groupUserIds }, date: orgToday, status: { not: 'cancelled' } } }),
        ]);
        const recordMap = new Map(records.map(r => [r.user_id, r]));
        const noticeMap = new Map(lateNotices.map(n => [n.user_id, n]));

        for (const user of group) {
          if (pendingSyncUsers.has(user.id)) continue;
          const shift = assignMap.get(user.id) || orgWideShift || defaultShift;
          if (!shift) continue;

          const record = recordMap.get(user.id);
          if (record?.check_in_at) continue;
          if (record && ['leave', 'half_leave', 'absent'].includes(record.status)) continue;

          const shiftStartMins = hhmmToMins(shift.start_time);
          const nowMins = minutesOfDayInTz(now, tz);
          let diffMins = nowMins - shiftStartMins;
          if (diffMins < -720) diffMins += 1440;

          const tolerance = lateThresholdFor(shift, org);
          if (diffMins <= tolerance || diffMins >= 720) continue;

          const notice = noticeMap.get(user.id);
          if (notice && nowMins <= hhmmToMins(notice.expected_time)) continue;

          if (!record || record.status !== 'late') {
            await prisma.attendanceRecord.upsert({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              update: { status: 'late' },
              // 'system' = scheduler-created placeholder; employee has not actually checked in
              create: { user_id: user.id, org_id: org.id, location_id: user.primary_location_id, date: orgToday, check_in_type: 'system', status: 'late', shift_id: shift.id },
            });
          }

          const shouldAlert = diffMins >= 30;
          const shouldEscalate = diffMins >= 60;
          const wasPreAnnounced = !!notice;
          const preAnnouncedSuffix = wasPreAnnounced ? ` (had a late notice — expected by ${notice!.expected_time})` : '';

          if (shouldAlert && !record?.late_alerted) {
            if (user.manager?.phone) {
              await notifyLateArrival(org.id, user.name, diffMins, user.manager.phone).catch(() => {});
            }
            if (user.manager_id) {
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: user.manager_id, orgId: org.id,
                type: 'attendance_late',
                title: wasPreAnnounced ? 'Employee late (past expected time)' : 'Employee late',
                body: `${user.name} is ${diffMins} minutes late and has not checked in${preAnnouncedSuffix}`,
                actionType: 'attendance', actionId: user.id,
              }).catch(console.error);
            }
            await prisma.attendanceRecord.update({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              data: { late_alerted: true },
            }).catch(() => {});
          }

          if (shouldEscalate && !record?.hour_alerted) {
            const escalMsg = `🚨 *1-Hour Late Alert*\n${user.name} has not checked in 60+ minutes past shift start${preAnnouncedSuffix}.\nPlease check on them.`;

            for (const admin of hrAdmins) {
              if (admin.phone) {
                await notify({ orgId: org.id, event: 'late_arrival', message: escalMsg, recipientType: 'individual', recipientId: admin.phone }).catch(() => {});
              }
              const { createNotification } = await import('../services/notifications');
              createNotification({
                userId: admin.id, orgId: org.id,
                type: 'attendance_late_escalation',
                title: '1-hour late escalation',
                body: `${user.name} still has not checked in — 60+ min past shift start${preAnnouncedSuffix}`,
                actionType: 'attendance', actionId: user.id,
              }).catch(console.error);
            }
            if (user.manager?.phone) {
              await notify({ orgId: org.id, event: 'late_arrival', message: escalMsg, recipientType: 'individual', recipientId: user.manager.phone }).catch(() => {});
            }
            await prisma.attendanceRecord.update({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              data: { hour_alerted: true },
            }).catch(() => {});
          }
        }
        }
      }
    } catch (err) {
      console.error('[JOB] Late arrival detector error:', err);
    }
  });
  console.log('⏰ Late arrival detector started');
}

// ─── Job: Absent Detector ─────────────────────────────
export function startAbsentDetector() {
  scheduledJob('startAbsentDetector', '0 * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true, late_policy: true } });
      for (const org of orgs) {
        // Org-configurable no-show window (late_policy.absent_after_mins), default 2h
        const { parseLatePolicy, DEFAULT_ABSENT_AFTER_MINS } = await import('../services/latePolicy');
        const absentAfterMins = parseLatePolicy(org.late_policy)?.absent_after_mins ?? DEFAULT_ABSENT_AFTER_MINS;
        const hrAdmins = await prisma.user.findMany({
          where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true, deleted_at: null },
          select: { id: true, phone: true },
        });

        const locations = await prisma.location.findMany({ where: { org_id: org.id }, select: { id: true, timezone: true } });
        const locationContexts = [...locations, { id: null, timezone: org.timezone }];
        const orgShifts = await prisma.shift.findMany({ where: { org_id: org.id, is_published: true } });
        const detectorUserSelect = {
          id: true, name: true, manager_id: true, primary_location_id: true,
          manager: { select: { phone: true } },
          primary_location: { select: { id: true, timezone: true } },
        } as const;
        const { isOrgHoliday } = await import('../services/holidays');
        for (const location of locationContexts) {
        const tz = location.timezone || org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();
        const locationId = location.id;
        // Global holidays and this branch's local holidays suppress absent marks.
        if (await isOrgHoliday(org.id, orgToday, locationId)) continue;

        const shifts = orgShifts.filter(shift => shift.active_days.includes(weekday));
        const orgWideShift = shifts.find(s => s.is_org_wide);
        const defaultShift = shifts.find(s => s.is_default);

        const assignments = await prisma.shiftAssignment.findMany({
          where: { date: orgToday, user: { org_id: org.id, is_active: true, deleted_at: null, primary_location_id: location.id } },
          include: { shift: true, user: { select: detectorUserSelect } },
        });
        if (!assignments.length && !orgWideShift && !defaultShift) continue;
        const defaultEmployees = orgWideShift || defaultShift
          ? await prisma.user.findMany({ where: { org_id: org.id, is_active: true, deleted_at: null, primary_location_id: location.id }, select: detectorUserSelect })
          : [];
        const { employees: group, shiftByUserId: assignMap } = mergeShiftCandidates(assignments, defaultEmployees);
        const groupUserIds = group.map(employee => employee.id);
        if (!groupUserIds.length) continue;

        const pendingSync = await prisma.attendanceSyncWatermark.findMany({ where: { org_id: org.id, user_id: { in: groupUserIds }, pending_until: { gt: now } }, select: { user_id: true } });
        const pendingSyncUsers = new Set(pendingSync.map(item => item.user_id));

        const records = await prisma.attendanceRecord.findMany({ where: { org_id: org.id, user_id: { in: groupUserIds }, date: orgToday } });
        const recordMap = new Map(records.map(r => [r.user_id, r]));

        for (const user of group) {
          if (pendingSyncUsers.has(user.id)) continue;
          const shift = assignMap.get(user.id) || orgWideShift || defaultShift;
          if (!shift) continue;

          const shiftStartMins = hhmmToMins(shift.start_time);
          const nowMins = minutesOfDayInTz(now, tz);
          let diffMins = nowMins - shiftStartMins;
          if (diffMins < -720) diffMins += 1440;

          if (diffMins < absentAfterMins || diffMins >= 720) continue;

          const record = recordMap.get(user.id);
          if (!record || !record.check_in_at) {
            if (record?.status === 'leave' || record?.status === 'half_leave' || record?.status === 'absent') continue;

            const alreadyAlerted = record?.absent_alerted ?? false;
            await prisma.attendanceRecord.upsert({
              where: { user_id_date: { user_id: user.id, date: orgToday } },
              update: { status: 'absent' },
              // 'system' = scheduler-created placeholder; employee has not actually checked in
              create: { user_id: user.id, org_id: org.id, location_id: user.primary_location_id, date: orgToday, check_in_type: 'system', status: 'absent' },
            });

            if (!alreadyAlerted) {
              await prisma.attendanceRecord.update({
                where: { user_id_date: { user_id: user.id, date: orgToday } },
                data: { absent_alerted: true },
              });

              if (user.manager?.phone) {
                await notifyAbsent(org.id, user.name, user.manager.phone);
              }
              // Also notify HR admins via WhatsApp (spec: absent alert to manager AND HR admin)
              for (const admin of hrAdmins) {
                if (admin.phone) {
                  await notifyAbsent(org.id, user.name, admin.phone).catch(() => {});
                }
              }
              if (user.manager_id) {
                const { createNotification } = await import('../services/notifications');
                createNotification({
                  userId: user.manager_id, orgId: org.id,
                  type: 'attendance_absent',
                  title: 'Employee absent',
                  body: `${user.name} has not checked in — marked absent`,
                  actionType: 'attendance', actionId: user.id,
                }).catch(console.error);
              }
            }
          }
        }
        }
      }
    } catch (err) {
      console.error('[JOB] Absent detector error:', err);
    }
  });
  console.log('❌ Absent detector started');
}

// ─── Job: Heartbeat Expiry Monitor ────────────────────
export function startHeartbeatExpiryMonitor() {
  scheduledJob('startHeartbeatExpiryMonitor', '*/5 * * * *', async () => {
    const now = new Date();
    try {
      // Query at the minimum possible staleness, then apply each org's
      // configurable grace window. Android Doze rate-limits background work
      // to ~1 wake per 9 minutes with the screen off, so anything under
      // ~20 minutes produces phantom checkouts for users sitting at their desk.
      const expired = await prisma.attendanceRecord.findMany({
        where: {
          check_out_at: null,
          status: { in: ['in', 'late'] },
          // Policy validation enforces a minimum grace of 10 minutes. Keep
          // fresh open records out of this five-minute worker's candidate set.
          last_heartbeat_at: { lte: new Date(now.getTime() - 10 * 60_000) },
          user: { org: { wifi_auto_checkout_enabled: true } },
        },
        include: {
          user: { include: { org: { select: { id: true, timezone: true, heartbeat_grace_mins: true } }, primary_location: { select: { timezone: true } } } },
          location: { select: { timezone: true } },
          shift: true,
          break_records: {
            where: { break_end: null },
            include: { shift_break: true },
          },
        },
      });

      for (const record of expired) {
        const tz = record.location?.timezone || record.user.primary_location?.timezone || record.user.org?.timezone || 'UTC';
        const localToday = dateOnlyInTz(now, tz);
        if (record.date.getTime() !== localToday.getTime()) continue;

        const graceMins = record.user.org?.heartbeat_grace_mins ?? 20;
        const staleMins = (now.getTime() - record.last_heartbeat_at!.getTime()) / 60_000;
        if (staleMins < graceMins) continue;

        const breakDueAt = activeBreakDueAt(record, tz);
        if (breakDueAt) {
          const breakGraceDue = new Date(breakDueAt.getTime() + graceMins * 60_000);
          if (now < breakGraceDue) continue;
        }

        const heartbeatExpiry = new Date(record.last_heartbeat_at!.getTime() + graceMins * 60_000);
        const checkOut = breakDueAt && breakDueAt > heartbeatExpiry
          ? breakDueAt
          : heartbeatExpiry;
        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;
        const breaks = await settleBreaks(record.id, checkOut, tz);
        const rawEarlyMins = earlyOutMinutes(checkOut, record.shift, tz);
        // Store tolerance-adjusted value: minutes beyond the early-checkout grace window
        const earlyMins = Math.max(0, rawEarlyMins - (record.shift?.early_checkout_tolerance_mins ?? 0));
        const score = adherenceScore(record.late_minutes ?? 0, earlyMins, record.shift);
        const extraOfficeMins = await netExtraMinutesAfterShift(record.id, checkOut, resolveScheduledEnd(record, tz, checkOut));
        const autoCountOvertime = !!record.shift?.overtime_enabled && !record.shift?.overtime_requires_approval;
        const overtimeHours = autoCountOvertime ? parseFloat((extraOfficeMins / 60).toFixed(2)) : 0;

        const updated = await prisma.attendanceRecord.updateMany({
          where: { id: record.id, check_out_at: null, last_heartbeat_at: record.last_heartbeat_at, user: { org: { wifi_auto_checkout_enabled: true } } },
          data: {
            check_out_at: checkOut,
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            status: 'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            overtime_hours: overtimeHours,
            extra_office_minutes: autoCountOvertime ? 0 : extraOfficeMins,
            break_minutes: breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            early_out_minutes: earlyMins,
            ...(score != null && { adherence_score: score }),
            last_heartbeat_at: null,
            challenge_sent_at: null,
            ip_checkout_pending_at: null,
          },
        });
        if (!updated.count) continue;
        await notifyCheckOut(record.user.org_id, record.user.name, formatTime12h(checkOut)).catch(() => {});
      }
    } catch (err) {
      console.error('[JOB] Heartbeat expiry monitor error:', err);
    }
  });
  console.log('💓 Heartbeat expiry monitor started');
}

// ─── Job: Stale Record Sweep ──────────────────────────
export function startStaleRecordSweep() {
  startSchedulerMarkerCleanup();
  scheduledJob('startStaleRecordSweep', '0 6 * * *', async () => {
    const now = new Date();
      const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const scanFrom = new Date(utcToday.getTime() - 2 * 86_400_000);

    try {
      const stale = await prisma.attendanceRecord.findMany({
        where: { date: { gte: scanFrom, lte: utcToday }, check_in_at: { not: null }, check_out_at: null },
        include: { shift: true, location: { select: { timezone: true } }, user: { include: { primary_location: { select: { timezone: true } }, org: { select: { timezone: true } } } } },
      });

      for (const record of stale) {
        const tz = record.location?.timezone || record.user?.primary_location?.timezone || record.user?.org?.timezone || 'UTC';
        const yesterday = dateOnlyInTz(new Date(now.getTime() - 24 * 60 * 60_000), tz);
        if (record.date.getTime() !== yesterday.getTime()) continue;
        const checkOut = record.scheduled_end ? new Date(record.scheduled_end) : new Date(yesterday.getTime() + 23 * 3600000 + 59 * 60000);
        const effectiveOut = checkOut > record.check_in_at! ? checkOut : record.check_in_at!;
        const hoursWorked = (effectiveOut.getTime() - record.check_in_at!.getTime()) / 3600000;
        const breaks = await settleBreaks(record.id, effectiveOut, tz);
        const extraOfficeMins = await netExtraMinutesAfterShift(record.id, effectiveOut, resolveScheduledEnd(record, tz, effectiveOut));
        const autoCountOvertime = !!record.shift?.overtime_enabled && !record.shift?.overtime_requires_approval;
        const overtimeHours = autoCountOvertime ? parseFloat((extraOfficeMins / 60).toFixed(2)) : 0;

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at: effectiveOut,
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            status: 'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            overtime_hours: overtimeHours,
            extra_office_minutes: autoCountOvertime ? 0 : extraOfficeMins,
            break_minutes: breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            last_heartbeat_at: null,
          },
        });
      }
    } catch (err) {
      console.error('[JOB] Stale record sweep error:', err);
    }
  });
  console.log('🧹 Stale record sweep started (06:00)');
}

// ─── Job: Shift Reminders ─────────────────────────────
export function startShiftReminderJob() {
  scheduledJob('startShiftReminderJob', '* * * * *', async ({ now }) => {
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true, locations: { where: { is_active: true }, select: { id: true, timezone: true } } } });
      for (const org of orgs) {
        const locations = org.locations.length ? org.locations : [{ id: null, timezone: org.timezone }];
        for (const location of locations) {
        const tz = location.timezone || org.timezone || 'UTC';
        const localDate = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });

        for (const shift of shifts) {
          const nowMins = minutesOfDayInTz(now, tz);
          const startMins = hhmmToMins(shift.start_time);
          const minsUntilStart = startMins - nowMins;
          // Catch up after a delayed tick, but do not send a reminder after the shift starts.
          if (minsUntilStart <= 0 || minsUntilStart > 30) continue;

          const assignments = await prisma.shiftAssignment.findMany({
            where: { shift_id: shift.id, date: localDate, ...(location.id ? { location_id: location.id } : {}) },
            include: { user: true },
          });

          for (const assignment of assignments) {
            const { user } = assignment;
            const localDateKey = localDate.toISOString().split('T')[0];
            const markerId = await claimSchedulerMarker({ orgId: org.id, jobKey: 'shift_reminder', subjectId: assignment.id, periodKey: `${localDateKey}:${shift.start_time}` });
            if (!markerId) continue;

            const [sh] = shift.start_time.split(':').map(Number);
            const shiftStartTime = `${shift.start_time} ${sh < 12 ? 'AM' : 'PM'}`;
            try {
              const queued = await createNotification({ userId: user.id, orgId: org.id, type: 'shift_reminder', title: 'Your shift starts in 30 minutes', body: `${shift.name} starts at ${shiftStartTime}.`, actionType: 'shift_assignment', actionId: assignment.id, metadata: { local_date: localDateKey }, dedupeKey: markerId });
              if (queued) await completeSchedulerMarker(markerId);
              else await retrySchedulerMarker(markerId, 'Could not queue shift reminder');
            } catch (error) {
              await retrySchedulerMarker(markerId, error);
              throw error;
            }
          }
        }
        }
      }
    } catch (err) {
      console.error('[JOB] Shift reminder error:', err);
    }
  });
}

// Notify task owners at 08:00 in their organisation timezone when a task is due tomorrow.
export function startProjectTaskDeadlineJob() {
  scheduledJob('startProjectTaskDeadlineJob', '* * * * *', async ({ now }) => {
    const dueSchedules = await getDueOrganizationJobs(ORG_SCHEDULED_JOBS.projectDeadlines, now);
    for (const schedule of dueSchedules) {
      const tz = schedule.timezone || 'UTC';
      const orgId = schedule.org_id;
      const today = dateOnlyInTz(now, tz);
      const todayKey = today.toISOString().slice(0, 10);
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const tasks = await prisma.projectTask.findMany({
        where: { project: { org_id: orgId }, due_date: tomorrow, status: { not: 'done' }, assignee_id: { not: null } },
        include: { assignee: { select: { id: true } }, project: { select: { name: true } } },
      });
      let retryableFailure = false;
      for (const task of tasks) {
        if (!task.assignee) continue;
        const markerId = await claimSchedulerMarker({ orgId, jobKey: 'project_task_deadline', subjectId: task.id, periodKey: todayKey });
        if (!markerId) {
          const marker = await prisma.schedulerJobMarker.findUnique({ where: { org_id_job_key_subject_id_period_key: { org_id: orgId, job_key: 'project_task_deadline', subject_id: task.id, period_key: todayKey } }, select: { status: true } });
          if (marker?.status !== 'sent') retryableFailure = true;
          continue;
        }
        try {
          const queued = await createNotification({
            userId: task.assignee.id, orgId, type: 'project_task_deadline',
            title: 'Project task due tomorrow', body: `${task.title} · ${task.project.name}`,
            actionType: 'project_task', actionId: task.id, metadata: { local_date: todayKey }, dedupeKey: markerId,
          });
          if (queued) await completeSchedulerMarker(markerId);
          else { retryableFailure = true; await retrySchedulerMarker(markerId, 'Could not queue project deadline reminder'); }
        } catch (error) {
          await retrySchedulerMarker(markerId, error);
          throw error;
        }
      }
      if (!retryableFailure) await markOrganizationJobComplete(orgId, ORG_SCHEDULED_JOBS.projectDeadlines, now);
    }
  });
  console.log('📅 Project task deadline reminders started (08:00 local time)');
}

export function startOrganizationJobScheduleReconcile() {
  void reconcileOrganizationJobSchedules().catch((error) => {
    jobLogger.error({ err: error }, 'initial organization job schedule reconciliation failed');
  });
  scheduledJob('startOrganizationJobScheduleReconcile', '*/15 * * * *', async ({ now }) => {
    await reconcileOrganizationJobSchedules(now);
  });
}

// ─── Job: Remote AI Nudges ────────────────────────────
export function startRemoteNudgeJob() {
  // Minute cadence is required because org-local shift starts can be at any
  // minute (and timezones include half/quarter-hour offsets).
  scheduledJob('startRemoteNudgeJob', '* * * * *', async ({ now, since }) => {
    try {
      const sessions = await prisma.remoteSession.findMany({
        where: {
          status: 'approved',
          attendance: { date: { gte: new Date(now.getTime() - 36 * 60 * 60_000), lte: new Date(now.getTime() + 36 * 60 * 60_000) } },
        },
        include: { user: { select: { id: true, org_id: true } }, attendance: { include: { shift: true, location: { select: { timezone: true } }, user: { include: { primary_location: { select: { timezone: true } } } }, org: { select: { timezone: true } } } } },
      });
      for (const session of sessions) {
        const orgId = session.user.org_id;
        if (!orgId) continue;
        const tz = session.attendance?.location?.timezone || session.attendance?.user.primary_location?.timezone || session.attendance?.org.timezone || 'UTC';
        const localToday = dateOnlyInTz(now, tz);
        const priorLocalDay = new Date(localToday.getTime() - 24 * 60 * 60_000);
        if (session.attendance && ![localToday.toISOString(), priorLocalDay.toISOString()].includes(session.attendance.date.toISOString())) continue;
          const workDate = session.attendance?.date ?? localToday;
          const workDateKey = workDate.toISOString().slice(0, 10);
          const shiftStart = session.attendance?.shift?.start_time || '09:00';
          const shiftEnd = session.attendance?.shift?.end_time || '18:00';
          const startMins = hhmmToMins(shiftStart);
          const endMins = hhmmToMins(shiftEnd);
          const shiftDuration = (endMins - startMins + 1440) % 1440;
          const middayMins = (startMins + Math.floor(shiftDuration / 2)) % 1440;

          const shiftStartAt = scheduledInstant(workDateKey, shiftStart, tz);
          const targetFor = (minute: number) => {
            const delta = (minute - startMins + 1440) % 1440;
            return new Date(shiftStartAt.getTime() + delta * 60_000);
          };
          const crossed = (target: Date) => target <= now
            && now.getTime() - target.getTime() <= 60 * 60_000
            && (since === null ? now.getTime() - target.getTime() <= 15 * 60_000 : target > since || now.getTime() - target.getTime() <= 15 * 60_000);
          const nudge = async (kind: 'morning' | 'midday' | 'eod', target: number, alreadySent: Date | null) => {
            if (alreadySent || !crossed(targetFor(target))) return false;
            const markerId = await claimSchedulerMarker({ orgId, jobKey: `remote_${kind}_nudge`, subjectId: session.id, periodKey: workDateKey });
            if (!markerId) return false;
            const type = kind === 'morning' ? 'remote_morning_nudge' : kind === 'midday' ? 'remote_midday_nudge' : 'remote_eod_nudge';
            try {
              const queued = await createNotification({ userId: session.user.id, orgId, type, title: kind === 'eod' ? 'End-of-shift check-in' : `${kind === 'midday' ? 'Midday' : 'Morning'} remote check-in`, body: kind === 'morning' ? 'Your remote shift has started. Please confirm that you are working today.' : kind === 'midday' ? 'Please confirm that you are still working remotely.' : 'Your remote shift is ending. Please complete your check-out when finished.', actionType: 'attendance', actionId: session.attendance_id, metadata: { remote_session_id: session.id, nudge: kind, local_date: workDateKey }, dedupeKey: markerId });
              if (queued) {
                await completeSchedulerMarker(markerId);
                await prisma.remoteSession.update({ where: { id: session.id }, data: kind === 'morning' ? { morning_nudge_at: now } : kind === 'midday' ? { midday_nudge_at: now } : { end_nudge_at: now } });
              } else await retrySchedulerMarker(markerId, `Could not queue ${kind} remote reminder`);
              return queued;
            } catch (error) {
              await retrySchedulerMarker(markerId, error);
              throw error;
            }
          };

          const morningDue = await nudge('morning', startMins, session.morning_nudge_at);
          if (!morningDue) {
            const middayDue = await nudge('midday', middayMins, session.midday_nudge_at);
            if (!middayDue) await nudge('eod', endMins, session.end_nudge_at);
          }
      }
    } catch (err) {
      console.error('[JOB] Remote nudge error:', err);
    }
  });
}

// ─── Job: Payroll Auto-Generate ───────────────────────
export function startPayrollAutoGenerate() {
  scheduledJob('startPayrollAutoGenerate', '* * * * *', async ({ now }) => {
    try {
      const schedules = await getDueOrganizationJobs(ORG_SCHEDULED_JOBS.payrollAutoGenerate, now);
      if (!schedules.length) return;
      const orgs = await prisma.organisation.findMany({ where: { id: { in: schedules.map(schedule => schedule.org_id) } } });
      for (const org of orgs) {
        const schedule = schedules.find(row => row.org_id === org.id);
        const tz = schedule?.timezone || org.timezone || 'UTC';
        const localNow = toZonedTime(now, tz);

        const month = localNow.getMonth() === 0 ? 12 : localNow.getMonth();
        const year = localNow.getMonth() === 0 ? localNow.getFullYear() - 1 : localNow.getFullYear();

        const { startOfMonth, endOfMonth } = await import('../utils/auth');
        const start = startOfMonth(year, month);
        const end = endOfMonth(year, month);

        const users = await prisma.user.findMany({ where: { org_id: org.id, is_active: true, deleted_at: null } });
        const payRates = await prisma.payRate.findMany({
          where: { org_id: org.id, user_id: { in: users.map(user => user.id) }, effective_from: { lte: end }, OR: [{ effective_to: null }, { effective_to: { gte: end } }] },
          orderBy: { effective_from: 'desc' },
        });
        const payRateByUser = new Map<string, (typeof payRates)[number]>();
        for (const rate of payRates) if (!payRateByUser.has(rate.user_id)) payRateByUser.set(rate.user_id, rate);
        const existingRecords = await prisma.payrollRecord.findMany({
          where: { org_id: org.id, period_month: month, period_year: year },
          select: { user_id: true },
        });
        const existingByUser = new Map(existingRecords.map(record => [record.user_id, record]));

        // Same shared computation as POST /payroll/generate — unpaid-leave
        // deduction, per-shift overtime multiplier and manual_adjustment
        // preservation must never drift between the route and this cron.
        const { computePeriodPayroll, payrollInputsHash } = await import('../utils/payroll');

        for (const user of users) {
          const existing = existingByUser.get(user.id);
          // A period row is immutable to this cron. Missing rows are created
          // on retry, so an interrupted partial run can resume without
          // changing a manually adjusted draft or finalized payroll.
          if (existing) continue;
          const attendance = await prisma.attendanceRecord.findMany({
            where: { user_id: user.id, date: { gte: start, lte: end } },
            include: { shift: { select: { overtime_multiplier: true } } },
          });
          const unpaidLeave = await prisma.leaveRequest.findMany({
            where: {
              user_id: user.id, status: 'approved', leave_type: 'unpaid',
              start_date: { lte: end }, end_date: { gte: start },
            },
            select: { working_days: true },
          });
          const unpaidDays = unpaidLeave.reduce((s, l) => s + l.working_days, 0);
          const payRate = payRateByUser.get(user.id);
          const payBasis = (payRate?.basis ?? 'hourly') as 'hourly' | 'daily' | 'monthly';
          const payRateAmount = payRate ? Number(payRate.amount) : Number(user.hourly_rate);
          const monthlyPayDivisor = Math.max(1, Number(org.monthly_pay_divisor) || 26);
          const rate = payBasis === 'hourly' ? payRateAmount : payBasis === 'daily' ? payRateAmount / 8 : payRateAmount / monthlyPayDivisor / 8;
          const calculated = computePeriodPayroll({
            attendance,
            unpaid_leave_days: unpaidDays,
            hourly_rate: rate,
            pay_basis: payBasis,
            pay_rate_amount: payRateAmount,
            monthly_pay_divisor: monthlyPayDivisor,
            manual_adjustment: 0,
          }, Number(org.tax_rate) || 0, Number(org.pension_rate) || 0);
          const statutory = await (await import('../services/statutoryPayroll')).applyStatutoryPayroll({ orgId: org.id, userId: user.id, year, month }, calculated);
          const totals = statutory.totals;
          const inputsHash = payrollInputsHash({
            attendance, unpaid_leave_days: unpaidDays, hourly_rate: rate,
            pay_basis: payBasis, pay_rate_amount: payRateAmount, monthly_pay_divisor: monthlyPayDivisor,
            tax_rate: Number(org.tax_rate) || 0, pension_rate: Number(org.pension_rate) || 0,
            statutory_parameter_set_id: statutory.statutory_parameter_set_id,
            pay_rate_id: payRate?.id ?? null,
          });

          const fields = {
            regular_hours: totals.regular_hours, overtime_hours: totals.overtime_hours,
            hourly_rate: rate, base_pay: totals.base_pay, overtime_pay: totals.overtime_pay,
            pay_basis: payBasis, pay_rate_amount: payRateAmount, pay_monthly_divisor: monthlyPayDivisor,
            unpaid_deduction: totals.unpaid_deduction, gross_pay: totals.gross_pay,
            tax_deduction: totals.tax_deduction, pension_deduction: totals.pension_deduction,
            statutory_parameter_set_id: statutory.statutory_parameter_set_id,
            pay_rate_id: payRate?.id ?? null,
            tax_calculation_method: statutory.tax_calculation_method,
            employee_statutory_deductions: statutory.employee_statutory_deductions,
            employer_statutory_contributions: statutory.employer_statutory_contributions,
            net_pay: totals.net_pay, is_incomplete: rate === 0, inputs_hash: inputsHash, inputs_stale: false,
          };
          try {
            await prisma.payrollRecord.create({
              data: { user_id: user.id, org_id: org.id, period_month: month, period_year: year, ...fields },
            });
          } catch (error) {
            // Another worker may have inserted this employee's period row.
            if ((error as { code?: string }).code !== 'P2002') throw error;
          }
        }
        await markOrganizationJobComplete(org.id, ORG_SCHEDULED_JOBS.payrollAutoGenerate, now);
      }
    } catch (err) {
      console.error('[JOB] Payroll auto-generate error:', err);
    }
  });
}

// ─── Job: Shift Auto-Checkout ─────────────────────────
// Fires every minute. For employees whose shift has auto_checkout enabled, checks
// whether scheduled shift end + buffer has passed and, if so, checks them out at
// the scheduled end time. Separate from the heartbeat expiry job (which handles
// WiFi dropout) — this handles deliberate in-office overtime cutoff.
export function startShiftAutoCheckoutJob() {
  scheduledJob('startShiftAutoCheckoutJob', '* * * * *', async () => {
    const now = new Date();
    // A work date can be one UTC day either side of `now` because supported
    // IANA offsets and overnight shifts cross UTC midnight. Narrow the indexed
    // date-only scan while retaining all possible location-local current days.
    const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dateFrom = new Date(utcToday.getTime() - 86_400_000);
    const dateTo = new Date(utcToday.getTime() + 86_400_000);
    try {
      const openRecords = await prisma.attendanceRecord.findMany({
        where: {
          date: { gte: dateFrom, lte: dateTo },
          check_out_at: null,
          check_in_at: { not: null },
          status: { in: ['in', 'late', 'remote'] },
          shift_id: { not: null },
        },
        include: { user: { include: { org: { select: { id: true, timezone: true } }, primary_location: { select: { timezone: true } } } }, location: { select: { timezone: true } }, shift: true },
      });

      for (const record of openRecords) {
        const tz = record.location?.timezone || record.user?.primary_location?.timezone || record.user?.org?.timezone || 'UTC';
        // Only process records for the assigned location's current local day.
        const localToday = dateOnlyInTz(now, tz);
        if (record.date.getTime() !== localToday.getTime()) continue;

        if (!shiftAutoCheckoutDue(record.shift, tz, now)) continue;

        // Checkout at scheduled shift end, not at now (keeps payroll deterministic)
        const { end: scheduledCheckOut } = scheduledWindow(record.shift!, tz, now);
        const checkOut = scheduledCheckOut > record.check_in_at! ? scheduledCheckOut : now;

        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;
        const breaks = await settleBreaks(record.id, checkOut, tz);
        const rawEarlyMins = earlyOutMinutes(checkOut, record.shift, tz);
        const earlyMins = Math.max(0, rawEarlyMins - (record.shift?.early_checkout_tolerance_mins ?? 0));
        const score = adherenceScore(record.late_minutes ?? 0, earlyMins, record.shift);
        const extraOfficeMins = await netExtraMinutesAfterShift(record.id, checkOut, resolveScheduledEnd(record, tz, checkOut));
        const autoCountOvertime = !!record.shift?.overtime_enabled && !record.shift?.overtime_requires_approval;
        const overtimeHours = autoCountOvertime ? parseFloat((extraOfficeMins / 60).toFixed(2)) : 0;

        await prisma.attendanceRecord.update({
          where: { id: record.id },
          data: {
            check_out_at: checkOut,
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            status: 'out',
            net_hours_worked: netHoursWorked(hoursWorked, breaks.unpaidMins),
            overtime_hours: overtimeHours,
            extra_office_minutes: autoCountOvertime ? 0 : extraOfficeMins,
            break_minutes: breaks.totalMins,
            paid_break_minutes: breaks.paidMins,
            auto_checked_out: true,
            early_out_minutes: earlyMins,
            ...(score != null && { adherence_score: score }),
            last_heartbeat_at: null,
          },
        });
        await notifyCheckOut(record.user.org_id, record.user.name, formatTime12h(checkOut)).catch(() => {});
      }
    } catch (err) {
      console.error('[JOB] Shift auto-checkout error:', err);
    }
  });
  console.log('🕐 Shift auto-checkout job started');
}

// ─── Job: Shift Break Auto-Manager ────────────────────
export function startShiftBreakAutoManager() {
  scheduledJob('startShiftBreakAutoManager', '* * * * *', async () => {
    const now = new Date();
    const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const candidateDateFrom = new Date(utcToday.getTime() - 86_400_000);
    const candidateDateTo = new Date(utcToday.getTime() + 86_400_000);
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        // Intentional: ShiftBreaks are children of Shifts. Employees checked in without
        // a resolved shift have no break templates to auto-start. This is correct behavior.
        const openRecords = await prisma.attendanceRecord.findMany({
          where: { org_id: org.id, date: { gte: candidateDateFrom, lte: candidateDateTo }, check_in_at: { not: null }, check_out_at: null, status: { in: ['in', 'late', 'remote'] }, shift_id: { not: null } },
          include: { location: { select: { timezone: true } }, user: { include: { primary_location: { select: { timezone: true } } } }, shift: { include: { breaks: true } }, break_records: true },
        });

        for (const record of openRecords) {
          const tz = record.location?.timezone || record.user.primary_location?.timezone || org.timezone || 'UTC';
          const localToday = dateOnlyInTz(now, tz);
          if (record.date.getTime() !== localToday.getTime()) continue;
          const nowMins = minutesOfDayInTz(now, tz);
          for (const tmpl of record.shift?.breaks || []) {
            if ((tmpl.applies_days.length && !tmpl.applies_days.includes(localToday.getUTCDay())) || (tmpl.exception_dates.length && tmpl.exception_dates.includes(localToday.toISOString().slice(0, 10)))) continue;
            if (tmpl.break_kind === 'flexible') continue;
            if (!tmpl.break_start_time || !tmpl.break_end_time) continue;
            const bStart = hhmmToMins(tmpl.break_start_time);
            const bEnd = hhmmToMins(tmpl.break_end_time);
            const existing = record.break_records.find(br => br.shift_break_id === tmpl.id);

            if (!existing && nowMins >= bStart && nowMins < bEnd && tmpl.auto_start) {
              if (!record.break_records.find(br => !br.break_end)) {
                await prisma.breakRecord.create({
                  data: { attendance_id: record.id, shift_break_id: tmpl.id, break_start: now, break_type: tmpl.name || 'shift_break', is_paid: tmpl.is_paid, auto_started: true, source: 'system' },
                });
              }
            } else if (existing && existing.auto_started && !existing.break_end && nowMins >= bEnd) {
              await prisma.breakRecord.update({
                where: { id: existing.id },
                data: { break_end: now, duration_mins: Math.max(0, Math.round((now.getTime() - existing.break_start.getTime()) / 60000)), auto_ended: true },
              });
              await updateAttendanceBreakSummary(record.id);
            }
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Shift break auto-manager error:', err);
    }
  });
}

// ─── Job: Trial Expiry Monitor ────────────────────────
export function startTrialExpiryMonitor() {
  scheduledJob('startTrialExpiryMonitor', '0 6 * * *', async () => {
    try {
      await prisma.organisation.updateMany({
        where: { subscription_status: 'trialing', trial_ends_at: { lt: new Date() } },
        data: { subscription_status: 'inactive' },
      });
    } catch (err) {
      console.error('[trial-expiry] Error:', err instanceof Error ? err.message : err);
    }
  });
}

// ─── Job: Daily Remote Nudge ──────────────────────────
export function startDailyRemoteNudgeJob() {
  scheduledJob('startDailyRemoteNudgeJob', '* * * * *', async ({ now }) => {
    const dueSchedules = await getDueOrganizationJobs(ORG_SCHEDULED_JOBS.dailyRemoteNudges, now);
    for (const schedule of dueSchedules) {
        const orgId = schedule.org_id;
        const tz = schedule.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);

        const sessions = await prisma.remoteSession.findMany({
          where: {
            status: 'approved',
            OR: [{ daily_nudge_at: null }, { daily_nudge_at: { lt: orgToday } }],
            attendance: { date: orgToday, org_id: orgId },
          },
          include: { user: { select: { id: true, name: true, phone: true } } },
        });

        for (const session of sessions) {
          if (!session.user.phone) continue;
          const claimed = await prisma.remoteSession.updateMany({
            where: {
              id: session.id,
              status: 'approved',
              OR: [{ daily_nudge_at: null }, { daily_nudge_at: { lt: orgToday } }],
            },
            data: { daily_nudge_at: orgToday },
          });
          if (!claimed.count) continue;
          try {
            await sendDailyRemoteNudge(orgId, session.user.name, session.user.phone);
          } catch (error) {
            await prisma.remoteSession.updateMany({
              where: { id: session.id, daily_nudge_at: orgToday },
              data: { daily_nudge_at: null },
            });
            throw error;
          }
        }
        await markOrganizationJobComplete(orgId, ORG_SCHEDULED_JOBS.dailyRemoteNudges, now);
    }
  });
  console.log('🏠 Daily remote nudge job started (08:00 local time per organization)');
}

// ─── Job: Monthly Leave Accrual ───────────────────────
// ─── Job: Late Pattern Scan ───────────────────────────
// Nightly: rolling lateness points per user (org late_policy tiers);
// alerts manager + HR when someone crosses the org's threshold.
export function startLatePatternScanJob() {
  scheduledJob('startLatePatternScanJob', '30 2 * * *', async () => {
    const { runLatePatternScan } = await import('../services/latePolicy');
    await runLatePatternScan();
  });
  console.log('⏰ Late pattern scan job started (daily, 02:30 UTC)');
}

// ─── Job: Document Expiry Scan ────────────────────────
// Daily: employee documents expiring in exactly 30 or 7 days notify the
// owner + uploader (deduped via the notifications table).
export function startDocumentExpiryScan() {
  scheduledJob('startDocumentExpiryScan', '0 3 * * *', async () => {
    const { runDocumentExpiryScan } = await import('../services/documents');
    await runDocumentExpiryScan();
  });
  console.log('📄 Document expiry scan started (daily, 03:00 UTC)');
}

// ─── Job: Announcement Publisher ──────────────────────
// Every 5 minutes: fan out scheduled announcements whose time has come.
export function startAnnouncementPublisher() {
  scheduledJob('startAnnouncementPublisher', '*/5 * * * *', async () => {
    const { publishDueAnnouncements } = await import('../services/announcements');
    await publishDueAnnouncements();
  });
  console.log('📣 Announcement publisher started (every 5 min)');
}

export function startLeaveAccrualJob() {
  scheduledJob('startLeaveAccrualJob', '* * * * *', async ({ now }) => {
    const schedules = await getDueOrganizationJobs(ORG_SCHEDULED_JOBS.leaveAccrual, now);
    const dueOrgIds = schedules.map(schedule => schedule.org_id);
    if (!dueOrgIds.length) return;
    const { runMonthlyAccrual } = await import('../services/leaveAccrual');
    await runMonthlyAccrual(now, dueOrgIds);
    for (const orgId of dueOrgIds) await markOrganizationJobComplete(orgId, ORG_SCHEDULED_JOBS.leaveAccrual, now);
  });
  console.log('🌴 Location-local leave accrual reconciliation started (daily, organization-local 02:00 worker)');
}

// ─── Job: Refresh-Token Purge ─────────────────────────
// Daily: delete expired tokens and revoked/rotated ones older than 30 days
// (kept that long for reuse-detection forensics). Without this the
// refresh_tokens table accretes forever — rotation only sets revoked_at.
export function startRefreshTokenPurgeJob() {
  scheduledJob('startRefreshTokenPurgeJob', '30 3 * * *', async () => {
    const { purgeRefreshTokens } = await import('../services/refreshTokens');
    const purged = await purgeRefreshTokens();
    jobLogger.info({ purged }, 'refresh token purge complete');
  });
  console.log('🔑 Refresh-token purge job started (daily, 03:30 UTC)');
}

export function startWebhookDeliveryRetryJob() {
  scheduledJob('startWebhookDeliveryRetryJob', '* * * * *', async () => {
    await prisma.orgWebhook.updateMany({
      where: { previous_secret_expires_at: { lte: new Date() }, previous_secret: { not: null } },
      data: { previous_secret: null, previous_secret_expires_at: null },
    });
    const { retryDueWebhookDeliveries } = await import('../services/webhookDelivery');
    await retryDueWebhookDeliveries();
  });
  console.log('🔁 Outbound webhook retry worker started (every minute)');
}

export function startOutboxPublisherJob() {
  scheduledJob('publishTransactionalOutbox', '* * * * *', async () => {
    const { publishOutboxBatch } = await import('../services/outbox');
    await publishOutboxBatch();
  });
  console.log('📬 Transactional outbox publisher started (every minute)');
}

export function startIdempotencyPurgeJob() {
  scheduledJob('purgeExpiredIdempotencyRecords', '17 4 * * *', async () => {
    const result = await prisma.idempotencyRecord.deleteMany({ where: { expires_at: { lt: new Date() } } });
    jobLogger.info({ deleted: result.count }, 'expired idempotency records purged');
  });
  console.log('🧹 Idempotency record cleanup started (daily, 04:17 UTC)');
}

export function startScheduledReportJob() {
  scheduledJob('startScheduledReportJob', '* * * * *', async () => {
    const { runDueReportSchedules } = await import('../services/scheduledReports');
    await runDueReportSchedules();
  });
  console.log('📊 Scheduled reports worker started (every minute)');
}

export function startNotificationDeliveryJob() {
  scheduledJob('startNotificationDeliveryJob', '* * * * *', async () => {
    const { deliverNotificationBatch } = await import('../services/notificationDelivery');
    await deliverNotificationBatch();
  });
  console.log('🔔 Notification channel delivery worker started (every minute)');
}

export function startNotificationDeliveryPurgeJob() {
  scheduledJob('startNotificationDeliveryPurgeJob', '50 4 * * *', async () => {
    const deleted = await prisma.notificationDelivery.deleteMany({
      where: { status: { in: ['sent', 'failed', 'suppressed'] }, created_at: { lt: new Date(Date.now() - 90 * 24 * 60 * 60_000) } },
    });
    jobLogger.info({ deleted: deleted.count, retention_days: 90 }, 'old notification delivery history purged');
  });
}

export function startOffboardingJob() {
  scheduledJob('startOffboardingJob', '* * * * *', async () => {
    const { processDueOffboardingCases } = await import('../services/offboarding');
    await processDueOffboardingCases();
  });
  console.log('👋 Offboarding access-revocation worker started (organization local dates)');
}

export function startAllJobs() {
  console.log('\n🔧 Starting background jobs...');
  startOrganizationJobScheduleReconcile();
  startLeaveAccrualJob();
  startLatePatternScanJob();
  startDocumentExpiryScan();
  startAnnouncementPublisher();
  startLateArrivalDetector();
  startAbsentDetector();
  startHeartbeatExpiryMonitor();
  startShiftAutoCheckoutJob();
  startStaleRecordSweep();
  startShiftReminderJob();
  startProjectTaskDeadlineJob();
  startRemoteNudgeJob();
  startDailyRemoteNudgeJob();
  startPayrollAutoGenerate();
  startShiftBreakAutoManager();
  startTrialExpiryMonitor();
  startRefreshTokenPurgeJob();
  startWebhookDeliveryRetryJob();
  startOutboxPublisherJob();
  startIdempotencyPurgeJob();
  startScheduledReportJob();
  startNotificationDeliveryJob();
  startNotificationDeliveryPurgeJob();
  startOffboardingJob();
  console.log('✅ All background jobs running\n');
}
