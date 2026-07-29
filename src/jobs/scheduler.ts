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
// Every job tick races for a Redis lock keyed by job name + minute bucket,
// so running 2+ API instances cannot double-fire a job. If Redis is down we
// run anyway: handlers are idempotent-ish and a duplicate beats a no-show.
async function acquireTickLock(name: string): Promise<boolean> {
  const bucket = new Date().toISOString().slice(0, 16); // minute resolution
  try {
    const res = await redis.set(`cronlock:${name}:${bucket}`, '1', 'EX', 3600, 'NX');
    return res === 'OK';
  } catch {
    return true;
  }
}

function scheduledJob(name: string, pattern: string, handler: () => Promise<void>) {
  cron.schedule(pattern, async () => {
    if (!(await acquireTickLock(name))) return;
    try {
      await handler();
    } catch (err) {
      jobLogger.error({ err, job: name }, 'scheduled job failed');
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
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
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

        const records = await prisma.attendanceRecord.findMany({ where: { org_id: org.id, date: orgToday } });
        const recordMap = new Map(records.map(r => [r.user_id, r]));

        for (const user of employees) {
          const shift = assignMap.get(user.id) || orgWideShift || defaultShift;
          if (!shift) continue;

          const shiftStartMins = hhmmToMins(shift.start_time);
          const nowMins = minutesOfDayInTz(now, tz);
          let diffMins = nowMins - shiftStartMins;
          if (diffMins < -720) diffMins += 1440;

          if (diffMins < 120 || diffMins >= 720) continue;

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
          last_heartbeat_at: { not: null, lte: new Date(now.getTime() - 10 * 60 * 1000) },
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

        // ─── FCM presence challenge (roadmap #24) ─────────
        // Before auto-checking-out, ping the device with a high-priority FCM
        // data message. High-priority pushes punch through Android Doze, so a
        // phone still on office WiFi wakes and answers via its normal
        // heartbeat — which refreshes last_heartbeat_at and drops the record
        // out of the expired set. A challenge answered by a later heartbeat
        // is treated as consumed, so a fresh loss of signal gets a fresh
        // challenge instead of an instant checkout.
        if (isPushConfigured() && record.user.fcm_token) {
          const challengeSentAt =
            record.challenge_sent_at && record.last_heartbeat_at! > record.challenge_sent_at
              ? null // heartbeat arrived after the challenge — it was answered
              : record.challenge_sent_at;

          if (!challengeSentAt) {
            const sent = await sendPresenceChallenge(record.user_id).catch(() => false);
            if (sent) {
              await prisma.attendanceRecord.update({
                where: { id: record.id },
                data: { challenge_sent_at: now },
              }).catch(() => {});
              continue; // grace tick: give the device a chance to respond
            }
          } else if (now.getTime() - challengeSentAt.getTime() < 5 * 60_000) {
            continue; // challenge pending — wait up to 5 minutes for a reply
          }
          // Challenge sent 5+ minutes ago with no heartbeat → proceed with checkout.
        }

        const checkOut = breakDueAt && breakDueAt > record.last_heartbeat_at!
          ? breakDueAt
          : record.last_heartbeat_at!;
        const hoursWorked = (checkOut.getTime() - record.check_in_at!.getTime()) / 3_600_000;
        const breaks = await settleBreaks(record.id, checkOut, tz);
        const rawEarlyMins = earlyOutMinutes(checkOut, record.shift, tz);
        // Store tolerance-adjusted value: minutes beyond the early-checkout grace window
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
            challenge_sent_at: null,
          },
        });
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

// ─── Job: Remote AI Nudges ────────────────────────────
export function startRemoteNudgeJob() {
  scheduledJob('startRemoteNudgeJob', '0 * * * *', async () => {
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
  scheduledJob('startPayrollAutoGenerate', '0 8 * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany();
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const localNow = toZonedTime(now, tz);
        if (localNow.getDate() !== org.payroll_day) continue;

        const month = localNow.getMonth() === 0 ? 12 : localNow.getMonth();
        const year = localNow.getMonth() === 0 ? localNow.getFullYear() - 1 : localNow.getFullYear();

        if (await prisma.payrollRecord.findFirst({ where: { org_id: org.id, period_month: month, period_year: year } })) continue;

        const { startOfMonth, endOfMonth } = await import('../utils/auth');
        const start = startOfMonth(year, month);
        const end = endOfMonth(year, month);

        const users = await prisma.user.findMany({ where: { org_id: org.id, is_active: true, deleted_at: null } });
        const taxRate = (org.tax_rate || 0) / 100;
        const pensionRate = (org.pension_rate || 0) / 100;

        for (const user of users) {
          const attendance = await prisma.attendanceRecord.findMany({ where: { user_id: user.id, date: { gte: start, lte: end } } });
          const regHours = attendance.reduce((s, r) => s + Number(r.net_hours_worked ?? r.hours_worked ?? 0), 0);
          const otHours = attendance.reduce((s, r) => s + Number(r.overtime_hours || 0), 0);
          const rate = Number(user.hourly_rate);
          const base = regHours * rate;
          const otPay = otHours * rate * 1.5;
          const gross = base + otPay;
          const tax = gross * taxRate;
          const pension = gross * pensionRate;
          const net = gross - tax - pension;

          await prisma.payrollRecord.upsert({
            where: { user_id_period_month_period_year: { user_id: user.id, period_month: month, period_year: year } },
            update: { regular_hours: regHours, overtime_hours: otHours, hourly_rate: rate, base_pay: base, overtime_pay: otPay, gross_pay: gross, tax_deduction: tax, pension_deduction: pension, net_pay: net, is_incomplete: rate === 0 },
            create: { user_id: user.id, org_id: org.id, period_month: month, period_year: year, regular_hours: regHours, overtime_hours: otHours, hourly_rate: rate, base_pay: base, overtime_pay: otPay, gross_pay: gross, tax_deduction: tax, pension_deduction: pension, net_pay: net, is_incomplete: rate === 0 },
          });
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
          where: { date: orgToday, check_out_at: null, status: { in: ['in', 'late', 'remote'] }, shift_id: { not: null } },
          include: { shift: { include: { breaks: true } }, break_records: true },
        });

        for (const record of openRecords) {
          const nowMins = minutesOfDayInTz(now, tz);
          for (const tmpl of record.shift?.breaks || []) {
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
            } else if (existing && !existing.break_end && nowMins >= bEnd) {
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
  scheduledJob('startDailyRemoteNudgeJob', '0 8 * * *', async () => {
    const now = new Date();
    try {
      const orgs = await prisma.organisation.findMany({ select: { id: true, timezone: true } });
      for (const org of orgs) {
        const tz = org.timezone || 'UTC';
        const orgToday = dateOnlyInTz(now, tz);

        const sessions = await prisma.remoteSession.findMany({
          where: { status: 'approved', attendance: { date: orgToday, org_id: org.id } },
          include: { user: { select: { id: true, name: true, phone: true } } },
        });

        for (const session of sessions) {
          if (!session.user.phone) continue;
          await sendDailyRemoteNudge(org.id, session.user.name, session.user.phone).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[JOB] Daily remote nudge error:', err);
    }
  });
  console.log('🏠 Daily remote nudge job started (08:00 UTC)');
}

// ─── Job: Monthly Leave Accrual ───────────────────────
export function startLeaveAccrualJob() {
  scheduledJob('startLeaveAccrualJob', '0 2 1 * *', async () => {
    const { runMonthlyAccrual } = await import('../services/leaveAccrual');
    await runMonthlyAccrual();
  });
  console.log('🌴 Leave accrual job started (1st of month, 02:00 UTC)');
}

export function startAllJobs() {
  console.log('\n🔧 Starting background jobs...');
  startLeaveAccrualJob();
  startLateArrivalDetector();
  startAbsentDetector();
  startHeartbeatExpiryMonitor();
  startShiftAutoCheckoutJob();
  startStaleRecordSweep();
  startShiftReminderJob();
  startRemoteNudgeJob();
  startDailyRemoteNudgeJob();
  startPayrollAutoGenerate();
  startShiftBreakAutoManager();
  startTrialExpiryMonitor();
  console.log('✅ All background jobs running\n');
}
