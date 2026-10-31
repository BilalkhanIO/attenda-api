import cron from 'node-cron';
import redis from '../utils/redis';
import { jobLogger } from '../utils/logger';
import { toZonedTime } from 'date-fns-tz';
import prisma from '../utils/prisma';
import {
  notifyLateArrival, notifyAbsent, notifyCheckOut,
  sendRemoteNudge, sendDailyRemoteNudge, notifyShiftReminder, formatTime12h, notify
} from '../services/whatsapp';
import {
  minutesOfDayInTz, hhmmToMins, lateThresholdFor, earlyOutMinutes, adherenceScore, dateOnlyInTz, scheduledWindow, scheduledInstant, shiftAutoCheckoutDue
} from '../utils/shift';
import { settleBreaks, netHoursWorked, netExtraMinutesAfterShift, updateAttendanceBreakSummary } from '../utils/attendance';
import { isPushConfigured, sendPresenceChallenge } from '../services/pushChallenge';
import { createNotification } from '../services/notifications';
import { randomUUID } from 'node:crypto';

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

function scheduledJob(name: string, pattern: string, handler: () => Promise<void>) {
  cron.schedule(pattern, async () => {
    const release = await acquireJobLock(name);
    if (!release) return;
    try {
      await handler();
    } catch (err) {
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
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();

        const employees = await prisma.user.findMany({
          where: { org_id: org.id, is_active: true, deleted_at: null },
          include: { manager: true },
        });

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });
        const orgWideShift = shifts.find(s => s.is_org_wide);
        const defaultShift = shifts.find(s => s.is_default);

        const assignments = await prisma.shiftAssignment.findMany({
          where: { date: orgToday, user_id: { in: employees.map(e => e.id) } },
          include: { shift: true },
        });
        const assignMap = new Map(assignments.map(a => [a.user_id, a.shift]));

        const [records, lateNotices] = await Promise.all([
          prisma.attendanceRecord.findMany({ where: { org_id: org.id, date: orgToday } }),
          prisma.lateArrivalNotice.findMany({ where: { org_id: org.id, date: orgToday, status: { not: 'cancelled' } } }),
        ]);
        const recordMap = new Map(records.map(r => [r.user_id, r]));
        const noticeMap = new Map(lateNotices.map(n => [n.user_id, n]));

        for (const user of employees) {
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
              create: { user_id: user.id, org_id: org.id, date: orgToday, check_in_type: 'system', status: 'late', shift_id: shift.id },
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
            const hrAdmins = await prisma.user.findMany({
              where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true },
              select: { id: true, phone: true },
            });
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
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();
        // Org-configurable no-show window (late_policy.absent_after_mins), default 2h
        const { parseLatePolicy, DEFAULT_ABSENT_AFTER_MINS } = await import('../services/latePolicy');
        const absentAfterMins = parseLatePolicy(org.late_policy)?.absent_after_mins ?? DEFAULT_ABSENT_AFTER_MINS;

        // Public holidays are not workdays — never mark anyone absent on them.
        const { isOrgHoliday } = await import('../services/holidays');
        if (await isOrgHoliday(org.id, orgToday)) continue;

        const employees = await prisma.user.findMany({
          where: { org_id: org.id, is_active: true, deleted_at: null },
          include: { manager: true },
        });

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });
        const orgWideShift = shifts.find(s => s.is_org_wide);
        const defaultShift = shifts.find(s => s.is_default);

        const assignments = await prisma.shiftAssignment.findMany({
          where: { date: orgToday, user_id: { in: employees.map(e => e.id) } },
          include: { shift: true },
        });
        const assignMap = new Map(assignments.map(a => [a.user_id, a.shift]));

        const records = await prisma.attendanceRecord.findMany({ where: { org_id: org.id, date: orgToday } });
        const recordMap = new Map(records.map(r => [r.user_id, r]));

        for (const user of employees) {
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
              create: { user_id: user.id, org_id: org.id, date: orgToday, check_in_type: 'system', status: 'absent' },
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
              const hrAdminsAbsent = await prisma.user.findMany({
                where: { org_id: org.id, role: { in: ['hr_admin', 'super_admin'] }, is_active: true },
                select: { phone: true },
              });
              for (const admin of hrAdminsAbsent) {
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
          last_heartbeat_at: { not: null },
          user: { org: { wifi_auto_checkout_enabled: true } },
        },
        include: {
          user: { include: { org: { select: { id: true, timezone: true, heartbeat_grace_mins: true } } } },
          shift: true,
          break_records: {
            where: { break_end: null },
            include: { shift_break: true },
          },
        },
      });

      for (const record of expired) {
        const tz = record.user.org?.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        if (record.date.getTime() !== orgToday.getTime()) continue;

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
  scheduledJob('startStaleRecordSweep', '0 6 * * *', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    try {
      const stale = await prisma.attendanceRecord.findMany({
        where: { date: yesterday, check_in_at: { not: null }, check_out_at: null },
        include: { shift: true, user: { include: { org: { select: { timezone: true } } } } },
      });

      for (const record of stale) {
        const tz = record.user?.org?.timezone || 'UTC';
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
const _shiftReminderSent = new Set<string>();
export function startShiftReminderJob() {
  scheduledJob('startShiftReminderJob', '* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        const weekday = toZonedTime(now, tz).getDay();

        const shifts = await prisma.shift.findMany({
          where: { org_id: org.id, is_published: true, active_days: { has: weekday } },
        });

        for (const shift of shifts) {
          const nowMins = minutesOfDayInTz(now, tz);
          const startMins = hhmmToMins(shift.start_time);
          const minsUntilStart = startMins - nowMins;
          if (minsUntilStart < 28 || minsUntilStart >= 32) continue;

          const assignments = await prisma.shiftAssignment.findMany({
            where: { shift_id: shift.id, date: orgToday },
            include: { user: true },
          });

          for (const assignment of assignments) {
            const { user } = assignment;
            if (!user.phone) continue;
            const cacheKey = `${assignment.id}:${orgToday.toISOString().split('T')[0]}`;
            if (_shiftReminderSent.has(cacheKey)) continue;

            const [sh] = shift.start_time.split(':').map(Number);
            const shiftStartTime = `${shift.start_time} ${sh < 12 ? 'AM' : 'PM'}`;
            await notifyShiftReminder(org.id, user.name, shiftStartTime, user.phone).catch(() => {});
            _shiftReminderSent.add(cacheKey);
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
  scheduledJob('startProjectTaskDeadlineJob', '* * * * *', async () => {
    const now = new Date();
    const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
    for (const org of orgs) {
      const tz = org.timezone || 'UTC';
      const localNow = toZonedTime(now, tz);
      if (localNow.getHours() !== 8 || localNow.getMinutes() !== 0) continue;
      const today = dateOnlyInTz(now, tz);
      const todayKey = today.toISOString().slice(0, 10);
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const tasks = await prisma.projectTask.findMany({
        where: { project: { org_id: org.id }, due_date: tomorrow, status: { not: 'done' }, assignee_id: { not: null } },
        include: { assignee: { select: { id: true } }, project: { select: { name: true } } },
      });
      for (const task of tasks) {
        if (!task.assignee) continue;
        const sent = await prisma.inAppNotification.findFirst({
          where: { user_id: task.assignee.id, type: 'project_task_deadline', action_id: task.id, created_at: { gte: today } },
          select: { id: true },
        });
        if (!sent) await createNotification({
          userId: task.assignee.id, orgId: org.id, type: 'project_task_deadline',
          title: 'Project task due tomorrow', body: `${task.title} · ${task.project.name}`,
          actionType: 'project_task', actionId: task.id, metadata: { local_date: todayKey },
        });
      }
    }
  });
  console.log('📅 Project task deadline reminders started (08:00 local time)');
}

// ─── Job: Remote AI Nudges ────────────────────────────
export function startRemoteNudgeJob() {
  // Minute cadence is required because org-local shift starts can be at any
  // minute (and timezones include half/quarter-hour offsets).
  scheduledJob('startRemoteNudgeJob', '* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);

        const sessions = await prisma.remoteSession.findMany({
          where: { status: 'approved', attendance: { date: orgToday } },
          include: {
            user: true,
            attendance: { include: { shift: true } },
          },
        });

        for (const session of sessions) {
          if (!session.user.phone) continue;
          const nowMins = minutesOfDayInTz(now, tz);
          const shiftStart = session.attendance?.shift?.start_time || '09:00';
          const shiftEnd = session.attendance?.shift?.end_time || '18:00';
          const startMins = hhmmToMins(shiftStart);
          const endMins = hhmmToMins(shiftEnd);
          const middayMins = Math.floor((startMins + endMins) / 2);

          const near = (target: number) => Math.abs(nowMins - target) <= 1;

          if (near(startMins) && !session.morning_nudge_at) {
            await sendRemoteNudge(org.id, session.user.name, 'morning', session.user.phone);
            await prisma.remoteSession.update({ where: { id: session.id }, data: { morning_nudge_at: new Date() } });
          } else if (near(middayMins) && !session.midday_nudge_at) {
            await sendRemoteNudge(org.id, session.user.name, 'midday', session.user.phone);
            await prisma.remoteSession.update({ where: { id: session.id }, data: { midday_nudge_at: new Date() } });
          } else if (near(endMins) && !session.end_nudge_at) {
            await sendRemoteNudge(org.id, session.user.name, 'eod', session.user.phone);
            await prisma.remoteSession.update({ where: { id: session.id }, data: { end_nudge_at: new Date() } });
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Remote nudge error:', err);
    }
  });
}

// ─── Job: Payroll Auto-Generate ───────────────────────
export function startPayrollAutoGenerate() {
  scheduledJob('startPayrollAutoGenerate', '* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany();
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const localNow = toZonedTime(now, tz);
        const configuredDay = Math.max(1, Math.min(31, org.payroll_day));
        const lastDayOfMonth = new Date(localNow.getFullYear(), localNow.getMonth() + 1, 0).getDate();
        const payrollDay = Math.min(configuredDay, lastDayOfMonth);
        if (localNow.getHours() < 8 || localNow.getDate() < payrollDay) continue;

        const month = localNow.getMonth() === 0 ? 12 : localNow.getMonth();
        const year = localNow.getMonth() === 0 ? localNow.getFullYear() - 1 : localNow.getFullYear();

        const { startOfMonth, endOfMonth } = await import('../utils/auth');
        const start = startOfMonth(year, month);
        const end = endOfMonth(year, month);

        const users = await prisma.user.findMany({ where: { org_id: org.id, is_active: true, deleted_at: null } });
        const existingRecords = await prisma.payrollRecord.findMany({
          where: { org_id: org.id, period_month: month, period_year: year },
          select: { user_id: true },
        });
        const existingByUser = new Map(existingRecords.map(record => [record.user_id, record]));

        // Same shared computation as POST /payroll/generate — unpaid-leave
        // deduction, per-shift overtime multiplier and manual_adjustment
        // preservation must never drift between the route and this cron.
        const { computePeriodPayroll } = await import('../utils/payroll');

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
          const rate = Number(user.hourly_rate);
          const totals = computePeriodPayroll({
            attendance,
            unpaid_leave_days: unpaidDays,
            hourly_rate: rate,
            manual_adjustment: 0,
          }, Number(org.tax_rate) || 0, Number(org.pension_rate) || 0);

          const fields = {
            regular_hours: totals.regular_hours, overtime_hours: totals.overtime_hours,
            hourly_rate: rate, base_pay: totals.base_pay, overtime_pay: totals.overtime_pay,
            unpaid_deduction: totals.unpaid_deduction, gross_pay: totals.gross_pay,
            tax_deduction: totals.tax_deduction, pension_deduction: totals.pension_deduction,
            net_pay: totals.net_pay, is_incomplete: rate === 0,
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
    try {
      const openRecords = await prisma.attendanceRecord.findMany({
        where: {
          check_out_at: null,
          check_in_at: { not: null },
          status: { in: ['in', 'late', 'remote'] },
          shift_id: { not: null },
        },
        include: { user: { include: { org: { select: { id: true, timezone: true } } } }, shift: true },
      });

      for (const record of openRecords) {
        const tz = record.user?.org?.timezone || 'UTC';
        // Only process records for the org's current local day
        const orgToday = dateOnlyInTz(now, tz);
        if (record.date.getTime() !== orgToday.getTime()) continue;

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
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);
        // Intentional: ShiftBreaks are children of Shifts. Employees checked in without
        // a resolved shift have no break templates to auto-start. This is correct behavior.
        const openRecords = await prisma.attendanceRecord.findMany({
          where: { org_id: org.id, date: orgToday, check_in_at: { not: null }, check_out_at: null, status: { in: ['in', 'late', 'remote'] }, shift_id: { not: null } },
          include: { shift: { include: { breaks: true } }, break_records: true },
        });

        for (const record of openRecords) {
          const nowMins = minutesOfDayInTz(now, tz);
          for (const tmpl of record.shift?.breaks || []) {
            if ((tmpl.applies_days.length && !tmpl.applies_days.includes(orgToday.getUTCDay())) || (tmpl.exception_dates.length && !tmpl.exception_dates.includes(orgToday.toISOString().slice(0, 10)))) continue;
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
  scheduledJob('startDailyRemoteNudgeJob', '* * * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const localNow = toZonedTime(now, tz);
        if (localNow.getHours() < 8) continue;
        const orgToday = dateOnlyInTz(now, tz);

        const sessions = await prisma.remoteSession.findMany({
          where: {
            status: 'approved',
            OR: [{ daily_nudge_at: null }, { daily_nudge_at: { lt: orgToday } }],
            attendance: { date: orgToday, org_id: org.id },
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
            await sendDailyRemoteNudge(org.id, session.user.name, session.user.phone);
          } catch (error) {
            await prisma.remoteSession.updateMany({
              where: { id: session.id, daily_nudge_at: orgToday },
              data: { daily_nudge_at: null },
            });
            throw error;
          }
        }
      }
    } catch (err) {
      console.error('[JOB] Daily remote nudge error:', err);
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
  scheduledJob('startLeaveAccrualJob', '* * * * *', async () => {
    const now = new Date();
    const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
    const dueOrgIds = orgs.filter(org => {
      const localNow = toZonedTime(now, org.timezone || 'UTC');
      // Retry on later local 02:xx ticks if the 02:00 tick was skipped due to
      // Redis downtime. The durable unique period row makes reruns harmless.
      return localNow.getHours() >= 2;
    }).map(org => org.id);
    if (!dueOrgIds.length) return;
    const { runMonthlyAccrual } = await import('../services/leaveAccrual');
    const dueOrgs: string[] = [];
    for (const orgId of dueOrgIds) {
      const org = orgs.find(item => item.id === orgId)!;
      const localNow = toZonedTime(now, org.timezone || 'UTC');
      const existing = await prisma.leaveAccrualRun.findUnique({
        where: { org_id_year_month: { org_id: orgId, year: localNow.getFullYear(), month: localNow.getMonth() + 1 } },
        select: { id: true },
      });
      if (!existing) dueOrgs.push(orgId);
    }
    if (dueOrgs.length) await runMonthlyAccrual(now, dueOrgs);
  });
  console.log('🌴 Leave accrual job started (monthly, retried during local 02:00 hour)');
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
    const { retryDueWebhookDeliveries } = await import('../services/webhookDelivery');
    await retryDueWebhookDeliveries();
  });
  console.log('🔁 Outbound webhook retry worker started (every minute)');
}

export function startAllJobs() {
  console.log('\n🔧 Starting background jobs...');
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
  console.log('✅ All background jobs running\n');
}
